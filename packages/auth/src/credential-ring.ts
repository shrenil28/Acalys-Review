import { inspect } from "node:util";

export interface CredentialVersion<T> {
  readonly value: T;
  readonly validUntil?: Date | undefined;
}

/**
 * Rotation primitive shared by secrets and private keys.
 *
 * Callers always use `active` for new signatures/tokens. Verification may try
 * previous material only until its explicit grace deadline. Credential values
 * live in ECMAScript private fields so normal object inspection cannot reveal
 * them accidentally.
 */
export class CredentialRing<T> {
  readonly #active: T;
  readonly #previous: readonly CredentialVersion<T>[];
  readonly #now: () => Date;

  public constructor(
    active: T,
    previous: readonly CredentialVersion<T>[] = [],
    now: () => Date = () => new Date(),
  ) {
    this.#active = active;
    this.#previous = previous;
    this.#now = now;
  }

  public get active(): T {
    return this.#active;
  }

  public verificationCandidates(): readonly T[] {
    const at = this.#now().getTime();
    return [
      this.#active,
      ...this.#previous
        .filter((entry) => entry.validUntil === undefined || entry.validUntil.getTime() > at)
        .map((entry) => entry.value),
    ];
  }

  /**
   * Every configured value, live or expired.
   *
   * Configuration validation asks this rather than `verificationCandidates`:
   * whether a secret is well-formed does not depend on what time it is, and a
   * ring holding an empty value is misconfigured even while that value sits
   * outside its grace window.
   */
  public configuredValues(): readonly T[] {
    return [this.#active, ...this.#previous.map((entry) => entry.value)];
  }

  public toString(): string {
    return "[REDACTED credential ring]";
  }

  public toJSON(): string {
    return "[REDACTED credential ring]";
  }

  public [inspect.custom](): string {
    return "[REDACTED credential ring]";
  }
}
