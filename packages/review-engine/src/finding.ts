/**
 * The generation discipline: a finding must explain itself or it does not exist.
 *
 * The failure mode this file prevents is not "the analyzer is wrong". It is
 * this:
 *
 * > "This might fail if the input is unexpected."
 *
 * which is a reviewer transferring its uncertainty to the reader, who now has
 * to do the analysis that was the reviewer's job. Ten of those and the bot gets
 * muted, and the two real findings underneath go with it.
 *
 * So a claim is not enough. A finding is only constructible with:
 *
 * ```
 * claim           what is wrong
 * anchor          the changed line that causes it
 * causal steps    how that line produces the failure
 * trigger         the input or state required to reach it
 * consequence     what the reader loses when it happens
 * evidence        what establishes it
 * counterfactual  would this exist without the change?
 * ```
 *
 * If the causal chain cannot be written, the finding is **suppressed** — not
 * downgraded, not emitted with a low score. A low-confidence correctness
 * comment is worse than silence, because it costs the same attention and
 * resolves nothing.
 *
 * Suppression is recorded rather than silent, for the same reason the planner
 * records omissions: "considered and rejected" and "never noticed" are
 * different facts, and only the first can be tuned.
 */

import type {
  FindingCategory,
  FindingSeverity,
} from "@acalys/contracts/domain";

import type { AnalyzerEvidence, FindingLocation } from "./analyzer.js";
import { confidenceFromEvidence } from "./analyzer.js";

/**
 * Correctness families — analyzer and eval diagnostics, never public taxonomy.
 *
 * The public category stays `correctness`. These exist so a regression is
 * diagnosable: "correctness recall −8%" is not actionable, "api contract −31%,
 * everything else flat" is.
 *
 * Deliberately not Phase 0 values. They never reach a DTO, and adding one is a
 * change to how we investigate, not to what we publish.
 */
export const CORRECTNESS_FAMILIES = [
  "control_flow",
  "state",
  "data_flow",
  "nullability",
  "boundary",
  "error_handling",
  "resource_lifecycle",
  "concurrency",
  "persistence",
  "api_contract",
  "compatibility",
] as const;

export type CorrectnessFamily = (typeof CORRECTNESS_FAMILIES)[number];

/** How the changed line produces the failure. */
export interface CausalChain {
  /** The changed line the author wrote. Not the symptom's location. */
  readonly anchor: FindingLocation;
  /**
   * Each step from the change to the failure. At least one, and each must be
   * a mechanism rather than a restatement of the claim.
   */
  readonly steps: readonly string[];
  /** The input or state required to reach it. */
  readonly trigger: string;
  /** What the reader loses when it happens. */
  readonly consequence: string;
}

/**
 * Whether the defect predates the change.
 *
 * `not_caused_by_change` already exists as a verification outcome, but spending
 * the verifier's budget on findings the analyzer could have recognized as
 * pre-existing is waste at the more expensive stage.
 */
export interface Counterfactual {
  readonly existsWithoutChange: boolean;
  readonly because: string;
}

export interface CandidateFinding {
  readonly ruleId: string;
  readonly category: FindingCategory;
  readonly family: CorrectnessFamily;
  readonly claim: string;
  readonly causal: CausalChain;
  readonly counterfactual: Counterfactual;
  readonly proposedSeverity: FindingSeverity;
  /** Derived from evidence. Never asserted by the rule that noticed. */
  readonly confidenceScore: number;
  readonly location: FindingLocation;
  readonly evidence: readonly AnalyzerEvidence[];
  readonly identityHint: string;
  readonly clusterId: string;
}

