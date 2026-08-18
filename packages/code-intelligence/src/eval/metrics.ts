/**
 * Planner metrics — the numbers that make a regression diagnosable.
 *
 * The point is attribution. When review quality drops, there are three
 * candidate causes and they need different fixes:
 *
 *     required context missing            →  the planner regressed
 *     context stable, finding recall down →  the analyzer regressed
 *     candidates stable, false positives up → the verifier regressed
 *
 * Only the first is measurable here, and measuring it is what stops the other
 * two being guessed at. A reviewer that misses a bug it was never shown is not
 * a model failure, and treating it as one sends the next month of work in the
 * wrong direction.
 *
 * Each metric below states what regression it detects; a number with no failure
 * mode attached is a number nobody will act on.
 */

import type { AssembledContext } from "../planner.js";
import type { PlannerScenario } from "./scenario.js";

export interface PlannerMetrics {
  readonly scenarioId: string;

  /**
   * Fraction of required context actually supplied.
   *
   * **The metric that matters most.** Anything below 1.0 means a reviewer was
   * asked to find a defect in code it could not see. Treated as a hard
   * invariant rather than a trend, because there is no acceptable amount of
   * "the necessary file was missing".
   */
  readonly requiredContextRecall: number;

  /** Required items that were missing, so a failure names them. */
  readonly missingRequired: readonly string[];

  /**
   * Forbidden items that reached the analyzer.
   *
   * Must be zero. These are items the planner is *tempted* by — a generated
   * file that genuinely imports the changed symbol — and admitting one evicts
   * real context purely by arriving first.
   */
  readonly forbiddenAdmitted: readonly string[];

  /**
   * Share of supplied tokens spent on material the scenario did not require.
   *
   * Not a defect on its own: extra context is often useful, and a planner that
   * supplied *only* the required items would be overfit to the corpus. It is a
   * **trend** — a sharp rise means the planner became greedy, which shows up as
   * cost per review long before it shows up as quality.
   */
  readonly irrelevantContextRatio: number;

  /**
   * Budget actually consumed.
   *
   * Low utilization with full recall is good — the reviewer got what it needed
   * cheaply. Low utilization with *incomplete* recall is the diagnostic pair
   * that matters: it means the planner failed to find the context, not that it
   * ran out of room.
   */
  readonly tokenUtilization: number;

  /**
   * Share of supplied items that were truncated.
   *
   * A rising rate means the budget is too small for the selection strategy, and
   * excerpts are the quietest way for a reviewer to be misled: half a function
   * looks like a whole one.
   */
  readonly truncationRate: number;

  /**
   * Fraction of required *symbols* supplied, as opposed to required files.
   *
   * Separate from file recall because supplying a 3,000-line file that happens
   * to contain the symbol is not the same as supplying the symbol. This catches
   * a planner that degrades to whole-file inclusion and still scores 1.0 on
   * path recall.
   */
  readonly relevantSymbolCoverage: number;

  /** Whether every declared instruction reached the analyzer. Must be 1.0. */
  readonly instructionCoverage: number;

  readonly suppliedTokens: number;
  readonly suppliedItems: number;
}

/** Whether an assembled context contains a required item. */
function supplies(
  context: AssembledContext,
  path: string,
  symbol?: string,
): boolean {
  return context.items.some((item) => {
    if (item.path !== path) return false;
    if (symbol === undefined) return true;
    // A symbol requirement is satisfied by the declaration itself, or by any
    // item whose supplied text actually contains it — a whole file counts, but
    // an excerpt that truncated the symbol away does not.
    if (item.symbol?.name === symbol || item.symbol?.qualifiedName === symbol) {
      return true;
    }
    return item.suppliedContent.includes(symbol);
  });
}

