/**
 * Enforcement, decided independently of attention.
 *
 * The same verified finding branches two ways, and the branches must not be
 * able to read each other:
 *
 * ```
 *                      ReviewFinding
 *                     /             \
 *      publication policy           pre-merge policy
 *             ↓                            ↓
 *      developer attention             enforcement
 *             ↓                            ↓
 *      comment / summary               check result
 * ```
 *
 * All four combinations are legitimate, and each has a real use:
 *
 * ```
 * comment yes,  block no     most findings — worth saying, not worth stopping
 * comment yes,  block yes    a critical defect
 * comment no,   block yes    the comment budget was spent, the policy still fails
 * comment no,   block no     withheld and below the blocking bar
 * ```
 *
 * The third is the one that proves the separation is real. If enforcement were
 * derived from publication state, a finding withheld by a *comment budget*
 * would silently stop blocking a merge — the merge gate would be tuned by a
 * rendering limit, and nobody would find that by reading either module.
 *
 * # How the independence is enforced rather than promised
 *
 * This module imports nothing from `../publication/`. Not the plan, not the
 * decision, not the reason vocabulary — there is no parameter through which a
 * publication outcome could reach it, so `published == merge_blocking` is not
 * something to remember not to write. The dependency-cruiser rule
 * `no-premerge-publication-coupling` fails the build if either direction is
 * ever added.
 *
 * {@link EnforceableFinding} is declared here rather than imported for the same
 * reason. It is structurally satisfied by what promotion produces, so no
 * conversion is needed at the call site — but the *type* dependency does not
 * exist, and a field added to the publication side cannot arrive here by
 * accident.
 *
 * # A check carries a status, never a severity
 *
 * Phase 0 §44 is explicit about this and it is easy to erode. Expressing "three
 * high findings" as a check with a severity makes severity start to mean
 * "blocking", and merge policy then gets tuned by re-grading defects rather
 * than by changing policy.
 */

import type { FindingSeverity } from "@acalys/contracts/domain";
import type { PreMergeCheckStatus } from "@acalys/contracts/domain";

/**
 * What enforcement is allowed to know about a finding.
 *
 * Deliberately no publication decision, no comment budget, no surface. Those
 * are facts about rendering, and a merge gate that can see them is a merge gate
 * that will eventually be decided by them.
 */
export interface EnforceableFinding {
  readonly findingId: string;
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly path: string;
}

export interface PreMergeCheckPlan {
  /** Namespaced and open by design: tenants author checks too (§79). */
  readonly checkId: string;
  readonly name: string;
  readonly status: PreMergeCheckStatus;
  readonly explanation?: string | undefined;
  /** A property of the check's configuration, recorded on the result. */
  readonly blocking: boolean;
}

export interface PreMergeConfig {
  /**
   * The severity at which a verified finding fails the correctness check.
   *
   * Independent of `PublicationConfig.minimumSeverity` on purpose. A team may
   * reasonably want to *hear about* medium findings while only *blocking* on
   * critical ones — and expressing that with one number forces them to choose
   * between a noisy gate and a silent reviewer.
   */
  readonly blockingSeverity: FindingSeverity;
  /** Whether the correctness check stops a merge, or only reports. */
  readonly blocking: boolean;
}

export const DEFAULT_PREMERGE_CONFIG: PreMergeConfig = {
  blockingSeverity: "high",
  // Reporting by default. A reviewer that starts blocking merges on the day it
  // is installed is a reviewer that gets uninstalled.
  blocking: false,
};

export const CORRECTNESS_CHECK_ID = "acalys.premerge.correctness";

const SEVERITY_ORDER: readonly FindingSeverity[] = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];

function atLeast(severity: FindingSeverity, minimum: FindingSeverity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(minimum);
}

/**
 * Evaluates merge policy from verified findings alone.
 *
 * Deterministic, like the publication policy and for the same reason: "why did
 * this PR get blocked?" must have one answer, and a nondeterministic gate makes
 * the question unanswerable at exactly the moment someone is blocked by it.
 *
 * Note what an empty input produces: a **passed** check, not a skipped one. A
 * review that found nothing actionable has satisfied the policy — that is the
 * successful case, and recording it as `skipped` would make a clean change
 * indistinguishable from one the platform never evaluated.
 */
export function evaluatePreMerge(
  findings: readonly EnforceableFinding[],
  config: PreMergeConfig = DEFAULT_PREMERGE_CONFIG,
): readonly PreMergeCheckPlan[] {
  const failing = findings.filter((finding) =>
    atLeast(finding.severity, config.blockingSeverity),
  );

  const status: PreMergeCheckStatus =
    failing.length === 0 ? "passed" : "failed";

  return [
    {
      checkId: CORRECTNESS_CHECK_ID,
      name: "Correctness",
      status,
      // Required by the Phase 0 contract for a failed check, and required in
      // practice: a developer shown a red check with no reason cannot act.
      explanation:
        status === "failed"
          ? `${String(failing.length)} verified finding(s) at or above ` +
            `\`${config.blockingSeverity}\` severity.`
          : undefined,
      blocking: config.blocking,
    },
  ];
}

/**
 * Whether these results stop a merge.
 *
 * Only a settled, blocking `failed` check does. `inconclusive` deliberately
 * does not: blocking on the platform's own uncertainty makes the product
 * unusable on every change it cannot fully analyze.
 */
export function blocksMerge(results: readonly PreMergeCheckPlan[]): boolean {
  return results.some(
    (result) => result.blocking && result.status === "failed",
  );
}
