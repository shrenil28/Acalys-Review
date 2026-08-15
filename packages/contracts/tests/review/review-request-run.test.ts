import { describe, expect, it } from "vitest";
import {
  REVIEW_REQUEST_SCHEMA_VERSION,
  defaultExecutionPolicy,
  reviewIdempotencyKey,
  reviewRequestSchema,
} from "../../src/domain/review/review-request.js";
import {
  REVIEW_RUN_SCHEMA_VERSION,
  assertRunStateMatchesHistory,
  isRetryable,
  isRunSettled,
  reviewRunSchema,
} from "../../src/domain/review/review-run.js";
import { REVIEW_TARGET_SCHEMA_VERSION } from "../../src/domain/review-target/review-target.js";
import {
  OrganizationIdOps,
  PullRequestRevisionIdOps,
  RepositoryIdOps,
  ReviewConfigSnapshotIdOps,
  ReviewRequestIdOps,
  ReviewRunIdOps,
} from "../../src/domain/identity/ids.js";
import { ValidationError } from "../../src/domain/errors/errors.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";
import { namespacedId } from "../../src/domain/primitives/namespaced-id.js";

const ORG = OrganizationIdOps.parse("0192f8a1-0000-7000-8000-000000000001");
const REPO = RepositoryIdOps.parse("0192f8a1-0000-7000-8000-000000000002");
const OTHER_REPO = RepositoryIdOps.parse(
  "0192f8a1-0000-7000-8000-00000000000f",
);
const REVISION = PullRequestRevisionIdOps.parse(
  "0192f8a1-0000-7000-8000-000000000005",
);
const REQUEST = ReviewRequestIdOps.parse(
  "0192f8a1-0000-7000-8000-000000000006",
);
const RUN = ReviewRunIdOps.parse("0192f8a1-0000-7000-8000-000000000007");
const CONFIG = ReviewConfigSnapshotIdOps.parse(
  "0192f8a1-0000-7000-8000-000000000008",
);

const at = (minute: number) =>
  timestamp(`2026-08-15T15:${String(minute).padStart(2, "0")}:00.000Z`);

const ref = (sha: string) => ({
  objectId: { algorithm: "sha1" as const, value: sha },
});

const prTarget = {
  kind: "pull_request" as const,
  schemaVersion: REVIEW_TARGET_SCHEMA_VERSION,
  repositoryId: REPO,
  provider: "github" as const,
  changeRequest: {
    kind: "change_request" as const,
    provider: "github" as const,
    externalId: "PR_1",
    number: 184,
  },
  base: ref("a".repeat(40)),
  head: ref("b".repeat(40)),
  title: "Add session verification",
  author: { kind: "human" as const, displayName: "Ada" },
  draft: false,
};

const workingTreeTarget = {
  kind: "working_tree" as const,
  schemaVersion: REVIEW_TARGET_SCHEMA_VERSION,
  repositoryId: REPO,
  baseline: ref("c".repeat(40)),
  stagedOnly: false,
};

const request = {
  schemaVersion: REVIEW_REQUEST_SCHEMA_VERSION,
  id: REQUEST,
  organizationId: ORG,
  repositoryId: REPO,
  target: prTarget,
  revisionId: REVISION,
  trigger: "pull_request_opened" as const,
  requestedBy: { kind: "human" as const, displayName: "Ada" },
  execution: { mode: "review" as const, strategy: "single" as const },
  configSnapshotId: CONFIG,
  idempotency: { key: "abc", scope: "webhook.github" },
  requestedAt: at(0),
};

const run = {
  schemaVersion: REVIEW_RUN_SCHEMA_VERSION,
  id: RUN,
  requestId: REQUEST,
  organizationId: ORG,
  repositoryId: REPO,
  target: prTarget,
  revisionId: REVISION,
  execution: { mode: "review" as const, strategy: "single" as const },
  attempt: 1,
  state: "queued" as const,
  history: [],
  configSnapshotId: CONFIG,
  createdAt: at(0),
};

