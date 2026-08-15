import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isRepositoryPath,
  pathBasename,
  pathDepth,
  pathDirname,
  pathExtension,
  repositoryPath,
  repositoryPathSchema,
} from "../../src/domain/primitives/repository-path.js";
import { ValidationError } from "../../src/domain/errors/errors.js";

/**
 * The security-critical primitive (P0.txt §63, §64). A path that escapes the
 * repository root becomes arbitrary filesystem access once sandbox workers
 * exist, so the negative cases here matter more than the positive ones.
 */
describe("repositoryPath (P0.txt §64)", () => {
  describe("accepts canonical relative paths", () => {
    it.each([
      "src/auth/session.ts",
      "README.md",
      "a",
      "deeply/nested/directory/tree/file.tsx",
      ".github/workflows/ci.yml",
      "src/components/Button.test.tsx",
      "packages/contracts/src/index.ts",
      "docs/design-notes.v2.md",
      "src/i18n/ja/メッセージ.json",
      "path with spaces/file name.txt",
    ])("%s", (input) => {
      expect(repositoryPath(input)).toBe(input);
    });
  });

  describe("rejects traversal", () => {
    it.each([
      ["parent escape", "../etc/passwd"],
      ["deep escape", "../../../../etc/passwd"],
      ["escape after a legitimate prefix", "src/../../etc/passwd"],
      ["escape in the middle", "src/lib/../../../etc/passwd"],
      ["bare parent", ".."],
      ["trailing parent", "src/.."],
    ])("%s: %s", (_label, input) => {
      expect(() => repositoryPath(input)).toThrow(ValidationError);
      expect(() => repositoryPath(input)).toThrow(/traversal|'\.\.' segment/);
    });
  });

  describe("rejects absolute and drive-qualified paths", () => {
    it.each([
      ["posix absolute", "/etc/passwd"],
      ["root", "/"],
      ["windows drive", "C:/Windows/System32/config/SAM"],
      ["windows drive lowercase", "c:/windows"],
    ])("%s: %s", (_label, input) => {
      expect(() => repositoryPath(input)).toThrow(ValidationError);
    });
  });

  describe("rejects separator and encoding tricks", () => {
    it.each([
      ["backslash separator", "src\\auth\\session.ts"],
      ["mixed separators", "src/auth\\..\\..\\etc"],
      ["percent-encoded dots", "src/%2e%2e/etc/passwd"],
      ["percent-encoded slash", "src%2fauth"],
      ["percent-encoded backslash", "src%5cauth"],
      ["uppercase encoding", "src/%2E%2E/etc"],
    ])("%s: %s", (_label, input) => {
      expect(() => repositoryPath(input)).toThrow(ValidationError);
    });
  });

  describe("rejects control characters", () => {
    it("NUL byte, which truncates the string in any C-based syscall", () => {
      expect(() => repositoryPath("src/ok.ts\u0000/../../etc/passwd")).toThrow(
        /control characters or a NUL byte/,
      );
    });

    it.each([
      ["newline", "src/a\nb.ts"],
      ["carriage return", "src/a\rb.ts"],
      ["tab", "src/a\tb.ts"],
      ["DEL", "src/a\u007Fb.ts"],
    ])("%s", (_label, input) => {
      expect(() => repositoryPath(input)).toThrow(ValidationError);
    });
  });

  describe("rejects malformed shapes", () => {
    it.each([
      ["empty", ""],
      ["trailing slash", "src/auth/"],
      ["empty segment", "src//auth.ts"],
      ["dot segment", "src/./auth.ts"],
      ["leading slash", "/src/auth.ts"],
      ["repository root after normalization", "./"],
    ])("%s: %s", (_label, input) => {
      expect(() => repositoryPath(input)).toThrow(ValidationError);
    });

    it("a path longer than the limit", () => {
      expect(() => repositoryPath(`${"a/".repeat(600)}f.ts`)).toThrow(
        /exceeds 1024 characters/,
      );
    });
  });

  it("normalizes exactly one leading './' and nothing else", () => {
    // Providers and tools commonly emit "./src/x". Accepting it is a
    // convenience; repairing anything further would let two distinct inputs
    // collapse to one path, and paths feed fingerprints (§28, §58).
    expect(repositoryPath("./src/auth.ts")).toBe("src/auth.ts");
    expect(() => repositoryPath("././src/auth.ts")).toThrow(ValidationError);
  });

  it("isRepositoryPath demands already-canonical form", () => {
    expect(isRepositoryPath("src/auth.ts")).toBe(true);
    // Accepted by the factory (it normalizes), but not itself canonical.
    expect(isRepositoryPath("./src/auth.ts")).toBe(false);
    expect(isRepositoryPath("../escape")).toBe(false);
    expect(isRepositoryPath(42)).toBe(false);
    expect(isRepositoryPath(null)).toBe(false);
  });

  it("reports a specific reason, never 'invalid input' (§96)", () => {
    try {
      repositoryPath("../etc/passwd");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validation = error as ValidationError;
      expect(validation.message).toContain("traversal is not permitted");
      expect(validation.details?.reason).toBe(
        "path contains a '..' segment; traversal is not permitted",
      );
      expect(validation.retryable).toBe(false);
    }
  });

  describe("accessors", () => {
    it("basename", () => {
      expect(pathBasename(repositoryPath("src/auth/session.ts"))).toBe(
        "session.ts",
      );
      expect(pathBasename(repositoryPath("README.md"))).toBe("README.md");
    });

    it("extension, treating a dotfile as having none", () => {
      expect(pathExtension(repositoryPath("src/a/session.ts"))).toBe("ts");
      expect(pathExtension(repositoryPath("src/a/Session.TS"))).toBe("ts");
      expect(pathExtension(repositoryPath("Makefile"))).toBeUndefined();
      expect(pathExtension(repositoryPath(".gitignore"))).toBeUndefined();
      expect(pathExtension(repositoryPath("archive.tar.gz"))).toBe("gz");
    });

    it("dirname, undefined at the repository root", () => {
      expect(pathDirname(repositoryPath("src/auth/session.ts"))).toBe(
        "src/auth",
      );
      expect(pathDirname(repositoryPath("README.md"))).toBeUndefined();
    });

    it("depth, the specificity signal for path-instruction precedence (§40)", () => {
      expect(pathDepth(repositoryPath("a.ts"))).toBe(1);
      expect(pathDepth(repositoryPath("src/a.ts"))).toBe(2);
      expect(pathDepth(repositoryPath("src/deep/a.ts"))).toBe(3);
    });
  });

  describe("schema", () => {
    it("parses and normalizes", () => {
      expect(repositoryPathSchema.parse("./src/a.ts")).toBe("src/a.ts");
    });

    it("surfaces the specific reason on failure", () => {
      const result = repositoryPathSchema.safeParse("../escape");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("traversal");
      }
    });
  });

  describe("property-based (§84)", () => {
    it("never accepts a string containing a '..' segment", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(fc.constant(".."), fc.stringMatching(/^[a-z]{1,8}$/)),
            { minLength: 1, maxLength: 6 },
          ),
          (segments) => {
            const candidate = segments.join("/");
            const hasTraversal = segments.includes("..");
            let accepted = true;
            try {
              repositoryPath(candidate);
            } catch {
              accepted = false;
            }
            // If it contains a traversal segment it must have been rejected.
            return hasTraversal ? !accepted : true;
          },
        ),
        { numRuns: 500 },
      );
    });

    it("output is always idempotent under re-parsing", () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6}){0,4}$/),
          (raw) => {
            const once = repositoryPath(raw);
            const twice = repositoryPath(once);
            return once === twice;
          },
        ),
        { numRuns: 500 },
      );
    });
  });
});
