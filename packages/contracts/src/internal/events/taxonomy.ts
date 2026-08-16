/**
 * The domain event taxonomy (P0.txt §48).
 *
 * §48's constraint on *what belongs here* is the one that matters: "avoid
 * overproducing tiny internal implementation events — events should represent
 * meaningful domain transitions."
 *
 * The test is whether a fact would still be interesting to someone who did not
 * write the worker that emitted it. `review.run.state_changed` is: it is the
 * lifecycle. `review.run.tool_invoked` is not — it is a worker's internal step,
 * and publishing it would make every consumer's exhaustive switch churn on a
 * refactor that changed no domain behaviour.
 *
 * # Payloads are references, not entities
 *
 * A payload carries ids and the few fields a consumer needs to route on. It
 * does not embed the entity, for two reasons that both bite later:
 *
 * - An event is **immutable**, an entity is not. Embedding a `ReviewFinding`
 *   freezes a copy that is wrong the moment the finding is resolved, and a
 *   consumer reading the event has no way to know which it holds.
 * - Events are replayed, stored, and shipped between processes (§67). A
 *   `ChangeManifest` for a 5000-file change would be megabytes, in every
 *   subscriber's queue, forever.
 *
 * So `finding.published` says *which* finding, plus severity and category so a
 * notification rule can filter without a database round-trip. The finding
 * itself is fetched.
 *
 * # Naming (§106)
 *
 * `noun.past_tense_verb`, dotted, always past tense — an event is a fact that
 * already happened (§77). `review.run.started`, never `review.run.start`.
 */

import { z } from "zod";
import {
  candidateFindingIdSchema,
  conversationIdSchema,
  conversationMessageIdSchema,
  findingIdSchema,
  preMergeCheckResultIdSchema,
  pullRequestIdSchema,
  pullRequestRevisionIdSchema,
  repositoryIdSchema,
  reviewRequestIdSchema,
  reviewRunIdSchema,
} from "../../domain/identity/ids.js";
import { reviewRunStateSchema } from "../../domain/review/review-run-state.js";
import {
  findingCategorySchema,
  findingSeveritySchema,
} from "../../domain/finding/taxonomy.js";
import { preMergeCheckStatusSchema } from "../../domain/premerge/premerge.js";
import { reviewDecisionSchema } from "../../domain/output/review-summary.js";
import { RETRYABILITIES } from "../../domain/errors/errors.js";
import { namespacedIdSchema } from "../../domain/primitives/namespaced-id.js";
import { TEXT_LIMITS } from "../../domain/primitives/limits.js";
import { domainEventSchema } from "./envelope.js";

/**
 * Every event type the platform emits.
 *
 * A closed union (§79): these are platform invariants, and a consumer must be
 * able to switch exhaustively over them. Tenant-extensible identifiers —
 * check ids, tool ids — are namespaced strings *inside* payloads, which is
 * where extensibility belongs.
 */
export const DOMAIN_EVENT_TYPES = [
  "review.requested",
  "review.run.queued",
  "review.run.started",
  "review.run.state_changed",
  "review.run.completed",
  "review.run.failed",
  "repository.revision.created",
  "change_manifest.created",
  "finding.candidate_created",
  "finding.verified",
  "finding.rejected",
  "finding.published",
  "finding.resolved",
  "finding.dismissed",
  "finding.superseded",
  "conversation.message_created",
  "premerge.check_completed",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
export const domainEventTypeSchema = z.enum(DOMAIN_EVENT_TYPES);

/**
 * Fields present on every review-scoped payload.
 *
 * Repeated deliberately in each payload rather than hoisted into the envelope:
 * they are what a subscriber filters and partitions on, and a consumer should
 * not have to know which events happen to be review-scoped to find them.
 */
const reviewScope = {
  repositoryId: repositoryIdSchema,
  reviewRunId: reviewRunIdSchema,
} as const;

// ---------------------------------------------------------------------------
// Review lifecycle
// ---------------------------------------------------------------------------

export const reviewRequestedEventSchema = domainEventSchema(
  "review.requested",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    reviewRequestId: reviewRequestIdSchema,
    // Absent for a working-tree target, which has no pull request (§112).
    pullRequestId: pullRequestIdSchema.optional(),
    revisionId: pullRequestRevisionIdSchema.optional(),
  }),
);

export const reviewRunQueuedEventSchema = domainEventSchema(
  "review.run.queued",
  z.strictObject({
    ...reviewScope,
    reviewRequestId: reviewRequestIdSchema,
    /** Attempt number. A retry is a new run of the same request (§20). */
    attempt: z.number().int().positive(),
  }),
);