describe("ReviewRequest vs ReviewRun (P0.txt §16, §18, §132)", () => {
  describe("they are genuinely different objects", () => {
    it("a request carries intent and no execution state", () => {
      const parsed = reviewRequestSchema.parse(request);
      const keys = Object.keys(parsed);
      for (const executionField of [
        "state",
        "attempt",
        "history",
        "failure",
        "startedAt",
        "completedAt",
      ]) {
        expect(keys).not.toContain(executionField);
      }
    });

    it("a run carries execution state and points back at its request", () => {
      const parsed = reviewRunSchema.parse(run);
      expect(parsed.requestId).toBe(REQUEST);
      expect(parsed.attempt).toBe(1);
      expect(parsed.state).toBe("queued");
    });

    it("one request supports many attempts, each keeping its own record", () => {
      // The retry case that makes the split necessary: without it, attempt 2
      // would overwrite attempt 1 and the failure would vanish from history.
      const attempt1 = reviewRunSchema.parse({
        ...run,
        id: ReviewRunIdOps.parse("0192f8a1-0000-7000-8000-00000000000a"),
        attempt: 1,
        state: "failed",
        history: [
          { from: "queued", to: "preparing", at: at(1) },
          { from: "preparing", to: "failed", at: at(2) },
        ],
        failure: {
          code: namespacedId("acalys.provider.unavailable"),
          message: "GitHub returned 503",
          retryability: "retryable",
          stage: "preparing",
        },
        startedAt: at(1),
        completedAt: at(2),
      });

      const attempt2 = reviewRunSchema.parse({
        ...run,
        id: ReviewRunIdOps.parse("0192f8a1-0000-7000-8000-00000000000b"),
        attempt: 2,
        state: "completed",
        history: [
          { from: "queued", to: "preparing", at: at(3) },
          { from: "preparing", to: "analyzing", at: at(4) },
          { from: "analyzing", to: "reviewing", at: at(5) },
          { from: "reviewing", to: "verifying", at: at(6) },
          { from: "verifying", to: "reconciling", at: at(7) },
          { from: "reconciling", to: "publishing", at: at(8) },
          { from: "publishing", to: "completed", at: at(9) },
        ],
        startedAt: at(3),
        completedAt: at(9),
      });

      // Both reference the same intent; neither erases the other.
      expect(attempt1.requestId).toBe(attempt2.requestId);
      expect(attempt1.attempt).not.toBe(attempt2.attempt);
      expect(attempt1.failure?.message).toBe("GitHub returned 503");
      expect(isRetryable(attempt1)).toBe(true);
      expect(isRunSettled(attempt2)).toBe(true);
    });
  });

  describe("execution policy (§17)", () => {
    it("maps /review to single and /deep-review to swarm", () => {
      expect(defaultExecutionPolicy("review")).toEqual({
        mode: "review",
        strategy: "single",
      });
      expect(defaultExecutionPolicy("deep_review")).toEqual({
        mode: "deep_review",
        strategy: "swarm",
      });
    });

    it("keeps mode and strategy separable", () => {
      // A future policy may route a very large /review to a swarm. Storing
      // only one field would lose either what the user asked for or what ran.
      expect(
        reviewRequestSchema.safeParse({
          ...request,
          execution: { mode: "review", strategy: "swarm" },
        }).success,
      ).toBe(true);
    });
  });

  describe("trigger vocabulary is provider-neutral (§20)", () => {
    it("accepts canonical triggers", () => {
      for (const trigger of [
        "pull_request_opened",
        "pull_request_updated",
        "manual",
        "cli",
        "ide",
        "api",
        "scheduled",
        "recheck",
        "configuration_changed",
      ] as const) {
        expect(
          reviewRequestSchema.safeParse({ ...request, trigger }).success,
        ).toBe(true);
      }
    });

    it("rejects a raw webhook event name", () => {
      // The adapter must map pull_request.synchronize -> pull_request_updated.
      expect(
        reviewRequestSchema.safeParse({
          ...request,
          trigger: "pull_request.synchronize",
        }).success,
      ).toBe(false);
    });
  });

  describe("idempotency (§47)", () => {
    const components = {
      organizationId: ORG,
      repositoryId: REPO,
      revisionKey: REVISION,
      mode: "review" as const,
      trigger: "pull_request_opened" as const,
      configSnapshotId: CONFIG,
    };

    it("is deterministic across key order", () => {
      const reordered = {
        trigger: components.trigger,
        configSnapshotId: components.configSnapshotId,
        organizationId: components.organizationId,
        mode: components.mode,
        revisionKey: components.revisionKey,
        repositoryId: components.repositoryId,
      };
      expect(reviewIdempotencyKey(components)).toBe(
        reviewIdempotencyKey(reordered),
      );
    });

    it("is stable across repeated calls", () => {
      const first = reviewIdempotencyKey(components);
      for (let index = 0; index < 1_000; index += 1) {
        expect(reviewIdempotencyKey(components)).toBe(first);
      }
    });

    it("collapses a duplicate webhook delivery to the same key", () => {
      // The point of §47: two deliveries of the same event must not create
      // two reviews. No timestamp participates, so they cannot differ.
      expect(reviewIdempotencyKey(components)).toBe(
        reviewIdempotencyKey({ ...components }),
      );
    });

    it("separates different revisions", () => {
      expect(reviewIdempotencyKey(components)).not.toBe(
        reviewIdempotencyKey({ ...components, revisionKey: "other" }),
      );
    });

    it("separates /review from /deep-review on the same revision", () => {
      expect(reviewIdempotencyKey(components)).not.toBe(
        reviewIdempotencyKey({ ...components, mode: "deep_review" }),
      );
    });

    it("separates a manual re-request from the automatic one", () => {
      expect(reviewIdempotencyKey(components)).not.toBe(
        reviewIdempotencyKey({ ...components, trigger: "manual" }),
      );
    });

    it("separates runs under different config snapshots", () => {
      const { configSnapshotId: _drop, ...withoutConfig } = components;
      expect(reviewIdempotencyKey(components)).not.toBe(
        reviewIdempotencyKey(withoutConfig),
      );
    });

    it("cannot be forged by a value containing a separator", () => {
      // Concatenation with a delimiter would let these two collide; canonical
      // JSON quoting makes that impossible.
      const a = reviewIdempotencyKey({ ...components, revisionKey: "a:b" });
      const b = reviewIdempotencyKey({ ...components, revisionKey: "a" });
      expect(a).not.toBe(b);
    });
  });

  describe("cross-field invariants (§107)", () => {
    it("rejects a request whose repository disagrees with its target", () => {
      // Would review one repository under another's tenancy and configuration.
      const result = reviewRequestSchema.safeParse({
        ...request,
        repositoryId: OTHER_REPO,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "must match the repository its target refers to",
        );
      }
    });

    it("rejects a revisionId on a non-pull-request target", () => {
      expect(
        reviewRequestSchema.safeParse({
          ...request,
          target: workingTreeTarget,
          revisionId: REVISION,
        }).success,
      ).toBe(false);
    });

    it("accepts a local review with no revision and no config snapshot", () => {
      const { revisionId: _r, configSnapshotId: _c, ...local } = request;
      expect(
        reviewRequestSchema.safeParse({
          ...local,
          target: workingTreeTarget,
          trigger: "cli",
          requestedBy: { kind: "human", displayName: "Ada" },
        }).success,
      ).toBe(true);
    });

    it("rejects a run whose repository disagrees with its target", () => {
      expect(
        reviewRunSchema.safeParse({ ...run, repositoryId: OTHER_REPO }).success,
      ).toBe(false);
    });
  });

  describe("run state consistency", () => {
    it("requires a failure when failed", () => {
      const result = reviewRunSchema.safeParse({
        ...run,
        state: "failed",
        completedAt: at(1),
        history: [{ from: "queued", to: "failed", at: at(1) }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) =>
            i.message.includes("must record why"),
          ),
        ).toBe(true);
      }
    });

    it("forbids a failure outside the failed state", () => {
      expect(
        reviewRunSchema.safeParse({
          ...run,
          state: "queued",
          failure: {
            code: namespacedId("acalys.provider.unavailable"),
            message: "x",
            retryability: "retryable",
          },
        }).success,
      ).toBe(false);
    });

    it("requires completedAt in a terminal state", () => {
      expect(
        reviewRunSchema.safeParse({
          ...run,
          state: "cancelled",
          history: [{ from: "queued", to: "cancelled", at: at(1) }],
        }).success,
      ).toBe(false);
    });

    it("forbids completedAt while still running", () => {
      expect(
        reviewRunSchema.safeParse({
          ...run,
          state: "analyzing",
          completedAt: at(5),
        }).success,
      ).toBe(false);
    });

    it("forbids completing before starting", () => {
      expect(
        reviewRunSchema.safeParse({
          ...run,
          state: "completed",
          startedAt: at(9),
          completedAt: at(2),
          history: [],
        }).success,
      ).toBe(false);
    });

    it("catches a state that disagrees with its history", () => {
      // The signature of a lost or partially-applied write.
      const drifted = reviewRunSchema.parse({
        ...run,
        state: "analyzing",
        history: [{ from: "queued", to: "preparing", at: at(1) }],
        startedAt: at(1),
      });

      expect(() => assertRunStateMatchesHistory(drifted)).toThrow(
        ValidationError,
      );
      expect(() => assertRunStateMatchesHistory(drifted)).toThrow(
        /'analyzing' but its history ends in 'preparing'/,
      );
    });

    it("accepts a run whose state matches its history", () => {
      const consistent = reviewRunSchema.parse({
        ...run,
        state: "preparing",
        history: [{ from: "queued", to: "preparing", at: at(1) }],
        startedAt: at(1),
      });
      expect(() => assertRunStateMatchesHistory(consistent)).not.toThrow();
    });
  });

  describe("retryability (§51, §74)", () => {
    const terminal = (
      state: "failed" | "cancelled" | "superseded",
      retryability?: "retryable" | "non_retryable",
    ) =>
      reviewRunSchema.parse({
        ...run,
        state,
        completedAt: at(5),
        history: [{ from: "queued", to: state, at: at(5) }],
        ...(state === "failed"
          ? {
              failure: {
                code: namespacedId("acalys.provider.unavailable"),
                message: "x",
                retryability: retryability ?? "retryable",
              },
            }
          : {}),
      });

    it("retries only a retryable failure", () => {
      expect(isRetryable(terminal("failed", "retryable"))).toBe(true);
      expect(isRetryable(terminal("failed", "non_retryable"))).toBe(false);
    });

    it("never retries a cancelled run — someone chose to stop", () => {
      expect(isRetryable(terminal("cancelled"))).toBe(false);
    });

    it("never retries a superseded run — the answer would be stale", () => {
      expect(isRetryable(terminal("superseded"))).toBe(false);
    });

    it("never retries a run still in flight", () => {
      expect(isRetryable(reviewRunSchema.parse(run))).toBe(false);
    });
  });

  it("rejects attempt 0 — attempts are 1-based", () => {
    expect(reviewRunSchema.safeParse({ ...run, attempt: 0 }).success).toBe(
      false,
    );
  });

  it("round-trips both contracts through JSON", () => {
    const parsedRequest = reviewRequestSchema.parse(request);
    expect(
      reviewRequestSchema.parse(JSON.parse(JSON.stringify(parsedRequest))),
    ).toEqual(parsedRequest);

    const parsedRun = reviewRunSchema.parse(run);
    expect(
      reviewRunSchema.parse(JSON.parse(JSON.stringify(parsedRun))),
    ).toEqual(parsedRun);
  });
});
