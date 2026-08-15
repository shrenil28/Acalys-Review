import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  compareTimestamps,
  isTimestamp,
  timestamp,
  timestampFromDate,
  timestampSchema,
  toDate,
  toEpochMillis,
} from "../../src/domain/primitives/timestamp.js";
import { ValidationError } from "../../src/domain/errors/errors.js";

describe("Timestamp (P0.txt §6)", () => {
  const VALID = "2026-08-15T15:30:12.421Z";

  it("accepts the canonical form", () => {
    expect(timestamp(VALID)).toBe(VALID);
    expect(isTimestamp(VALID)).toBe(true);
  });

  describe("rejects other valid ISO 8601 forms", () => {
    // Every one of these is a legitimate ISO 8601 instant. They are refused
    // because allowing two spellings of the same instant would break byte
    // stability for hashes (§58) and lexicographic ordering.
    it.each([
      ["no milliseconds", "2026-08-15T15:30:12Z"],
      ["microseconds", "2026-08-15T15:30:12.421000Z"],
      ["positive offset", "2026-08-15T17:30:12.421+02:00"],
      ["negative offset", "2026-08-15T13:30:12.421-02:00"],
      ["no timezone", "2026-08-15T15:30:12.421"],
      ["lowercase z", "2026-08-15T15:30:12.421z"],
      ["space separator", "2026-08-15 15:30:12.421Z"],
      ["date only", "2026-08-15"],
      ["epoch millis as string", "1786000212421"],
    ])("%s: %s", (_label, input) => {
      expect(() => timestamp(input)).toThrow(ValidationError);
      expect(isTimestamp(input)).toBe(false);
    });
  });

  describe("rejects well-formed but impossible instants", () => {
    // These pass the regex — the shape is right — and are caught only by the
    // Date round-trip. Without it, `new Date()` would silently roll them
    // forward: 2026-02-30 becomes 2026-03-02.
    it.each([
      ["February 30th", "2026-02-30T00:00:00.000Z"],
      ["month 13", "2026-13-01T00:00:00.000Z"],
      ["day 32", "2026-01-32T00:00:00.000Z"],
      ["hour 25", "2026-01-01T25:00:00.000Z"],
      ["minute 60", "2026-01-01T00:60:00.000Z"],
      ["Feb 29 in a non-leap year", "2027-02-29T00:00:00.000Z"],
    ])("%s: %s", (_label, input) => {
      expect(() => timestamp(input)).toThrow(ValidationError);
      expect(isTimestamp(input)).toBe(false);
    });

    it("accepts Feb 29 in a leap year", () => {
      expect(timestamp("2028-02-29T00:00:00.000Z")).toBeTruthy();
    });

    it("distinguishes a shape failure from a value failure", () => {
      expect(() => timestamp("nope")).toThrow(/Expected an RFC 3339/);
      expect(() => timestamp("2026-02-30T00:00:00.000Z")).toThrow(
        /well-formed but not a real instant/,
      );
    });
  });

  describe("Date conversion at the boundary", () => {
    it("round-trips", () => {
      const date = new Date(VALID);
      expect(timestampFromDate(date)).toBe(VALID);
      expect(toDate(timestamp(VALID)).toISOString()).toBe(VALID);
    });

    it("rejects an invalid Date rather than producing 'Invalid Date'", () => {
      expect(() => timestampFromDate(new Date("nope"))).toThrow(
        ValidationError,
      );
    });

    it("returns a fresh Date each call, since Date is mutable", () => {
      const value = timestamp(VALID);
      const first = toDate(value);
      first.setFullYear(1999);
      expect(toDate(value).getUTCFullYear()).toBe(2026);
    });

    it("converts to epoch millis", () => {
      expect(toEpochMillis(timestamp("1970-01-01T00:00:00.000Z"))).toBe(0);
    });
  });

  it("orders lexicographically, which is why the format is fixed-width", () => {
    const unsorted = [
      timestamp("2026-08-15T15:30:12.421Z"),
      timestamp("2024-01-01T00:00:00.000Z"),
      timestamp("2026-08-15T15:30:12.422Z"),
      timestamp("2025-12-31T23:59:59.999Z"),
    ];

    // Plain string sort must agree with chronological sort.
    const byString = [...unsorted].sort();
    const byCompare = [...unsorted].sort(compareTimestamps);
    const byInstant = [...unsorted].sort(
      (a, b) => toEpochMillis(a) - toEpochMillis(b),
    );

    expect(byString).toEqual(byInstant);
    expect(byCompare).toEqual(byInstant);
  });

  it("schema parses valid and rejects invalid", () => {
    expect(timestampSchema.parse(VALID)).toBe(VALID);
    expect(timestampSchema.safeParse("2026-08-15T15:30:12Z").success).toBe(
      false,
    );
    expect(timestampSchema.safeParse("2026-02-30T00:00:00.000Z").success).toBe(
      false,
    );
  });

  describe("property-based (§84)", () => {
    it("any representable Date round-trips through timestampFromDate", () => {
      fc.assert(
        fc.property(
          fc.date({
            min: new Date("1970-01-01T00:00:00.000Z"),
            max: new Date("2200-01-01T00:00:00.000Z"),
            noInvalidDate: true,
          }),
          (date) => {
            const value = timestampFromDate(date);
            return (
              isTimestamp(value) && toEpochMillis(value) === date.getTime()
            );
          },
        ),
        { numRuns: 1_000 },
      );
    });

    it("string order and chronological order never disagree", () => {
      // Bounded to four-digit years on purpose. Outside 0000-9999,
      // `toISOString` emits ISO 8601's expanded form ("+010000-…"), whose
      // leading "+" (0x2B) sorts before any digit and would invert the
      // ordering. `timestampFromDate` rejects those instants outright — the
      // case below asserts that — so they can never enter the domain and the
      // property holds for every value that can.
      const representable = fc.date({
        min: new Date("0001-01-01T00:00:00.000Z"),
        max: new Date("9999-12-31T23:59:59.999Z"),
        noInvalidDate: true,
      });

      fc.assert(
        fc.property(representable, representable, (left, right) => {
          const a = timestampFromDate(left);
          const b = timestampFromDate(right);
          const stringOrder = Math.sign(a < b ? -1 : a > b ? 1 : 0);
          const instantOrder = Math.sign(left.getTime() - right.getTime());
          return stringOrder === instantOrder;
        }),
        { numRuns: 1_000 },
      );
    });

    it("rejects instants outside the four-digit-year range", () => {
      // Found by the ordering property above: `toISOString` silently switches
      // to expanded-year form, which is neither canonical nor sortable.
      expect(() =>
        timestampFromDate(new Date("+010000-01-01T00:00:00.000Z")),
      ).toThrow(/outside the representable range/);

      expect(() => timestampFromDate(new Date(Date.UTC(-1, 0, 1)))).toThrow(
        /outside the representable range/,
      );
    });
  });
});
