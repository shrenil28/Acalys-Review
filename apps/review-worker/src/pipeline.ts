/**
 * A stored delivery becomes review history.
 *
 * This is the step the whole ingestion boundary exists to reach:
 *
 *     WebhookDelivery (bytes, authenticated, durable)
 *            ↓  parse — once, from the retained bytes
 *     PullRequest        current metadata
 *            ↓
 *     PullRequestRevision  immutable, keyed on head SHA
 *            ↓
 *     ReviewRequest      intent, keyed on idempotency
 *            ↓
 *     ReviewRun          one logical execution
 *
 * Every write converges, so running this twice on the same delivery produces
 * the same history rather than a second copy of it. That is what lets the
 * worker be crash-tolerant without any distributed-transaction machinery: it
 * simply re-runs.
 *
 * # Parsing happens here, not at the gateway
 *
 * The gateway stored the exact bytes and read only `action` from them. This
 * function re-reads those bytes and does the full parse. One parsing path, so
 * the gateway and the worker can never disagree about what arrived — and the
 * worker's view is reconstructible from the database alone, which is what makes
 * replay possible after a crash.
 */

import {
  NormalizationError,
  githubPullRequestEventSchema,
  isHandledAction,
  revisionTriggerFor,
  toActor,
  toReviewTarget,
  type GithubPullRequestEvent,
} from "@acalys/provider-github";
import type {
  EffectiveReviewPolicyEnvelope,
  ReviewIngestionStore,
} from "@acalys/database";
import { matchesGlob } from "@acalys/contracts/domain";

/**
 * The slice of a delivery the pipeline reads.
 *
 * Narrower than `WebhookDelivery` on purpose: the pipeline needs the event name
 * and the bytes, and nothing else. A narrow input is what keeps it replayable —
 * everything it uses is reconstructible from the database alone.
 */
export interface DeliveryForIngestion {
  readonly id: string;
  readonly event: string;
  readonly payload: Buffer;
}

/**
 * Why processing stopped, and whether trying again could help.
 *
 * The distinction decides whether a delivery is retried or dead-lettered, and
 * getting it wrong is expensive in both directions: retrying a permanent
 * failure burns the whole budget on work that fails identically every time,
 * and dead-lettering a transient one throws away a review GitHub will never
 * resend.
 */
export const OUTCOME_KINDS = [
  "ingested",
  "ignored",
  "retryable_failure",
  "permanent_failure",
] as const;

export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export type PipelineOutcome =
  | {
      readonly kind: "ingested";
      readonly pullRequestId: string;
      readonly revisionId: string;
      readonly requestId: string;
      readonly runId: string;
      /** Runs superseded because this revision is newer. */
      readonly supersededRunIds: readonly string[];
      /** True when this run itself answers a revision that is no longer latest. */
      readonly stale: boolean;
    }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "retryable_failure"; readonly errorCode: string }
  | { readonly kind: "permanent_failure"; readonly errorCode: string };

export interface PipelinePolicyResolver {
  resolveEffectivePolicy(
    organizationId: string,
    repositoryId: string,
  ): Promise<EffectiveReviewPolicyEnvelope | undefined>;
}

