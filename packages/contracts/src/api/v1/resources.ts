/**
 * Public resource DTOs and the projections that build them (P0.txt §76, §105).
 *
 * Each DTO is designed against a page that already exists in `apps/web`, which
 * is what stops them being imagined:
 *
 * | DTO | Rendered by |
 * | --- | --- |
 * | `RepositoryDto` | `pages/review/Repositories.tsx` |
 * | `PullRequestSummaryDto` | `pages/review/Triage.tsx` |
 * | `FindingDto` | `pages/security/AiDeepScan.tsx`, `PrFindings.tsx` |
 * | `KnowledgeItemDto` | `pages/review/Learnings.tsx` |
 * | `ReviewRunDto`, `ReviewSummaryDto` | the live review view Phase 1 builds |
 *
 * # What every projection removes
 *
 * The domain types these come from carry execution detail the caller must not
 * see. `ReviewRun` alone holds `attempt`, `execution`, `configSnapshotId`, and
 * a full `history` — every one of which is *how the platform ran the review*,
 * not *what the review found*. Exposing them would make a worker refactor a
 * breaking API change, which is the coupling the whole layering exists to
 * prevent.
 *
 * # Ids become plain strings
 *
 * Brands are a compile-time device for the backend. Over HTTP an id is text,
 * and `apps/web` should not import the branding machinery to render a table.
 */

import { z } from "zod";
import type { Repository } from "../../domain/repository/repository.js";
import { REPOSITORY_VISIBILITIES } from "../../domain/repository/repository.js";
import type { PullRequest } from "../../domain/pull-request/pull-request.js";
import type { Actor } from "../../domain/actor/actor.js";
import { assertNever } from "../../domain/primitives/assert-never.js";
import { PULL_REQUEST_STATES } from "../../domain/pull-request/pull-request.js";
import type { ReviewRun } from "../../domain/review/review-run.js";
import { REVIEW_RUN_STATES } from "../../domain/review/review-run-state.js";
import type { ReviewFinding } from "../../domain/finding/review-finding.js";
import {
  FINDING_CATEGORIES,
  FINDING_CONFIDENCE_LEVELS,
  FINDING_SEVERITIES,
} from "../../domain/finding/taxonomy.js";
import { FINDING_LIFECYCLE_STATES } from "../../domain/finding/finding-lifecycle.js";
import type { ReviewSummary } from "../../domain/output/review-summary.js";
import { REVIEW_DECISIONS } from "../../domain/output/review-summary.js";
import type { ReviewConversation } from "../../domain/output/conversation.js";
import { CONVERSATION_STATES } from "../../domain/output/conversation.js";
import type { PreMergeCheckResult } from "../../domain/premerge/premerge.js";
import { PRE_MERGE_CHECK_STATUSES } from "../../domain/premerge/premerge.js";
import type { KnowledgeReference } from "../../domain/knowledge/knowledge.js";
import {
  KNOWLEDGE_SCOPES,
  KNOWLEDGE_SOURCE_TYPES,
} from "../../domain/knowledge/knowledge.js";
import { SOURCE_PROVIDERS } from "../../domain/provider/provider.js";
import {
  TEXT_LIMITS,
  COLLECTION_LIMITS,
} from "../../domain/primitives/limits.js";
import { apiIdSchema, apiTimestampSchema } from "./common.js";

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * A repository as the dashboard lists it.
 *
 * `name` is the provider's own — `owner/repo` on GitHub, the full path on
 * GitLab. It is display text and never identity: the existing frontend keys
 * repositories by mutable name, which breaks the moment one is renamed, and
 * `id` is what replaces that.
 *
 * Omitted from {@link Repository}: `providerConnectionId` (which credential
 * reaches this repository is an operational detail) and `organizationId` (the
 * caller's session already determines the tenant, and echoing it invites a
 * client to send one — the §9 mistake).
 */
export interface RepositoryDto {
  readonly id: string;
  readonly name: string;
  readonly provider: (typeof SOURCE_PROVIDERS)[number];
  readonly visibility: (typeof REPOSITORY_VISIBILITIES)[number];
  readonly defaultBranch?: string | undefined;
  /** False when archived or disabled — what greys the row out. */
  readonly reviewsEnabled: boolean;
  readonly updatedAt: string;
}

