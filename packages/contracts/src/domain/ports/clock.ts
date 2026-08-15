/**
 * Time as an injected dependency (P0.txt §93).
 *
 * Domain logic that calls `new Date()` directly cannot be tested without
 * either mocking a global or tolerating flaky assertions. Several Phase 0+
 * behaviours are time-dependent — revision ordering, run duration, artifact
 * expiry, token freshness — and every one of them should be exercised at a
 * known instant.
 *
 * `Clock` is a one-method port. `SystemClock` in production, `FixedClock` in
 * tests, and the code under test cannot tell the difference.
 */

import { timestampFromDate, type Timestamp } from "../primitives/timestamp.js";

export interface Clock {
  /** The current instant in canonical form (§6). */
  now(): Timestamp;
}

/** Reads the host clock. The production implementation. */
export class SystemClock implements Clock {
  now(): Timestamp {
    return timestampFromDate(new Date());
  }
}

/**
 * A clock that reports whatever instant you set.
 *
 * Lives in the production package rather than a test helper because ports and
 * their test doubles belong together — a consumer testing against `Clock`
 * should not have to build its own fake, and every fake built independently
 * drifts.
 */
export class FixedClock implements Clock {
  #current: Timestamp;

  constructor(current: Timestamp) {
    this.#current = current;
  }

  now(): Timestamp {
    return this.#current;
  }

  /** Jumps to an explicit instant. */
  set(next: Timestamp): void {
    this.#current = next;
  }

  /**
   * Moves forward by a duration, for testing timeouts and elapsed-time logic.
   *
   * @param milliseconds - may be negative, to test clock skew between hosts
   */
  advance(milliseconds: number): Timestamp {
    this.#current = timestampFromDate(
      new Date(new Date(this.#current).getTime() + milliseconds),
    );
    return this.#current;
  }
}

/** Shared instance; `Clock` is stateless, so one is enough. */
export const systemClock: Clock = new SystemClock();
