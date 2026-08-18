/**
 * The App JWT — the short-lived credential that mints installation tokens.
 *
 * Three credentials, deliberately not behind one abstraction:
 *
 *     GithubAppPrivateKey      long-lived, rotated by hand      signs ↓
 *     App JWT                  ≤ 10 minutes, this module        authorizes ↓
 *     installation token       1 hour, per installation         repository access
 *
 * They differ in lifetime, scope, storage, rotation, and failure mode. A single
 * `AuthService.getToken()` hiding all three becomes a junk drawer the first
 * time one of them needs different retry behaviour.
 *
 * # Why the JWT is hand-assembled
 *
 * A JWT is three base64url segments and an RSA signature — trivial to produce
 * and, unusually, safe to hand-roll here. Every famous JWT vulnerability
 * (`alg: none`, RS256/HS256 confusion, key-id injection) is a **verification**
 * flaw: they are ways of tricking a verifier into accepting a token it should
 * reject. This module only ever *signs*, and GitHub does the verifying.
 *
 * So there is no attacker-controlled input, no parsing, and no algorithm
 * negotiation — the header is a constant. A dependency would add supply-chain
 * surface to the most sensitive path in the system for forty lines of encoding.
 *
 * # GitHub's constraints
 *
 * | Requirement | How it is met |
 * | --- | --- |
 * | `RS256` | the only algorithm emitted; the key is validated as RSA |
 * | `iat`, `exp`, `iss` | always present |
 * | `exp` ≤ 10 minutes ahead | enforced, and the default is 9 |
 * | clock skew | `iat` is back-dated 60 seconds by default |
 * | `iss` | the App's client id |
 */

import { createSign } from "node:crypto";

import type { Clock } from "@acalys/contracts/domain";

import type { GithubAppPrivateKey } from "./private-key.js";

/**
 * GitHub rejects a JWT whose `exp` is more than ten minutes ahead.
 *
 * The default lifetime is deliberately below it. GitHub validates `exp`
 * against *their* clock, so a token minted at the maximum is rejected whenever
 * this host runs even slightly fast — an outage that appears only on the
 * machines with drifted clocks and is correspondingly hard to diagnose.
 */
export const MAX_JWT_LIFETIME_SECONDS = 600;
export const DEFAULT_JWT_LIFETIME_SECONDS = 540;

/**
 * How far `iat` is back-dated.
 *
 * GitHub rejects a JWT issued in the future. Without back-dating, a host whose
 * clock is a few seconds fast fails *every* request, and the symptom — 401 on
 * all deliveries from one worker — looks like a credential problem rather than
 * an NTP problem.
 */
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;

export class JwtSigningError extends Error {
  public override readonly name = "JwtSigningError";

  public constructor(reason: string) {
    super(`Cannot sign GitHub App JWT: ${reason}`);
  }
}

export interface AppJwtSignerOptions {
  /**
   * The App's client id, used as `iss`.
   *
   * GitHub now recommends the client id over the numeric app id. Both are
   * public identifiers, so this value is safe to log.
   */
  readonly appClientId: string;
  readonly privateKey: GithubAppPrivateKey;
  /**
   * Injected so expiry and skew are testable without waiting.
   *
   * Scattering `Date.now()` through signing makes every boundary condition —
   * "is `exp` really capped?", "is `iat` really in the past?" — untestable
   * except by sleeping.
   */
  readonly clock: Clock;
  readonly lifetimeSeconds?: number | undefined;
  readonly clockSkewSeconds?: number | undefined;
}

/** The claims, exposed so a test can assert them without decoding base64url. */
export interface AppJwtClaims {
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
}

export interface SignedAppJwt {
  /** The compact JWT. **Secret** — a bearer credential for ten minutes. */
  readonly token: string;
  readonly claims: AppJwtClaims;
}

function base64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input, "utf8") : input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Epoch seconds from the canonical timestamp the clock returns. */
function epochSeconds(clock: Clock): number {
  const millis = Date.parse(clock.now());
  if (Number.isNaN(millis)) {
    throw new JwtSigningError("clock returned an unparseable timestamp");
  }
  return Math.floor(millis / 1000);
}

