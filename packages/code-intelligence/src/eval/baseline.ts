/**
 * The committed baseline, and how drift from it is judged.
 *
 * A metric nobody compares against anything is a number in a log. The baseline
 * is checked in so that a planner change shows up as a **reviewable diff** —
 * "this edit dropped `irrelevantContextRatio` from 0.61 to 0.24" is a claim a
 * reviewer can accept or reject; "the eval still passes" is not.
 *
 * Two different failure modes, deliberately judged differently:
 *
 *   invariants   requiredContextRecall, instructionCoverage, forbidden leaks.
 *                Absolute. No tolerance, no baseline — a violation is a bug
 *                whatever the previous value was. Ratcheting these against a
 *                baseline would let a regression become the new normal.
 *
 *   trends       irrelevantContextRatio, truncationRate, token counts.
 *                Compared to the baseline with a tolerance, because there is no
 *                a-priori correct value and a small movement is not news.
 */

import { contextSimilarity, type PlannerMetrics } from "./metrics.js";
import { evaluate } from "./run.js";
import type { PlannerScenario } from "./scenario.js";

/** Movement smaller than this is noise, not a signal worth failing on. */
export const DRIFT_TOLERANCE = 0.05;

/**
 * Minimum similarity between an equivalent pair.
 *
 * Not 1.0: the same change at a different offset legitimately picks up
 * different neighbouring context. Below this, position is changing the review,
 * which makes every other comparison in this file noise.
 */
export const MIN_STABILITY = 0.9;

export interface BaselineEntry {
  readonly irrelevantContextRatio: number;
  readonly tokenUtilization: number;
  readonly truncationRate: number;
  readonly suppliedItems: number;
  readonly suppliedTokens: number;
}

export interface PlannerBaseline {
  /** Bumped when the metric definitions change, so stale files fail loudly. */
  readonly version: number;
  readonly scenarios: Readonly<Record<string, BaselineEntry>>;
  readonly stability: Readonly<Record<string, number>>;
}

export const BASELINE_VERSION = 1;

function entryOf(metrics: PlannerMetrics): BaselineEntry {
  return {
    irrelevantContextRatio: metrics.irrelevantContextRatio,
    tokenUtilization: metrics.tokenUtilization,
    truncationRate: metrics.truncationRate,
    suppliedItems: metrics.suppliedItems,
    suppliedTokens: metrics.suppliedTokens,
  };
}

export function buildBaseline(
  scenarios: readonly PlannerScenario[],
): PlannerBaseline {
  const { report, contexts } = evaluate(scenarios);

  const entries: Record<string, BaselineEntry> = {};
  for (const metrics of report.scenarios) {
    entries[metrics.scenarioId] = entryOf(metrics);
  }

  const stability: Record<string, number> = {};
  for (const scenario of scenarios) {
    const other = scenario.equivalentTo;
    if (other === undefined) continue;
    const left = contexts.get(scenario.id);
    const right = contexts.get(other);
    if (left === undefined || right === undefined) {
      throw new Error(
        `Scenario "${scenario.id}" declares equivalentTo "${other}", which is not in the corpus.`,
      );
    }
    stability[`${other}~${scenario.id}`] = contextSimilarity(left, right);
  }

  // Keys sorted so the committed file diffs on values, never on ordering.
  return {
    version: BASELINE_VERSION,
    scenarios: Object.fromEntries(
      Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
    ),
    stability: Object.fromEntries(
      Object.entries(stability).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

export interface Drift {
  readonly scenarioId: string;
  readonly metric: string;
  readonly baseline: number;
  readonly current: number;
}

/**
 * Every trend metric that moved past tolerance, plus scenarios that appeared or
 * vanished. A scenario missing from the baseline is reported rather than
 * silently accepted: a corpus that grows without the baseline growing means the
 * new scenarios are unmeasured.
 */
export function compareBaseline(
  baseline: PlannerBaseline,
  current: PlannerBaseline,
): readonly Drift[] {
  const drift: Drift[] = [];

  for (const [scenarioId, expected] of Object.entries(baseline.scenarios)) {
    const actual = current.scenarios[scenarioId];
    if (actual === undefined) {
      drift.push({
        scenarioId,
        metric: "scenario-removed",
        baseline: 1,
        current: 0,
      });
      continue;
    }
    for (const metric of Object.keys(expected) as (keyof BaselineEntry)[]) {
      const before = expected[metric];
      const after = actual[metric];
      // Counts move by whole items; ratios by fractions. Comparing both against
      // an absolute 0.05 would make a one-item change invisible.
      const tolerance =
        metric === "suppliedItems" || metric === "suppliedTokens"
          ? Math.max(1, Math.abs(before) * DRIFT_TOLERANCE)
          : DRIFT_TOLERANCE;
      if (Math.abs(after - before) > tolerance) {
        drift.push({ scenarioId, metric, baseline: before, current: after });
      }
    }
  }

  for (const scenarioId of Object.keys(current.scenarios)) {
    if (baseline.scenarios[scenarioId] === undefined) {
      drift.push({
        scenarioId,
        metric: "scenario-unmeasured",
        baseline: 0,
        current: 1,
      });
    }
  }

  for (const [pair, before] of Object.entries(baseline.stability)) {
    const after = current.stability[pair];
    if (after === undefined) {
      drift.push({
        scenarioId: pair,
        metric: "stability-removed",
        baseline: before,
        current: 0,
      });
    } else if (Math.abs(after - before) > DRIFT_TOLERANCE) {
      drift.push({
        scenarioId: pair,
        metric: "stability",
        baseline: before,
        current: after,
      });
    }
  }

  return drift;
}
