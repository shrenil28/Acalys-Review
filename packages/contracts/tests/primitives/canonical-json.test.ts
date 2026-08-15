import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalJson } from "../../src/domain/primitives/canonical-json.js";
import { ValidationError } from "../../src/domain/errors/errors.js";
import type { JsonValue } from "../../src/domain/primitives/json.js";

/**
 * Determinism is the whole contract (P0.txt §58). Fingerprints, config
 * snapshot hashes, and artifact checksums are all only as stable as these
 * bytes.
 */
describe("canonicalJson (P0.txt §58)", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = { zebra: 1, alpha: 2, middle: 3 };
    const b = { middle: 3, zebra: 1, alpha: 2 };
    const c = { alpha: 2, middle: 3, zebra: 1 };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(b)).toBe(canonicalJson(c));
    expect(canonicalJson(a)).toBe('{"alpha":2,"middle":3,"zebra":1}');
  });

  it("is where JSON.stringify would have failed us", () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    // The bug this module exists to prevent:
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("sorts nested keys at every depth", () => {
    const value = { outer: { z: 1, a: { y: 2, b: 3 } } };
    expect(canonicalJson(value)).toBe('{"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  it("preserves array order, because order is semantically meaningful (§123)", () => {
    // evidence[] and paths[] depend on this: sorting them would destroy
    // provenance sequence and path-instruction precedence.
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("handles the primitive cases", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });

  it("escapes strings and keys correctly", () => {
    expect(canonicalJson({ 'a"b': "c\nd" })).toBe('{"a\\"b":"c\\nd"}');
    expect(canonicalJson("日本語")).toBe('"日本語"');
  });

  it("omits object keys whose value is undefined, matching the §57 rule", () => {
    // `.optional()` fields are absent, not null. An absent key and an
    // explicitly-undefined key must hash the same.
    const withUndefined = { a: 1, b: undefined } as unknown as JsonValue;
    expect(canonicalJson(withUndefined)).toBe('{"a":1}');
    expect(canonicalJson(withUndefined)).toBe(canonicalJson({ a: 1 }));
  });

  describe("rejects values with no deterministic form", () => {
    it("undefined inside an array, where omission would shift indices", () => {
      const value = [1, undefined, 3] as unknown as JsonValue;
      expect(() => canonicalJson(value)).toThrow(ValidationError);
      expect(() => canonicalJson(value)).toThrow(/\$\[1\] is undefined/);
    });

    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ])("%s, which JSON.stringify would silently turn into null", (_l, n) => {
      expect(() => canonicalJson(n as unknown as JsonValue)).toThrow(
        ValidationError,
      );
    });

    it("bigint", () => {
      expect(() => canonicalJson(1n as unknown as JsonValue)).toThrow(/bigint/);
    });

    it.each([
      ["function", () => "x"],
      ["symbol", Symbol("x")],
    ])("%s — transport contracts carry data only (§63)", (_l, v) => {
      expect(() => canonicalJson({ v } as unknown as JsonValue)).toThrow(
        ValidationError,
      );
    });

    it("Date, because timestamps cross boundaries as strings (§6)", () => {
      const value = { at: new Date() } as unknown as JsonValue;
      expect(() => canonicalJson(value)).toThrow(/is a Date/);
    });

    it("circular references", () => {
      const cyclic: Record<string, unknown> = { name: "root" };
      cyclic.self = cyclic;
      expect(() => canonicalJson(cyclic as JsonValue)).toThrow(
        /Circular reference/,
      );
    });

    it("names the failing path, not just 'invalid' (§96)", () => {
      const value = { outer: { inner: [1, Number.NaN] } };
      expect(() => canonicalJson(value)).toThrow(/\$\.outer\.inner\[1\]/);
    });
  });

  it("allows the same object to appear twice without being circular", () => {
    // A shared reference is a DAG, not a cycle — the seen-set must be scoped
    // to the current descent, not the whole traversal.
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe(
      '{"x":{"a":1},"y":{"a":1}}',
    );
  });

  describe("property-based (§84)", () => {
    const jsonArb = fc.letrec<{ value: JsonValue }>((tie) => ({
      value: fc.oneof(
        { maxDepth: 4 },
        fc.constant(null),
        fc.boolean(),
        fc.integer(),
        fc.string(),
        fc.array(tie("value"), { maxLength: 5 }),
        fc.dictionary(fc.string(), tie("value"), { maxKeys: 5 }),
      ),
    })).value;

    it("output always re-parses to a value that canonicalizes identically", () => {
      fc.assert(
        fc.property(jsonArb, (value) => {
          const first = canonicalJson(value);
          const second = canonicalJson(JSON.parse(first) as JsonValue);
          return first === second;
        }),
        { numRuns: 1_000 },
      );
    });

    it("is stable across 100 repeated calls", () => {
      fc.assert(
        fc.property(jsonArb, (value) => {
          const expected = canonicalJson(value);
          for (let index = 0; index < 100; index += 1) {
            if (canonicalJson(value) !== expected) return false;
          }
          return true;
        }),
        { numRuns: 100 },
      );
    });
  });
});
