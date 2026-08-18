/**
 * What an analyzer is, and the one boundary that makes the whole pipeline
 * measurable.
 *
 * # An analyzer sees the assembled context and nothing else
 *
 * `analyze` takes an `AssembledContext`, not a repository, not a filesystem,
 * not a path it can read. That is deliberate and it is the most important line
 * in this file.
 *
 * If an analyzer could reach past the planner for a file it wanted, then a
 * missed finding would have no attributable cause: maybe the planner failed,
 * maybe the analyzer did, maybe the analyzer quietly compensated for a planner
 * that was failing all along and the metrics were flattering. Cutting the
 * analyzer off from everything except supplied context makes the P1-F numbers
 * mean what they claim:
 *
 *     required context missing            →  the planner regressed
 *     context stable, recall down         →  the analyzer regressed
 *
 * The cost is real and is the point: **a defect whose evidence was never
 * supplied cannot be found.** That is a true statement about a reviewer, and a
 * system that hides it is a system that cannot be improved deliberately.
 *
 * # Analyzers refuse to guess
 *
 * A finding is emitted only when the supplied context *establishes* it. No
 * heuristics from naming, no "this looks like it returns a promise". A guess
 * that happens to be right is indistinguishable from noise to the person
 * reading it, and noise is the thing that gets a review bot muted.
 */

import type { AssembledContext } from "@acalys/code-intelligence";
import type {
  EvidenceStrength,
  EvidenceType,
  FindingCategory,
  FindingSeverity,
} from "@acalys/contracts/domain";

/** Where a finding is, in the terms the repository uses. */
export interface FindingLocation {
  readonly path: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * One piece of support for a claim.
 *
 * Every finding must carry at least one, and the strongest one it carries caps
 * its confidence. A claim with no evidence is an opinion, and this pipeline has
 * no way to verify an opinion later.
 */
export interface AnalyzerEvidence {
  readonly type: EvidenceType;
  readonly strength: EvidenceStrength;
  /** What was observed. Never a conclusion — that is the finding's job. */
  readonly observation: string;
  readonly location?: FindingLocation | undefined;
}

/**
 * A candidate finding, before verification.
 *
 * `claim` rather than `message`: an analyzer asserts something that may be
 * wrong, and naming the field after what it is keeps the verifier's job
 * legible. `proposedSeverity` for the same reason — severity is decided by the
 * pipeline, not by whoever noticed the problem.
 */
export interface AnalyzerFinding {
  /** Namespaced and stable. Part of the fingerprint. */
  readonly ruleId: string;
  readonly category: FindingCategory;
  readonly claim: string;
  /** Why it matters, in the reader's terms. Not a restatement of the claim. */
  readonly rationale: string;
  readonly proposedSeverity: FindingSeverity;
  /**
   * 0–1. A *function of evidence*, never of how confident the rule feels.
   * `deterministic` evidence earns a high score; `supporting` earns less.
   */
  readonly confidenceScore: number;
  readonly location: FindingLocation;
  readonly evidence: readonly AnalyzerEvidence[];
  /** Stable across revisions for the same defect. Feeds the fingerprint. */
  readonly identityHint: string;
}

export interface AnalyzerInput {
  /**
   * Everything the analyzer may look at.
   *
   * Not a superset of what was sent to a model — the *same* thing. An analyzer
   * reasoning over material the reviewer never saw would measure a pipeline
   * that does not exist.
   */
  readonly context: AssembledContext;
}

export interface Analyzer {
  /** Namespaced id. Part of the analyzer-input identity for caching. */
  readonly id: string;
  /** Bumped when output could change for identical input. */
  readonly version: string;
  /** What this analyzer claims to cover, for gap analysis. */
  readonly categories: readonly FindingCategory[];
  analyze(input: AnalyzerInput): readonly AnalyzerFinding[];
}

/**
 * The confidence a piece of evidence can justify.
 *
 * A table rather than a judgement at each call site, because "how sure are we?"
 * is the number that decides whether a human is interrupted, and it should be
 * arguable in one place.
 *
 * The ceiling is 0.95, not 1.0. A static rule can be certain about the code it
 * was shown and still be wrong about the code it was not — a caller that
 * handles the rejection two frames up, a wrapper that awaits internally. There
 * is no evidence available here that justifies certainty.
 */
export const CONFIDENCE_FOR_STRENGTH: Readonly<
  Record<EvidenceStrength, number>
> = {
  deterministic: 0.95,
  strong: 0.8,
  supporting: 0.6,
  weak: 0.3,
};

/** The confidence a finding's evidence supports: its strongest single item. */
export function confidenceFromEvidence(
  evidence: readonly AnalyzerEvidence[],
): number {
  return evidence.reduce(
    (best, item) => Math.max(best, CONFIDENCE_FOR_STRENGTH[item.strength]),
    0,
  );
}
