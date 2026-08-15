/**
 * One execution attempt (P0.txt §18, §71, §73, §74).
 *
 * A {@link ReviewRequest} is intent; a `ReviewRun` is one attempt to satisfy
 * it. The relationship is one-to-many:
 *
 *     ReviewRequest ──┬── run 1  attempt 1  failed      (provider 503)
 *                     ├── run 2  attempt 2  superseded  (revision 4 landed)
 *                     └── run 3  attempt 3  completed
 *
 * Several things force that shape (§18): retries, manual reruns, recovery
 * after a crash, and later shadow evaluation or alternate-model experiments,
 * where two runs execute the *same* request deliberately and their outputs are
 * compared. None of that is expressible if a request can only ever have one
 * execution.
 *
 * The run is where reproducibility is recorded (§72). Its snapshot fields —
 * revision, config snapshot, change manifest — say exactly what this attempt
 * consumed, so the question "what did run R actually analyze?" has an answer
 * that survives every later change to the repository or its configuration.
 */

import { z } from "zod";
import {
  organizationIdSchema,
  pullRequestRevisionIdSchema,
  repositoryIdSchema,
  reviewConfigSnapshotIdSchema,
  reviewRequestIdSchema,
  reviewRunIdSchema,
  type OrganizationId,
  type PullRequestRevisionId,
  type RepositoryId,
  type ReviewConfigSnapshotId,
  type ReviewRequestId,
  type ReviewRunId,
} from "../identity/ids.js";
import {
  reviewTargetSchema,
  targetRepositoryId,
  type ReviewTarget,
} from "../review-target/review-target.js";
import {
  reviewExecutionPolicySchema,
  type ReviewExecutionPolicy,
} from "./review-request.js";
import {
  isTerminalReviewRunState,
  reviewRunStateSchema,
  reviewRunTransitionSchema,
  type ReviewRunState,
  type ReviewRunTransition,
} from "./review-run-state.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { type Retryability, ValidationError } from "../errors/errors.js";
import { TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/** Schema version for this transported contract (§7). */
export const REVIEW_RUN_SCHEMA_VERSION = 1;

/**
 * Why a run failed, in a form safe to store and show.
 *
 * `code` is a namespaced id rather than free text so failures can be counted
 * and alerted on. `message` is operator-facing and must never carry a stack
 * trace, provider payload, or credential (§63) — the {@link SerializedError}
 * discipline applies here too.
 *
 * `retryability` is recorded on the run, not recomputed later, because it is
 * the *classification made at the time*: whether a later attempt is worthwhile
 * depends on what the failing component knew (§51).
 */
export interface ReviewRunFailure {
  /** e.g. `acalys.provider.unavailable`, `acalys.config.invalid`. */
  readonly code: NamespacedId;
  readonly message: string;
  readonly retryability: Retryability;
  /** Which stage broke, for triage. */
  readonly stage?: ReviewRunState | undefined;
}

export const reviewRunFailureSchema = z.strictObject({
  code: namespacedIdSchema,
  message: z.string().min(1).max(TEXT_LIMITS.summary),
  retryability: z.enum(["retryable", "non_retryable", "conditional"]),
  stage: reviewRunStateSchema.optional(),
});

/**
 * A concrete attempt to satisfy a review request.
 *
 * `state` is derived from `history` and stored alongside it — denormalized on
 * purpose, so "find running runs" is an indexed query rather than a scan that
 * replays every history. {@link assertRunStateMatchesHistory} keeps the two
 * honest.
 */
export interface ReviewRun {
  readonly schemaVersion: number;
  readonly id: ReviewRunId;
  readonly requestId: ReviewRequestId;
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
  readonly target: ReviewTarget;
  readonly revisionId?: PullRequestRevisionId | undefined;
  readonly execution: ReviewExecutionPolicy;
  /**
   * 1-based attempt number within this request.
   *
   * Distinct from a retry count: it identifies *this* attempt, so two
   * concurrent shadow runs of one request are distinguishable.
   */
  readonly attempt: number;
  readonly state: ReviewRunState;
  /** Append-only. The evidence for how the run progressed (§71). */
  readonly history: readonly ReviewRunTransition[];
  /** Configuration this attempt executed against (§39, §72). */
  readonly configSnapshotId?: ReviewConfigSnapshotId | undefined;
  /** Present only in a failed terminal state. */
  readonly failure?: ReviewRunFailure | undefined;
  readonly createdAt: Timestamp;
  /** When the run left `queued`. Absent while still queued. */
  readonly startedAt?: Timestamp | undefined;
  /** When the run reached a terminal state. Absent until settled. */
  readonly completedAt?: Timestamp | undefined;
}

export const reviewRunSchema = z
  .strictObject({
    schemaVersion: z
      .number()
      .int()
      .positive()
      .max(REVIEW_RUN_SCHEMA_VERSION, {
        error: `Unsupported ReviewRun schemaVersion; this build understands up to ${String(REVIEW_RUN_SCHEMA_VERSION)}`,
      }),
    id: reviewRunIdSchema,
    requestId: reviewRequestIdSchema,
    organizationId: organizationIdSchema,
    repositoryId: repositoryIdSchema,
    target: reviewTargetSchema,
    revisionId: pullRequestRevisionIdSchema.optional(),
    execution: reviewExecutionPolicySchema,
    attempt: z.number().int().positive({ error: "Attempts are 1-based" }),
    state: reviewRunStateSchema,
    history: z.array(reviewRunTransitionSchema).max(1_000),
    configSnapshotId: reviewConfigSnapshotIdSchema.optional(),
    failure: reviewRunFailureSchema.optional(),
    createdAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
  })
  .superRefine((run, ctx) => {
    // §107 — the run, its target, and its findings must all agree on which
    // repository is under review.
    if (run.repositoryId !== targetRepositoryId(run.target)) {
      ctx.addIssue({
        code: "custom",
        path: ["repositoryId"],
        message:
          "ReviewRun.repositoryId must match the repository its target refers to",
      });
    }

    // A failure without a failed state (or vice versa) is a contradiction the
    // UI and retry policy would both read wrongly.
    if (run.failure !== undefined && run.state !== "failed") {
      ctx.addIssue({
        code: "custom",
        path: ["failure"],
        message: `A failure may only be recorded in state 'failed', not '${run.state}'`,
      });
    }
    if (run.state === "failed" && run.failure === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["failure"],
        message: "A run in state 'failed' must record why",
      });
    }

    // A settled run must say when it settled; an unsettled one must not claim
    // to have. Either way round, a duration metric would be wrong.
    const settled = isTerminalReviewRunState(run.state);
    if (settled && run.completedAt === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: `A run in terminal state '${run.state}' must record completedAt`,
      });
    }
    if (!settled && run.completedAt !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: `completedAt must be absent while the run is still in '${run.state}'`,
      });
    }

    if (
      run.startedAt !== undefined &&
      run.completedAt !== undefined &&
      run.completedAt < run.startedAt
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A run cannot complete before it starts",
      });
    }
    if (run.startedAt !== undefined && run.startedAt < run.createdAt) {
      ctx.addIssue({
        code: "custom",
        path: ["startedAt"],
        message: "A run cannot start before it is created",
      });
    }

    if (run.revisionId !== undefined && run.target.kind !== "pull_request") {
      ctx.addIssue({
        code: "custom",
        path: ["revisionId"],
        message: `revisionId is only valid for a pull_request target, not '${run.target.kind}'`,
      });
    }
  });