export function computeMetrics(
  scenario: PlannerScenario,
  context: AssembledContext,
): PlannerMetrics {
  const missingRequired = scenario.required
    .filter(
      (requirement) => !supplies(context, requirement.path, requirement.symbol),
    )
    .map((requirement) =>
      requirement.symbol === undefined
        ? requirement.path
        : `${requirement.path}#${requirement.symbol}`,
    );

  const forbiddenAdmitted = (scenario.forbidden ?? [])
    .filter((entry) => context.items.some((item) => item.path === entry.path))
    .map((entry) => entry.path);

  // Changed files count as required whether or not a scenario declares them:
  // they are the subject of the review. A ratio that called the changed file
  // "irrelevant" would reward a planner for dropping the diff itself, which is
  // the one thing it can never do.
  const requiredPaths = new Set([
    ...scenario.required.map((r) => r.path),
    ...scenario.changed.map((c) => c.path),
  ]);
  const suppliedTokens = context.items.reduce(
    (total, item) => total + Math.ceil(item.suppliedContent.length / 4),
    0,
  );
  const irrelevantTokens = context.items
    .filter((item) => !requiredPaths.has(item.path))
    .reduce(
      (total, item) => total + Math.ceil(item.suppliedContent.length / 4),
      0,
    );

  const requiredSymbols = scenario.required.filter(
    (r) => r.symbol !== undefined,
  );
  const coveredSymbols = requiredSymbols.filter((r) =>
    context.items.some(
      (item) =>
        item.path === r.path &&
        (item.symbol?.name === r.symbol ||
          item.symbol?.qualifiedName === r.symbol),
    ),
  );

  const declaredInstructions = [
    ...(scenario.instructions ?? []).map((i) => i.path),
    ...(scenario.pathInstructions ?? []).map((i) => i.glob),
  ];
  const suppliedInstructions = declaredInstructions.filter((path) =>
    context.items.some(
      (item) => item.path === path && item.kind === "instruction",
    ),
  );

  const ratio = (numerator: number, denominator: number): number =>
    denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));

  return {
    scenarioId: scenario.id,
    requiredContextRecall: ratio(
      scenario.required.length - missingRequired.length,
      scenario.required.length,
    ),
    missingRequired,
    forbiddenAdmitted,
    irrelevantContextRatio: ratio(irrelevantTokens, suppliedTokens),
    tokenUtilization: ratio(context.budget.consumed, context.budget.limit),
    truncationRate: ratio(
      // `excerpt` and `summary` only. A `metadata` pointer is emitted when the
      // body was already supplied in full elsewhere in the same context, so
      // counting it as truncation would report loss where none occurred — and
      // would make the de-duplication that *saves* context look like a
      // regression.
      context.items.filter(
        (item) =>
          item.representation === "excerpt" ||
          item.representation === "summary",
      ).length,
      context.items.length,
    ),
    relevantSymbolCoverage: ratio(
      coveredSymbols.length,
      requiredSymbols.length,
    ),
    instructionCoverage: ratio(
      suppliedInstructions.length,
      declaredInstructions.length,
    ),
    suppliedTokens,
    suppliedItems: context.items.length,
  };
}

/** Corpus-level aggregate. Per-scenario numbers stay available for diagnosis. */
export interface PlannerReport {
  readonly scenarios: readonly PlannerMetrics[];
  readonly requiredContextRecall: number;
  readonly instructionCoverage: number;
  readonly relevantSymbolCoverage: number;
  readonly irrelevantContextRatio: number;
  readonly truncationRate: number;
  /** Scenarios that admitted something forbidden. Must be empty. */
  readonly leaks: readonly string[];
}

export function summarize(scenarios: readonly PlannerMetrics[]): PlannerReport {
  const mean = (pick: (m: PlannerMetrics) => number): number =>
    scenarios.length === 0
      ? 1
      : Number(
          (
            scenarios.reduce((total, m) => total + pick(m), 0) /
            scenarios.length
          ).toFixed(4),
        );

  return {
    scenarios,
    requiredContextRecall: mean((m) => m.requiredContextRecall),
    instructionCoverage: mean((m) => m.instructionCoverage),
    relevantSymbolCoverage: mean((m) => m.relevantSymbolCoverage),
    irrelevantContextRatio: mean((m) => m.irrelevantContextRatio),
    truncationRate: mean((m) => m.truncationRate),
    leaks: scenarios
      .filter((m) => m.forbiddenAdmitted.length > 0)
      .map((m) => m.scenarioId),
  };
}

/**
 * How similar two selections are — the stability metric.
 *
 * Jaccard over `path:reason` pairs. The same semantic change expressed
 * differently must select equivalent context, or an unrelated edit above a
 * function silently changes its review and every eval comparison becomes noise.
 *
 * Measures *selection*, not volume — two contexts choosing the same items for
 * the same reasons score 1.0 even if one carries far more text, because a file
 * that grew is still the same file. Volume is watched separately by the
 * baseline's `suppliedTokens`, which is what catches a change that quietly
 * multiplies prompt cost without changing what was chosen.
 */
export function contextSimilarity(
  left: AssembledContext,
  right: AssembledContext,
): number {
  const key = (context: AssembledContext) =>
    new Set(context.items.map((item) => `${item.path}:${item.reason}`));
  const a = key(left);
  const b = key(right);
  const intersection = [...a].filter((entry) => b.has(entry)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : Number((intersection / union).toFixed(4));
}
