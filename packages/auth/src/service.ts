import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "@acalys/contracts/domain";
import { type AuthRole, AuthStore } from "@acalys/database";

export const AUTH_ROLES = ["owner", "admin", "member", "read_only"] as const;
export type Role = (typeof AUTH_ROLES)[number];

export const API_SCOPES = [
  "repositories:read",
  "reviews:read",
  "reviews:write",
  "findings:read",
  "findings:write",
  "conversations:read",
  "conversations:write",
  "knowledge:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface Principal {
  readonly kind: "session" | "api_key";
  readonly id: string;
  readonly userId?: string | undefined;
  readonly organizationId: string;
  readonly role: Role;
  /** Sessions receive role-derived capabilities; API keys are additionally scope-limited. */
  readonly scopes: ReadonlySet<ApiScope>;
}

export interface IssuedCredential {
  readonly id: string;
  readonly token: string;
  readonly expiresAt?: Date | undefined;
}

export interface VerifiedGithubIdentity {
  readonly providerUserId: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
}

export interface EstablishedGithubSession {
  readonly userId: string;
  readonly role: Role;
  readonly credential: IssuedCredential;
}

const ROLE_SCOPES: Readonly<Record<Role, ReadonlySet<ApiScope>>> = {
  owner: new Set(API_SCOPES),
  admin: new Set(API_SCOPES),
  member: new Set([
    "repositories:read",
    "reviews:read",
    "reviews:write",
    "findings:read",
    "findings:write",
    "conversations:read",
    "conversations:write",
    "knowledge:read",
  ]),
  read_only: new Set([
    "repositories:read",
    "reviews:read",
    "findings:read",
    "conversations:read",
    "knowledge:read",
  ]),
};

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function secureToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function validScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

function validRole(value: string): value is Role {
  return (AUTH_ROLES as readonly string[]).includes(value);
}

export function requireScope(principal: Principal, scope: ApiScope): void {
  if (!principal.scopes.has(scope)) {
    throw new ForbiddenError(`Credential is not authorized for scope '${scope}'`);
  }
}

export function mapGithubPermissionsToRole(input: {
  readonly organizationOwner: boolean;
  readonly permissions: Readonly<Record<string, string>>;
}): Role {
  if (input.organizationOwner) return "owner";
  if (input.permissions["administration"] === "write") return "admin";
  if (
    input.permissions["contents"] === "write" ||
    input.permissions["pull_requests"] === "write" ||
    input.permissions["issues"] === "write"
  ) {
    return "member";
  }
  return "read_only";
}

export interface AuthServiceOptions {
  readonly store: AuthStore;
  readonly sessionTtlMillis?: number | undefined;
  /** @deprecated Credential and OAuth-commit chronology is database-owned. */
  readonly now?: (() => Date) | undefined;
}

export class AuthService {
  readonly #store: AuthStore;
  readonly #sessionTtlMillis: number;

