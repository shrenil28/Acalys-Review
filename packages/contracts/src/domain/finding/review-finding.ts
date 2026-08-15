/**
 * A verified, lifecycle-bearing finding (P0.txt §23, §27, §28, §107).
 *
 * What a `ReviewFinding` asserts that a {@link CandidateFinding} does not:
 *
 *   > This was independently verified, it has a stable identity that survives
 *   > code movement, and its state can change only through explicitly
 *   > permitted transitions.
 *
 * The promotion boundary is deliberately visible in the type. Three fields are
 * **required here and absent or optional on a candidate**, and each represents
 * something that can only exist after promotion:
 *
 *     verification   the independent decision (§32) — a candidate has none
 *     fingerprint    identity across revisions (§28) — optional on a candidate
 *     lifecycle      state + append-only history (§27) — forbidden on a candidate
 *
 * So `ReviewFinding` is **not** `CandidateFinding & { state }`. `severity`
 * replaces `proposedSeverity` because it is now settled rather than proposed,
 * `confidence` comes from verification rather than from the producer, and
 * `candidateIds` is a *list* — in `/deep-review` several reviewers can raise
 * the same issue and aggregation merges them into one finding whose evidence
 * spans all of them (§113).
 */

import { z } from "zod";
import {
  candidateFindingIdSchema,
  findingIdSchema,
  organizationIdSchema,
  pullRequestRevisionIdSchema,
  repositoryIdSchema,
  reviewRunIdSchema,
  suggestedFixIdSchema,
  type CandidateFindingId,
  type FindingId,
  type OrganizationId,
  type PullRequestRevisionId,
  type RepositoryId,
  type ReviewRunId,
  type SuggestedFixId,
} from "../identity/ids.js";
import {
  sourceLocationSchema,
  type SourceLocation,
} from "../location/source-location.js";
import {
  evidenceReferenceListSchema,
  type EvidenceReference,
} from "../evidence/evidence.js";
import {
  findingCategorySchema,
  findingConfidenceSchema,
  findingSeveritySchema,
  type FindingCategory,
  type FindingConfidence,
  type FindingSeverity,
} from "./taxonomy.js";
import {
  findingFingerprintSchema,
  type FindingFingerprint,
} from "./fingerprint.js";
import {
  verificationResultSchema,
  type VerificationResult,
} from "./verification.js";
import {
  findingLifecycleStateSchema,
  findingTransitionSchema,
  isTerminalFindingLifecycleState,
  type FindingLifecycleState,
  type FindingTransition,
} from "./finding-lifecycle.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { COLLECTION_LIMITS, TEXT_LIMITS } from "../primitives/limits.js";
import { ValidationError } from "../errors/errors.js";

/** Schema version for this durable contract (§7). */
export const REVIEW_FINDING_SCHEMA_VERSION = 1;

/**
 * A finding that survived verification and now participates in the lifecycle.
 *
 * `state` is denormalized alongside `history` for the same reason as
 * {@link ReviewRun}: "find all published findings for this repository" must be
 * an indexed query, not a scan that replays every history.
 * {@link assertFindingStateMatchesHistory} keeps the pair honest.
 *
 * `supersededBy` points forward to the finding that replaced this one, which
 * is what makes lineage traversable in both directions — "what replaced this?"
 * and, by scanning, "what did this replace?".
 */
export interface ReviewFinding {
  readonly schemaVersion: number;
  readonly id: FindingId;
  /** Denormalized tenant key (§9). */
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
  /** The run that produced it. */
  readonly reviewRunId: ReviewRunId;
  /** The revision analyzed. Absent for local reviews (§112). */
  readonly revisionId?: PullRequestRevisionId | undefined;
  /** Candidates merged into this finding. At least one. */
  readonly candidateIds: readonly CandidateFindingId[];

  readonly title: string;
  readonly explanation: string;
  readonly category: FindingCategory;
  /** Settled, not proposed. */
  readonly severity: FindingSeverity;
  /** Derived from verification, not from the producer's self-estimate. */
  readonly confidence: FindingConfidence;
  readonly location: SourceLocation;
  readonly evidence: readonly EvidenceReference[];

  /** Identity across revisions. Required — this is what makes it a finding. */
  readonly fingerprint: FindingFingerprint;
  /** The independent decision that promoted it (§32). */
  readonly verification: VerificationResult;

