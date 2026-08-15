import { describe, expect, it } from "vitest";
import {
  assertValidRevisionSeries,
  compareRevisions,
  currentRevision,
  isSupersededBy,
  pullRequestRevisionSchema,
  pullRequestSchema,
  revisionsDescribeSameCode,
  type PullRequestRevision,
} from "../../src/domain/pull-request/pull-request.js";
import {
  OrganizationIdOps,
  PullRequestIdOps,
  PullRequestRevisionIdOps,
  RepositoryIdOps,
} from "../../src/domain/identity/ids.js";
import { ValidationError } from "../../src/domain/errors/errors.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";

const ORG = OrganizationIdOps.parse("0192f8a1-0000-7000-8000-000000000001");
const REPO = RepositoryIdOps.parse("0192f8a1-0000-7000-8000-000000000002");
const PR = PullRequestIdOps.parse("0192f8a1-0000-7000-8000-000000000003");
const OTHER_PR = PullRequestIdOps.parse("0192f8a1-0000-7000-8000-000000000004");

const ref = (sha: string, name?: string) => ({
  ...(name === undefined ? {} : { name }),
  objectId: { algorithm: "sha1" as const, value: sha },
});

const at = (minute: number) =>
  timestamp(`2026-08-15T15:${String(minute).padStart(2, "0")}:00.000Z`);

function revision(
  sequence: number,
  overrides: Partial<PullRequestRevision> = {},
): PullRequestRevision {
  return {
    id: PullRequestRevisionIdOps.parse(
      `0192f8a1-0000-7000-8000-10000000000${sequence}`,
    ),
    organizationId: ORG,
    repositoryId: REPO,
    pullRequestId: PR,
    sequence,
    base: ref("a".repeat(40), "main"),
    head: ref(String(sequence).repeat(40).slice(0, 40)),
    trigger: sequence === 1 ? "opened" : "push",
    createdAt: at(sequence),
    ...overrides,
  };
}

