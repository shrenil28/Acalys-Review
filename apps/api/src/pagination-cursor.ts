import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type PaginationCollection =
  "repositories" | "pull_requests" | "findings" | "conversations" | "knowledge";

export interface PaginationCursorBinding {
  readonly organizationId: string;
  readonly collection: PaginationCollection;
  /** Parent resource for nested collections, such as repository or review id. */
  readonly resource?: string | undefined;
  /** Canonicalized filters whose change must invalidate the cursor. */
  readonly query?: string | undefined;
}

export interface PaginationCursorCodec {
  encode(binding: PaginationCursorBinding, rowId: string): string;
  decode(binding: PaginationCursorBinding, token: string): string;
}

export class InvalidPaginationCursor extends Error {
  constructor() {
    super("Invalid pagination cursor");
    this.name = "InvalidPaginationCursor";
  }
}

const TOKEN_PREFIX = "c1.";
const TOKEN_PATTERN = /^c1\.([A-Za-z0-9_-]+)$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const BINDING_BYTES = 16;
const PAYLOAD_BYTES = 2 + 16 + BINDING_BYTES * 3;
const TOKEN_BYTES = NONCE_BYTES + PAYLOAD_BYTES + AUTH_TAG_BYTES;
const AAD = Buffer.from("acalys.api.pagination.cursor.v1", "utf8");
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4_096;
const MAX_SECRET_GENERATIONS = 4;

const COLLECTION_CODE: Readonly<Record<PaginationCollection, number>> = {
  repositories: 1,
  pull_requests: 2,
  findings: 3,
  conversations: 4,
  knowledge: 5,
};

function deriveKey(secret: string): Buffer {
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
    throw new Error(
      `Pagination cursor secrets must be ${MIN_SECRET_BYTES}-${MAX_SECRET_BYTES} UTF-8 bytes`,
    );
  }
  return createHash("sha256")
    .update("acalys.api.pagination.cursor.key.v1\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

function bindingHash(label: string, value: string | undefined): Buffer {
  return createHash("sha256")
    .update(`acalys.api.pagination.${label}.v1\0`, "utf8")
    .update(value ?? "", "utf8")
    .digest()
    .subarray(0, BINDING_BYTES);
}

function uuidBytes(value: string): Buffer {
  if (!UUID_PATTERN.test(value))
    throw new Error("PAGINATION_CURSOR_SOURCE_INVALID");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function uuidString(value: Buffer): string {
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildPayload(binding: PaginationCursorBinding, rowId: string): Buffer {
  const payload = Buffer.allocUnsafe(PAYLOAD_BYTES);
  payload[0] = 1;
  payload[1] = COLLECTION_CODE[binding.collection];
  uuidBytes(rowId).copy(payload, 2);
  bindingHash("tenant", binding.organizationId).copy(payload, 18);
  bindingHash("resource", binding.resource).copy(payload, 18 + BINDING_BYTES);
  bindingHash("query", binding.query).copy(payload, 18 + BINDING_BYTES * 2);
  return payload;
}

function matchesBinding(
  payload: Buffer,
  binding: PaginationCursorBinding,
): boolean {
  if (payload[0] !== 1 || payload[1] !== COLLECTION_CODE[binding.collection])
    return false;
  const tenant = payload.subarray(18, 18 + BINDING_BYTES);
  const resource = payload.subarray(18 + BINDING_BYTES, 18 + BINDING_BYTES * 2);
  const query = payload.subarray(
    18 + BINDING_BYTES * 2,
    18 + BINDING_BYTES * 3,
  );
  return (
    timingSafeEqual(tenant, bindingHash("tenant", binding.organizationId)) &&
    timingSafeEqual(resource, bindingHash("resource", binding.resource)) &&
    timingSafeEqual(query, bindingHash("query", binding.query))
  );
}

function decryptWithKey(raw: Buffer, key: Buffer): Buffer | undefined {
  const nonce = raw.subarray(0, NONCE_BYTES);
  const encrypted = raw.subarray(NONCE_BYTES, raw.length - AUTH_TAG_BYTES);
  const tag = raw.subarray(raw.length - AUTH_TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    return undefined;
  }
}

/**
 * Creates the stateless public cursor codec.
 *
 * The first secret is active for issuance. Remaining generations are decode-only
 * so a rolling secret rotation does not break an in-progress page walk. Tokens
 * carry no plaintext tenant/resource/row identifiers; AES-GCM authenticates the
 * encrypted fixed-size payload and the payload itself binds the collection,
 * tenant, parent resource and canonical filter set.
 */
export function createPaginationCursorCodec(
  secretGenerations: readonly string[],
): PaginationCursorCodec {
  if (
    secretGenerations.length === 0 ||
    secretGenerations.length > MAX_SECRET_GENERATIONS
  ) {
    throw new Error(
      `Pagination cursor secret ring must contain 1-${MAX_SECRET_GENERATIONS} generations`,
    );
  }
  const keys = secretGenerations.map(deriveKey);

  return {
    encode(binding, rowId) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", keys[0]!, nonce);
      cipher.setAAD(AAD);
      const encrypted = Buffer.concat([
        cipher.update(buildPayload(binding, rowId)),
        cipher.final(),
      ]);
      const token = Buffer.concat([
        nonce,
        encrypted,
        cipher.getAuthTag(),
      ]).toString("base64url");
      return `${TOKEN_PREFIX}${token}`;
    },

    decode(binding, token) {
      const match = TOKEN_PATTERN.exec(token);
      if (match === null) throw new InvalidPaginationCursor();

      let raw: Buffer;
      try {
        raw = Buffer.from(match[1]!, "base64url");
      } catch {
        throw new InvalidPaginationCursor();
      }
      if (
        raw.length !== TOKEN_BYTES ||
        raw.toString("base64url") !== match[1]
      ) {
        throw new InvalidPaginationCursor();
      }

      for (const key of keys) {
        const payload = decryptWithKey(raw, key);
        if (
          payload !== undefined &&
          payload.length === PAYLOAD_BYTES &&
          matchesBinding(payload, binding)
        ) {
          return uuidString(payload.subarray(2, 18));
        }
      }
      throw new InvalidPaginationCursor();
    },
  };
}
