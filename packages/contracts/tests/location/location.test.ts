import { describe, expect, it } from "vitest";
import {
  containsLine,
  lineCount,
  lineRangeSchema,
  rangesOverlap,
} from "../../src/domain/location/line-range.js";
import {
  SYMBOL_KINDS,
  symbolIdentity,
  symbolReferenceSchema,
  symbolsEqual,
} from "../../src/domain/location/symbol-reference.js";
import {
  formatLocation,
  locationsEqual,
  sourceLocationSchema,
} from "../../src/domain/location/source-location.js";
import { RepositoryIdOps } from "../../src/domain/identity/ids.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";

const REPO = RepositoryIdOps.parse("0192f8a1-0000-7000-8000-000000000002");
const OTHER = RepositoryIdOps.parse("0192f8a1-0000-7000-8000-00000000000f");

describe("LineRange (P0.txt §22)", () => {
  it("accepts a single-line range", () => {
    expect(lineRangeSchema.parse({ start: 7, end: 7 })).toEqual({
      start: 7,
      end: 7,
    });
    expect(lineCount({ start: 7, end: 7 })).toBe(1);
  });

  it("accepts a multiline range", () => {
    expect(lineCount({ start: 10, end: 14 })).toBe(5);
  });

  it("rejects line 0 — lines are 1-based, and that is explicit", () => {
    const result = lineRangeSchema.safeParse({ start: 0, end: 5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("1-based");
    }
  });

  it("rejects a negative line", () => {
    expect(lineRangeSchema.safeParse({ start: -1, end: 5 }).success).toBe(
      false,
    );
  });

  it("rejects a fractional line", () => {
    expect(lineRangeSchema.safeParse({ start: 1.5, end: 5 }).success).toBe(
      false,
    );
  });

  it("rejects end < start", () => {
    const result = lineRangeSchema.safeParse({ start: 10, end: 4 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        "ends before it starts",
      );
      expect(result.error.issues[0]?.path).toEqual(["end"]);
    }
  });

  it("rejects unknown fields", () => {
    expect(
      lineRangeSchema.safeParse({ start: 1, end: 2, column: 3 }).success,
    ).toBe(false);
  });

  it("tests containment inclusively at both ends", () => {
    const range = { start: 10, end: 12 };
    expect(containsLine(range, 9)).toBe(false);
    expect(containsLine(range, 10)).toBe(true);
    expect(containsLine(range, 12)).toBe(true);
    expect(containsLine(range, 13)).toBe(false);
  });

  it("detects overlap, including touching at one line", () => {
    expect(rangesOverlap({ start: 1, end: 5 }, { start: 5, end: 9 })).toBe(
      true,
    );
    expect(rangesOverlap({ start: 1, end: 4 }, { start: 5, end: 9 })).toBe(
      false,
    );
    expect(rangesOverlap({ start: 5, end: 9 }, { start: 1, end: 5 })).toBe(
      true,
    );
  });
});

describe("SymbolReference (P0.txt §22, §28)", () => {
  it("requires only a name and a kind, so weak analyzers can use it", () => {
    // A regex-based linter knows a path and little else. Requiring rich
    // semantics would make the type unusable for the tools that produce the
    // most findings.
    const parsed = symbolReferenceSchema.parse({
      name: "verify",
      kind: "unknown",
    });
    expect(symbolIdentity(parsed)).toBe("verify");
  });

  it("prefers the most specific name available", () => {
    expect(
      symbolIdentity({
        name: "verify",
        kind: "method",
        qualifiedName: "auth.Session.verify",
        container: "Session",
      }),
    ).toBe("auth.Session.verify");

    expect(
      symbolIdentity({ name: "verify", kind: "method", container: "Session" }),
    ).toBe("Session.verify");

    expect(symbolIdentity({ name: "verify", kind: "method" })).toBe("verify");
  });

  it("identity never includes a line number", () => {
    const identity = symbolIdentity({
      name: "verify",
      kind: "method",
      qualifiedName: "auth.Session.verify",
      range: { start: 82, end: 96 },
    });
    expect(identity).toBe("auth.Session.verify");
    expect(identity).not.toContain("82");
  });

  it("treats a moved symbol as the same symbol", () => {
    // The property fingerprints depend on.
    const before = {
      name: "verify",
      kind: "method" as const,
      qualifiedName: "auth.Session.verify",
      range: { start: 10, end: 15 },
    };
    const after = { ...before, range: { start: 110, end: 115 } };
    expect(symbolsEqual(before, after)).toBe(true);
  });

  it("distinguishes symbols differing only in kind", () => {
    expect(
      symbolsEqual(
        { name: "verify", kind: "method" },
        { name: "verify", kind: "function" },
      ),
    ).toBe(false);
  });

  it("does not fold case", () => {
    // getUser and GetUser are different symbols in every language reviewed.
    expect(
      symbolsEqual(
        { name: "getUser", kind: "function" },
        { name: "GetUser", kind: "function" },
      ),
    ).toBe(false);
  });

  it("includes file as a legitimate anchor kind", () => {
    // File-scoped findings (a missing license header) are real, and forcing
    // them into 'unknown' would lose information.
    expect(SYMBOL_KINDS).toContain("file");
    expect(SYMBOL_KINDS).toContain("unknown");
    expect(new Set(SYMBOL_KINDS).size).toBe(SYMBOL_KINDS.length);
  });

  it("rejects an unknown symbol kind", () => {
    expect(
      symbolReferenceSchema.safeParse({ name: "x", kind: "macro" }).success,
    ).toBe(false);
  });
});

describe("SourceLocation (P0.txt §22, §64)", () => {
  const base = {
    repositoryId: REPO,
    path: repositoryPath("src/auth.ts"),
    side: "head" as const,
    lines: { start: 82, end: 84 },
  };

  it("parses a minimal location", () => {
    const parsed = sourceLocationSchema.parse(base);
    expect(parsed.path).toBe("src/auth.ts");
    expect(parsed.side).toBe("head");
  });

  it("uses repository-relative paths, never absolute ones (§64)", () => {
    // An absolute path could never be portable across the API, a worker, and a
    // sandbox — and is an escape vector once sandboxes exist.
    expect(
      sourceLocationSchema.safeParse({ ...base, path: "/etc/passwd" }).success,
    ).toBe(false);
    expect(
      sourceLocationSchema.safeParse({ ...base, path: "../../etc/passwd" })
        .success,
    ).toBe(false);
  });

  it("normalizes a './'-prefixed path from an adapter", () => {
    expect(
      sourceLocationSchema.parse({ ...base, path: "./src/auth.ts" }).path,
    ).toBe("src/auth.ts");
  });

  it("supports the base side, for findings about removed code", () => {
    // "This deletion drops the only bounds check" can only be anchored to
    // lines that no longer exist on head.
    expect(sourceLocationSchema.parse({ ...base, side: "base" }).side).toBe(
      "base",
    );
  });

  it("rejects an invalid side", () => {
    expect(
      sourceLocationSchema.safeParse({ ...base, side: "left" }).success,
    ).toBe(false);
  });

  it("rejects an invalid line range", () => {
    expect(
      sourceLocationSchema.safeParse({ ...base, lines: { start: 5, end: 1 } })
        .success,
    ).toBe(false);
  });

  it("carries an optional symbol anchor", () => {
    const parsed = sourceLocationSchema.parse({
      ...base,
      symbol: {
        name: "verify",
        kind: "method",
        qualifiedName: "auth.Session.verify",
      },
    });
    expect(parsed.symbol?.qualifiedName).toBe("auth.Session.verify");
  });

  it("accepts a commit as a typed object id, not a raw sha string", () => {
    const parsed = sourceLocationSchema.parse({
      ...base,
      commit: { algorithm: "sha1", value: "a".repeat(40) },
    });
    expect(parsed.commit?.algorithm).toBe("sha1");
    // Consistent with Checkpoint B, which eliminated bare sha strings.
    expect(
      sourceLocationSchema.safeParse({ ...base, commit: "a".repeat(40) })
        .success,
    ).toBe(false);
  });

  it("formats for display", () => {
    expect(formatLocation(sourceLocationSchema.parse(base))).toBe(
      "src/auth.ts:82-84",
    );
    expect(
      formatLocation(
        sourceLocationSchema.parse({ ...base, lines: { start: 82, end: 82 } }),
      ),
    ).toBe("src/auth.ts:82");
  });

  describe("equality is positional, not semantic", () => {
    it("matches identical positions", () => {
      expect(
        locationsEqual(
          sourceLocationSchema.parse(base),
          sourceLocationSchema.parse(base),
        ),
      ).toBe(true);
    });

    it("distinguishes different lines — which is why it is NOT used for identity", () => {
      // A moved finding is the same finding; that is the fingerprint's job,
      // not this function's.
      expect(
        locationsEqual(
          sourceLocationSchema.parse(base),
          sourceLocationSchema.parse({
            ...base,
            lines: { start: 97, end: 99 },
          }),
        ),
      ).toBe(false);
    });

    it("distinguishes repositories and sides", () => {
      expect(
        locationsEqual(
          sourceLocationSchema.parse(base),
          sourceLocationSchema.parse({ ...base, repositoryId: OTHER }),
        ),
      ).toBe(false);
      expect(
        locationsEqual(
          sourceLocationSchema.parse(base),
          sourceLocationSchema.parse({ ...base, side: "base" }),
        ),
      ).toBe(false);
    });
  });

  it("round-trips through JSON", () => {
    const parsed = sourceLocationSchema.parse({
      ...base,
      columns: { start: 5, end: 40 },
      commit: { algorithm: "sha1", value: "b".repeat(40) },
      symbol: { name: "verify", kind: "method" },
    });
    expect(
      sourceLocationSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });
});
