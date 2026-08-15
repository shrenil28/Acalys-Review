import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_SOURCE_TYPES,
  isAuthoredInstruction,
  knowledgeReferenceSchema,
} from "../../src/domain/knowledge/knowledge.js";
import {
  PRE_MERGE_CHECK_STATUSES,
  aggregateCheckStatus,
  blocksMerge,
  isSettledCheck,
  preMergeCheckResultSchema,
  type PreMergeCheckResult,
} from "../../src/domain/premerge/premerge.js";
import { FINDING_SEVERITIES } from "../../src/domain/finding/taxonomy.js";
import { unsafeBrand } from "../../src/domain/primitives/brand.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";
import type {
  OrganizationId,
  PreMergeCheckResultId,
  RepositoryId,
  ReviewRunId,
} from "../../src/domain/identity/ids.js";

const uuid = (suffix: string) =>
  `0192f8a1-0000-7000-8000-${suffix.padStart(12, "0")}`;
const organizationId = unsafeBrand<OrganizationId>(uuid("1"));
const repositoryId = unsafeBrand<RepositoryId>(uuid("2"));
const reviewRunId = unsafeBrand<ReviewRunId>(uuid("3"));
const at = timestamp("2026-08-16T10:00:00.000Z");

describe("KnowledgeReference (P0.txt §43)", () => {
  const reference = (overrides: Record<string, unknown> = {}) => ({
    sourceType: "learning" as const,
    scope: "repository" as const,
    sourceId: "learning.0192f8a1",
    organizationId,
    repositoryId,
    summary: "This team prefers repository methods over direct SQL.",
    ...overrides,
  });

  it("names every source type §43 lists", () => {
    expect([...KNOWLEDGE_SOURCE_TYPES]).toEqual([
      "repository_instruction",
      "organization_instruction",
      "path_instruction",
      "learning",
      "pull_request",
      "issue",
      "external_document",
      "mcp",
      "web",
    ]);
  });

  it("encodes no retrieval strategy", () => {
    // §43 defers retrieval, and §116 keeps it swappable: an embedding or a
    // similarity score in this contract would make changing how knowledge is
    // *found* a schema change.
    const shape = Object.keys(reference());
    for (const forbidden of [
      "embedding",
      "vector",
      "score",
      "similarity",
      "distance",
    ]) {
      expect(shape).not.toContain(forbidden);
    }
    expect(
      knowledgeReferenceSchema.safeParse(reference({ embedding: [0.1, 0.2] }))
        .success,
    ).toBe(false);
  });

  it("separates a human's standing rule from the platform's own inference", () => {
    // A learning weighed equally with an authored instruction lets one bad
    // inference harden into permanent policy (§116).
    expect(isAuthoredInstruction("organization_instruction")).toBe(true);
    expect(isAuthoredInstruction("repository_instruction")).toBe(true);
    expect(isAuthoredInstruction("path_instruction")).toBe(true);
    expect(isAuthoredInstruction("learning")).toBe(false);
    expect(isAuthoredInstruction("web")).toBe(false);
  });

  describe("scope must match the fields that realize it", () => {
    it("requires a repository for a repository-scoped reference", () => {
      expect(
        knowledgeReferenceSchema.safeParse(
          reference({ scope: "repository", repositoryId: undefined }),
        ).success,
      ).toBe(false);
    });

    it("forbids a repository on an organization-scoped reference", () => {
      // An organization rule applies everywhere; naming one repository would
      // claim a narrower reach than it has.
      expect(
        knowledgeReferenceSchema.safeParse(reference({ scope: "organization" }))
          .success,
      ).toBe(false);
      expect(
        knowledgeReferenceSchema.safeParse(
          reference({ scope: "organization", repositoryId: undefined }),
        ).success,
      ).toBe(true);
    });

    it("requires a path for a path-scoped reference and forbids one otherwise", () => {
      // The leak this prevents: a learning about `migrations/` applied to the
      // frontend, or a frontend rule silently applied everywhere.
      expect(
        knowledgeReferenceSchema.safeParse(reference({ scope: "path" }))
          .success,
      ).toBe(false);
      expect(
        knowledgeReferenceSchema.safeParse(
          reference({ scope: "path", path: repositoryPath("db/migrations") }),
        ).success,
      ).toBe(true);
      expect(
        knowledgeReferenceSchema.safeParse(
          reference({
            scope: "repository",
            path: repositoryPath("db/migrations"),
          }),
        ).success,
      ).toBe(false);
    });
  });

  it("carries a recap, not the knowledge itself (§65)", () => {
    const enormous = "x".repeat(50_000);
    expect(
      knowledgeReferenceSchema.safeParse(reference({ summary: enormous }))
        .success,
    ).toBe(false);
  });
});

