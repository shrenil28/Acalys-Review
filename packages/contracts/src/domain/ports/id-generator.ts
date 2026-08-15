/**
 * Identifier minting as an injected dependency (P0.txt §94).
 *
 * Same motivation as {@link Clock}: a domain service that calls a UUID
 * generator directly produces a different value on every run, so its output
 * cannot be asserted against a fixture or a golden file. Injecting the
 * generator makes id assignment deterministic under test while staying
 * genuinely random in production.
 */

import { unsafeBrand, type Brand } from "../primitives/brand.js";
import { ValidationError } from "../errors/errors.js";

export interface IdGenerator<TId> {
  /** A fresh identifier. Never returns the same value twice. */
  next(): TId;
}

/**
 * Wraps any `defineId` triple's `generate` into an {@link IdGenerator}.
 *
 * Usage: `const runIds = idGeneratorFor(ReviewRunIdOps);`
 */
export function idGeneratorFor<TId>(ops: {
  generate: () => TId;
}): IdGenerator<TId> {
  return { next: () => ops.generate() };
}

/**
 * Emits `00000000-0000-7000-8000-00000000000N` in sequence.
 *
 * Valid canonical UUID text, so it passes every id schema, while being
 * completely predictable: the first id a test observes is always `…0001`.
 * That is what lets a fixture assert on exact ids rather than shape alone.
 *
 * Not for production — 12 hex digits of counter is only ~2.8×10¹⁴ values and
 * carries no timestamp, so it loses both the collision safety and the
 * sortability that UUIDv7 provides.
 */
export class SequentialIdGenerator<
  TId extends Brand<string, string>,
> implements IdGenerator<TId> {
  #counter: number;

  constructor(start = 0) {
    this.#counter = start;
  }

  next(): TId {
    this.#counter += 1;
    if (this.#counter > 0xffff_ffff_ffff) {
      throw new ValidationError(
        "SequentialIdGenerator exhausted its 48-bit counter",
      );
    }
    const suffix = this.#counter.toString(16).padStart(12, "0");
    return unsafeBrand<TId>(`00000000-0000-7000-8000-${suffix}`);
  }

  /** Rewinds, so each test case can start from a known point. */
  reset(start = 0): void {
    this.#counter = start;
  }
}
