import { describe, expect, it } from "vitest";
import type { IncrementalStats } from "../src/repository-index/incremental.js";
import {
  IncrementalStatsRecorder,
  L5_INCREMENTAL_MEASURED_RUNS,
  L5_INCREMENTAL_WARMUPS,
  measureIncrementalEconomics,
  measureMonotonic,
} from "../src/eval/l5-incremental.js";

const stats = (
  overrides: Partial<IncrementalStats> = {},
): IncrementalStats => ({
  attempted: true,
  succeeded: true,
  modulesTotal: 8,
  modulesRetained: 6,
  modulesRecomputed: 2,
  modulesDeleted: 0,
  recomputeReasons: {
    modified: 1,
    references_changed_module: 1,
  },
  referencesRecomputed: 3,
  bindingsRecomputed: 2,
  referencesRetained: 40,
  bindingsRetained: 30,
  ...overrides,
});

describe("incremental stats recording", () => {
  it("returns the exact outcome and reports only production observations", () => {
    const recorder = new IncrementalStatsRecorder();
    const index = Object.freeze({ revision: "h2", records: 17 });
    const outcome = Object.freeze({ index, stats: Object.freeze(stats()) });

    const returned = recorder.observe(() => outcome);
    expect(returned).toBe(outcome);
    expect(returned.index).toBe(index);

    recorder.record(
      stats({
        succeeded: false,
        fallbackReason: "candidate_failed_validation",
        fallbackDetail: "binding_exists: missing binding",
        modulesRetained: 0,
        modulesRecomputed: 8,
        recomputeReasons: {
          added: 2,
          unresolved_reference_present: 3,
          not_indexed_previously: 1,
        },
        referencesRecomputed: 0,
        referencesRetained: 0,
        bindingsRecomputed: 0,
        bindingsRetained: 0,
      }),
    );

    expect(recorder.report()).toMatchObject({
      runs: 2,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      fullRebuildFallbacks: 1,
      fallbacksByReason: { candidate_failed_validation: 1 },
      totals: {
        modulesTotal: 16,
        modulesRetained: 6,
        modulesRecomputed: 10,
        referencesRecomputed: 3,
        referencesRetained: 40,
        bindingsRecomputed: 2,
        bindingsRetained: 30,
        directInvalidations: 3,
        dependencyInvalidations: 4,
        recomputeReasons: {
          added: 2,
          modified: 1,
          references_changed_module: 1,
          unresolved_reference_present: 3,
          not_indexed_previously: 1,
        },
      },
    });
  });
});

describe("monotonic operation measurement", () => {
  it("returns the exact value and rejects a backwards clock", () => {
    const index = Object.freeze({ revision: "h2" });
    const timestamps = [100, 107];
    const measured = measureMonotonic(
      () => index,
      () => timestamps.shift() ?? 0,
    );

    expect(measured).toEqual({ value: index, durationMs: 7 });
    expect(measured.value).toBe(index);
    expect(() => measureMonotonic(() => index, createClock([9, 8]))).toThrow(
      /moved backwards/,
    );
  });
});