  readonly state: FindingLifecycleState;
  /** Append-only (§71). */
  readonly history: readonly FindingTransition[];
  /** The finding that replaced this one, when superseded. */
  readonly supersededBy?: FindingId | undefined;
  readonly suggestedFixId?: SuggestedFixId | undefined;

  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export const reviewFindingSchema = z
  .strictObject({
    schemaVersion: z
      .number()
      .int()
      .positive()
      .max(REVIEW_FINDING_SCHEMA_VERSION, {
        error: `Unsupported ReviewFinding schemaVersion; this build understands up to ${String(REVIEW_FINDING_SCHEMA_VERSION)}`,
      }),
    id: findingIdSchema,
    organizationId: organizationIdSchema,
    repositoryId: repositoryIdSchema,
    reviewRunId: reviewRunIdSchema,
    revisionId: pullRequestRevisionIdSchema.optional(),
    candidateIds: z
      .array(candidateFindingIdSchema)
      .min(1, {
        error: "A ReviewFinding must record the candidate(s) it came from",
      })
      .max(COLLECTION_LIMITS.evidencePerFinding),

    title: z.string().min(1).max(TEXT_LIMITS.title),
    explanation: z.string().min(1).max(TEXT_LIMITS.explanation),
    category: findingCategorySchema,
    severity: findingSeveritySchema,
    confidence: findingConfidenceSchema,
    location: sourceLocationSchema,
    evidence: evidenceReferenceListSchema,

    fingerprint: findingFingerprintSchema,
    verification: verificationResultSchema,

    state: findingLifecycleStateSchema,
    history: z.array(findingTransitionSchema).max(1_000),
    supersededBy: findingIdSchema.optional(),
    suggestedFixId: suggestedFixIdSchema.optional(),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((finding, ctx) => {
    // §107 — a published finding must not carry a rejected verification.
    // Structurally near-impossible (a rejected candidate is never promoted),
    // but asserted because the consequence is publishing something a verifier
    // explicitly refuted.
    if (finding.verification.decision === "rejected") {
      ctx.addIssue({
        code: "custom",
        path: ["verification", "decision"],
        message:
          "A ReviewFinding cannot carry a rejected verification; a rejected candidate is never promoted",
      });
    }

    // §107 — a finding's location must belong to the repository under review.
    if (finding.location.repositoryId !== finding.repositoryId) {
      ctx.addIssue({
        code: "custom",
        path: ["location", "repositoryId"],
        message:
          "A finding's location must belong to the repository the finding is about",
      });
    }

    // supersededBy and the superseded state must agree in both directions.
    if (finding.state === "superseded" && finding.supersededBy === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["supersededBy"],
        message: "A superseded finding must record which finding replaced it",
      });
    }
    if (finding.state !== "superseded" && finding.supersededBy !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["supersededBy"],
        message: `supersededBy is only meaningful in state 'superseded', not '${finding.state}'`,
      });
    }
    if (finding.supersededBy === finding.id) {
      ctx.addIssue({
        code: "custom",
        path: ["supersededBy"],
        message: "A finding cannot supersede itself",
      });
    }

    if (finding.updatedAt < finding.createdAt) {
      ctx.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "A finding cannot be updated before it is created",
      });
    }

    // Duplicate candidate ids would double-count in swarm aggregation metrics.
    if (new Set(finding.candidateIds).size !== finding.candidateIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateIds"],
        message: "Candidate ids must be unique",
      });
    }
  });

/**
 * Checks that the denormalized `state` matches what `history` implies.
 *
 * Cross-aggregate consistency the schema cannot express on its own, enforced
 * by the application service on write (§107, §108). A mismatch means a lost or
 * partially-applied update.
 *
 * @throws {ValidationError} when the two disagree
 */
export function assertFindingStateMatchesHistory(finding: ReviewFinding): void {
  const last = finding.history.at(-1);
  const implied: FindingLifecycleState =
    last === undefined ? "verified" : last.to;

  if (implied !== finding.state) {
    throw new ValidationError(
      `ReviewFinding.state is '${finding.state}' but its history ends in '${implied}'`,
      { details: { state: finding.state, impliedState: implied } },
    );
  }
}

/** Whether the finding still represents an open claim. */
export function isOpenFinding(finding: ReviewFinding): boolean {
  return !isTerminalFindingLifecycleState(finding.state);
}

/**
 * Whether this finding should block a merge.
 *
 * Combines three independent axes deliberately: severity (is it bad?),
 * confidence (are we sure?), and state (is it still open?). Any policy keying
 * on severity alone would block merges on unverified guesses, which is the
 * failure the three-axis taxonomy exists to prevent (§24-26, §119).
 */
export function isBlocking(finding: ReviewFinding): boolean {
  return (
    isOpenFinding(finding) &&
    (finding.severity === "critical" || finding.severity === "high") &&
    finding.confidence.level === "very_high"
  );
}
