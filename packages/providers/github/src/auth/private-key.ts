/**
 * The GitHub App private key, and the discipline around holding it.
 *
 * This key signs the JWT that mints installation tokens. Whoever holds it can
 * act as the App against every installation — read every private repository,
 * post as the app, and do so without any audit trail distinguishing them from
 * the platform. It is the single highest-value secret in the system.
 *
 * Two properties, both enforced rather than documented:
 *
 * 1. **Validated at construction, not at first use.** A malformed or wrong-type
 *    key must fail the deploy, not the first webhook of the day. A process that
 *    starts happily and then fails every delivery is far harder to diagnose
 *    than one that refuses to start.
 *
 * 2. **Unprintable.** `toString`, `toJSON`, template interpolation, and Node's
 *    inspector are all overridden to redact. That matters because the paths
 *    that leak secrets are never the ones anyone wrote deliberately — they are
 *    `logger.error({ config })`, `JSON.stringify(options)` in a telemetry
 *    attribute, and a thrown error whose message interpolated the whole object.
 *
 * # Rotation
 *
 * GitHub App private keys do not expire, and GitHub permits several active at
 * once precisely so rotation needs no downtime:
 *
 *     add replacement key at GitHub  →  deploy config with it  →  revoke old
 *
 * The platform only ever **signs**, never verifies, so exactly one key is in
 * use at a time and rotation is a configuration swap. This class therefore
 * models a single key rather than a keyring — a multi-key abstraction here
 * would carry no behaviour and imply a capability that does not exist. What
 * makes rotation safe is that a bad key fails at construction, so a mistyped
 * rotation is caught by the deploy rather than by production traffic.
 */

import { createPrivateKey, type KeyObject } from "node:crypto";

/** Shown wherever the key would otherwise be rendered. */
export const REDACTED = "[REDACTED GitHub App private key]";

export class PrivateKeyError extends Error {
  public override readonly name = "PrivateKeyError";

  public constructor(reason: string) {
    // The reason describes the *shape* problem only. It never quotes the input:
    // a partially-valid PEM in an error message is still key material, and
    // error messages reach logs.
    super(`Invalid GitHub App private key: ${reason}`);
  }
}

/**
 * A validated RSA private key.
 *
 * The underlying {@link KeyObject} is held in a private field, so it is not
 * reachable by property access, spread, `Object.keys`, or structured clone.
 */
export class GithubAppPrivateKey {
  readonly #key: KeyObject;

  private constructor(key: KeyObject) {
    this.#key = key;
  }

  /**
   * Parses and validates a PEM-encoded private key.
   *
   * @throws {PrivateKeyError} if the PEM is malformed, is not a private key,
   *   is not RSA, or is too short to be safe.
   */
  public static fromPem(pem: string): GithubAppPrivateKey {
    if (pem.trim().length === 0) {
      throw new PrivateKeyError("empty");
    }

    let key: KeyObject;
    try {
      // Node accepts PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub downloads)
      // and PKCS#8 (`BEGIN PRIVATE KEY`, what many secret managers re-encode
      // to). Both are legitimate; rejecting one would break a deployment for a
      // reason that has nothing to do with security.
      key = createPrivateKey(pem);
    } catch {
      // The underlying OpenSSL error is deliberately swallowed. It can include
      // fragments of the input, and this message reaches logs.
      throw new PrivateKeyError(
        "not a readable PEM private key (expected PKCS#1 or PKCS#8)",
      );
    }

    if (key.type !== "private") {
      throw new PrivateKeyError(
        `expected a private key, got a ${key.type} key`,
      );
    }

    // GitHub App JWTs must be RS256. An EC or Ed25519 key parses fine and then
    // fails at signing time with a confusing error, or — worse — signs with a
    // different algorithm that GitHub rejects on every request.
    if (key.asymmetricKeyType !== "rsa") {
      throw new PrivateKeyError(
        `expected an RSA key for RS256, got ${key.asymmetricKeyType ?? "an unknown type"}`,
      );
    }

    // 2048 is the floor for RSA signatures and what GitHub issues. A shorter
    // key would sign successfully and be weak, which is the worst combination.
    const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (modulusLength < 2048) {
      throw new PrivateKeyError(
        `RSA modulus is ${String(modulusLength)} bits; 2048 is the minimum`,
      );
    }

    return new GithubAppPrivateKey(key);
  }

  /**
   * The key, for signing.
   *
   * Deliberately a method rather than a property: a getter named `key` is
   * picked up by object spread and by loggers that walk enumerable properties,
   * while a method is not. Every call site is greppable.
   *
   * @internal Used by {@link AppJwtSigner}. Nothing else should need it.
   */
  public signingKey(): KeyObject {
    return this.#key;
  }

  /** Bits in the RSA modulus. Safe to log — it is not secret. */
  public get modulusBits(): number {
    return this.#key.asymmetricKeyDetails?.modulusLength ?? 0;
  }

  public toString(): string {
    return REDACTED;
  }

  /** `JSON.stringify(anything containing this)` yields the placeholder. */
  public toJSON(): string {
    return REDACTED;
  }

  /** `console.log`, `util.inspect`, and most structured loggers. */
  public [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }

  /** Template interpolation and implicit string coercion. */
  public [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}
