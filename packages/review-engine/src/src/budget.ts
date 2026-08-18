/**
 * Budget allocation. Not the product's Triage screen.
 *
 * Two things in this product classify risk, and conflating them would be a
 * real architectural mistake:
 *
 * ```
 * budget allocation  (here)         product triage  (assessment.ts → the UI)
 * decides what to SPEND             decides what a HUMAN reviews first
 * never user-visible                the Triage page renders it
 * per risk cluster                  per pull request
 * cheap and approximate on purpose  presented as a considered judgement
 * ```
 *
 * They share inputs — the same signals answer "is this dangerous?" for both —
 * so the signals are computed once, here, and projected for the UI in
 * `assessment.ts`. What must never happen is the reverse: the UI's notion of
 * priority feeding back into how much compute a cluster gets, or budget
 * internals reaching a DTO. The Phase 0 leakage test already forbids the
 * second.
 *
 * The strongest reasoning pass must not be spent equally on every cluster —
 * a renamed local and a change to transaction boundaries are not the same
 * question, and pricing them the same is how a reviewer becomes uneconomic.
 *
 * # The constraint that matters more than the heuristics
 *
 * **Allocation cannot emit a finding.** Not "should not" — cannot:
 * `allocateBudget` returns a {@link BudgetAllocation}, and there is no field on it that could
 * carry a claim. The moment a cheap mechanism can publish, it becomes a second
 * reviewer that nobody tuned, and the cheapness that justified it is exactly
 * what makes its output bad. This is the same reasoning that keeps the verifier
 * from seeing the analyzer's confidence: a component optimized for one job
 * should not be able to do a different one badly.
 *
 * The signals below are approximate on purpose. Getting a tier wrong costs
 * budget; computing it expensively costs the thing it exists to save.
 */

import type { RiskCluster } from "./cluster.js";

