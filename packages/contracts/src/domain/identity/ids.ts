/**
 * Every entity identifier in the platform, defined exactly once (P0.txt §5, §99).
 *
 * This module is the sole owner of `*Id` types. A second `RepositoryId`
 * declared in a provider package would be structurally identical and therefore
 * silently interchangeable — which is precisely the class of bug branding
 * exists to prevent. Import from here; never redeclare.
 *
 * **UUIDv7**, not v4 (§5). v7 embeds a 48-bit big-endian millisecond timestamp
 * in its high bits, which buys two properties a review platform cares about:
 *
 * - **Sortable.** Ids sort chronologically as strings, so "the most recent
 *   runs for this repository" is an index range scan rather than a sort on a
 *   separate column. With v4, every insert lands at a random point in a
 *   B-tree, fragmenting the index.
 * - **Distributed.** Generated independently in an API process, a worker, or a
 *   webhook gateway with no coordination and no collision risk.
 *
 * Ids are opaque to consumers. Nothing outside this module may parse a
 * timestamp back out of one: that would couple callers to the id format and
 * make migrating away from v7 a breaking change.
 */

import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { unsafeBrand, type Brand } from "../primitives/brand.js";
import { ValidationError } from "../errors/errors.js";
import { quoteValue } from "../primitives/format.js";

// -------------------------------------------------------------------------
// Identifier types
// -------------------------------------------------------------------------

/** Tenant. The root of every ownership chain (§9). */
export type OrganizationId = Brand<string, "OrganizationId">;
/** A human principal. */
export type UserId = Brand<string, "UserId">;
/** A user's membership of an organization. */
export type MembershipId = Brand<string, "MembershipId">;
/** An installation or credential link to a source provider. */
export type ProviderConnectionId = Brand<string, "ProviderConnectionId">;

/** Acalys repository identity — distinct from the provider's own id (§10). */
export type RepositoryId = Brand<string, "RepositoryId">;

/** A pull/merge request, stable across all its revisions (§14). */
export type PullRequestId = Brand<string, "PullRequestId">;
/** One immutable snapshot of a pull request's base/head (§15). */
export type PullRequestRevisionId = Brand<string, "PullRequestRevisionId">;

/** Intent to review (§16). */
export type ReviewRequestId = Brand<string, "ReviewRequestId">;
/** One concrete execution attempt of that intent (§18). */
export type ReviewRunId = Brand<string, "ReviewRunId">;

/** An unverified claim produced by a review agent (§23). */
export type CandidateFindingId = Brand<string, "CandidateFindingId">;
/** A verified, publishable finding (§23). */
export type FindingId = Brand<string, "FindingId">;
/** A single piece of supporting evidence (§29). */
export type EvidenceId = Brand<string, "EvidenceId">;

/** A comment authored by the platform or a human. */
export type CommentId = Brand<string, "CommentId">;
/** A discussion thread. */
export type ConversationId = Brand<string, "ConversationId">;
/** One message within a conversation. */
export type ConversationMessageId = Brand<string, "ConversationMessageId">;

/** A proposed code change attached to a finding (§37). */
export type SuggestedFixId = Brand<string, "SuggestedFixId">;
/** Frozen configuration a run executed against (§39). */
export type ReviewConfigSnapshotId = Brand<string, "ReviewConfigSnapshotId">;
/** Out-of-band content: diffs, logs, SARIF, patches (§45). */
export type ArtifactId = Brand<string, "ArtifactId">;
/** Result of one pre-merge policy check (§44). */
export type PreMergeCheckResultId = Brand<string, "PreMergeCheckResultId">;
/** A domain event on the bus or in the outbox (§48). */
export type EventId = Brand<string, "EventId">;
/** A command instructing the platform to act (§77). */
export type CommandId = Brand<string, "CommandId">;

/** Union of every identifier, for generic id-handling utilities. */
export type AnyId =
  | OrganizationId
  | UserId
  | MembershipId
  | ProviderConnectionId
  | RepositoryId
  | PullRequestId
  | PullRequestRevisionId
  | ReviewRequestId
  | ReviewRunId
  | CandidateFindingId
  | FindingId
  | EvidenceId
  | CommentId
  | ConversationId
  | ConversationMessageId
  | SuggestedFixId
  | ReviewConfigSnapshotId
  | ArtifactId
  | PreMergeCheckResultId
  | EventId
  | CommandId;

// -------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------

/**
 * Canonical UUID text form, lowercase.
 *
 * Version and variant nibbles are left unconstrained on purpose: ids minted
 * before a future change to the generation strategy must keep validating, and
 * pinning `7` here would make that migration a breaking change. Callers treat
 * ids as opaque, so the version carries no meaning for them anyway.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidIdFormat(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Builds the validating factory + schema pair for one identifier type.
 *
 * Every id shares the same rules, so writing 21 near-identical validators by
 * hand would be 21 chances to get one subtly wrong. The name is captured for
 * error messages, which is what makes a failure actionable (§96):
 * `Invalid ReviewRunId` rather than `Invalid input`.
 */
