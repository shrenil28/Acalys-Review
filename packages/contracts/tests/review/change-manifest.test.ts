import { describe, expect, it } from "vitest";
import {
  CHANGE_MANIFEST_SCHEMA_VERSION,
  changeManifestSchema,
  changedFileSchema,
  computeChangeStatistics,
  diffHunkSchema,
  reviewableFiles,
  sortChangedFiles,
  sortLanguageSummaries,
  totalLinesChanged,
  type ChangedFile,
} from "../../src/domain/change/change-manifest.js";
import { lineRangeSchema } from "../../src/domain/location/line-range.js";
import { RepositoryIdOps } from "../../src/domain/identity/ids.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";
import { namespacedId } from "../../src/domain/primitives/namespaced-id.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";
import { canonicalJson } from "../../src/domain/primitives/canonical-json.js";

const REPO = RepositoryIdOps.parse("0192f8a1-0000-7000-8000-000000000002");

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: repositoryPath(path),
    status: "modified",
    additions: 10,
    deletions: 2,
    binary: false,
    language: namespacedId("lang.typescript"),
    ...overrides,
  };
}

const manifest = (files: ChangedFile[]) => ({
  schemaVersion: CHANGE_MANIFEST_SCHEMA_VERSION,
  repositoryId: REPO,
  comparison: {
    base: { algorithm: "sha1" as const, value: "a".repeat(40) },
    head: { algorithm: "sha1" as const, value: "b".repeat(40) },
  },
  files: sortChangedFiles(files),
  stats: computeChangeStatistics(files),
  languages: [],
  truncated: false,
  generatedAt: timestamp("2026-08-15T15:30:00.000Z"),
});