export const reviewRunStartedEventSchema = domainEventSchema(
  "review.run.started",
  z.strictObject(reviewScope),
);

export const reviewRunStateChangedEventSchema = domainEventSchema(
  "review.run.state_changed",
  z.strictObject({
    ...reviewScope,
    from: reviewRunStateSchema,
    to: reviewRunStateSchema,
  }),
);

export const reviewRunCompletedEventSchema = domainEventSchema(
  "review.run.completed",
  z.strictObject({
    ...reviewScope,
    decision: reviewDecisionSchema.optional(),
    findingCount: z.number().int().nonnegative(),
    /** Wall-clock duration, for billing and evaluation (§117, §118). */
    durationMs: z.number().int().nonnegative(),
  }),
);

export const reviewRunFailedEventSchema = domainEventSchema(
  "review.run.failed",
  z.strictObject({
    ...reviewScope,
    /** The error's stable code. Never a message, and never a stack (§125). */
    errorCode: namespacedIdSchema,
    /** Whether a retry could succeed — what a supervisor routes on. */
    retryability: z.enum(RETRYABILITIES),
  }),
);

// ---------------------------------------------------------------------------
// Repository and change
// ---------------------------------------------------------------------------

export const repositoryRevisionCreatedEventSchema = domainEventSchema(
  "repository.revision.created",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    pullRequestId: pullRequestIdSchema,
    revisionId: pullRequestRevisionIdSchema,
    sequence: z.number().int().positive(),
  }),
);

export const changeManifestCreatedEventSchema = domainEventSchema(
  "change_manifest.created",
  z.strictObject({
    ...reviewScope,
    fileCount: z.number().int().nonnegative(),
    /** True when the change exceeded limits and was sampled (§97). */
    truncated: z.boolean(),
  }),
);

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * The shape shared by every published-finding lifecycle event.
 *
 * `severity` and `category` travel with the event so a notification rule can
 * filter on them without loading the finding — the one deliberate exception to
 * "payloads carry references only", and the reason it is worth making.
 */
const findingScope = {
  ...reviewScope,
  findingId: findingIdSchema,
  severity: findingSeveritySchema,
  category: findingCategorySchema,
} as const;

export const findingCandidateCreatedEventSchema = domainEventSchema(
  "finding.candidate_created",
  z.strictObject({
    ...reviewScope,
    candidateFindingId: candidateFindingIdSchema,
    /** A *proposal*, not a verdict — a candidate is unverified (§27). */
    proposedSeverity: findingSeveritySchema,
    category: findingCategorySchema,
    producedBy: namespacedIdSchema,
  }),
);

export const findingVerifiedEventSchema = domainEventSchema(
  "finding.verified",
  z.strictObject({
    ...findingScope,
    candidateFindingId: candidateFindingIdSchema,
    confidenceScore: z.number().min(0).max(1),
  }),
);

export const findingRejectedEventSchema = domainEventSchema(
  "finding.rejected",
  // Carries the *candidate* id, not a finding id: a rejected candidate never
  // became a finding, and minting one to describe its rejection would put a
  // finding nobody should see into every consumer's store (§27, §107).
  z.strictObject({
    ...reviewScope,
    candidateFindingId: candidateFindingIdSchema,
    reason: z.string().min(1).max(TEXT_LIMITS.summary),
  }),
);

export const findingPublishedEventSchema = domainEventSchema(
  "finding.published",
  z.strictObject(findingScope),
);

export const findingResolvedEventSchema = domainEventSchema(
  "finding.resolved",
  z.strictObject({
    ...findingScope,
    /** The revision that fixed it, when the platform could determine one. */
    revisionId: pullRequestRevisionIdSchema.optional(),
  }),
);

export const findingDismissedEventSchema = domainEventSchema(
  "finding.dismissed",
  z.strictObject({
    ...findingScope,
    reason: z.string().min(1).max(TEXT_LIMITS.summary).optional(),
  }),
);

export const findingSupersededEventSchema = domainEventSchema(
  "finding.superseded",
  z.strictObject({
    ...findingScope,
    /** The run that replaced it. */
    supersededByRunId: reviewRunIdSchema,
  }),
);

// ---------------------------------------------------------------------------
// Conversation and pre-merge
// ---------------------------------------------------------------------------

export const conversationMessageCreatedEventSchema = domainEventSchema(
  "conversation.message_created",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    conversationId: conversationIdSchema,
    messageId: conversationMessageIdSchema,
    /** Whether a human wrote it — what decides if anyone needs to reply. */
    authoredByHuman: z.boolean(),
  }),
);