describe("PullRequest and revisions (P0.txt §14, §15, §71)", () => {
  describe("the race this model exists to prevent", () => {
    it("pins a review to an exact revision, not to the pull request", () => {
      // A run records revision 3. Revision 4 arriving later cannot change what
      // revision 3 says, so findings stay correct forever.
      const analyzed = revision(3);
      const later = revision(4);

      expect(analyzed.head).not.toEqual(later.head);
      expect(isSupersededBy(analyzed, later)).toBe(true);
      // And the earlier revision is untouched by the newer one existing.
      expect(analyzed.sequence).toBe(3);
      expect(analyzed.head.objectId.value).toBe(
        revision(3).head.objectId.value,
      );
    });

    it("does not treat an older revision as superseding a newer one", () => {
      expect(isSupersededBy(revision(4), revision(3))).toBe(false);
    });

    it("does not treat another pull request's revision as superseding", () => {
      // Sequence numbers are per-PR, so comparing across PRs is meaningless.
      const mine = revision(3);
      const theirs = revision(9, { pullRequestId: OTHER_PR });
      expect(isSupersededBy(mine, theirs)).toBe(false);
    });
  });

  describe("revision series integrity", () => {
    it("accepts a dense, ordered series", () => {
      expect(() =>
        assertValidRevisionSeries([revision(1), revision(2), revision(3)]),
      ).not.toThrow();
    });

    it("rejects a series that does not start at 1", () => {
      expect(() => assertValidRevisionSeries([revision(2)])).toThrow(
        /must start at sequence 1/,
      );
    });

    it("rejects a gap — the signature of a lost write", () => {
      // Sequence 3 vanishing means incremental review would compare against
      // the wrong baseline without ever noticing.
      expect(() =>
        assertValidRevisionSeries([revision(1), revision(2), revision(4)]),
      ).toThrow(/not dense at index 2: 2 is followed by 4/);
    });

    it("rejects a duplicate — the signature of a double-processed webhook", () => {
      expect(() =>
        assertValidRevisionSeries([revision(1), revision(2), revision(2)]),
      ).toThrow(ValidationError);
    });

    it("rejects mixed pull requests", () => {
      expect(() =>
        assertValidRevisionSeries([
          revision(1),
          revision(2, { pullRequestId: OTHER_PR }),
        ]),
      ).toThrow(/mixes pull requests at index 1/);
    });

    it("rejects time moving backwards", () => {
      expect(() =>
        assertValidRevisionSeries([
          revision(1, { createdAt: at(10) }),
          revision(2, { createdAt: at(5) }),
        ]),
      ).toThrow(/backwards in time at index 1/);
    });

    it("allows two revisions in the same instant", () => {
      expect(() =>
        assertValidRevisionSeries([
          revision(1, { createdAt: at(5) }),
          revision(2, { createdAt: at(5) }),
        ]),
      ).not.toThrow();
    });

    it("accepts an empty series", () => {
      expect(() => assertValidRevisionSeries([])).not.toThrow();
      expect(currentRevision([])).toBeUndefined();
    });
  });

  describe("current revision", () => {
    it("is the highest sequence, regardless of array order", () => {
      const unordered = [revision(2), revision(4), revision(1), revision(3)];
      expect(currentRevision(unordered)?.sequence).toBe(4);
    });

    it("sorts by sequence", () => {
      const sorted = [revision(3), revision(1), revision(2)].sort(
        compareRevisions,
      );
      expect(sorted.map((r) => r.sequence)).toEqual([1, 2, 3]);
    });
  });

  describe("code identity vs record identity", () => {
    it("treats a manual refresh as the same code", () => {
      // Same base and head, new row: nothing to re-analyze, so a cached
      // ChangeManifest is still valid.
      const original = revision(3);
      const refreshed = revision(4, {
        head: original.head,
        base: original.base,
        trigger: "manual_refresh",
      });

      expect(revisionsDescribeSameCode(original, refreshed)).toBe(true);
      expect(original.id).not.toBe(refreshed.id);
    });

    it("treats a moved head as different code", () => {
      expect(revisionsDescribeSameCode(revision(1), revision(2))).toBe(false);
    });

    it("treats a retarget as different code even with an identical head", () => {
      // base_changed exists precisely for this: the diff changes completely
      // without a single new commit, which a "did head move?" check misses.
      const before = revision(3);
      const after = revision(4, {
        head: before.head,
        base: ref("f".repeat(40), "release/2.0"),
        trigger: "base_changed",
      });

      expect(revisionsDescribeSameCode(before, after)).toBe(false);
    });

    it("distinguishes a known merge base from an absent one", () => {
      const withMergeBase = revision(1, { mergeBase: ref("e".repeat(40)) });
      expect(revisionsDescribeSameCode(withMergeBase, revision(1))).toBe(false);
    });
  });

  describe("schemas", () => {
    it("parses a revision", () => {
      expect(pullRequestRevisionSchema.parse(revision(1)).sequence).toBe(1);
    });

    it("rejects sequence 0 — revisions are 1-based", () => {
      expect(
        pullRequestRevisionSchema.safeParse({ ...revision(1), sequence: 0 })
          .success,
      ).toBe(false);
    });

    it("rejects a revision with no createdAt", () => {
      const { createdAt: _drop, ...withoutTime } = revision(1);
      expect(pullRequestRevisionSchema.safeParse(withoutTime).success).toBe(
        false,
      );
    });

    it("has no updatedAt — revisions are immutable (§71)", () => {
      // An updatedAt field would invite in-place mutation, which is exactly
      // what must never happen to a revision.
      const parsed = pullRequestRevisionSchema.parse(revision(1));
      expect(Object.keys(parsed)).not.toContain("updatedAt");
      expect(
        pullRequestRevisionSchema.safeParse({
          ...revision(1),
          updatedAt: at(9),
        }).success,
      ).toBe(false);
    });

    it("parses a pull request and keeps mutable metadata separate", () => {
      const pullRequest = pullRequestSchema.parse({
        id: PR,
        organizationId: ORG,
        repositoryId: REPO,
        provider: "github",
        providerChangeRequest: {
          kind: "change_request",
          provider: "github",
          externalId: "PR_kwDOABCD",
          number: 184,
        },
        title: "Add session verification",
        author: { kind: "human", displayName: "Ada" },
        state: "open",
        draft: false,
        labels: ["backend", "security"],
        createdAt: at(1),
        updatedAt: at(2),
      });

      // The PR carries changeable metadata and an updatedAt; correctness-
      // critical geometry lives on revisions instead.
      expect(pullRequest.updatedAt).toBe(at(2));
      expect(Object.keys(pullRequest)).not.toContain("base");
      expect(Object.keys(pullRequest)).not.toContain("head");
    });

    it("distinguishes merged from closed", () => {
      // Merged findings describe production code; closed ones are moot.
      for (const state of ["open", "closed", "merged"] as const) {
        expect(
          pullRequestSchema.safeParse({
            id: PR,
            organizationId: ORG,
            repositoryId: REPO,
            provider: "github",
            providerChangeRequest: {
              kind: "change_request",
              provider: "github",
              externalId: "x",
            },
            title: "t",
            author: { kind: "system", component: "acalys.scheduler" },
            state,
            draft: false,
            labels: [],
            createdAt: at(1),
            updatedAt: at(1),
          }).success,
        ).toBe(true);
      }
    });

    it("rejects an unknown revision trigger", () => {
      expect(
        pullRequestRevisionSchema.safeParse({
          ...revision(1),
          trigger: "pull_request.synchronize",
        }).success,
      ).toBe(false);
    });
  });

  it("round-trips a revision through JSON", () => {
    const parsed = pullRequestRevisionSchema.parse(revision(2));
    expect(
      pullRequestRevisionSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });
});