describe("ChangeManifest (P0.txt §21, §123)", () => {
  describe("it is not files: string[]", () => {
    it("carries per-file status, counts, and hunks", () => {
      const parsed = changedFileSchema.parse(
        file("src/auth/session.ts", {
          hunks: [
            { base: { start: 10, end: 14 }, head: { start: 10, end: 18 } },
            { head: { start: 40, end: 42 } },
          ],
        }),
      );

      expect(parsed.status).toBe("modified");
      expect(parsed.hunks).toHaveLength(2);
      // A pure addition has no base side, and that absence is the signal.
      expect(parsed.hunks?.[1]?.base).toBeUndefined();
    });

    it("distinguishes 'hunks not computed' from 'no hunks'", () => {
      // Absent means unknown; empty means known-to-be-none. Collapsing them
      // would make a reviewer treat missing analysis as an empty diff.
      expect(changedFileSchema.parse(file("a.ts")).hunks).toBeUndefined();
      expect(
        changedFileSchema.parse(file("a.ts", { hunks: [] })).hunks,
      ).toEqual([]);
    });
  });

  describe("line ranges are 1-based and inclusive (§22)", () => {
    it("accepts a single-line range", () => {
      expect(lineRangeSchema.parse({ start: 7, end: 7 })).toEqual({
        start: 7,
        end: 7,
      });
    });

    it("rejects line 0 — the convention is explicit, not assumed", () => {
      expect(lineRangeSchema.safeParse({ start: 0, end: 5 }).success).toBe(
        false,
      );
    });

    it("rejects a range that ends before it starts", () => {
      const result = lineRangeSchema.safeParse({ start: 10, end: 4 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "ends before it starts",
        );
      }
    });

    it("rejects a negative or fractional line", () => {
      expect(lineRangeSchema.safeParse({ start: -1, end: 5 }).success).toBe(
        false,
      );
      expect(lineRangeSchema.safeParse({ start: 1.5, end: 5 }).success).toBe(
        false,
      );
    });

    it("rejects a hunk touching neither side", () => {
      expect(diffHunkSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("rename tracking (§28)", () => {
    it("requires previousPath on a rename", () => {
      // Without it a finding cannot follow the file, and would be reported as
      // fixed-and-reintroduced across the rename.
      const result = changedFileSchema.safeParse(
        file("src/new.ts", { status: "renamed" }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "must record previousPath",
        );
      }
    });

    it("accepts a rename that records its origin", () => {
      const parsed = changedFileSchema.parse(
        file("src/new.ts", {
          status: "renamed",
          previousPath: repositoryPath("src/old.ts"),
        }),
      );
      expect(parsed.previousPath).toBe("src/old.ts");
    });

    it("rejects previousPath on a non-rename", () => {
      expect(
        changedFileSchema.safeParse(
          file("src/a.ts", {
            status: "modified",
            previousPath: repositoryPath("src/b.ts"),
          }),
        ).success,
      ).toBe(false);
    });
  });

  describe("binary files", () => {
    it("cannot report line counts", () => {
      // Non-zero counts on binary content would corrupt blast-radius stats.
      expect(
        changedFileSchema.safeParse(
          file("assets/logo.png", { binary: true, additions: 40 }),
        ).success,
      ).toBe(false);
    });

    it("are valid with zero counts", () => {
      expect(
        changedFileSchema.safeParse(
          file("assets/logo.png", {
            binary: true,
            additions: 0,
            deletions: 0,
          }),
        ).success,
      ).toBe(true);
    });
  });

  describe("path safety flows through (§64)", () => {
    it("rejects a traversal path inside a manifest", () => {
      expect(
        changedFileSchema.safeParse({
          ...file("src/a.ts"),
          path: "../../etc/passwd",
        }).success,
      ).toBe(false);
    });

    it("normalizes a './'-prefixed path from an adapter", () => {
      expect(
        changedFileSchema.parse({ ...file("src/a.ts"), path: "./src/a.ts" })
          .path,
      ).toBe("src/a.ts");
    });
  });

  describe("ordering is part of the contract (§123)", () => {
    it("sorts files by path", () => {
      const sorted = sortChangedFiles([
        file("src/z.ts"),
        file("README.md"),
        file("src/a.ts"),
      ]);
      expect(sorted.map((f) => f.path)).toEqual([
        "README.md",
        "src/a.ts",
        "src/z.ts",
      ]);
    });

    it("makes two adapters listing the same files hash identically", () => {
      // The whole reason ordering is specified: a manifest is hashed for
      // caching and reproducibility.
      const a = manifest([file("src/z.ts"), file("README.md")]);
      const b = manifest([file("README.md"), file("src/z.ts")]);
      expect(canonicalJson(a.files)).toBe(canonicalJson(b.files));
    });

    it("sorts language summaries by id", () => {
      const sorted = sortLanguageSummaries([
        {
          language: namespacedId("lang.typescript"),
          files: 1,
          additions: 1,
          deletions: 0,
        },
        {
          language: namespacedId("lang.go"),
          files: 1,
          additions: 1,
          deletions: 0,
        },
      ]);
      expect(sorted.map((l) => l.language)).toEqual([
        "lang.go",
        "lang.typescript",
      ]);
    });
  });

  describe("statistics are derived, never hand-counted", () => {
    it("matches the file list exactly", () => {
      const files = [
        file("a.ts", { status: "added", additions: 100, deletions: 0 }),
        file("b.ts", { status: "modified", additions: 10, deletions: 5 }),
        file("c.ts", { status: "deleted", additions: 0, deletions: 30 }),
        file("d.ts", {
          status: "renamed",
          previousPath: repositoryPath("old.ts"),
          additions: 2,
          deletions: 2,
        }),
        file("bin.png", { binary: true, additions: 0, deletions: 0 }),
        file("gen.ts", { generated: true, additions: 500, deletions: 0 }),
      ];

      expect(computeChangeStatistics(files)).toEqual({
        filesChanged: 6,
        additions: 612,
        deletions: 37,
        filesAdded: 1,
        filesModified: 3,
        filesDeleted: 1,
        filesRenamed: 1,
        binaryFiles: 1,
        generatedFiles: 1,
      });
    });

    it("is empty for an empty change", () => {
      expect(computeChangeStatistics([])).toMatchObject({
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      });
    });

    it("totals lines changed", () => {
      expect(
        totalLinesChanged(changeManifestSchema.parse(manifest([file("a.ts")]))),
      ).toBe(12);
    });
  });

  describe("reviewable subset", () => {
    it("excludes deletions, binaries, and generated files — for distinct reasons", () => {
      const parsed = changeManifestSchema.parse(
        manifest([
          file("src/keep.ts"),
          file("src/gone.ts", {
            status: "deleted",
            additions: 0,
            deletions: 9,
          }),
          file("logo.png", { binary: true, additions: 0, deletions: 0 }),
          file("bundle.js", { generated: true }),
        ]),
      );

      expect(reviewableFiles(parsed).map((f) => f.path)).toEqual([
        "src/keep.ts",
      ]);
      // But all four still count toward the size of the change.
      expect(parsed.stats.filesChanged).toBe(4);
    });
  });

  describe("large payloads stay out of the contract (§45)", () => {
    it("has no field for patch text", () => {
      const parsed = changeManifestSchema.parse(manifest([file("a.ts")]));
      const keys = Object.keys(parsed);
      for (const forbidden of ["patch", "diff", "content", "blob"]) {
        expect(keys).not.toContain(forbidden);
      }
      // Only a reference to where the bytes live.
      expect(changeManifestSchema.shape).toHaveProperty("patchArtifactId");
    });

    it("flags truncation explicitly rather than silently", () => {
      // A reviewer that does not know it saw a partial change will state
      // confidently that nothing else was touched.
      const parsed = changeManifestSchema.parse({
        ...manifest([file("a.ts")]),
        truncated: true,
      });
      expect(parsed.truncated).toBe(true);
    });

    it("requires the truncated flag to be present", () => {
      const { truncated: _drop, ...withoutFlag } = manifest([file("a.ts")]);
      expect(changeManifestSchema.safeParse(withoutFlag).success).toBe(false);
    });
  });

  describe("local review compatibility (§112)", () => {
    it("parses with no revisionId", () => {
      // A working-tree review has no revision to point at.
      const parsed = changeManifestSchema.parse(manifest([file("a.ts")]));
      expect(parsed.revisionId).toBeUndefined();
    });
  });

  it("rejects an unsupported schema version (§7)", () => {
    expect(
      changeManifestSchema.safeParse({
        ...manifest([file("a.ts")]),
        schemaVersion: 42,
      }).success,
    ).toBe(false);
  });

  it("round-trips through JSON", () => {
    const parsed = changeManifestSchema.parse(
      manifest([
        file("src/a.ts", {
          hunks: [{ base: { start: 1, end: 2 }, head: { start: 1, end: 5 } }],
        }),
        file("src/b.ts"),
      ]),
    );
    expect(
      changeManifestSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });
});
