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

  /** Checks every configured generation, including expired verification-only values. */
  public hasEmptyString(): boolean {
    return (
      (typeof this.#active === "string" && this.#active.length === 0) ||
      this.#previous.some(
        (entry) => typeof entry.value === "string" && entry.value.length === 0,
      )
    );
  }

  public verificationCandidates(): readonly T[] {
    const at = this.#now().getTime();
    return [
      this.#active,
      ...this.#previous
        .filter(
          (entry) =>
            entry.validUntil === undefined || entry.validUntil.getTime() > at,
        )
        .map((entry) => entry.value),
    ];
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
