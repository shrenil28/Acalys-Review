import { describe, expect, it } from "vitest";
import {
  checksumSchema,
  checksumsEqual,
  formatChecksum,
} from "../../src/domain/primitives/checksum.js";
import {
  isNamespacedId,
  namespaceOf,
  namespacedId,
  namespacedIdSchema,
} from "../../src/domain/primitives/namespaced-id.js";
import { assertNever } from "../../src/domain/primitives/assert-never.js";
import {
  isJsonValue,
  jsonValueSchema,
} from "../../src/domain/primitives/json.js";
import {
  InternalError,
  ValidationError,
} from "../../src/domain/errors/errors.js";
import { FixedClock, SystemClock } from "../../src/domain/ports/clock.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";

describe("Checksum (P0.txt §46)", () => {
  const SHA256 =
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

  it("accepts a correctly sized digest and lowercases it", () => {
    expect(
      checksumSchema.parse({
        algorithm: "sha256",
        value: SHA256.toUpperCase(),
      }),
    ).toEqual({ algorithm: "sha256", value: SHA256 });
  });

  it("rejects a digest length that contradicts the algorithm", () => {
    expect(
      checksumSchema.safeParse({ algorithm: "sha512", value: SHA256 }).success,
    ).toBe(false);
  });

  it("rejects sha1 — it is a Git object format, not an integrity claim", () => {
    expect(
      checksumSchema.safeParse({ algorithm: "sha1", value: "a".repeat(40) })
        .success,
    ).toBe(false);
  });

  it("equality requires the algorithm to match too", () => {
    expect(
      checksumsEqual(
        { algorithm: "sha256", value: SHA256 },
        { algorithm: "sha256", value: SHA256 },
      ),
    ).toBe(true);
    expect(
      checksumsEqual(
        { algorithm: "sha256", value: SHA256 },
        { algorithm: "sha512", value: SHA256 },
      ),
    ).toBe(false);
  });

  it("formats compactly", () => {
    expect(formatChecksum({ algorithm: "sha256", value: SHA256 })).toBe(
      `sha256:${SHA256}`,
    );
  });
});

describe("NamespacedId (P0.txt §79, §80)", () => {
  it.each([
    "semgrep",
    "tool.semgrep",
    "acalys.compiler.typescript",
    "github.check.codeql",
    "org.acme.check.no-direct-sql",
    "a1.b2-c3",
  ])("accepts %s", (value) => {
    expect(namespacedId(value)).toBe(value);
    expect(isNamespacedId(value)).toBe(true);
  });

  it.each([
    ["uppercase — equality must be a plain === (§58)", "Tool.Semgrep"],
    ["leading dot", ".tool"],
    ["trailing dot", "tool."],
    ["double dot", "tool..semgrep"],
    ["leading dash", "-tool"],
    ["underscore", "tool_semgrep"],
    ["space", "tool semgrep"],
    ["slash", "tool/semgrep"],
    ["empty", ""],
    ["unicode", "tool.セムグレップ"],
  ])("rejects %s: %s", (_label, value) => {
    expect(() => namespacedId(value)).toThrow(ValidationError);
    expect(isNamespacedId(value)).toBe(false);
  });

  it("rejects an over-long identifier", () => {
    expect(() => namespacedId("a".repeat(129))).toThrow(/exceeds 128/);
  });

  it("extracts the owning namespace, for trust decisions", () => {
    expect(namespaceOf(namespacedId("org.acme.check.no-direct-sql"))).toBe(
      "org",
    );
    expect(namespaceOf(namespacedId("acalys.compiler.typescript"))).toBe(
      "acalys",
    );
    expect(namespaceOf(namespacedId("semgrep"))).toBe("semgrep");
  });

  it("schema round-trips", () => {
    expect(namespacedIdSchema.parse("tool.semgrep")).toBe("tool.semgrep");
    expect(namespacedIdSchema.safeParse("Tool.Semgrep").success).toBe(false);
  });
});

describe("JsonValue (P0.txt §52)", () => {
  it("accepts serializable structures", () => {
    expect(isJsonValue({ a: [1, "two", true, null, { b: {} }] })).toBe(true);
  });

  it.each([
    ["NaN, which stringify turns into null", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a bigint", 1n],
  ])("rejects %s", (_label, value) => {
    expect(isJsonValue(value)).toBe(false);
  });

  it("rejects __proto__ keys (§63 prototype pollution)", () => {
    // JSON.parse is the realistic entry point: it creates a real own property
    // named __proto__ rather than invoking the setter.
    const hostile: unknown = JSON.parse('{"__proto__": {"admin": true}}');
    expect(isJsonValue(hostile)).toBe(false);
    expect(jsonValueSchema.safeParse(hostile).success).toBe(false);
  });

  it("accepts a Date only after it has been serialized", () => {
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Date().toISOString())).toBe(true);
  });
});

describe("assertNever (P0.txt §85)", () => {
  it("throws with the discriminant when reached at runtime", () => {
    const rogue = { kind: "quantum_review" } as never;
    expect(() => assertNever(rogue)).toThrow(InternalError);
    expect(() => assertNever(rogue)).toThrow(/kind=quantum_review/);
  });

  it("includes the caller's context label", () => {
    const rogue = { type: "unknown_evidence" } as never;
    expect(() => assertNever(rogue, "evidenceSource")).toThrow(
      /Unhandled union variant in evidenceSource: type=unknown_evidence/,
    );
  });

  it("handles a primitive variant", () => {
    expect(() => assertNever("stray" as never)).toThrow(/stray/);
  });

  it("does not splice an unknown object wholesale into the message", () => {
    const rogue = { secret: "sk-live-abc" } as never;
    expect(() => assertNever(rogue)).toThrow(/<unknown variant>/);
    try {
      assertNever(rogue);
    } catch (error) {
      expect((error as InternalError).message).not.toContain("sk-live-abc");
    }
  });
});

describe("Clock (P0.txt §93)", () => {
  it("SystemClock returns a valid canonical timestamp", () => {
    const now = new SystemClock().now();
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("FixedClock is stable, which is what makes tests deterministic", () => {
    const clock = new FixedClock(timestamp("2026-08-15T15:30:12.421Z"));
    expect(clock.now()).toBe("2026-08-15T15:30:12.421Z");
    expect(clock.now()).toBe(clock.now());
  });

  it("FixedClock advances and rewinds", () => {
    const clock = new FixedClock(timestamp("2026-08-15T15:30:12.421Z"));
    expect(clock.advance(1_000)).toBe("2026-08-15T15:30:13.421Z");
    // Negative advance models clock skew between hosts.
    expect(clock.advance(-2_000)).toBe("2026-08-15T15:30:11.421Z");
    clock.set(timestamp("2030-01-01T00:00:00.000Z"));
    expect(clock.now()).toBe("2030-01-01T00:00:00.000Z");
  });
});
