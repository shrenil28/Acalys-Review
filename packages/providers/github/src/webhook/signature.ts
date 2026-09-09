/**
 * GitHub webhook signature verification — the platform's front door.
 *
 * Everything downstream trusts that a delivery reaching normalization came
 * from GitHub. This module is the only thing establishing that. A defect here
 * does not degrade review quality; it lets a stranger start review runs on
 * private repositories, spend model budget, and post comments as the app.
 *
 * # The bug that matters most
 *
 * The HMAC must be computed over the **exact bytes GitHub sent**, never over a
 * re-serialized object:
 *
 *     ✗  verify(secret, JSON.stringify(req.body), signature)   always wrong
 *     ✓  verify(secret, rawBodyBuffer, signature)
 *
 * `JSON.parse` followed by `JSON.stringify` is not the identity function — it
 * changes key order, whitespace, unicode escaping, and number formatting. The
 * signature is over the original bytes, so a re-serialized body produces a
 * different digest and every delivery fails. The dangerous fix is to then
 * disable verification "because it never works", which is why this function
 * accepts only raw bytes and a string, never a parsed object.
 *
 * The Express-shaped consequence: the route must capture the raw body *before*
 * `express.json()` consumes it. That is Phase 1's `apps/webhook-gateway`
 * responsibility, and it is asserted by a test there.
 *
 * # Why the comparison is constant-time
 *
 * `expected === actual` returns as soon as two bytes differ. An attacker who
 * can send many deliveries and time the responses recovers the digest one byte
 * at a time — roughly 16 × 256 requests for a 64-character hex digest, which is
 * minutes of work. `timingSafeEqual` compares every byte regardless.
 *
 * # What this module deliberately does not do
 *
 * Replay protection is **not** here. A signature stays valid forever by
 * design — GitHub redelivers failed webhooks, sometimes hours later, and a
 * timestamp window would reject legitimate redeliveries. Duplicate suppression
 * belongs to idempotent ingestion, keyed on the delivery id (§47), and that is
 * a different guarantee: this module answers *"did GitHub send this?"*, not
 * *"have we already handled it?"*.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The header GitHub signs with. */
export const SIGNATURE_HEADER = "x-hub-signature-256";
/** Unique per delivery, and the natural idempotency key (§47). */
export const DELIVERY_HEADER = "x-github-delivery";
/** Which event this is: `pull_request`, `push`, `ping`, … */
export const EVENT_HEADER = "x-github-event";

const SIGNATURE_PREFIX = "sha256=";
/** SHA-256 is 32 bytes → 64 lowercase hex characters. */
const DIGEST_HEX_LENGTH = 64;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Why a delivery was refused.
 *
 * A closed union rather than a boolean, because the gateway responds
 * differently to each: a missing header is a misconfigured hook (log loudly,
 * 400), while a mismatched digest is either a rotated secret or an attack
 * (401, alert). Collapsing them to `false` erases that distinction at exactly
 * the moment it matters.
 *
 * The reason is for **logs and metrics only**. It must never reach the HTTP
 * response body: telling a caller "signature mismatch" versus "malformed
 * signature" tells them how far they got, which is free reconnaissance.
 */
export const SIGNATURE_FAILURES = [
  "missing_signature",
  "malformed_signature",
  "mismatch",
  "empty_secret",
  "empty_body",
] as const;

export type SignatureFailure = (typeof SIGNATURE_FAILURES)[number];

export type SignatureVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SignatureFailure };

/**
 * Verifies a GitHub webhook signature.
 *
 * @param secret   The webhook secret configured on the GitHub App.
 * @param rawBody  The **exact bytes** of the request body. A `string` is
 *                 encoded as UTF-8, matching what GitHub signed. Never pass a
 *                 parsed and re-serialized object.
 * @param signatureHeader  The `X-Hub-Signature-256` header value, or
 *                 `undefined` when absent.
 *
 * Returns a result rather than throwing. A failed signature is an expected
 * condition on a public endpoint — anyone can POST to it — and an exception
 * per unauthenticated request is both a performance problem and a noisy log.
 */
