import { describe, expect, it } from "vitest";
import {
  REVIEW_PROGRESS_TABLE,
  findingDtoSchema,
  pullRequestSummaryDtoSchema,
  repositoryDtoSchema,
  reviewProgressEventSchema,
  reviewRunDtoSchema,
  toFindingDto,
  toPullRequestSummaryDto,
  toRepositoryDto,
  toReviewProgressEvent,
  toReviewRunDto,
} from "../../src/api/v1/index.js";
import { REVIEW_RUN_STATES } from "../../src/domain/review/review-run-state.js";
import type { Repository } from "../../src/domain/repository/repository.js";
import type { PullRequest } from "../../src/domain/pull-request/pull-request.js";
import type { ReviewRun } from "../../src/domain/review/review-run.js";
import type { ReviewFinding } from "../../src/domain/finding/review-finding.js";
import { unsafeBrand } from "../../src/domain/primitives/brand.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";
import type {
  CandidateFindingId,
  FindingId,
  OrganizationId,
  PullRequestId,
  RepositoryId,
  ReviewRequestId,
  ReviewRunId,
} from "../../src/domain/identity/ids.js";

const uuid = (suffix: string) =>
  `0192f8a1-0000-7000-8000-${suffix.padStart(12, "0")}`;
const organizationId = unsafeBrand<OrganizationId>(uuid("1"));
const repositoryId = unsafeBrand<RepositoryId>(uuid("2"));
const reviewRunId = unsafeBrand<ReviewRunId>(uuid("3"));
const at = timestamp("2026-08-16T10:00:00.000Z");

const repository: Repository = {
  id: repositoryId,
  organizationId,
  provider: "github",
  providerRepository: {
    kind: "repository",
    provider: "github",
    externalId: "1296269",
    owner: "acalys",
    name: "acalys",
  },
  defaultBranch: "main",
  visibility: "private",
  lifecycle: "active",
  createdAt: at,
  updatedAt: at,
};

const pullRequest: PullRequest = {
  id: unsafeBrand<PullRequestId>(uuid("4")),
  organizationId,
  repositoryId,
  provider: "github",
  providerChangeRequest: {
    kind: "change_request",
    provider: "github",
    externalId: "998877",
    number: 412,
  },
  title: "Stream agent responses over SSE",
  author: { kind: "human", displayName: "shrenil28" },
  state: "open",
  draft: false,
  labels: ["backend"],
  createdAt: at,
  updatedAt: at,
};

const run: ReviewRun = {
  schemaVersion: 1,
  id: reviewRunId,
  requestId: unsafeBrand<ReviewRequestId>(uuid("5")),
  organizationId,
  repositoryId,
  target: {
    kind: "commit",
    schemaVersion: 1,
    repositoryId,
    commit: {
      name: "main",
      objectId: { algorithm: "sha1", value: "a".repeat(40) },
    },
  },
  execution: { mode: "review", strategy: "single" },
  attempt: 3,
  state: "analyzing",
  history: [],
  createdAt: at,
  startedAt: at,
};

const finding: ReviewFinding = {
  schemaVersion: 1,
  id: unsafeBrand<FindingId>(uuid("6")),
  organizationId,
  repositoryId,
  reviewRunId,
  candidateIds: [unsafeBrand<CandidateFindingId>(uuid("7"))],
  title: "SQL injection in Session.verify",
  explanation: "User input reaches the query without parameterization.",
  category: "security",
  severity: "critical",
  confidence: { score: 0.93, level: "high" },
  location: {
    repositoryId,
    path: repositoryPath("src/auth.ts"),
    side: "head",
    lines: { start: 82, end: 84 },
  },
  evidence: [],
  fingerprint: {
    algorithm: "acalys.fingerprint.symbol-anchor",
    algorithmVersion: 1,
    value: "b".repeat(64),
  },
  verification: {
    decision: "verified",
    reasonCodes: ["confirmed_by_static_trace"],
    evidence: [],
    confidence: { score: 0.93, level: "high" },
    verifiedBy: { kind: "agent", agentType: "verifier" },
    verifiedAt: at,
  },
  state: "published",
  history: [],
  createdAt: at,
  updatedAt: at,
};