function defineId<TId extends Brand<string, string>>(name: string) {
  const parse = (value: string): TId => {
    if (!UUID_PATTERN.test(value)) {
      throw new ValidationError(
        `Invalid ${name}: expected a lowercase canonical UUID, received ${quoteValue(value)}`,
        { details: { idType: name, value } },
      );
    }
    return unsafeBrand<TId>(value);
  };

  const schema = z
    .string()
    .regex(UUID_PATTERN, {
      error: `Invalid ${name}: expected a lowercase canonical UUID`,
    })
    .transform((value) => unsafeBrand<TId>(value));

  // A fresh, sortable id. Centralized here so no package invents its own
  // scheme (§5).
  const generate = (): TId => unsafeBrand<TId>(uuidv7());

  return { parse, schema, generate } as const;
}

// -------------------------------------------------------------------------
// Factories, schemas, and generators — one triple per identifier
// -------------------------------------------------------------------------

export const OrganizationIdOps = defineId<OrganizationId>("OrganizationId");
export const UserIdOps = defineId<UserId>("UserId");
export const MembershipIdOps = defineId<MembershipId>("MembershipId");
export const ProviderConnectionIdOps = defineId<ProviderConnectionId>(
  "ProviderConnectionId",
);
export const RepositoryIdOps = defineId<RepositoryId>("RepositoryId");
export const PullRequestIdOps = defineId<PullRequestId>("PullRequestId");
export const PullRequestRevisionIdOps = defineId<PullRequestRevisionId>(
  "PullRequestRevisionId",
);
export const ReviewRequestIdOps = defineId<ReviewRequestId>("ReviewRequestId");
export const ReviewRunIdOps = defineId<ReviewRunId>("ReviewRunId");
export const CandidateFindingIdOps =
  defineId<CandidateFindingId>("CandidateFindingId");
export const FindingIdOps = defineId<FindingId>("FindingId");
export const EvidenceIdOps = defineId<EvidenceId>("EvidenceId");
export const CommentIdOps = defineId<CommentId>("CommentId");
export const ConversationIdOps = defineId<ConversationId>("ConversationId");
export const ConversationMessageIdOps = defineId<ConversationMessageId>(
  "ConversationMessageId",
);
export const SuggestedFixIdOps = defineId<SuggestedFixId>("SuggestedFixId");
export const ReviewConfigSnapshotIdOps = defineId<ReviewConfigSnapshotId>(
  "ReviewConfigSnapshotId",
);
export const ArtifactIdOps = defineId<ArtifactId>("ArtifactId");
export const PreMergeCheckResultIdOps = defineId<PreMergeCheckResultId>(
  "PreMergeCheckResultId",
);
export const EventIdOps = defineId<EventId>("EventId");
export const CommandIdOps = defineId<CommandId>("CommandId");

// Ergonomic aliases. `repositoryId(value)` reads better at a call site than
// `RepositoryIdOps.parse(value)`, and the schemas are what contract files
// compose with.

export const organizationId = OrganizationIdOps.parse;
export const userId = UserIdOps.parse;
export const membershipId = MembershipIdOps.parse;
export const providerConnectionId = ProviderConnectionIdOps.parse;
export const repositoryId = RepositoryIdOps.parse;
export const pullRequestId = PullRequestIdOps.parse;
export const pullRequestRevisionId = PullRequestRevisionIdOps.parse;
export const reviewRequestId = ReviewRequestIdOps.parse;
export const reviewRunId = ReviewRunIdOps.parse;
export const candidateFindingId = CandidateFindingIdOps.parse;
export const findingId = FindingIdOps.parse;
export const evidenceId = EvidenceIdOps.parse;
export const commentId = CommentIdOps.parse;
export const conversationId = ConversationIdOps.parse;
export const conversationMessageId = ConversationMessageIdOps.parse;
export const suggestedFixId = SuggestedFixIdOps.parse;
export const reviewConfigSnapshotId = ReviewConfigSnapshotIdOps.parse;
export const artifactId = ArtifactIdOps.parse;
export const preMergeCheckResultId = PreMergeCheckResultIdOps.parse;
export const eventId = EventIdOps.parse;
export const commandId = CommandIdOps.parse;

export const organizationIdSchema = OrganizationIdOps.schema;
export const userIdSchema = UserIdOps.schema;
export const membershipIdSchema = MembershipIdOps.schema;
export const providerConnectionIdSchema = ProviderConnectionIdOps.schema;
export const repositoryIdSchema = RepositoryIdOps.schema;
export const pullRequestIdSchema = PullRequestIdOps.schema;
export const pullRequestRevisionIdSchema = PullRequestRevisionIdOps.schema;
export const reviewRequestIdSchema = ReviewRequestIdOps.schema;
export const reviewRunIdSchema = ReviewRunIdOps.schema;
export const candidateFindingIdSchema = CandidateFindingIdOps.schema;
export const findingIdSchema = FindingIdOps.schema;
export const evidenceIdSchema = EvidenceIdOps.schema;
export const commentIdSchema = CommentIdOps.schema;
export const conversationIdSchema = ConversationIdOps.schema;
export const conversationMessageIdSchema = ConversationMessageIdOps.schema;
export const suggestedFixIdSchema = SuggestedFixIdOps.schema;
export const reviewConfigSnapshotIdSchema = ReviewConfigSnapshotIdOps.schema;
export const artifactIdSchema = ArtifactIdOps.schema;
export const preMergeCheckResultIdSchema = PreMergeCheckResultIdOps.schema;
export const eventIdSchema = EventIdOps.schema;
export const commandIdSchema = CommandIdOps.schema;