describe("the fixed L.5 incremental timing protocol", () => {
  it("warms up five times and measures twenty alternating reversed pairs", () => {
    const calls: string[] = [];
    let fullCalls = 0;
    let incrementalCalls = 0;
    const measuredDurations: number[] = [];

    for (let run = 0; run < L5_INCREMENTAL_MEASURED_RUNS; run += 1) {
      const fullMs = run < 10 ? 100 : 10;
      const incrementalMs = run < 10 ? 50 : 9;
      const pair =
        run % 2 === 0 ? [fullMs, incrementalMs] : [incrementalMs, fullMs];
      measuredDurations.push(...pair);
    }

    let now = 1_000;
    const timestamps = measuredDurations.flatMap((duration) => {
      const start = now;
      now += duration;
      return [start, now];
    });

    const report = measureIncrementalEconomics({
      full: () => {
        fullCalls += 1;
        calls.push("full");
        return Object.freeze({ kind: "full", call: fullCalls });
      },
      incremental: () => {
        incrementalCalls += 1;
        calls.push("incremental");
        const measuredRun = incrementalCalls - L5_INCREMENTAL_WARMUPS;
        const fallback = measuredRun > 0 && measuredRun % 4 === 0;
        return Object.freeze({
          index: Object.freeze({ kind: "incremental", call: incrementalCalls }),
          stats: Object.freeze(
            stats({
              succeeded: !fallback,
              ...(fallback
                ? { fallbackReason: "extraction_threw" as const }
                : {}),
              // Deliberately unrelated to duration: retention is not a clock.
              modulesRetained: incrementalCalls * 1_000,
            }),
          ),
        });
      },
      clock: createClock(timestamps),
    });

    expect(fullCalls).toBe(
      L5_INCREMENTAL_WARMUPS + L5_INCREMENTAL_MEASURED_RUNS,
    );
    expect(incrementalCalls).toBe(
      L5_INCREMENTAL_WARMUPS + L5_INCREMENTAL_MEASURED_RUNS,
    );
    expect(calls).toEqual(
      [L5_INCREMENTAL_WARMUPS, L5_INCREMENTAL_MEASURED_RUNS].flatMap(
        (phaseRuns) =>
          Array.from({ length: phaseRuns }, (_, run) =>
            run % 2 === 0 ? ["full", "incremental"] : ["incremental", "full"],
          ).flat(),
      ),
    );
    expect(timestamps).toHaveLength(0);

    expect(report.primary.full).toEqual({
      n: 20,
      median: 55,
      p95: 100,
      max: 100,
    });
    expect(report.primary.incremental).toEqual({
      n: 20,
      median: 29.5,
      p95: 50,
      max: 50,
    });
    expect(report.primary.pairedSpeedup).toEqual({
      n: 20,
      median: (2 + 10 / 9) / 2,
      p95: 2,
      max: 2,
    });
    expect(report.rows.map((row) => row.pairedSpeedup)).toEqual([
      ...Array<number>(10).fill(2),
      ...Array<number>(10).fill(10 / 9),
    ]);
    expect(report.primary.pairedSpeedup.median).not.toBeCloseTo(
      report.primary.full.median / report.primary.incremental.median,
    );
    expect(report.rows.map((row) => row.order)).toEqual(
      Array.from({ length: 20 }, (_, run) =>
        run % 2 === 0 ? "full_then_incremental" : "incremental_then_full",
      ),
    );
    expect(report.incrementalStats).toMatchObject({
      runs: 20,
      attempted: 20,
      succeeded: 15,
      failed: 5,
      fullRebuildFallbacks: 5,
      fallbacksByReason: { extraction_threw: 5 },
    });
    expect(report.successRate).toBe(0.75);
    expect(report.economicallyUseful).toBe(false);
    expect(report.successfulOnly).toEqual({
      full: { n: 15, median: 100, p95: 100, max: 100 },
      incremental: { n: 15, median: 50, p95: 50, max: 50 },
      pairedSpeedup: { n: 15, median: 2, p95: 2, max: 2 },
    });
    // Fallbacks remain in the primary denominator. Retained work counts are
    // deliberately huge and unrelated, so they cannot determine speedup.
    expect(report.primary.incremental.n).toBe(report.incrementalStats.runs);
  });

  it("requires both ninety-percent success and ten-percent paired savings", () => {
    const atBoundary = constantTimingReport(18, 100, 90);
    expect(atBoundary.successRate).toBe(0.9);
    expect(atBoundary.primary.pairedSpeedup.median).toBeCloseTo(1 / 0.9);
    expect(atBoundary.economicallyUseful).toBe(true);

    const tooSlow = constantTimingReport(20, 100, 91);
    expect(tooSlow.successRate).toBe(1);
    expect(tooSlow.primary.pairedSpeedup.median).toBeLessThan(1 / 0.9);
    expect(tooSlow.economicallyUseful).toBe(false);
  });
});

function constantTimingReport(
  successes: number,
  fullMs: number,
  incrementalMs: number,
) {
  let incrementalCalls = 0;
  const measuredDurations = Array.from(
    { length: L5_INCREMENTAL_MEASURED_RUNS },
    (_, run) =>
      run % 2 === 0 ? [fullMs, incrementalMs] : [incrementalMs, fullMs],
  ).flat();
  let now = 0;
  const timestamps = measuredDurations.flatMap((duration) => {
    const start = now;
    now += duration;
    return [start, now];
  });

  return measureIncrementalEconomics({
    full: () => ({ index: "full" }),
    incremental: () => {
      incrementalCalls += 1;
      const measuredRun = incrementalCalls - L5_INCREMENTAL_WARMUPS;
      const succeeded = measuredRun <= 0 || measuredRun <= successes;
      return {
        index: "incremental",
        stats: stats({
          succeeded,
          ...(succeeded ? {} : { fallbackReason: "extraction_threw" }),
        }),
      };
    },
    clock: createClock(timestamps),
  });
}

function createClock(timestamps: number[]): () => number {
  return () => {
    const timestamp = timestamps.shift();
    if (timestamp === undefined) throw new Error("clock exhausted");
    return timestamp;
  };
}