export const repositoryDtoSchema = z.strictObject({
  id: apiIdSchema,
  name: z.string().min(1).max(TEXT_LIMITS.identifier),
  provider: z.enum(SOURCE_PROVIDERS),
  visibility: z.enum(REPOSITORY_VISIBILITIES),
  defaultBranch: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  reviewsEnabled: z.boolean(),
  updatedAt: apiTimestampSchema,
});

export function toRepositoryDto(repository: Repository): RepositoryDto {
  return {
    id: repository.id,
    // The provider's own display path. Derived rather than stored: `owner`
    // and `name` are the fields the provider actually gives, and `id` is what
    // identity uses (§8).
    name: `${repository.providerRepository.owner}/${repository.providerRepository.name}`,
    provider: repository.provider,
    visibility: repository.visibility,
    ...(repository.defaultBranch === undefined
      ? {}
      : { defaultBranch: repository.defaultBranch }),
    reviewsEnabled: repository.lifecycle === "active",
    updatedAt: repository.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Pull request
// ---------------------------------------------------------------------------

/**
 * A pull request row in the triage table.
 *
 * The existing `TriagePr` fixture fuses three things into one flat record:
 * provider metadata, review state, and AI-derived risk. They are split here
 * because they have different lifetimes and different sources — provider
 * metadata changes when the author pushes, review state when a run completes,
 * risk when a review is re-run. A merged row cannot express "the PR updated but
 * the review has not caught up yet", which is the normal case.
 *
 * So this DTO carries only what the *provider* knows. Review-derived fields
 * arrive with {@link ReviewRunDto} and {@link ReviewSummaryDto}.
 */
export interface PullRequestSummaryDto {
  readonly id: string;
  readonly repositoryId: string;
  /** Provider-facing number, e.g. `412`. Display, not identity. */
  readonly number?: number | undefined;
  readonly title: string;
  readonly authorLabel: string;
  readonly state: (typeof PULL_REQUEST_STATES)[number];
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const pullRequestSummaryDtoSchema = z.strictObject({
  id: apiIdSchema,
  repositoryId: apiIdSchema,
  number: z.number().int().positive().optional(),
  title: z.string().min(1).max(TEXT_LIMITS.title),
  authorLabel: z.string().min(1).max(TEXT_LIMITS.identifier),
  state: z.enum(PULL_REQUEST_STATES),
  draft: z.boolean(),
  labels: z
    .array(z.string().max(TEXT_LIMITS.identifier))
    .max(COLLECTION_LIMITS.labels),
  createdAt: apiTimestampSchema,
  updatedAt: apiTimestampSchema,
});

/**
 * Renders an {@link Actor} as one display string.
 *
 * The UI shows a name; the domain models *what kind of thing acted*. Flattening
 * here keeps that distinction inside the platform, where authorization needs
 * it, and out of a table cell, which does not.
 */
function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case "human":
      return actor.displayName ?? actor.provider?.handle ?? "unknown";
    case "integration":
      return actor.displayName ?? actor.integrationId;
    case "agent":
      return `acalys.${actor.agentType}`;
    case "system":
      return actor.component;
    default:
      return assertNever(actor, "actorLabel");
  }
}

export function toPullRequestSummaryDto(
  pullRequest: PullRequest,
): PullRequestSummaryDto {
  return {
    id: pullRequest.id,
    repositoryId: pullRequest.repositoryId,
    ...(pullRequest.providerChangeRequest.number === undefined
      ? {}
      : { number: pullRequest.providerChangeRequest.number }),
    title: pullRequest.title,
    authorLabel: actorLabel(pullRequest.author),
    state: pullRequest.state,
    draft: pullRequest.draft,
    labels: pullRequest.labels,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Review run
// ---------------------------------------------------------------------------

/**
 * A review as the UI follows it.
 *
 * The narrowest DTO in the layer, and deliberately so. {@link ReviewRun} holds
 * `attempt`, `execution`, `configSnapshotId`, and the full transition
 * `history`; none of it appears here.
 *
 * `history` is the interesting omission. It is genuinely useful — but it is a
 * *worker's* record of how the run progressed, and a UI that rendered it would
 * break every time the state machine gained a state. What the UI needs is the
 * current state and whether it is finished, which is what it gets.
 *
 * `failureCode` is a stable code, never a message: an error string is written
 * for an operator reading logs and routinely contains a path, a host, or a
 * provider payload (§63, §125).
 */
export interface ReviewRunDto {
  readonly id: string;
  readonly repositoryId: string;
  readonly pullRequestId?: string | undefined;
  readonly state: (typeof REVIEW_RUN_STATES)[number];
  /** True once the run reached a terminal state — what stops the spinner. */
  readonly settled: boolean;
  readonly failureCode?: string | undefined;
  readonly createdAt: string;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
}

export const reviewRunDtoSchema = z.strictObject({
  id: apiIdSchema,
  repositoryId: apiIdSchema,
  pullRequestId: apiIdSchema.optional(),
  state: z.enum(REVIEW_RUN_STATES),
  settled: z.boolean(),
  failureCode: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  createdAt: apiTimestampSchema,
  startedAt: apiTimestampSchema.optional(),
  completedAt: apiTimestampSchema.optional(),
});

/**
 * `pullRequestId` arrives as an option rather than being read off the run.
 *
 * A {@link ReviewRun}'s target holds the *provider's* change-request
 * reference, not the platform's `PullRequestId` — resolving one to the other
 * is a lookup the domain deliberately does not perform (§1). Inventing the id
 * here would mean guessing; taking it from the caller, which already loaded
 * the pull request to render the page, states the dependency honestly.
 */
export function toReviewRunDto(
  run: ReviewRun,
  options: { readonly pullRequestId?: string } = {},
): ReviewRunDto {
  return {
    id: run.id,
    repositoryId: run.repositoryId,
    ...(options.pullRequestId === undefined
      ? {}
      : { pullRequestId: options.pullRequestId }),
    state: run.state,
    settled:
      run.state === "completed" ||
      run.state === "failed" ||
      run.state === "cancelled" ||
      run.state === "superseded",
    ...(run.failure === undefined ? {} : { failureCode: run.failure.code }),
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
  };
}

// ---------------------------------------------------------------------------
// Review summary
// ---------------------------------------------------------------------------

export interface ReviewSummaryAreaDto {
  readonly title: string;
  readonly description: string;
  readonly paths: readonly string[];
}

export interface ReviewRiskAreaDto {
  readonly id: string;
  readonly summary: string;
  readonly paths?: readonly string[] | undefined;
}

export interface ReviewSummaryDto {
  readonly reviewRunId: string;
  readonly overview: string;
  readonly changedAreas: readonly ReviewSummaryAreaDto[];
  readonly riskAreas: readonly ReviewRiskAreaDto[];
  readonly findingCounts: {
    readonly total: number;
    readonly bySeverity: Readonly<
      Record<(typeof FINDING_SEVERITIES)[number], number>
    >;
  };
  readonly decision?: (typeof REVIEW_DECISIONS)[number] | undefined;
  readonly generatedAt: string;
}

export const reviewSummaryDtoSchema = z.strictObject({
  reviewRunId: apiIdSchema,
  overview: z.string().min(1).max(TEXT_LIMITS.explanation),
  changedAreas: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(TEXT_LIMITS.title),
        description: z.string().min(1).max(TEXT_LIMITS.summary),
        paths: z.array(z.string().max(TEXT_LIMITS.identifier)),
      }),
    )
    .max(COLLECTION_LIMITS.summaryAreas),
  riskAreas: z
    .array(
      z.strictObject({
        id: apiIdSchema,
        summary: z.string().min(1).max(TEXT_LIMITS.summary),
        paths: z.array(z.string().max(TEXT_LIMITS.identifier)).optional(),
      }),
    )
    .max(COLLECTION_LIMITS.summaryAreas),
  findingCounts: z.strictObject({
    total: z.number().int().nonnegative(),
    bySeverity: z.strictObject(
      Object.fromEntries(
        FINDING_SEVERITIES.map((severity) => [
          severity,
          z.number().int().nonnegative(),
        ]),
      ) as Record<(typeof FINDING_SEVERITIES)[number], z.ZodNumber>,
    ),
  }),
  decision: z.enum(REVIEW_DECISIONS).optional(),
  generatedAt: apiTimestampSchema,
});