describe("Projections produce valid DTOs (P0.txt §76)", () => {
  /**
   * The check that a projection and its schema agree.
   *
   * Hand-written DTO fixtures elsewhere only prove the *schema* accepts
   * something; these prove the code that actually builds DTOs in production
   * emits what the schema describes. A projection that quietly stopped
   * populating a field would pass every other test in the suite.
   */
  it("toRepositoryDto", () => {
    const dto = toRepositoryDto(repository);
    expect(repositoryDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto.name).toBe("acalys/acalys");
  });

  it("toPullRequestSummaryDto", () => {
    const dto = toPullRequestSummaryDto(pullRequest);
    expect(pullRequestSummaryDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto.number).toBe(412);
    expect(dto.authorLabel).toBe("shrenil28");
  });

  it("toReviewRunDto", () => {
    const dto = toReviewRunDto(run);
    expect(reviewRunDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("toFindingDto", () => {
    const dto = toFindingDto(finding);
    expect(findingDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("drops the attempt number", () => {
    // A retry is invisible to the viewer by design: they asked for a review,
    // and which attempt delivered it is the platform's business (§20).
    expect(run.attempt).toBe(3);
    expect(Object.keys(toReviewRunDto(run))).not.toContain("attempt");
  });

  it("drops the confidence score, keeping the level", () => {
    // The score's scale changes as verification improves; the level is the
    // stable projection a user can compare across months.
    expect(finding.confidence.score).toBe(0.93);
    expect(toFindingDto(finding).confidence).toBe("high");
  });

  it("drops the fingerprint", () => {
    // Publishing it invites a client to key on it, which would freeze the
    // algorithm the moment anyone did.
    expect(Object.keys(toFindingDto(finding))).not.toContain("fingerprint");
  });

  it("omits an absent optional rather than emitting undefined", () => {
    // `{ startedAt: undefined }` serializes to a key that is present with no
    // value in some encoders and absent in others — §57's rule is that absent
    // means absent, and the projection has to honour it.
    const queued: ReviewRun = { ...run, state: "queued", startedAt: undefined };
    expect(Object.keys(toReviewRunDto(queued))).not.toContain("startedAt");
  });
});

describe("Review progress (SSE payload)", () => {
  it("covers every run state", () => {
    // Exhaustive by construction: a state added without deciding how it
    // renders is a compile error, not a bar that sits at "waiting" forever.
    expect(Object.keys(REVIEW_PROGRESS_TABLE).sort()).toEqual(
      [...REVIEW_RUN_STATES].sort(),
    );
  });

  it("produces a valid payload for every state", () => {
    for (const state of REVIEW_RUN_STATES) {
      const event = toReviewProgressEvent("run-1", state, at);
      expect(reviewProgressEventSchema.safeParse(event).success, state).toBe(
        true,
      );
    }
  });

  it("advances monotonically through the working states", () => {
    // A bar that goes backwards reads as a failure even when nothing is wrong.
    const working = [
      "queued",
      "preparing",
      "analyzing",
      "reviewing",
      "verifying",
      "reconciling",
      "publishing",
      "completed",
    ] as const;

    for (let index = 1; index < working.length; index += 1) {
      const previousState = working[index - 1];
      const currentState = working[index];
      if (previousState === undefined || currentState === undefined) continue;
      expect(REVIEW_PROGRESS_TABLE[currentState].progress).toBeGreaterThan(
        REVIEW_PROGRESS_TABLE[previousState].progress,
      );
    }
  });

  it("treats cancelled and superseded as finished, not errored", () => {
    // A superseded run was replaced because the author pushed again — the
    // system working. Showing it as an error trains users to ignore real ones.
    expect(REVIEW_PROGRESS_TABLE.cancelled.phase).toBe("finished");
    expect(REVIEW_PROGRESS_TABLE.superseded.phase).toBe("finished");
    expect(REVIEW_PROGRESS_TABLE.failed.phase).toBe("errored");
  });

  it("marks only queued as waiting", () => {
    const waiting = REVIEW_RUN_STATES.filter(
      (state) => REVIEW_PROGRESS_TABLE[state].phase === "waiting",
    );
    expect(waiting).toEqual(["queued"]);
  });
});