export const SUPPRESSION_REASONS = [
  "no_causal_chain",
  "no_trigger",
  "no_consequence",
  "no_evidence",
  "pre_existing",
  "below_confidence_floor",
  "not_a_correctness_claim",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface Suppression {
  readonly reason: SuppressionReason;
  readonly ruleId: string;
  readonly clusterId: string;
  readonly detail: string;
}

/**
 * Below this, a correctness comment is not worth a reader's attention.
 *
 * Not a tuning knob to be lowered when recall looks disappointing. Recall
 * bought by emitting things the analyzer does not believe is not recall — it is
 * the reader doing the analysis, with extra steps.
 */
export const CONFIDENCE_FLOOR = 0.55;

export interface Proposal {
  readonly ruleId: string;
  readonly family: CorrectnessFamily;
  readonly claim: string;
  readonly causal: CausalChain;
  readonly counterfactual: Counterfactual;
  readonly proposedSeverity: FindingSeverity;
  readonly location: FindingLocation;
  readonly evidence: readonly AnalyzerEvidence[];
  readonly identityHint: string;
  readonly clusterId: string;
}

export type ProposalOutcome =
  | { readonly kind: "finding"; readonly finding: CandidateFinding }
  | { readonly kind: "suppressed"; readonly suppression: Suppression };

/**
 * The only way to construct a candidate finding.
 *
 * Every rejection below is a class of comment that would have been shipped
 * otherwise. They are checked in order of how cheap they are to detect, and
 * each one names itself in the record so the suppression rate is diagnosable
 * rather than merely reassuring.
 */
export function propose(proposal: Proposal): ProposalOutcome {
  const suppress = (
    reason: SuppressionReason,
    detail: string,
  ): ProposalOutcome => ({
    kind: "suppressed",
    suppression: {
      reason,
      ruleId: proposal.ruleId,
      clusterId: proposal.clusterId,
      detail,
    },
  });

  if (proposal.causal.steps.length === 0) {
    return suppress(
      "no_causal_chain",
      "the rule could not state how the changed line produces the failure",
    );
  }
  if (proposal.causal.trigger.trim() === "") {
    return suppress("no_trigger", "no input or state that reaches the defect");
  }
  if (proposal.causal.consequence.trim() === "") {
    return suppress("no_consequence", "no stated effect on the reader");
  }
  if (proposal.evidence.length === 0) {
    return suppress("no_evidence", "a claim with no support is an opinion");
  }
  if (proposal.counterfactual.existsWithoutChange) {
    // Real, possibly worth fixing, and not this review's business. Surfacing it
    // trains authors that Acalys comments on code they did not write.
    return suppress("pre_existing", proposal.counterfactual.because);
  }

  const confidenceScore = confidenceFromEvidence(proposal.evidence);
  if (confidenceScore < CONFIDENCE_FLOOR) {
    return suppress(
      "below_confidence_floor",
      `strongest evidence supports ${confidenceScore.toFixed(2)}, floor is ${String(CONFIDENCE_FLOOR)}`,
    );
  }

  return {
    kind: "finding",
    finding: {
      ruleId: proposal.ruleId,
      category: "correctness",
      family: proposal.family,
      claim: proposal.claim,
      causal: proposal.causal,
      counterfactual: proposal.counterfactual,
      proposedSeverity: proposal.proposedSeverity,
      confidenceScore,
      location: proposal.location,
      evidence: proposal.evidence,
      identityHint: proposal.identityHint,
      clusterId: proposal.clusterId,
    },
  };
}

/** What one analysis produced, including what it decided not to say. */
export interface AnalysisResult {
  readonly findings: readonly CandidateFinding[];
  readonly suppressions: readonly Suppression[];
  /** Clusters that were not deeply analyzed, and why. */
  readonly degradations: readonly {
    readonly clusterId: string;
    readonly reason: string;
  }[];
}

/**
 * Whether a result is a complete review or a budget-constrained one.
 *
 * A review that analyzed half the pull request and presented the result as
 * complete makes every quality metric computed from it wrong in an unknown
 * direction. Callers must be able to ask.
 */
export function wasDegraded(result: AnalysisResult): boolean {
  return result.degradations.length > 0;
}