export interface PipelineOptions {
  readonly store: ReviewIngestionStore;
  /** Required by production composition; optional only for deterministic legacy tests. */
  readonly policy?: PipelinePolicyResolver | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * The idempotency key for a delivery: **review target + revision.**
 *
 * The full logical identity is four parts, and every one is load-bearing:
 *
 *     organizationId   the scope column — supplied by the store, not here
 *     provider         github | gitlab | …
 *     pull request     the provider's immutable id for the target
 *     head SHA         the provider's immutable name for the code
 *
 * `UNIQUE (idempotency_scope, idempotency_key)` therefore means
 * `(tenant) × (provider, target, revision)`.
 *
 * # Why each part must stay
 *
 * **Head SHA alone is not identity.** One commit can legitimately be the head
 * of several targets — a stacked pull request, a branch opened twice, a commit
 * cherry-picked into a second PR:
 *
 *     PR #10 @ SHA X     ─┐  must remain
 *     PR #27 @ SHA X     ─┘  two distinct reviews
 *
 * Dropping the pull request id would merge them and silently review only one.
 * That is the "optimization" this comment exists to prevent, and
 * `end-to-end.test.ts` asserts against it.
 *
 * **The tenant scope is separate and equally required.** A global key space
 * would let one organization's request suppress another's — a cross-tenant leak
 * wearing the costume of a deduplication optimization.
 *
 * # What it deliberately does NOT include
 *
 * The delivery id, the action, and the trigger. Two different deliveries about
 * one push — an `opened` followed by a `synchronize` for the same head, a
 * GitHub redelivery, an operator replaying through a second endpoint — describe
 * the same target at the same revision and must resolve to one request.
 *
 * # Reruns are not deduplication
 *
 * An explicit rerun does not bypass this key; it reuses the request and adds a
 * `ReviewRun` at `attempt + 1`. That is the P1-D separation holding:
 *
 *     ReviewRequest (one, keyed here)
 *       ├── ReviewRun attempt 1
 *       └── ReviewRun attempt 2   ← the rerun
 */
export function idempotencyKeyFor(event: GithubPullRequestEvent): string {
  // Written as named parts so the composition is visible at the call site and
  // a future edit cannot quietly drop one.
  const provider = "github";
  const target = String(event.pull_request.id);
  const revision = event.pull_request.head.sha;
  return `${provider}:${target}:${revision}`;
}

/**
 * Processes one stored delivery.
 *
 * Pure with respect to time and identity: everything it needs comes from the
 * delivery's retained bytes and the store. No network call, no clock read
 * except through `now`, so a replay months later produces the same result.
 */
export async function ingestDelivery(
  delivery: DeliveryForIngestion,
  options: PipelineOptions,
): Promise<PipelineOutcome> {
  const now = options.now ?? (() => new Date());
  const store = options.store;

  // Only pull_request events reach here with work scheduled; anything else is
  // a scheduling bug rather than a payload problem.
  if (delivery.event !== "pull_request") {
    return { kind: "ignored", reason: `unsupported event: ${delivery.event}` };
  }

  let event: GithubPullRequestEvent;
  try {
    event = githubPullRequestEventSchema.parse(
      JSON.parse(delivery.payload.toString("utf8")) as unknown,
    );
  } catch {
    // The bytes passed the HMAC, so this is not forgery — it is GitHub having
    // changed a shape, or a payload this build cannot read. It will fail
    // identically on every retry, so spending the budget is waste.
    return {
      kind: "permanent_failure",
      errorCode: "acalys.error.payload-unreadable",
    };
  }

  if (!isHandledAction(event.action)) {
    return { kind: "ignored", reason: `unhandled action: ${event.action}` };
  }

  const trigger = revisionTriggerFor(event);

  const repository = await store.findRepository(
    "github",
    String(event.repository.id),
  );
  if (repository === undefined) {
    // Not necessarily permanent: a delivery can outrun installation sync and
    // arrive before the repository row exists. Retrying gives sync time to
    // catch up; the attempt budget bounds how long that is worth.
    return {
      kind: "retryable_failure",
      errorCode: "acalys.error.repository-not-resolved",
    };
  }

  const scope = {
    organizationId: repository.organizationId,
    repositoryId: repository.repositoryId,
  };

  let admitted: EffectiveReviewPolicyEnvelope | undefined;
  try {
    admitted = await options.policy?.resolveEffectivePolicy(
      scope.organizationId,
      scope.repositoryId,
    );
  } catch {
    return { kind: "retryable_failure", errorCode: "acalys.error.storage" };
  }
  if (options.policy !== undefined && admitted === undefined) {
    return {
      kind: "retryable_failure",
      errorCode: "acalys.error.repository-policy-not-resolved",
    };
  }

  try {
    const pull = await store.upsertPullRequest(scope, {
      providerExternalId: String(event.pull_request.id),
      number: event.pull_request.number,
      description: event.pull_request.body ?? null,
      title: event.pull_request.title,
      author: toActor(event.pull_request.user),
      state:
        event.pull_request.merged === true ||
        event.pull_request.merged_at != null
          ? "merged"
          : event.pull_request.state === "closed"
            ? "closed"
            : "open",
      draft: event.pull_request.draft ?? false,
      labels: (event.pull_request.labels ?? []).map((label) => label.name),
      createdAt: new Date(event.pull_request.created_at),
      updatedAt: new Date(event.pull_request.updated_at),
    });

    if (admitted !== undefined) {
      const policy = admitted.policy;
      if (event.action === "closed") {
        if (policy.organizationConfig.behavior.abortOnClose) {
          await store.cancelPrePublicationRuns(pull.id);
        }
        return { kind: "ignored", reason: "pull request closed" };
      }
      if (policy.repositoryLifecycle !== "enabled") {
        return {
          kind: "ignored",
          reason: `repository reviews ${policy.repositoryLifecycle}`,
        };
      }
      if (!policy.organizationConfig.behavior.autoReview) {
        return { kind: "ignored", reason: "automatic review disabled" };
      }
      if (
        (event.pull_request.draft ?? false) &&
        !policy.organizationConfig.behavior.autoReviewDrafts
      ) {
        return { kind: "ignored", reason: "draft reviews disabled" };
      }
      if (
        event.action === "synchronize" &&
        !policy.organizationConfig.behavior.autoIncrementalReview
      ) {
        return { kind: "ignored", reason: "incremental reviews disabled" };
      }
      const bases = policy.organizationConfig.behavior.baseBranches;
      if (
        bases.length > 0 &&
        !bases.some((pattern) =>
          matchesGlob(pattern, event.pull_request.base.ref),
        )
      ) {
        return {
          kind: "ignored",
          reason: "base branch excluded by review policy",
        };
      }
    }

    if (trigger === undefined) {
      return {
        kind: "ignored",
        reason: `no revision for action: ${event.action}`,
      };
    }

    const revision = await store.upsertRevision(scope, {
      pullRequestId: pull.id,
      headSha: event.pull_request.head.sha,
      headRef: event.pull_request.head.ref,
      baseSha: event.pull_request.base.sha,
      baseRef: event.pull_request.base.ref,
      // Deliberately null. GitHub's `merge_commit_sha` is an async *test merge
      // commit* that exists in neither branch; using it as the diff base would
      // attribute the base branch's commits to this change's author. The real
      // merge base is resolved against the Git repository, later.
      mergeBaseSha: null,
      trigger,
      createdAt: now(),
    });

    const request = await store.upsertReviewRequest(scope, {
      pullRequestId: pull.id,
      revisionId: revision.id,
      target: toReviewTarget(event, {
        organizationId: scope.organizationId as never,
        repositoryId: scope.repositoryId as never,
      }),
      trigger:
        event.action === "opened"
          ? "pull_request_opened"
          : "pull_request_updated",
      requestedBy: { kind: "system", component: "acalys.webhook-gateway" },
      executionMode: "review",
      executionStrategy: "single",
      idempotencyKey: idempotencyKeyFor(event),
      requestedAt: now(),
      ...(admitted === undefined
        ? {}
        : {
            policySnapshot: admitted.policy,
            policyFingerprint: admitted.fingerprint,
          }),
    });

    const run = await store.upsertReviewRun(scope, {
      requestId: request.id,
      revisionId: revision.id,
      // Always 1 here. A crash produces another *job* attempt, and this call
      // converges onto the same run. Attempt 2 exists only when the domain asks
      // for a rerun.
      attempt: 1,
      executionMode: "review",
      executionStrategy: "single",
      createdAt: now(),
    });

    const isLatest = await store.isLatestRevision(pull.id, revision.id);

    // Supersede older live runs for this pull request. Done *after* the run
    // exists so the newest run is never itself a candidate, and skipped when
    // this delivery is stale — an old delivery must not cancel newer work.
    const supersededRunIds = isLatest
      ? await store.supersedeOlderRuns(pull.id, run.id)
      : [];

    if (!isLatest) {
      // A run answering a question the repository has already moved past. It is
      // recorded and superseded rather than skipped: the push happened and the
      // request was real, and skipping would leave no trace that the platform
      // decided not to review it.
      await store.transition(run.id, run.state, "superseded");
    }

    return {
      kind: "ingested",
      pullRequestId: pull.id,
      revisionId: revision.id,
      requestId: request.id,
      runId: run.id,
      supersededRunIds,
      stale: !isLatest,
    };
  } catch (error) {
    if (error instanceof NormalizationError) {
      return {
        kind: "permanent_failure",
        errorCode: "acalys.error.normalization-failed",
      };
    }
    // A database error, a lock timeout, a connection reset. Transient by
    // default: assuming permanence here would discard reviews for a blip.
    return { kind: "retryable_failure", errorCode: "acalys.error.storage" };
  }
}

/** Whether an outcome means the job should be tried again. */
export function isRetryable(outcome: PipelineOutcome): boolean {
  return outcome.kind === "retryable_failure";
}

/** Whether an outcome settled the delivery, successfully or not. */
export function isSettled(outcome: PipelineOutcome): boolean {
  return outcome.kind === "ingested" || outcome.kind === "ignored";
}
