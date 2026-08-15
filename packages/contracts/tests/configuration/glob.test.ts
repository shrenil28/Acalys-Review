import { describe, expect, it } from "vitest";
import {
  GlobSyntaxError,
  MAX_GLOB_EXPANSIONS,
  compileGlobPattern,
  expandBraces,
  globPatternSchema,
  globSpecificity,
  isValidGlob,
  matchesGlob,
} from "../../src/domain/configuration/glob.js";

describe("Glob dialect (P0.txt §40)", () => {
  describe("* stays inside one segment", () => {
    /**
     * The single most consequential rule in the dialect. If `*` crossed a
     * slash, `src/*.ts` would match every TypeScript file in the repository
     * and a rule meant for one directory would govern all of them.
     */
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["src/*.ts", "src/auth.ts", true],
      ["src/*.ts", "src/nested/auth.ts", false],
      ["*.ts", "auth.ts", true],
      ["*.ts", "src/auth.ts", false],
      ["src/*/auth.ts", "src/a/auth.ts", true],
      ["src/*/auth.ts", "src/a/b/auth.ts", false],
      ["src/*", "src/a", true],
      ["src/*", "src/a/b", false],
    ];

    it.each(cases)("%s vs %s -> %s", (pattern, path, expected) => {
      expect(matchesGlob(pattern, path)).toBe(expected);
    });
  });

  describe("** spans whole segments, including none", () => {
    /**
     * "Including none" is the row every hand-rolled matcher gets wrong.
     * `src/**\/*.ts` must match `src/a.ts`, or every author writing the
     * idiomatic recursive pattern silently loses the top-level files.
     */
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["**/*.ts", "auth.ts", true],
      ["**/*.ts", "src/auth.ts", true],
      ["**/*.ts", "src/a/b/auth.ts", true],
      ["**/*.ts", "src/auth.js", false],
      ["src/**/*.ts", "src/auth.ts", true],
      ["src/**/*.ts", "src/a/b/auth.ts", true],
      ["src/**/*.ts", "lib/auth.ts", false],
      ["src/**", "src/a", true],
      ["src/**", "src/a/b/c", true],
      ["src/**", "src", false],
      ["**", "anything/at/all.ts", true],
    ];

    it.each(cases)("%s vs %s -> %s", (pattern, path, expected) => {
      expect(matchesGlob(pattern, path)).toBe(expected);
    });
  });

  it("? matches exactly one character and never a separator", () => {
    expect(matchesGlob("src/a?.ts", "src/ab.ts")).toBe(true);
    expect(matchesGlob("src/a?.ts", "src/a.ts")).toBe(false);
    expect(matchesGlob("src/a?.ts", "src/abc.ts")).toBe(false);
    expect(matchesGlob("src?auth.ts", "src/auth.ts")).toBe(false);
  });

  it("matches case-sensitively, because Git paths are", () => {
    expect(matchesGlob("src/Auth.ts", "src/Auth.ts")).toBe(true);
    expect(matchesGlob("src/Auth.ts", "src/auth.ts")).toBe(false);
  });

  it("treats regex metacharacters in a pattern as literals", () => {
    // Without escaping, `a.ts` would match `axts` and `src/(x)` would be a
    // capture group — a rule matching files nobody named.
    expect(matchesGlob("src/a.ts", "src/axts")).toBe(false);
    expect(matchesGlob("src/a+b.ts", "src/a+b.ts")).toBe(true);
    expect(matchesGlob("src/a+b.ts", "src/aab.ts")).toBe(false);
    expect(matchesGlob("src/(x).ts", "src/(x).ts")).toBe(true);
    expect(matchesGlob("src/a|b.ts", "src/a.ts")).toBe(false);
    expect(matchesGlob("src/x$.ts", "src/x$.ts")).toBe(true);
  });

  it("anchors both ends", () => {
    // An unanchored pattern is a substring search: `auth.ts` would match
    // `src/not-auth.ts.bak`.
    expect(matchesGlob("auth.ts", "src/auth.ts")).toBe(false);
    expect(matchesGlob("auth.ts", "auth.ts.bak")).toBe(false);
  });

  describe("brace alternation", () => {
    it("expands to one pattern per alternative", () => {
      expect(expandBraces("src/*.{ts,tsx}")).toEqual(["src/*.ts", "src/*.tsx"]);
    });

    it("expands nested and multiple groups", () => {
      expect(expandBraces("{a,b}/{c,d}.ts")).toEqual([
        "a/c.ts",
        "a/d.ts",
        "b/c.ts",
        "b/d.ts",
      ]);
    });

    it("matches any alternative", () => {
      expect(matchesGlob("src/*.{ts,tsx}", "src/a.tsx")).toBe(true);
      expect(matchesGlob("src/*.{ts,tsx}", "src/a.js")).toBe(false);
    });

    it("caps expansion, because braces multiply", () => {
      // Six binary groups is 64; seven is 128 and must be refused. An
      // unbounded expansion is a denial of service in eight characters.
      const six = `${"{a,b}".repeat(6)}.ts`;
      expect(expandBraces(six)).toHaveLength(MAX_GLOB_EXPANSIONS);

      const seven = `${"{a,b}".repeat(7)}.ts`;
      expect(() => expandBraces(seven)).toThrow(GlobSyntaxError);
    });
  });

  describe("unsupported syntax is rejected, never approximated", () => {
    /**
     * Every one of these means something in some other glob dialect. Accepting
     * them with *this* dialect's semantics would apply the wrong review rules
     * to the wrong files and report nothing — which is why they throw.
     */
    const rejected: readonly (readonly [string, string])[] = [
      ["src/[abc].ts", "character class"],
      ["!src/a.ts", "negation"],
      ["src/a\\*.ts", "escape"],
      ["src/**test/a.ts", "'**' that is not a whole segment"],
      ["src/te**st.ts", "'**' inside a segment"],
      ["/src/a.ts", "absolute"],
      ["src//a.ts", "empty segment"],
      ["src/", "trailing slash"],
      ["", "empty pattern"],
      ["./src/a.ts", "'.' segment"],
      ["../src/a.ts", "'..' segment"],
      ["src\\a.ts", "backslash separator"],
      ["src/{a}.ts", "single-alternative brace"],
      ["src/{a,b.ts", "unbalanced '{'"],
      ["src/a,b}.ts", "unbalanced '}'"],
      ["src/**/**/a.ts", "redundant '**/**'"],
      ["src/a\u0000.ts", "NUL byte"],
    ];

    it.each(rejected)("rejects %s (%s)", (pattern) => {
      expect(() => compileGlobPattern(pattern)).toThrow(GlobSyntaxError);
      expect(isValidGlob(pattern)).toBe(false);
      expect(globPatternSchema.safeParse(pattern).success).toBe(false);
    });

    it("names the syntax in the error, so an author can fix it", () => {
      expect(() => compileGlobPattern("src/[abc].ts")).toThrow(
        /character classes are not supported/,
      );
      expect(() => compileGlobPattern("!src/a.ts")).toThrow(
        /negation is not supported/,
      );
    });
  });

  describe("specificity", () => {
    it("counts literal segments", () => {
      expect(globSpecificity("src/auth/session.ts")).toBe(3);
      expect(globSpecificity("src/auth/*.ts")).toBe(2);
      expect(globSpecificity("src/**/*.ts")).toBe(1);
      expect(globSpecificity("**")).toBe(0);
    });

    it("beats a longer but vaguer pattern", () => {
      // The reason specificity is not string length: the braced pattern is
      // three times longer and names nothing.
      expect(globSpecificity("src/a.ts")).toBeGreaterThan(
        globSpecificity("**/{a,b,c,d,e,f}.ts"),
      );
    });

    it("scores a braced pattern by its weakest alternative", () => {
      // Any alternative may be the one that matched, so the score must not
      // claim more precision than the match guarantees.
      expect(globSpecificity("{src/a.ts,**}")).toBe(0);
    });
  });

  it("compiles deterministically: the same pattern always matches the same set", () => {
    const paths = ["src/a.ts", "src/a/b.ts", "lib/a.ts", "a.ts"];
    const first = paths.map((path) => matchesGlob("src/**/*.ts", path));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(paths.map((path) => matchesGlob("src/**/*.ts", path))).toEqual(
        first,
      );
    }
  });

  it("matches long adversarial input without backtracking", () => {
    // `(?:[^/]+/)*` cannot backtrack across a separator, so a deep path that
    // fails to match still returns immediately rather than hanging the worker.
    const deep = `${"a/".repeat(2_000)}b.js`;
    const started = Date.now();
    expect(matchesGlob("**/*.ts", deep)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
