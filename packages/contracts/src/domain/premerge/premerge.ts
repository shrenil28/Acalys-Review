/**
 * Pre-merge policy checks (P0.txt §44, §119).
 *
 * **A pre-merge check is not a finding** (§132, "Review finding != Pre-merge
 * check"), and keeping them apart is the entire point of this module.
 *
 *     finding      a claim about the code:   "this query is injectable"
 *     check        a claim about the change: "it satisfies our merge policy"
 *
 * They differ in what they output, who decides them, and what they gate. A
 * finding carries a *severity* — how bad the problem is. A check carries a
 * *status* — pass, fail, or could not tell. Expressing "the description is
 * missing" as a `low` severity finding, or "there are three high findings" as
 * a check with a severity, muddles both: severity would start meaning
 * "blocking", and policy would be tuned by re-grading defects.
 *
 * So a check produces PASS / FAIL / INCONCLUSIVE **without abusing review
 * severity** (§44), while reading findings as one of its inputs.
 */

import { z } from "zod";
import {
  organizationIdSchema,
  preMergeCheckResultIdSchema,
  repositoryIdSchema,
  reviewRunIdSchema,
  type OrganizationId,
  type PreMergeCheckResultId,
  type RepositoryId,
  type ReviewRunId,
} from "../identity/ids.js";
import {
  evidenceReferenceListSchema,
  type EvidenceReference,
} from "../evidence/evidence.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/**
 * The outcome of one check.
 *
 * `inconclusive` and `skipped` are separate, and both are separate from
 * `failed`, because each licenses a different response:
 *
 * | Status | Means | Merge policy should |
 * | --- | --- | --- |
 * | `passed` | the check ran and was satisfied | allow |
 * | `failed` | the check ran and was not satisfied | block |
 * | `inconclusive` | the check ran and could not tell | decide by policy — this is the one a boolean loses |
 * | `skipped` | deliberately not run for this change | allow, and say why |
 * | `pending`/`running` | not settled yet | wait |
 *
 * Collapsing `inconclusive` into `failed` blocks merges on the platform's own
 * uncertainty; collapsing it into `passed` lets an unevaluated policy read as
 * satisfied. Both are wrong, and only a distinct value lets the tenant choose.
 */
export const PRE_MERGE_CHECK_STATUSES = [
  "pending",
  "running",
  "passed",
  "failed",
  "inconclusive",
  "skipped",
] as const;

export type PreMergeCheckStatus = (typeof PRE_MERGE_CHECK_STATUSES)[number];

export const preMergeCheckStatusSchema = z.enum(PRE_MERGE_CHECK_STATUSES);

/** Whether the check has reached a final answer. */
export function isSettledCheck(status: PreMergeCheckStatus): boolean {
  return status !== "pending" && status !== "running";
}

/**
 * The result of running one check against one review run.
 *
 * `checkId` is a namespaced open string rather than an enum because checks are
 * extensible by definition: first-party checks (`acalys.premerge.title`)
 * sit alongside tenant-authored ones (`org.acme.check.no-direct-sql`), and
 * adding one must never require a schema release (§79, §80).
 *
 * `evidence` is required-but-possibly-empty rather than optional: a check that
 * fails should say what it looked at, and making the field always present
 * means a consumer never has to distinguish "no evidence" from "field absent".
 */
export interface PreMergeCheckResult {
  readonly id: PreMergeCheckResultId;
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
  readonly reviewRunId: ReviewRunId;
  /** e.g. `acalys.premerge.description`, `org.acme.check.no-direct-sql`. */
  readonly checkId: NamespacedId;
  /** Human-facing name, for display alongside the status. */
  readonly name: string;
  readonly status: PreMergeCheckStatus;
  /** Why it reached this status. Required once settled. */
  readonly explanation?: string | undefined;
  readonly evidence: readonly EvidenceReference[];
  /**
   * Whether this check blocks the merge.
   *
   * A property of the *check's configuration*, recorded on the result so the
   * result stays interpretable after the configuration changes — the same
   * reason a run pins its config snapshot (§39, §72).
   */
  readonly blocking: boolean;
  readonly evaluatedAt?: Timestamp | undefined;
}

export const preMergeCheckResultSchema = z
  .strictObject({
    id: preMergeCheckResultIdSchema,
    organizationId: organizationIdSchema,
    repositoryId: repositoryIdSchema,
    reviewRunId: reviewRunIdSchema,
    checkId: namespacedIdSchema,
    name: z.string().min(1).max(TEXT_LIMITS.title),
    status: preMergeCheckStatusSchema,
    explanation: z.string().min(1).max(TEXT_LIMITS.summary).optional(),
    evidence: evidenceReferenceListSchema,
    blocking: z.boolean(),
    evaluatedAt: timestampSchema.optional(),
  })
  .superRefine((result, ctx) => {
    const settled = isSettledCheck(result.status);

    // A settled check must say when it settled and why. Without either, the
    // result is unactionable: a developer sees "failed" with no way to fix it.
    if (settled && result.evaluatedAt === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["evaluatedAt"],
        message: `A '${result.status}' check must record when it was evaluated`,
      });
    }
    if (!settled && result.evaluatedAt !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["evaluatedAt"],
        message: `A '${result.status}' check has not been evaluated yet`,
      });
    }
    if (
      (result.status === "failed" ||
        result.status === "inconclusive" ||
        result.status === "skipped") &&
      result.explanation === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["explanation"],
        message: `A '${result.status}' check must explain why`,
      });
    }

    // A `severity` key is rejected by the strict object above, not here — a
    // refinement receives the already-validated value, so a check for it would
    // be dead code implying a rule that never runs. The separation §44 asks
    // for is enforced by the shape itself, and asserted by the test that feeds
    // this schema a severity.
  });

/**
 * Whether this result should stop a merge.
 *
 * Only a settled, blocking `failed` check does. `inconclusive` deliberately
 * does not: blocking on the platform's own uncertainty makes the product
 * unusable on any change it cannot fully analyze. A tenant that wants
 * uncertainty to block expresses that by configuring the check, not by
 * reinterpreting the status here.
 */
export function blocksMerge(result: PreMergeCheckResult): boolean {
  return isMergeBlockingResult(result);
}

/**
 * The same rule, over just the two fields it needs.
 *
 * Structural so that every representation of a check — the domain result, the
 * API DTO, whatever a client holds — can ask the question without converting
 * first, and without writing the rule again.
 *
 * It exists because it was written twice. A frontend adapter reimplemented it
 * as `blocking` alone, which would have stopped a merge on a check that
 * PASSED while being configured to block. The mistake was caught by a test,
 * but two implementations of one policy is one too many: they do not drift
 * loudly, they drift on a Tuesday when someone edits one of them.
 *
 * This defines what the public fields MEAN together. It does not decide
 * policy — the backend still produces `status` and `blocking`, and a tenant
 * still configures which checks block.
 */
export function isMergeBlockingResult(check: {
  readonly status: PreMergeCheckStatus;
  readonly blocking: boolean;
}): boolean {
  return check.blocking && check.status === "failed";
}

/**
 * The overall gate across every check.
 *
 * Returns `failed` if any blocking check failed; `pending` if any check is
 * still running (an unsettled check must not be read as a pass); otherwise
 * `passed`.
 */
export function aggregateCheckStatus(
  results: readonly PreMergeCheckResult[],
): PreMergeCheckStatus {
  if (results.some(blocksMerge)) return "failed";
  if (results.some((result) => !isSettledCheck(result.status)))
    return "pending";
  return "passed";
}