/**
 * Signs App JWTs.
 *
 * Stateless and cheap — roughly a millisecond per signature on a 2048-bit key —
 * so there is deliberately no JWT cache. Caching a bearer credential to save a
 * millisecond trades a real security property (short exposure) for nothing.
 * The *installation token* is cached, because minting one costs a network round
 * trip to GitHub.
 */
export class AppJwtSigner {
  readonly #appClientId: string;
  readonly #privateKey: GithubAppPrivateKey;
  readonly #clock: Clock;
  readonly #lifetimeSeconds: number;
  readonly #clockSkewSeconds: number;

  public constructor(options: AppJwtSignerOptions) {
    const lifetime = options.lifetimeSeconds ?? DEFAULT_JWT_LIFETIME_SECONDS;
    const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;

    // Validated at construction so a misconfiguration fails the deploy rather
    // than every request afterwards.
    if (options.appClientId.length === 0) {
      throw new JwtSigningError("appClientId is empty");
    }
    if (!Number.isInteger(lifetime) || lifetime <= 0) {
      throw new JwtSigningError("lifetimeSeconds must be a positive integer");
    }
    if (lifetime > MAX_JWT_LIFETIME_SECONDS) {
      throw new JwtSigningError(
        `lifetimeSeconds ${String(lifetime)} exceeds GitHub's maximum of ${String(MAX_JWT_LIFETIME_SECONDS)}`,
      );
    }
    if (!Number.isInteger(skew) || skew < 0) {
      throw new JwtSigningError(
        "clockSkewSeconds must be a non-negative integer",
      );
    }

    this.#appClientId = options.appClientId;
    this.#privateKey = options.privateKey;
    this.#clock = options.clock;
    this.#lifetimeSeconds = lifetime;
    this.#clockSkewSeconds = skew;
  }

  public sign(): SignedAppJwt {
    const now = epochSeconds(this.#clock);
    const claims: AppJwtClaims = {
      iat: now - this.#clockSkewSeconds,
      exp: now + this.#lifetimeSeconds,
      iss: this.#appClientId,
    };

    // A constant. There is no algorithm negotiation and no `kid`, so there is
    // nothing here an input could influence.
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify(claims));
    const signingInput = `${header}.${payload}`;

    let signature: Buffer;
    try {
      signature = createSign("RSA-SHA256")
        .update(signingInput)
        .sign(this.#privateKey.signingKey());
    } catch (cause) {
      // The failure is surfaced without its cause. OpenSSL errors can carry key
      // material, and this message reaches logs. There is deliberately no
      // fallback path: a signing failure must abort, never degrade to an
      // unsigned or differently-signed token.
      throw new JwtSigningError(
        `RSA signing failed (${String((cause as Error | undefined)?.name ?? "unknown")})`,
      );
    }

    return { token: `${signingInput}.${base64url(signature)}`, claims };
  }
}

/**
 * Decodes a JWT's claims **without verifying it**.
 *
 * For tests and for logging a token's expiry during diagnosis. Named to make
 * misuse obvious: nothing in this platform verifies a JWT, and if that ever
 * changes, this function must not be what does it.
 */
export function decodeUnverifiedJwtClaims(token: string): AppJwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtSigningError("not a compact JWT");
  }
  const [, payload] = parts;
  if (payload === undefined) {
    throw new JwtSigningError("not a compact JWT");
  }
  return JSON.parse(
    Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8"),
  ) as AppJwtClaims;
}

/** The `alg` a token declares, read from its header. Tests assert RS256. */
export function decodeUnverifiedJwtAlgorithm(token: string): string {
  const [header] = token.split(".");
  if (header === undefined) {
    throw new JwtSigningError("not a compact JWT");
  }
  const decoded = JSON.parse(
    Buffer.from(
      header.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8"),
  ) as { readonly alg?: unknown };
  return typeof decoded.alg === "string" ? decoded.alg : "";
}