export const preMergeCheckCompletedEventSchema = domainEventSchema(
  "premerge.check_completed",
  z.strictObject({
    ...reviewScope,
    resultId: preMergeCheckResultIdSchema,
    checkId: namespacedIdSchema,
    status: preMergeCheckStatusSchema,
    blocking: z.boolean(),
  }),
);

/**
 * Every event, as one discriminated union.
 *
 * Discriminated on `type`, so `assertNever` makes a consumer's switch
 * exhaustive at compile time (§85): adding an event to the taxonomy breaks
 * every handler that has not considered it, which is the point.
 */
export const anyDomainEventSchema = z.discriminatedUnion("type", [
  reviewRequestedEventSchema,
  reviewRunQueuedEventSchema,
  reviewRunStartedEventSchema,
  reviewRunStateChangedEventSchema,
  reviewRunCompletedEventSchema,
  reviewRunFailedEventSchema,
  repositoryRevisionCreatedEventSchema,
  changeManifestCreatedEventSchema,
  findingCandidateCreatedEventSchema,
  findingVerifiedEventSchema,
  findingRejectedEventSchema,
  findingPublishedEventSchema,
  findingResolvedEventSchema,
  findingDismissedEventSchema,
  findingSupersededEventSchema,
  conversationMessageCreatedEventSchema,
  preMergeCheckCompletedEventSchema,
]);

export type AnyDomainEvent = z.output<typeof anyDomainEventSchema>;

/** One event, narrowed by its type. */
export type DomainEventOf<TType extends DomainEventType> = Extract<
  AnyDomainEvent,
  { readonly type: TType }
>;

export type ReviewRequestedEvent = DomainEventOf<"review.requested">;
export type ReviewRunQueuedEvent = DomainEventOf<"review.run.queued">;
export type ReviewRunStartedEvent = DomainEventOf<"review.run.started">;
export type ReviewRunStateChangedEvent =
  DomainEventOf<"review.run.state_changed">;
export type ReviewRunCompletedEvent = DomainEventOf<"review.run.completed">;
export type ReviewRunFailedEvent = DomainEventOf<"review.run.failed">;
export type RepositoryRevisionCreatedEvent =
  DomainEventOf<"repository.revision.created">;
export type ChangeManifestCreatedEvent =
  DomainEventOf<"change_manifest.created">;
export type FindingCandidateCreatedEvent =
  DomainEventOf<"finding.candidate_created">;
export type FindingVerifiedEvent = DomainEventOf<"finding.verified">;
export type FindingRejectedEvent = DomainEventOf<"finding.rejected">;
export type FindingPublishedEvent = DomainEventOf<"finding.published">;
export type FindingResolvedEvent = DomainEventOf<"finding.resolved">;
export type FindingDismissedEvent = DomainEventOf<"finding.dismissed">;
export type FindingSupersededEvent = DomainEventOf<"finding.superseded">;
export type ConversationMessageCreatedEvent =
  DomainEventOf<"conversation.message_created">;
export type PreMergeCheckCompletedEvent =
  DomainEventOf<"premerge.check_completed">;

/**
 * Every event schema, keyed by type.
 *
 * Frozen and exhaustive by construction: `Record<DomainEventType, …>` means
 * adding a type to {@link DOMAIN_EVENT_TYPES} without registering its schema
 * is a compile error, so the union and the registry cannot drift.
 */
export const DOMAIN_EVENT_SCHEMAS = Object.freeze({
  "review.requested": reviewRequestedEventSchema,
  "review.run.queued": reviewRunQueuedEventSchema,
  "review.run.started": reviewRunStartedEventSchema,
  "review.run.state_changed": reviewRunStateChangedEventSchema,
  "review.run.completed": reviewRunCompletedEventSchema,
  "review.run.failed": reviewRunFailedEventSchema,
  "repository.revision.created": repositoryRevisionCreatedEventSchema,
  "change_manifest.created": changeManifestCreatedEventSchema,
  "finding.candidate_created": findingCandidateCreatedEventSchema,
  "finding.verified": findingVerifiedEventSchema,
  "finding.rejected": findingRejectedEventSchema,
  "finding.published": findingPublishedEventSchema,
  "finding.resolved": findingResolvedEventSchema,
  "finding.dismissed": findingDismissedEventSchema,
  "finding.superseded": findingSupersededEventSchema,
  "conversation.message_created": conversationMessageCreatedEventSchema,
  "premerge.check_completed": preMergeCheckCompletedEventSchema,
} satisfies Record<DomainEventType, unknown>);