export function toReviewSummaryDto(summary: ReviewSummary): ReviewSummaryDto {
  return {
    reviewRunId: summary.reviewRunId,
    overview: summary.overview,
    changedAreas: summary.changedAreas.map((area) => ({
      title: area.title,
      description: area.description,
      paths: [...area.paths],
    })),
    riskAreas: summary.riskAreas.map((area) => ({
      id: area.id,
      summary: area.summary,
      ...(area.paths === undefined ? {} : { paths: [...area.paths] }),
    })),
    findingCounts: {
      total: summary.findingCounts.total,
      bySeverity: summary.findingCounts.bySeverity,
    },
    ...(summary.decision === undefined ? {} : { decision: summary.decision }),
    generatedAt: summary.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

/**
 * A published finding, as both security pages render it.
 *
 * `confidence` exposes the **level**, not the raw score. The score is a model
 * artifact whose scale is free to change as verification improves; a UI that
 * rendered `0.82` would make that recalibration user-visible, and a user
 * comparing 0.82 today with 0.82 next month would be comparing nothing. The
 * level is the stable, meaningful projection.
 *
 * Omitted entirely: `fingerprint` (an internal identity used for
 * reconciliation — publishing it invites a client to key on it and freezes the
 * algorithm), `evidence` provenance internals, and `candidateFindingId`.
 */
export interface FindingDto {
  readonly id: string;
  readonly repositoryId: string;
  readonly reviewRunId: string;
  readonly severity: (typeof FINDING_SEVERITIES)[number];
  readonly category: (typeof FINDING_CATEGORIES)[number];
  readonly confidence: (typeof FINDING_CONFIDENCE_LEVELS)[number];
  readonly lifecycle: (typeof FINDING_LIFECYCLE_STATES)[number];
  readonly title: string;
  readonly explanation: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** How many pieces of evidence support it. The count, not the evidence. */
  readonly evidenceCount: number;
  readonly hasSuggestedFix: boolean;
  readonly createdAt: string;
}

export const findingDtoSchema = z.strictObject({
  id: apiIdSchema,
  repositoryId: apiIdSchema,
  reviewRunId: apiIdSchema,
  severity: z.enum(FINDING_SEVERITIES),
  category: z.enum(FINDING_CATEGORIES),
  confidence: z.enum(FINDING_CONFIDENCE_LEVELS),
  lifecycle: z.enum(FINDING_LIFECYCLE_STATES),
  title: z.string().min(1).max(TEXT_LIMITS.title),
  explanation: z.string().min(1).max(TEXT_LIMITS.explanation),
  path: z.string().min(1).max(TEXT_LIMITS.identifier),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  evidenceCount: z.number().int().nonnegative(),
  hasSuggestedFix: z.boolean(),
  createdAt: apiTimestampSchema,
});

export function toFindingDto(finding: ReviewFinding): FindingDto {
  return {
    id: finding.id,
    repositoryId: finding.repositoryId,
    reviewRunId: finding.reviewRunId,
    severity: finding.severity,
    category: finding.category,
    confidence: finding.confidence.level,
    lifecycle: finding.state,
    title: finding.title,
    explanation: finding.explanation,
    path: finding.location.path,
    startLine: finding.location.lines.start,
    endLine: finding.location.lines.end,
    evidenceCount: finding.evidence.length,
    hasSuggestedFix: finding.suggestedFixId !== undefined,
    createdAt: finding.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Conversation and pre-merge
// ---------------------------------------------------------------------------

export interface ConversationDto {
  readonly id: string;
  readonly repositoryId: string;
  readonly pullRequestId?: string | undefined;
  readonly findingId?: string | undefined;
  readonly state: (typeof CONVERSATION_STATES)[number];
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const conversationDtoSchema = z.strictObject({
  id: apiIdSchema,
  repositoryId: apiIdSchema,
  pullRequestId: apiIdSchema.optional(),
  findingId: apiIdSchema.optional(),
  state: z.enum(CONVERSATION_STATES),
  messageCount: z.number().int().nonnegative(),
  createdAt: apiTimestampSchema,
  updatedAt: apiTimestampSchema,
});

export function toConversationDto(
  conversation: ReviewConversation,
): ConversationDto {
  return {
    id: conversation.id,
    repositoryId: conversation.repositoryId,
    ...(conversation.pullRequestId === undefined
      ? {}
      : { pullRequestId: conversation.pullRequestId }),
    ...(conversation.findingId === undefined
      ? {}
      : { findingId: conversation.findingId }),
    state: conversation.state,
    messageCount: conversation.messageIds.length,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

/**
 * A pre-merge check result.
 *
 * Carries `status` and never a severity — the §44 separation survives the
 * projection, which is the point of asserting it here as well as in the
 * domain. A DTO that quietly mapped `failed` onto `"critical"` for the UI's
 * convenience would reintroduce the conflation at the boundary.
 */
export interface PreMergeCheckDto {
  readonly id: string;
  readonly reviewRunId: string;
  readonly checkId: string;
  readonly name: string;
  readonly status: (typeof PRE_MERGE_CHECK_STATUSES)[number];
  readonly blocking: boolean;
  readonly explanation?: string | undefined;
  readonly evaluatedAt?: string | undefined;
}

export const preMergeCheckDtoSchema = z.strictObject({
  id: apiIdSchema,
  reviewRunId: apiIdSchema,
  checkId: apiIdSchema,
  name: z.string().min(1).max(TEXT_LIMITS.title),
  status: z.enum(PRE_MERGE_CHECK_STATUSES),
  blocking: z.boolean(),
  explanation: z.string().min(1).max(TEXT_LIMITS.summary).optional(),
  evaluatedAt: apiTimestampSchema.optional(),
});

export function toPreMergeCheckDto(
  result: PreMergeCheckResult,
): PreMergeCheckDto {
  return {
    id: result.id,
    reviewRunId: result.reviewRunId,
    checkId: result.checkId,
    name: result.name,
    status: result.status,
    blocking: result.blocking,
    ...(result.explanation === undefined
      ? {}
      : { explanation: result.explanation }),
    ...(result.evaluatedAt === undefined
      ? {}
      : { evaluatedAt: result.evaluatedAt }),
  };
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

/** A learning or instruction, as the Learnings page lists it. */
export interface KnowledgeItemDto {
  readonly id: string;
  readonly sourceType: (typeof KNOWLEDGE_SOURCE_TYPES)[number];
  readonly scope: (typeof KNOWLEDGE_SCOPES)[number];
  readonly repositoryId?: string | undefined;
  readonly path?: string | undefined;
  readonly summary: string;
  /** True for a human-authored rule, false for a platform inference. */
  readonly authored: boolean;
  readonly recordedAt?: string | undefined;
}

export const knowledgeItemDtoSchema = z.strictObject({
  id: apiIdSchema,
  sourceType: z.enum(KNOWLEDGE_SOURCE_TYPES),
  scope: z.enum(KNOWLEDGE_SCOPES),
  repositoryId: apiIdSchema.optional(),
  path: z.string().max(TEXT_LIMITS.identifier).optional(),
  summary: z.string().min(1).max(TEXT_LIMITS.summary),
  authored: z.boolean(),
  recordedAt: apiTimestampSchema.optional(),
});

export function toKnowledgeItemDto(
  reference: KnowledgeReference,
  authored: boolean,
): KnowledgeItemDto {
  return {
    id: reference.sourceId,
    sourceType: reference.sourceType,
    scope: reference.scope,
    ...(reference.repositoryId === undefined
      ? {}
      : { repositoryId: reference.repositoryId }),
    ...(reference.path === undefined ? {} : { path: reference.path }),
    summary: reference.summary,
    authored,
    ...(reference.recordedAt === undefined
      ? {}
      : { recordedAt: reference.recordedAt }),
  };
}
