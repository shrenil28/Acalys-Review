/**
 * Intent to review (P0.txt §16, §17, §20, §47).
 *
 * A `ReviewRequest` says **what should happen**:
 *
 *   > Review PR #184 at revision 3, in deep mode, under config snapshot C78.
 *
 * It says nothing about whether that has happened, how many times it was
 * attempted, or how it went. That is {@link ReviewRun}, and keeping the two
 * apart is the design rule this module exists to enforce (§132,
 * "ReviewRequest != ReviewRun").
 *
 * Collapsing them looks harmless until the first retry:
 *
 *     request  ──> run #1  failed (provider timeout)
 *              ──> run #2  completed
 *
 * With one object, run #2 overwrites run #1 and the failure vanishes from
 * history. With two, the request is a stable thing to reference — from a
 * webhook, from a UI timeline, from a rerun button — while each attempt keeps
 * its own record. Everything later depends on this: `/review`, deep review,
 * retries, incremental review, and the frontend timeline.
 *
 * A request is **immutable** once created. Re-requesting under different
 * configuration is a new request, not an edit — otherwise a run could no
 * longer prove what it was asked to do.
 */

import { z } from "zod";
import {
  organizationIdSchema,
  pullRequestRevisionIdSchema,
  repositoryIdSchema,
  reviewConfigSnapshotIdSchema,
  reviewRequestIdSchema,
  type OrganizationId,
  type PullRequestRevisionId,
  type RepositoryId,
  type ReviewConfigSnapshotId,
  type ReviewRequestId,
} from "../identity/ids.js";
import {
  reviewTargetSchema,
  type ReviewTarget,
} from "../review-target/review-target.js";
import { actorSchema, type Actor } from "../actor/actor.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { canonicalJson } from "../primitives/canonical-json.js";
import { TEXT_LIMITS } from "../primitives/limits.js";

/** Schema version for this transported contract (§7). */
export const REVIEW_REQUEST_SCHEMA_VERSION = 1;

/**
 * Why the review exists (§20).
 *
 * Provider-neutral: an adapter converts GitHub's `pull_request.synchronize`
 * and GitLab's equivalent into `pull_request_updated`. A webhook event name
 * never reaches the domain — that is the §1 boundary applied to triggers.
 */
export const REVIEW_TRIGGERS = [
  "pull_request_opened",
  "pull_request_updated",
  "manual",
  "cli",
  "ide",
  "api",
  "scheduled",
  "recheck",
  "configuration_changed",
] as const;

export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

export const reviewTriggerSchema = z.enum(REVIEW_TRIGGERS);

/**
 * What the user asked for — the surface vocabulary (§17).
 *
 * `/review` and `/deep-review` are the two commands a user types.
 */
export const REVIEW_EXECUTION_MODES = ["review", "deep_review"] as const;
export type ReviewExecutionMode = (typeof REVIEW_EXECUTION_MODES)[number];

/**
 * How the platform will run it — the internal vocabulary (§17).
 *
 * `single` uses one reviewer agent; `swarm` fans out to several and
 * aggregates their candidates into one finding set (§113).
 */
export const REVIEW_EXECUTION_STRATEGIES = ["single", "swarm"] as const;
export type ReviewExecutionStrategy =
  (typeof REVIEW_EXECUTION_STRATEGIES)[number];

/**
 * Mode and strategy together.
 *
 * They are separate fields because they answer different questions and will
 * diverge: a future policy might route a very large `/review` to a swarm for
 * throughput without the user ever typing `/deep-review`. Storing only the
 * mode would make that invisible in the record; storing only the strategy
 * would lose what the user actually asked for.
 *
 * The §17 invariant — **`/review` → single, `/deep-review` → swarm** — is the
 * default mapping, and {@link defaultExecutionPolicy} is the single place it
 * lives.
 *
 * Critically, mode does **not** change finding semantics. Severity, categories,
 * verification, and evidence rules are identical in both; a swarm produces
 * more candidates, not different kinds of truth (§17, §132).
 */
export interface ReviewExecutionPolicy {
  readonly mode: ReviewExecutionMode;
  readonly strategy: ReviewExecutionStrategy;
}

export const reviewExecutionPolicySchema = z.strictObject({
  mode: z.enum(REVIEW_EXECUTION_MODES),
  strategy: z.enum(REVIEW_EXECUTION_STRATEGIES),
});

/** The §17 mapping, in one place. */
export function defaultExecutionPolicy(
  mode: ReviewExecutionMode,
): ReviewExecutionPolicy {
  return {
    mode,
    strategy: mode === "deep_review" ? "swarm" : "single",
  };
}