/**
 * Checks that the denormalized `state` equals what `history` implies.
 *
 * Separate from the schema because it is a cross-field consistency rule the
 * *application service* enforces on write (§107) — a read path that has
 * already trusted its store should not pay to replay history on every load.
 *
 * @throws {ValidationError} when the two disagree, which means a lost or
 *   partially-applied write
 */
export function assertRunStateMatchesHistory(run: ReviewRun): void {
  const last = run.history.at(-1);
  const implied: ReviewRunState = last === undefined ? "queued" : last.to;

  if (implied !== run.state) {
    throw new ValidationError(
      `ReviewRun.state is '${run.state}' but its history ends in '${implied}'`,
      { details: { state: run.state, impliedState: implied } },
    );
  }
}

/** Whether the run has settled and will not transition again. */
export function isRunSettled(run: ReviewRun): boolean {
  return isTerminalReviewRunState(run.state);
}

/**
 * Whether the request may be attempted again.
 *
 * Only a `failed` run justifies a retry, and only when the failure was
 * classified retryable. `cancelled` means someone chose to stop, and
 * `superseded` means the answer would be stale on arrival — retrying either
 * would be doing work nobody wants (§51, §74).
 */
export function isRetryable(run: ReviewRun): boolean {
  return run.state === "failed" && run.failure?.retryability === "retryable";
}

/** Wall-clock duration in milliseconds, once settled. */
export function runDurationMillis(run: ReviewRun): number | undefined {
  if (run.startedAt === undefined || run.completedAt === undefined) {
    return undefined;
  }
  return (
    new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
  );
}