  public constructor(options: AuthServiceOptions) {
    this.#store = options.store;
    this.#sessionTtlMillis = options.sessionTtlMillis ?? 8 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(this.#sessionTtlMillis) || this.#sessionTtlMillis <= 0) {
      throw new ValidationError("Session TTL must be a positive safe integer");
    }
  }

  /**
   * Persists a provider-verified GitHub identity, synchronizes the tenant role,
   * and issues the first opaque session through one database-owned commit.
   *
   * The proposed user id is only used on first sight. The store returns the
   * canonical provider identity, exact membership row, persisted role, and
   * database-clock expiry from the same transaction. A failed session insert
   * therefore cannot leave an identity/membership update committed by itself.
   */
  public async establishGithubSession(input: {
    readonly organizationId: string;
    readonly identity: VerifiedGithubIdentity;
    readonly organizationOwner: boolean;
    readonly permissions: Readonly<Record<string, string>>;
  }): Promise<EstablishedGithubSession> {
    const requestedRole = mapGithubPermissionsToRole({
      organizationOwner: input.organizationOwner,
      permissions: input.permissions,
    });
    const sessionId = uuidv7();
    const token = secureToken("acalys_session");
    const established = await this.#store.establishOAuthSession({
      proposedUserId: uuidv7(),
      membershipId: uuidv7(),
      sessionId,
      organizationId: input.organizationId,
      provider: "github",
      providerUserId: input.identity.providerUserId,
      ...(input.identity.email === undefined ? {} : { primaryEmail: input.identity.email }),
      ...(input.identity.displayName === undefined ? {} : { displayName: input.identity.displayName }),
      role: requestedRole,
      tokenHash: hashToken(token),
      ttlMillis: this.#sessionTtlMillis,
    });
    return {
      userId: established.userId,
      role: established.role as Role,
      credential: { id: sessionId, token, expiresAt: established.expiresAt },
    };
  }

  public async issueSession(userId: string, organizationId: string): Promise<IssuedCredential> {
    const id = uuidv7();
    const token = secureToken("acalys_session");
    const created = await this.#store.createSession({
      id,
      userId,
      organizationId,
      tokenHash: hashToken(token),
      ttlMillis: this.#sessionTtlMillis,
    });
    if (created === undefined) {
      throw new UnauthorizedError("A session can only be issued for a live organization membership");
    }
    return { id, token, expiresAt: created.expiresAt };
  }

  public async authenticateSession(token: string): Promise<Principal> {
    if (!token.startsWith("acalys_session_")) throw new UnauthorizedError("Invalid session credential");
    const row = await this.#store.authenticateSessionByHash(hashToken(token));
    if (row === undefined) {
      throw new UnauthorizedError("Session is invalid, expired, rotated, revoked, or no longer authorized");
    }
    const role = row.role as Role;
    return {
      kind: "session",
      id: row.sessionId,
      userId: row.userId,
      organizationId: row.organizationId,
      role,
      scopes: ROLE_SCOPES[role],
    };
  }

  public async rotateSession(token: string): Promise<IssuedCredential> {
    if (!token.startsWith("acalys_session_")) throw new UnauthorizedError("Invalid session credential");
    const replacementId = uuidv7();
    const replacement = secureToken("acalys_session");
    const rotated = await this.#store.rotateSessionByHash({
      currentHash: hashToken(token),
      replacementId,
      replacementHash: hashToken(replacement),
      ttlMillis: this.#sessionTtlMillis,
    });
    if (rotated === undefined) throw new UnauthorizedError("Session could not be rotated");
    return { id: replacementId, token: replacement, expiresAt: rotated.expiresAt };
  }

  public revokeSession(sessionId: string, organizationId: string): Promise<boolean> {
    return this.#store.revokeSession(sessionId, organizationId);
  }

  public async issueApiKey(input: {
    readonly organizationId: string;
    readonly userId?: string | undefined;
    readonly name: string;
    readonly role?: Role | undefined;
    readonly scopes: readonly ApiScope[];
    readonly expiresAt?: Date | undefined;
  }): Promise<IssuedCredential> {
    if (input.name.trim().length === 0) throw new ValidationError("API key name is required");
    if (input.scopes.length === 0) throw new ValidationError("API key needs at least one scope");
    if (new Set(input.scopes).size !== input.scopes.length) throw new ValidationError("API key scopes must be unique");
    if (!input.scopes.every((scope) => validScope(scope))) throw new ValidationError("API key contains an unknown scope");
    const role = input.role ?? "read_only";
    if (!validRole(role)) throw new ValidationError("API key role is invalid");
    if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt.getTime())) {
      throw new ValidationError("API key expiry must be a valid timestamp");
    }
    const id = uuidv7();
    const prefix = randomBytes(6).toString("hex");
    const token = `acalys_key_${prefix}_${randomBytes(32).toString("base64url")}`;
    const created = await this.#store.createApiKey({
      id,
      organizationId: input.organizationId,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      prefix,
      hash: hashToken(token),
      name: input.name.trim(),
      role,
      scopes: input.scopes,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    if (created === "invalid_expiry") {
      throw new ValidationError("API key expiry must be in the future");
    }
    if (created === "membership_missing") {
      throw new ValidationError("A user-bound API key requires a live organization membership");
    }
    return { id, token, ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) };
  }

  public async authenticateApiKey(token: string): Promise<Principal> {
    if (!token.startsWith("acalys_key_")) throw new UnauthorizedError("Invalid API key credential");
    const row = await this.#store.authenticateApiKeyByHash(hashToken(token));
    if (row === undefined) {
      throw new UnauthorizedError("API key is invalid, expired, revoked, or no longer authorized");
    }
    const roleScopes = ROLE_SCOPES[row.role as Role];
    const scopes = new Set<ApiScope>();
    for (const scope of row.scopes) {
      if (validScope(scope) && roleScopes.has(scope)) scopes.add(scope);
    }
    return {
      kind: "api_key",
      id: row.apiKeyId,
      ...(row.userId === null ? {} : { userId: row.userId }),
      organizationId: row.organizationId,
      role: row.role as Role,
      scopes,
    };
  }

  public revokeApiKey(apiKeyId: string, organizationId: string): Promise<boolean> {
    return this.#store.revokeApiKey(apiKeyId, organizationId);
  }

  public async authenticateBearer(value: string | undefined): Promise<Principal> {
    if (value === undefined || !value.startsWith("Bearer ")) throw new UnauthorizedError("Bearer authentication is required");
    const token = value.slice("Bearer ".length);
    return token.startsWith("acalys_session_")
      ? this.authenticateSession(token)
      : this.authenticateApiKey(token);
  }
}
