/**
 * What the reviewer says about the change as a whole (P0.txt §33, §34).
 *
 * A summary is **not a collection of findings** (§33). Findings are claims
 * about specific lines; a summary is an orientation for someone about to read
 * the change — what moved, where the risk sits, and whether it looks ready.
 * Deriving one by concatenating findings produces a list, not a summary, and
 * a change with no findings still needs one.
 *
 * The two are also consumed differently. The UI renders Summary, Walkthrough,
 * Findings, and Pre-merge checks as separate views (§33), and a summary that
 * were merely a finding roll-up would leave three of those empty.
 */

import { z } from "zod";
import { reviewRunIdSchema, type ReviewRunId } from "../identity/ids.js";
import {
  repositoryPathSchema,
  type RepositoryPath,
} from "../primitives/repository-path.js";
import {
  FINDING_SEVERITIES,
  type FindingSeverity,
} from "../finding/taxonomy.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { COLLECTION_LIMITS, TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/** Schema version for this durable contract (§7). */
export const REVIEW_SUMMARY_SCHEMA_VERSION = 1;

/**
 * A provider-neutral verdict (§34).
 *
 * Deliberately **not** GitHub's `APPROVE | REQUEST_CHANGES | COMMENT`, even
 * though the values look similar. GitLab has no direct equivalent of
 * `REQUEST_CHANGES`, and a `local` review has nowhere to record a verdict at
 * all — so adapters map these outward and nothing in the platform encodes a
 * provider's API vocabulary (§1, §34).
 *
 * `neutral` is distinct from `comment`: `comment` means "I have remarks",
 * `neutral` means "I deliberately express no opinion" — which is what a review
 * suppressed by policy, or one that found nothing worth saying, should record.
 * Collapsing them would make "no verdict" indistinguishable from "no review".
 */
export const REVIEW_DECISIONS = [
  "approve",
  "request_changes",
  "comment",
  "neutral",
] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const reviewDecisionSchema = z.enum(REVIEW_DECISIONS);

/**
 * Counts per severity, plus the total.
 *
 * `total` is stored rather than summed on read because it must include
 * findings the summary chose not to enumerate — a truncated review still
 * reports how many there were. {@link findingCountsAreConsistent} checks the
 * pair when no truncation occurred.
 */
export interface FindingCountSummary {
  readonly total: number;
  readonly bySeverity: Readonly<Record<FindingSeverity, number>>;
}

export const findingCountSummarySchema = z.strictObject({
  total: z.number().int().nonnegative(),
  bySeverity: z.strictObject(
    Object.fromEntries(
      FINDING_SEVERITIES.map((severity) => [
        severity,
        z.number().int().nonnegative(),
      ]),
    ) as Record<FindingSeverity, z.ZodNumber>,
  ),
});

/** Whether the per-severity counts add up to the stated total. */
export function findingCountsAreConsistent(
  counts: FindingCountSummary,
): boolean {
  const sum = FINDING_SEVERITIES.reduce(
    (running, severity) => running + counts.bySeverity[severity],
    0,
  );
  return sum === counts.total;
}

/**
 * One coherent area the change touched — the "walkthrough" the UI renders.
 *
 * Grouped by intent rather than by directory: "session handling" may span
 * `src/auth/`, `src/middleware/`, and a migration. A per-directory grouping is
 * something the reader can already see in the diff.
 */
export interface ReviewSummaryArea {
  readonly title: string;
  readonly description: string;
  /** Files that make up the area. Ordered as the reviewer presented them. */
  readonly paths: readonly RepositoryPath[];
}

export const reviewSummaryAreaSchema = z.strictObject({
  title: z.string().min(1).max(TEXT_LIMITS.title),
  description: z.string().min(1).max(TEXT_LIMITS.summary),
  paths: z.array(repositoryPathSchema).max(COLLECTION_LIMITS.changedFiles),
});

/**
 * Somewhere the change warrants extra attention.
 *
 * Distinct from a finding: a risk area says "look here", a finding says "this
 * is wrong". A migration that appears correct is still a risk area and is not
 * a finding, and conflating the two would either hide the risk or fabricate a
 * defect (the same separation as {@link RiskSignal} in the change manifest).
 */
export interface ReviewRiskArea {
  /** e.g. `acalys.risk.database-migration`. */
  readonly id: NamespacedId;
  readonly summary: string;
  readonly paths?: readonly RepositoryPath[] | undefined;
}

export const reviewRiskAreaSchema = z.strictObject({
  id: namespacedIdSchema,
  summary: z.string().min(1).max(TEXT_LIMITS.summary),
  paths: z
    .array(repositoryPathSchema)
    .max(COLLECTION_LIMITS.changedFiles)
    .optional(),
});

/**
 * The reviewer's account of the change.
 *
 * One per run. `decision` is optional because a run can complete without
 * reaching a verdict — publication may be suppressed by policy, or the target
 * may be a local review with nothing to approve (§112).
 */
export interface ReviewSummary {
  readonly schemaVersion: number;
  readonly reviewRunId: ReviewRunId;
  /** A short prose orientation. The first thing a human reads. */
  readonly overview: string;
  /** The walkthrough, in presentation order (§123). */
  readonly changedAreas: readonly ReviewSummaryArea[];
  readonly riskAreas: readonly ReviewRiskArea[];
  readonly findingCounts: FindingCountSummary;
  readonly decision?: ReviewDecision | undefined;
  readonly generatedAt: Timestamp;
}

export const reviewSummarySchema = z.strictObject({
  schemaVersion: z
    .number()
    .int()
    .positive()
    .max(REVIEW_SUMMARY_SCHEMA_VERSION, {
      error: `Unsupported ReviewSummary schemaVersion; this build understands up to ${String(REVIEW_SUMMARY_SCHEMA_VERSION)}`,
    }),
  reviewRunId: reviewRunIdSchema,
  overview: z.string().min(1).max(TEXT_LIMITS.explanation),
  changedAreas: z
    .array(reviewSummaryAreaSchema)
    .max(COLLECTION_LIMITS.summaryAreas),
  riskAreas: z.array(reviewRiskAreaSchema).max(COLLECTION_LIMITS.summaryAreas),
  findingCounts: findingCountSummarySchema,
  decision: reviewDecisionSchema.optional(),
  generatedAt: timestampSchema,
});

/** An all-zero count summary, for a change with nothing to report. */
export const EMPTY_FINDING_COUNTS: FindingCountSummary = Object.freeze({
  total: 0,
  bySeverity: Object.freeze({
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  }),
});

/**
 * Tallies published findings into a count summary.
 *
 * Derived rather than hand-assembled, so the summary cannot disagree with the
 * findings it describes.
 */
export function summarizeFindingCounts(
  severities: readonly FindingSeverity[],
): FindingCountSummary {
  const bySeverity: Record<FindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const severity of severities) {
    bySeverity[severity] += 1;
  }
  return { total: severities.length, bySeverity };
}