describe("PreMergeCheckResult (P0.txt §44, §132)", () => {
  const check = (overrides: Record<string, unknown> = {}): unknown => ({
    id: unsafeBrand<PreMergeCheckResultId>(uuid("4")),
    organizationId,
    repositoryId,
    reviewRunId,
    checkId: "acalys.premerge.description",
    name: "Description present",
    status: "passed" as const,
    evidence: [],
    blocking: true,
    evaluatedAt: at,
    ...overrides,
  });

  const parsed = (
    overrides: Record<string, unknown> = {},
  ): PreMergeCheckResult => preMergeCheckResultSchema.parse(check(overrides));

  it("has a status, never a severity", () => {
    // §132: a review finding is not a pre-merge check. Sharing the severity
    // vocabulary would make severity start to mean "blocking", and policy
    // would be tuned by re-grading defects.
    expect(
      preMergeCheckResultSchema.safeParse(check({ severity: "high" })).success,
    ).toBe(false);
    for (const severity of FINDING_SEVERITIES) {
      expect(PRE_MERGE_CHECK_STATUSES).not.toContain(severity);
    }
  });

  it("keeps 'inconclusive' distinct from 'failed' and 'passed'", () => {
    // The distinction a boolean loses. Collapsing it into `failed` blocks
    // merges on the platform's own uncertainty; into `passed`, an unevaluated
    // policy reads as satisfied.
    expect(PRE_MERGE_CHECK_STATUSES).toContain("inconclusive");
    expect(
      blocksMerge(
        parsed({
          status: "inconclusive",
          explanation: "Could not parse the template.",
        }),
      ),
    ).toBe(false);
  });

  it("blocks a merge only when a blocking check actually failed", () => {
    expect(
      blocksMerge(parsed({ status: "failed", explanation: "No description." })),
    ).toBe(true);
    expect(
      blocksMerge(
        parsed({
          status: "failed",
          explanation: "No description.",
          blocking: false,
        }),
      ),
    ).toBe(false);
    expect(blocksMerge(parsed({ status: "passed" }))).toBe(false);
  });

  it("records whether it blocked, so the result survives a config change", () => {
    // The same reason a run pins its config snapshot (§39, §72): the result
    // must stay interpretable after the policy that produced it changes.
    expect(parsed().blocking).toBe(true);
  });

  describe("settlement", () => {
    it("treats pending and running as unsettled", () => {
      expect(isSettledCheck("pending")).toBe(false);
      expect(isSettledCheck("running")).toBe(false);
      for (const status of [
        "passed",
        "failed",
        "inconclusive",
        "skipped",
      ] as const) {
        expect(isSettledCheck(status)).toBe(true);
      }
    });

    it("requires an evaluation time once settled, and forbids one before", () => {
      expect(
        preMergeCheckResultSchema.safeParse(check({ evaluatedAt: undefined }))
          .success,
      ).toBe(false);
      expect(
        preMergeCheckResultSchema.safeParse(check({ status: "running" }))
          .success,
      ).toBe(false);
      expect(
        preMergeCheckResultSchema.safeParse(
          check({ status: "running", evaluatedAt: undefined }),
        ).success,
      ).toBe(true);
    });

    it("requires an explanation for any non-passing outcome", () => {
      // A developer seeing "failed" with no reason has nothing to act on.
      for (const status of ["failed", "inconclusive", "skipped"] as const) {
        expect(
          preMergeCheckResultSchema.safeParse(check({ status })).success,
        ).toBe(false);
        expect(
          preMergeCheckResultSchema.safeParse(
            check({ status, explanation: "why" }),
          ).success,
        ).toBe(true);
      }
    });
  });

  describe("aggregate gate", () => {
    it("fails when any blocking check failed", () => {
      expect(
        aggregateCheckStatus([
          parsed({ status: "passed" }),
          parsed({ status: "failed", explanation: "no" }),
        ]),
      ).toBe("failed");
    });

    it("waits rather than passing while a check is unsettled", () => {
      // An unsettled check read as a pass is how a policy gets bypassed by
      // being slow.
      expect(
        aggregateCheckStatus([
          parsed({ status: "passed" }),
          parsed({ status: "running", evaluatedAt: undefined }),
        ]),
      ).toBe("pending");
    });

    it("passes an empty set", () => {
      // A repository with no checks configured is not blocked by the absence.
      expect(aggregateCheckStatus([])).toBe("passed");
    });

    it("does not block on a non-blocking failure or on uncertainty", () => {
      expect(
        aggregateCheckStatus([
          parsed({ status: "failed", explanation: "no", blocking: false }),
          parsed({ status: "inconclusive", explanation: "unclear" }),
          parsed({ status: "skipped", explanation: "not applicable" }),
        ]),
      ).toBe("passed");
    });
  });

  it("accepts a tenant-authored check id without a schema change (§79, §80)", () => {
    expect(
      preMergeCheckResultSchema.safeParse(
        check({ checkId: "org.acme.check.no-direct-sql" }),
      ).success,
    ).toBe(true);
  });
});