export type WebhookSecretSet = string | readonly string[];

export function verifyWebhookSignature(
  secret: WebhookSecretSet,
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
): SignatureVerification {
  const candidates = typeof secret === "string" ? [secret] : secret;
  // An empty candidate would make part of a rotation configuration trivially
  // forgeable. Treat the whole set as misconfigured rather than silently
  // ignoring the broken generation.
  if (candidates.length === 0 || candidates.some((candidate) => candidate.length === 0)) {
    return { ok: false, reason: "empty_secret" };
  }

  if (signatureHeader === undefined || signatureHeader.length === 0) {
    return { ok: false, reason: "missing_signature" };
  }

  const body =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;

  // GitHub never sends an empty body on a signed delivery. Accepting one would
  // mean computing an HMAC over nothing, which is a stable value an attacker
  // can precompute offline once and replay forever.
  if (body.length === 0) {
    return { ok: false, reason: "empty_body" };
  }

  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: "malformed_signature" };
  }

  const provided = signatureHeader.slice(SIGNATURE_PREFIX.length);

  // Validated before `timingSafeEqual`, which throws on a length mismatch
  // rather than returning false. Doing this as a shape check on
  // attacker-controlled input leaks nothing: the length and character set of a
  // SHA-256 hex digest are public, and no secret-derived value is compared yet.
  if (provided.length !== DIGEST_HEX_LENGTH || !HEX_DIGEST.test(provided)) {
    return { ok: false, reason: "malformed_signature" };
  }

  const actual = Buffer.from(provided, "hex");
  let matched = false;
  for (const candidate of candidates) {
    const expected = createHmac("sha256", candidate).update(body).digest();

    // Both buffers are 32 bytes: `expected` by construction, `actual` because
    // the hex string was length-checked above. The guard stays anyway — a
    // future edit that loosens the regex would otherwise turn validation into
    // an exception on the public request path.
    if (expected.length !== actual.length) {
      return { ok: false, reason: "malformed_signature" };
    }
    // Deliberately evaluate every configured generation. Besides being simple,
    // this avoids making the active-vs-previous position observable in timing.
    matched = timingSafeEqual(expected, actual) || matched;
  }

  return matched ? { ok: true } : { ok: false, reason: "mismatch" };
}

/**
 * Computes the header GitHub would send for a body.
 *
 * Exported for tests and for a local development harness that replays
 * deliveries. It is the same primitive as verification — deliberately, so a
 * test cannot pass against a signer that disagrees with the verifier.
 */
export function signWebhookBody(
  secret: string,
  rawBody: Buffer | string,
): string {
  const body =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return `${SIGNATURE_PREFIX}${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** The headers every delivery carries, once verified. */
export interface DeliveryHeaders {
  /** `X-GitHub-Delivery` — unique per delivery; the idempotency key (§47). */
  readonly deliveryId: string;
  /** `X-GitHub-Event` — the event name, lowercase. */
  readonly event: string;
  /** `X-Hub-Signature-256`, as received. */
  readonly signature: string;
}

/**
 * Extracts and validates the delivery headers.
 *
 * `deliveryId` is bounded and character-restricted because it becomes an
 * idempotency key and, eventually, part of a database key. GitHub sends a
 * UUID; accepting arbitrary length or content would let a forged delivery
 * (one that somehow passed signature verification, e.g. with a leaked secret)
 * poison the deduplication table with an unbounded key.
 */
export function readDeliveryHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): DeliveryHeaders | undefined {
  const single = (name: string): string | undefined => {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (typeof value === "string") return value;
    // A repeated header is ambiguous — which one was signed? Refusing is the
    // only safe reading, and it is never legitimate from GitHub.
    return undefined;
  };

  const deliveryId = single(DELIVERY_HEADER);
  const event = single(EVENT_HEADER);
  const signature = single(SIGNATURE_HEADER);

  if (
    deliveryId === undefined ||
    event === undefined ||
    signature === undefined
  ) {
    return undefined;
  }
  if (!/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)) return undefined;
  if (!/^[a-z_]{1,64}$/.test(event)) return undefined;

  return { deliveryId, event, signature };
}
