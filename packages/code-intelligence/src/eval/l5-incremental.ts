/**
 * Observational accounting for the P1-L.5 incremental economics experiment.
 *
 * Work counts come only from production {@link IncrementalStats}. Timing is a
 * separate observation: retained records are evidence about skipped work, not
 * a clock and never an input to the reported speedup.
 */

import type {
  FallbackReason,
  IncrementalStats,
} from "../repository-index/incremental.js";
import type { RecomputeReason } from "../repository-index/incremental-plan.js";

export const L5_INCREMENTAL_WARMUPS = 5;
export const L5_INCREMENTAL_MEASURED_RUNS = 20;
export const L5_MINIMUM_INCREMENTAL_SUCCESS_RATE = 0.9;
export const L5_MINIMUM_MEDIAN_PAIRED_SPEEDUP = 1 / (1 - 0.1);

export type MonotonicClock = () => number;

export interface IncrementalOperationOutcome {
  readonly stats: IncrementalStats;
}

export interface IncrementalStatsTotals {
  readonly modulesTotal: number;
  readonly modulesRetained: number;
  readonly modulesRecomputed: number;
  readonly modulesDeleted: number;
  readonly referencesRecomputed: number;
  readonly referencesRetained: number;
  readonly bindingsRecomputed: number;
  readonly bindingsRetained: number;
  /** Added or modified modules, as stated by production recompute reasons. */
  readonly directInvalidations: number;
  /** Modules invalidated because their repository dependencies may differ. */
  readonly dependencyInvalidations: number;
  readonly recomputeReasons: Readonly<Partial<Record<RecomputeReason, number>>>;
}

export interface IncrementalStatsReport {
  readonly runs: number;
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly fullRebuildFallbacks: number;
  readonly fallbacksByReason: Readonly<Partial<Record<FallbackReason, number>>>;
  /** Per-run production observations, retained for the required case rows. */
  readonly observations: readonly IncrementalStats[];
  readonly totals: IncrementalStatsTotals;
}

const cloneStats = (stats: IncrementalStats): IncrementalStats => ({
  ...stats,
  recomputeReasons: { ...stats.recomputeReasons },
});

const sum = (
  observations: readonly IncrementalStats[],
  pick: (stats: IncrementalStats) => number,
): number =>
  observations.reduce((total, observation) => total + pick(observation), 0);

/** Records production stats without changing the operation's returned value. */
export class IncrementalStatsRecorder {
  private readonly observations: IncrementalStats[] = [];

  record(stats: IncrementalStats): void {
    this.observations.push(cloneStats(stats));
  }

  observe<T extends IncrementalOperationOutcome>(operation: () => T): T {
    const outcome = operation();
    this.record(outcome.stats);
    return outcome;
  }

  report(): IncrementalStatsReport {
    const observations = this.observations.map(cloneStats);
    const reasonEntries = observations.flatMap(
      (stats) =>
        Object.entries(stats.recomputeReasons) as [RecomputeReason, number][],
    );
    const recomputeReasons = reasonEntries.reduce<
      Partial<Record<RecomputeReason, number>>
    >((totals, [reason, count]) => {
      totals[reason] = (totals[reason] ?? 0) + count;
      return totals;
    }, {});
    const fallbacksByReason = observations.reduce<
      Partial<Record<FallbackReason, number>>
    >((totals, stats) => {
      if (!stats.succeeded && stats.fallbackReason !== undefined) {
        totals[stats.fallbackReason] = (totals[stats.fallbackReason] ?? 0) + 1;
      }
      return totals;
    }, {});

    return {
      runs: observations.length,
      attempted: observations.filter((stats) => stats.attempted).length,
      succeeded: observations.filter((stats) => stats.succeeded).length,
      failed: observations.filter((stats) => !stats.succeeded).length,
      fullRebuildFallbacks: observations.filter(
        (stats) => !stats.succeeded && stats.fallbackReason !== undefined,
      ).length,
      fallbacksByReason,
      observations,
      totals: {
        modulesTotal: sum(observations, (stats) => stats.modulesTotal),
        modulesRetained: sum(observations, (stats) => stats.modulesRetained),
        modulesRecomputed: sum(
          observations,
          (stats) => stats.modulesRecomputed,
        ),
        modulesDeleted: sum(observations, (stats) => stats.modulesDeleted),
        referencesRecomputed: sum(
          observations,
          (stats) => stats.referencesRecomputed,
        ),
        referencesRetained: sum(
          observations,
          (stats) => stats.referencesRetained,
        ),
        bindingsRecomputed: sum(
          observations,
          (stats) => stats.bindingsRecomputed,
        ),
        bindingsRetained: sum(observations, (stats) => stats.bindingsRetained),
        directInvalidations:
          (recomputeReasons.added ?? 0) + (recomputeReasons.modified ?? 0),
        dependencyInvalidations:
          (recomputeReasons.references_changed_module ?? 0) +
          (recomputeReasons.unresolved_reference_present ?? 0),
        recomputeReasons,
      },
    };
  }
}

export interface MonotonicMeasurement<T> {
  readonly value: T;
  readonly durationMs: number;
}

/** Times one operation and returns its value by identity. */
export function measureMonotonic<T>(
  operation: () => T,
  clock: MonotonicClock = () => performance.now(),
): MonotonicMeasurement<T> {
  const startedAt = clock();
  const value = operation();
  const completedAt = clock();

  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) {
    throw new Error("Monotonic clock returned a non-finite timestamp");
  }
  if (completedAt < startedAt) {
    throw new Error(
      `Monotonic clock moved backwards: ${startedAt} -> ${completedAt}`,
    );
  }

  return { value, durationMs: completedAt - startedAt };
}