export const RISK_TIERS = ["low", "medium", "high", "critical"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/**
 * What triage looks at. Each is cheap to compute from supplied context and
 * says something a reviewer would also weigh.
 */
export interface RiskSignals {
  /** How much was actually written. */
  readonly changedLines: number;
  readonly changedSymbols: number;
  /**
   * How much supplied context references this cluster — the blast radius.
   * A change nothing depends on is cheaper to get wrong.
   */
  readonly dependents: number;
  /**
   * Whether an interface or type declaration is in scope. Contract changes
   * break callers that were never opened, which is the failure a reviewer is
   * least likely to catch unaided.
   */
  readonly contractSensitive: boolean;
  /** Whether tests covering this cluster were supplied. */
  readonly testsPresent: boolean;
  /** Branch and loop density in the changed material. */
  readonly complexity: number;
  /**
   * Declarations with no supplied consumer — new surface, or surface whose
   * consumers the planner did not find. Both deserve a closer look, and this
   * function cannot tell them apart, which is stated rather than hidden.
   */
  readonly novelSymbols: number;
}

export interface BudgetAllocation {
  readonly clusterId: string;
  readonly tier: RiskTier;
  /** Whether a deep reasoning pass runs at all. */
  readonly deepPass: boolean;
  /** Ceiling for this cluster's assembled context. */
  readonly contextTokenBudget: number;
  /** Hard cap on reasoning invocations, retries included. */
  readonly maxReasoningCalls: number;
  readonly signals: RiskSignals;
  /** Why this tier, in the terms a human would argue with. */
  readonly rationale: string;
}

const BRANCHING = /\b(if|for|while|switch|catch|\?\?|&&|\|\|)\b|\?\./g;

export function computeSignals(cluster: RiskCluster): RiskSignals {
  const changedLines = cluster.subject.reduce(
    (total, entry) => total + entry.changedLines.length,
    0,
  );

  const subjectPaths = new Set(cluster.subject.map((entry) => entry.path));

  const dependents = cluster.context.filter(
    (item) =>
      (item.reason === "caller" || item.reason === "associated_test") &&
      !subjectPaths.has(item.path),
  ).length;

  const contractSensitive = cluster.context.some(
    (item) =>
      item.symbol?.kind === "interface" ||
      item.symbol?.kind === "type" ||
      item.reason === "referenced_symbol",
  );

  const testsPresent = cluster.context.some(
    (item) => item.kind === "test" || item.reason === "associated_test",
  );

  const changedText = cluster.context
    .filter(
      (item) => subjectPaths.has(item.path) && item.representation === "full",
    )
    .map((item) => item.suppliedContent)
    .join("\n");
  const complexity = (changedText.match(BRANCHING) ?? []).length;

  const referencedNames = new Set(
    cluster.context
      .filter((item) => !subjectPaths.has(item.path))
      .flatMap((item) => item.suppliedContent.split(/\W+/)),
  );
  const novelSymbols = cluster.changedSymbols.filter((symbol) => {
    const bare = symbol.split(".").pop() ?? symbol;
    return !referencedNames.has(bare);
  }).length;

  return {
    changedLines,
    changedSymbols: cluster.changedSymbols.length,
    dependents,
    contractSensitive,
    testsPresent,
    complexity,
    novelSymbols,
  };
}

/**
 * Assigns a tier and a budget.
 *
 * The weights are editorial judgement and belong in one arguable place. The
 * ordering matters more than the numbers:
 *
 * - **Contract sensitivity outranks size.** A three-line change to an interface
 *   can break every caller; a three-hundred-line change inside one private
 *   function cannot.
 * - **Dependents raise the tier**, because the cost of a missed defect scales
 *   with how much depends on it.
 * - **Missing tests raise it too.** Not because untested code is worse, but
 *   because nothing else is checking, so the review is the only line.
 * - **Volume alone raises it slowly.** A large mechanical rename is not risky,
 *   and treating size as risk is how budget gets spent on the least
 *   interesting pull requests.
 */
export function allocateBudget(
  cluster: RiskCluster,
  limits: { readonly contextTokens: number } = { contextTokens: 24_000 },
): BudgetAllocation {
  const signals = computeSignals(cluster);
  const reasons: string[] = [];

  // Primary risk: reasons a change is dangerous in itself.
  let score = 0;
  if (signals.contractSensitive) {
    score += 4;
    reasons.push("a contract or interface is in scope");
  }
  if (signals.dependents >= 3) {
    score += 2;
    reasons.push(`${String(signals.dependents)} supplied dependents`);
  } else if (signals.dependents > 0) {
    score += 1;
    reasons.push(`${String(signals.dependents)} supplied dependent(s)`);
  }
  if (signals.complexity >= 12) {
    score += 2;
    reasons.push("dense branching in the changed material");
  } else if (signals.complexity >= 4) {
    score += 1;
  }
  if (signals.changedLines >= 200) {
    score += 1;
    reasons.push("large change");
  }

  // Amplifiers, and they only amplify. "Untested" and "nothing supplied
  // references it" make an already-risky change riskier; on their own they
  // describe most small self-contained edits in any codebase, and letting them
  // originate risk would push nearly every cluster to `medium` and spend the
  // deep-pass budget on renames.
  if (score > 0) {
    if (!signals.testsPresent) {
      score += 1;
      reasons.push("no covering test was supplied");
    }
    if (signals.novelSymbols > 0) {
      score += 1;
      reasons.push(
        `${String(signals.novelSymbols)} declaration(s) with no supplied consumer`,
      );
    }
  }

  const tier: RiskTier =
    score >= 7
      ? "critical"
      : score >= 5
        ? "high"
        : score >= 2
          ? "medium"
          : "low";

  // A low tier still gets deterministic analysis — that is nearly free and is
  // where the compiler-grade findings come from. What it does not get is an
  // expensive reasoning pass.
  const deepPass = tier !== "low";

  const contextTokenBudget = Math.round(
    limits.contextTokens *
      { low: 0.25, medium: 0.5, high: 1, critical: 1.5 }[tier],
  );

  return {
    clusterId: cluster.id,
    tier,
    deepPass,
    contextTokenBudget,
    maxReasoningCalls: { low: 0, medium: 1, high: 2, critical: 3 }[tier],
    signals,
    rationale:
      reasons.length === 0
        ? "nothing raised the tier: small, self-contained, and covered"
        : reasons.join("; "),
  };
}