/**
 * Scoped idempotency (§47).
 *
 * `scope` namespaces the key so two subsystems cannot collide on the same
 * string — a webhook delivery id and a CLI invocation id may look alike and
 * mean nothing to each other.
 */
export interface IdempotencyContext {
  readonly key: string;
  readonly scope: string;
}

export const idempotencyContextSchema = z.strictObject({
  key: z.string().min(1).max(TEXT_LIMITS.identifier),
  scope: z.string().min(1).max(TEXT_LIMITS.identifier),
});

/**
 * Intent to review one revision, under one configuration, for one reason.
 *
 * Immutable. `configSnapshotId` pins the configuration so the request stays
 * meaningful even after the repository's `.acalys.yaml` changes tomorrow
 * (§39, §72) — without it, "what was this run asked to do?" would be
 * unanswerable a day later.
 */
export interface ReviewRequest {
  readonly schemaVersion: number;
  readonly id: ReviewRequestId;
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
  readonly target: ReviewTarget;
  /** Present for pull-request reviews; absent for local ones (§112). */
  readonly revisionId?: PullRequestRevisionId | undefined;
  readonly trigger: ReviewTrigger;
  readonly requestedBy: Actor;
  readonly execution: ReviewExecutionPolicy;
  /** Frozen configuration this request runs under (§39). */
  readonly configSnapshotId?: ReviewConfigSnapshotId | undefined;
  readonly idempotency: IdempotencyContext;
  readonly requestedAt: Timestamp;
}

export const reviewRequestSchema = z
  .strictObject({
    schemaVersion: z
      .number()
      .int()
      .positive()
      .max(REVIEW_REQUEST_SCHEMA_VERSION, {
        error: `Unsupported ReviewRequest schemaVersion; this build understands up to ${String(REVIEW_REQUEST_SCHEMA_VERSION)}`,
      }),
    id: reviewRequestIdSchema,
    organizationId: organizationIdSchema,
    repositoryId: repositoryIdSchema,
    target: reviewTargetSchema,
    revisionId: pullRequestRevisionIdSchema.optional(),
    trigger: reviewTriggerSchema,
    requestedBy: actorSchema,
    execution: reviewExecutionPolicySchema,
    configSnapshotId: reviewConfigSnapshotIdSchema.optional(),
    idempotency: idempotencyContextSchema,
    requestedAt: timestampSchema,
  })
  .superRefine((request, ctx) => {
    // §107 — a request whose repository disagrees with its target's would
    // review one repository under another's configuration and tenancy. Pure
    // schemas can express this one because both fields are present here.
    if (request.repositoryId !== request.target.repositoryId) {
      ctx.addIssue({
        code: "custom",
        path: ["repositoryId"],
        message:
          "ReviewRequest.repositoryId must match the repository its target refers to",
      });
    }
    // A revision only exists for a pull request. Attaching one to a
    // working-tree review would claim a provenance that is not there.
    if (
      request.revisionId !== undefined &&
      request.target.kind !== "pull_request"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["revisionId"],
        message: `revisionId is only valid for a pull_request target, not '${request.target.kind}'`,
      });
    }
  });

/**
 * The components that decide whether two requests are the same request (§47).
 *
 * Deliberately **excludes** time and actor. Two identical webhook deliveries
 * arrive milliseconds apart with different ids; including a timestamp would
 * make every duplicate look novel, which is exactly the deduplication failure
 * §47 warns about. It also excludes the trigger's *identity* while keeping its
 * class, so a `manual` re-request after an automatic one is genuinely a new
 * request rather than a duplicate.
 */
export interface ReviewIdempotencyComponents {
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
  /** Revision for a PR review; the head commit otherwise. */
  readonly revisionKey: string;
  readonly mode: ReviewExecutionMode;
  readonly trigger: ReviewTrigger;
  readonly configSnapshotId?: ReviewConfigSnapshotId | undefined;
}

/**
 * Builds a deterministic idempotency key.
 *
 * Uses {@link canonicalJson} rather than string concatenation so the key is
 * unambiguous — concatenating with a separator lets two different component
 * sets collide if a value happens to contain the separator — and stable
 * regardless of property order (§58).
 *
 * The result is plain readable text, not a hash: a duplicate-suppression
 * conflict is far easier to debug when the key says which revision and mode
 * collided. Callers that need a fixed-width column can hash it with a
 * {@link ContentHasher}.
 */
export function reviewIdempotencyKey(
  components: ReviewIdempotencyComponents,
): string {
  return canonicalJson({
    organizationId: components.organizationId,
    repositoryId: components.repositoryId,
    revisionKey: components.revisionKey,
    mode: components.mode,
    trigger: components.trigger,
    ...(components.configSnapshotId === undefined
      ? {}
      : { configSnapshotId: components.configSnapshotId }),
  });
}