export interface NumericDistribution {
  readonly n: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

/** Values are milliseconds. */
export type DurationDistribution = NumericDistribution;

/** Unitless full-duration / incremental-duration ratios. */
export type PairedSpeedupDistribution = NumericDistribution;

export type IncrementalExecutionOrder =
  "full_then_incremental" | "incremental_then_full";

export interface IncrementalTimingRow {
  /** One-based measured-run number. */
  readonly run: number;
  readonly order: IncrementalExecutionOrder;
  readonly fullMs: number;
  readonly incrementalMs: number;
  /** This pair's full duration divided by its complete incremental duration. */
  readonly pairedSpeedup: number;
  readonly incrementalStats: IncrementalStats;
}

export interface PairedTimingDistributions {
  readonly full: DurationDistribution;
  readonly incremental: DurationDistribution;
  readonly pairedSpeedup: PairedSpeedupDistribution;
}

export interface IncrementalTimingReport {
  readonly warmupsPerPath: typeof L5_INCREMENTAL_WARMUPS;
  readonly measuredRuns: typeof L5_INCREMENTAL_MEASURED_RUNS;
  readonly rows: readonly IncrementalTimingRow[];
  /** Intention-to-treat: every scheduled measured incremental attempt. */
  readonly primary: PairedTimingDistributions;
  /** Diagnostic only; excludes failed and fallback incremental attempts. */
  readonly successfulOnly: PairedTimingDistributions | undefined;
  readonly successRate: number;
  readonly economicallyUseful: boolean;
  readonly incrementalStats: IncrementalStatsReport;
}

export interface IncrementalTimingOptions<
  FullResult,
  IncrementalResult extends IncrementalOperationOutcome,
> {
  readonly full: () => FullResult;
  /** Must invoke the complete updateRepositoryIndex operation. */
  readonly incremental: () => IncrementalResult;
  readonly clock?: MonotonicClock | undefined;
}

const executionOrder = (run: number): IncrementalExecutionOrder =>
  run % 2 === 0 ? "full_then_incremental" : "incremental_then_full";

const runWarmupPair = (
  order: IncrementalExecutionOrder,
  full: () => unknown,
  incremental: () => unknown,
): void => {
  if (order === "full_then_incremental") {
    full();
    incremental();
  } else {
    incremental();
    full();
  }
};

const distribution = (samples: readonly number[]): NumericDistribution => {
  const sorted = [...samples].sort((left, right) => left - right);
  if (sorted.length === 0) {
    throw new Error("Cannot summarize an empty duration distribution");
  }

  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const p95Index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
  );

  return {
    n: sorted.length,
    median,
    p95: sorted[p95Index] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
};

/**
 * Runs the fixed L.5 protocol. Alternating pair order controls first-path
 * bias; every second pair reverses the preceding pair's order.
 */
export function measureIncrementalEconomics<
  FullResult,
  IncrementalResult extends IncrementalOperationOutcome,
>(
  options: IncrementalTimingOptions<FullResult, IncrementalResult>,
): IncrementalTimingReport {
  const clock = options.clock ?? (() => performance.now());

  for (let run = 0; run < L5_INCREMENTAL_WARMUPS; run += 1) {
    runWarmupPair(executionOrder(run), options.full, options.incremental);
  }

  const recorder = new IncrementalStatsRecorder();
  const rows: IncrementalTimingRow[] = [];

  for (let run = 0; run < L5_INCREMENTAL_MEASURED_RUNS; run += 1) {
    const order = executionOrder(run);
    let fullMeasurement: MonotonicMeasurement<FullResult>;
    let incrementalMeasurement: MonotonicMeasurement<IncrementalResult>;

    if (order === "full_then_incremental") {
      fullMeasurement = measureMonotonic(options.full, clock);
      incrementalMeasurement = measureMonotonic(options.incremental, clock);
    } else {
      incrementalMeasurement = measureMonotonic(options.incremental, clock);
      fullMeasurement = measureMonotonic(options.full, clock);
    }

    recorder.record(incrementalMeasurement.value.stats);
    if (incrementalMeasurement.durationMs === 0) {
      throw new Error(
        "Incremental duration was zero; clock resolution cannot support a paired speedup",
      );
    }
    rows.push({
      run: run + 1,
      order,
      fullMs: fullMeasurement.durationMs,
      incrementalMs: incrementalMeasurement.durationMs,
      pairedSpeedup:
        fullMeasurement.durationMs / incrementalMeasurement.durationMs,
      incrementalStats: cloneStats(incrementalMeasurement.value.stats),
    });
  }

  const distributionsFor = (
    selected: readonly IncrementalTimingRow[],
  ): PairedTimingDistributions => ({
    full: distribution(selected.map((row) => row.fullMs)),
    incremental: distribution(selected.map((row) => row.incrementalMs)),
    pairedSpeedup: distribution(selected.map((row) => row.pairedSpeedup)),
  });
  const primary = distributionsFor(rows);
  const successfulRows = rows.filter((row) => row.incrementalStats.succeeded);
  const successfulOnly =
    successfulRows.length === 0 ? undefined : distributionsFor(successfulRows);
  const incrementalStats = recorder.report();
  const successRate = incrementalStats.succeeded / rows.length;

  return {
    warmupsPerPath: L5_INCREMENTAL_WARMUPS,
    measuredRuns: L5_INCREMENTAL_MEASURED_RUNS,
    rows,
    primary,
    successfulOnly,
    successRate,
    economicallyUseful:
      successRate >= L5_MINIMUM_INCREMENTAL_SUCCESS_RATE &&
      primary.pairedSpeedup.median >= L5_MINIMUM_MEDIAN_PAIRED_SPEEDUP,
    incrementalStats,
  };
}
