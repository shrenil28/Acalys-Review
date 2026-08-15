/**
 * The single canonical instant representation (P0.txt §6).
 *
 * One format, everywhere, in every contract:
 *
 *     2026-08-15T15:30:12.421Z
 *
 * RFC 3339, UTC, exactly three fractional digits, literal `Z`. Nothing else
 * validates — not `+02:00`, not a bare date, not a Unix epoch number, not
 * second precision.
 *
 * That strictness buys three things the platform depends on:
 *
 * 1. **Lexicographic order equals chronological order.** `revisions.sort()`
 *    is correct without parsing, and a Postgres `text` index behaves like a
 *    timestamp index.
 * 2. **Byte-stable hashes.** `2026-08-15T15:30:12Z` and
 *    `2026-08-15T15:30:12.000Z` are the same instant but different bytes, so
 *    allowing both would make config and fingerprint hashes non-deterministic
 *    (§58).
 * 3. **No ambiguity at rest.** Every persisted review-domain timestamp is UTC,
 *    so no reader has to know which zone wrote it.
 *
 * `Date` is deliberately *not* the boundary type. It is mutable, carries a
 * local-time interpretation, and has no place in a JSON contract (§52).
 * Convert at the edge with {@link timestampFromDate} / {@link toDate} and pass
 * `Timestamp` everywhere in between.
 */

import { z } from "zod";
import { unsafeBrand, type Brand } from "./brand.js";
import { ValidationError } from "../errors/errors.js";
import { quoteValue } from "./format.js";

/** An RFC 3339 UTC instant with millisecond precision. */
export type Timestamp = Brand<string, "Timestamp">;

/**
 * Shape gate. Deliberately rigid — the alternatives it rejects are all
 * *valid ISO 8601* but would break ordering or hash stability.
 */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Value gate. The pattern accepts `2026-02-30T00:00:00.000Z` — the right
 * shape, an impossible date. `Date` silently rolls it forward to March 2nd, so
 * round-tripping and comparing is what actually rejects it.
 */
function isRealInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function isTimestamp(value: unknown): value is Timestamp {
  return (
    typeof value === "string" &&
    TIMESTAMP_PATTERN.test(value) &&
    isRealInstant(value)
  );
}

/**
 * Validating factory — the only way to obtain a `Timestamp` from a string.
 *
 * @throws {ValidationError} when the value is not a real UTC instant in the
 *   canonical format
 */
export function timestamp(value: string): Timestamp {
  if (!TIMESTAMP_PATTERN.test(value)) {
    throw new ValidationError(
      `Expected an RFC 3339 UTC timestamp with millisecond precision (e.g. 2026-08-15T15:30:12.421Z), received ${quoteValue(value)}`,
      { details: { value } },
    );
  }
  if (!isRealInstant(value)) {
    throw new ValidationError(
      `Timestamp ${quoteValue(value)} is well-formed but not a real instant`,
      { details: { value } },
    );
  }
  return unsafeBrand<Timestamp>(value);
}

/**
 * Converts at the boundary — a provider payload's `Date`, a database column,
 * `new Date()` inside a `Clock` implementation.
 *
 * @throws {ValidationError} on an invalid `Date` (`new Date("nope")`), which
 *   would otherwise stringify to `"Invalid Date"` and poison whatever it
 *   touches
 */
export function timestampFromDate(date: Date): Timestamp {
  const time = date.getTime();
  if (Number.isNaN(time)) {
    throw new ValidationError("Cannot build a Timestamp from an invalid Date");
  }

  const iso = date.toISOString();

  // `toISOString` does *not* always emit a four-digit year. Outside
  // 0000-9999 it switches to ISO 8601's expanded form — year 10000 becomes
  // "+010000-01-01T00:00:00.000Z", and year -1 becomes "-000001-…". Those
  // strings break both the canonical format and, more seriously, the
  // lexicographic-ordering guarantee: "+010000-…" sorts *before* "2026-…"
  // because "+" is 0x2B and digits start at 0x30.
  //
  // Validating here rather than branding blindly is what keeps
  // `Timestamp` a type you can trust without re-checking.
  if (!TIMESTAMP_PATTERN.test(iso)) {
    throw new ValidationError(
      `Date is outside the representable range: ${iso} is not a four-digit-year UTC instant`,
      { details: { iso } },
    );
  }

  return unsafeBrand<Timestamp>(iso);
}

/** Earliest and latest instants that have a canonical representation. */
export const MIN_TIMESTAMP = "0000-01-01T00:00:00.000Z" as Timestamp;
export const MAX_TIMESTAMP = "9999-12-31T23:59:59.999Z" as Timestamp;

/**
 * Converts back to `Date` for arithmetic and comparison.
 *
 * Returns a fresh instance every call: `Date` is mutable, and handing out a
 * shared one invites action at a distance.
 */
export function toDate(value: Timestamp): Date {
  return new Date(value);
}

/** Milliseconds since the Unix epoch — for durations and metrics. */
export function toEpochMillis(value: Timestamp): number {
  return new Date(value).getTime();
}

/**
 * Chronological comparison, suitable for `Array.prototype.sort`.
 *
 * String comparison is correct here precisely because the format is fixed:
 * same length, fixed-width fields, UTC. That is the ordering property the
 * strict format was chosen for.
 */
export function compareTimestamps(left: Timestamp, right: Timestamp): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Runtime schema. Both gates apply, so a malformed instant is rejected at
 * every boundary — queue, API, database read — not only at construction.
 */
export const timestampSchema = z
  .string()
  .regex(TIMESTAMP_PATTERN, {
    error:
      "Expected an RFC 3339 UTC timestamp with millisecond precision, e.g. 2026-08-15T15:30:12.421Z",
  })
  .refine(isRealInstant, { error: "Not a real instant" })
  .transform((value) => unsafeBrand<Timestamp>(value));
