import { describe, expect, it } from "vitest";

import {
  L5_PRODUCTION_INCREMENTAL_SCHEMA_VERSION,
  measureAllL5ProductionIncrementalPairs,
  measureL5ProductionIncrementalPair,
  measureL5ProductionIncrementalPairsSafely,
} from "../src/eval/l5-production-incremental.js";
import { L5_CORPUS } from "../src/eval/l5-corpus.js";
import { l5RevisionObjectId } from "../src/eval/l5-production.js";

const unitClock = (): (() => number) => {
  let tick = 0;
  return () => tick++;
};

describe("P1-L.5 production incremental economics adapter", () => {
  it("measures every frozen pair with the fixed alternating protocol", () => {
    const reports = measureAllL5ProductionIncrementalPairs(unitClock());

    expect(L5_PRODUCTION_INCREMENTAL_SCHEMA_VERSION).toBe(
      "acalys.p1-l5.production-incremental/v1",
    );
    expect(reports.map((report) => report.pairId)).toEqual(
      L5_CORPUS.incrementalPairs.map((pair) => pair.id),
    );

    for (const report of reports) {
      expect(report.economics.warmupsPerPath).toBe(5);
      expect(report.economics.measuredRuns).toBe(20);
      expect(report.economics.rows).toHaveLength(20);
      expect(report.economics.incrementalStats.observations).toHaveLength(20);
      expect(report.economics.rows.map((row) => row.order)).toEqual(
        Array.from({ length: 20 }, (_, index) =>
          index % 2 === 0 ? "full_then_incremental" : "incremental_then_full",
        ),
      );

      // The fake clock advances once per observation, avoiding real timing
      // evidence while proving that both paths are measured as paired runs.
      expect(report.economics.primary.full).toEqual({
        n: 20,
        median: 1,
        p95: 1,
        max: 1,
      });
      expect(report.economics.primary.incremental).toEqual({
        n: 20,
        median: 1,
        p95: 1,
        max: 1,
      });
    }
  });

  it("constructs deterministic H1/H2 identities and equivalent H2 indexes", () => {
    for (const pair of L5_CORPUS.incrementalPairs) {
      const report = measureL5ProductionIncrementalPair(pair, unitClock());
      const baseCase = L5_CORPUS.cases.find(
        (candidate) => candidate.id === pair.baseCaseId,
      );
      if (baseCase === undefined) throw new Error("missing frozen base case");

      expect(report.base.identity.repositoryId).toBe(
        `p1-l5/incremental/${pair.baseCaseId}`,
      );
      expect(report.base.identity.revision.value).toBe(
        l5RevisionObjectId(baseCase.syntheticRevision),
      );
      expect(report.next.identity.revision.value).toBe(
        l5RevisionObjectId(pair.to.syntheticRevision),
      );
      expect(report.base.identity.revision.value).not.toBe(
        report.next.identity.revision.value,
      );
      expect(report.indexEquivalence.equivalent).toBe(true);
      expect(report.indexEquivalence.incrementalIndexDigest).toBe(
        report.indexEquivalence.fullIndexDigest,
      );
      expect(
        report.economics.incrementalStats.observations.every(
          (stats) => stats.attempted,
        ),
      ).toBe(true);
    }
  });

  it("uses the production config and instruction snapshot filter", () => {
    const reports = measureAllL5ProductionIncrementalPairs(unitClock());
    const config = reports.find(
      (report) => report.pairId === "incremental-config-source-edit",
    );
    const instruction = reports.find(
      (report) => report.pairId === "incremental-instruction-source-edit",
    );

    expect(config?.next.indexedPaths).toEqual(["services/report/src/first.ts"]);
    expect(
      config?.economics.incrementalStats.observations.every(
        (stats) => stats.modulesTotal === 1,
      ),
    ).toBe(true);

    expect(instruction?.next.indexedPaths).toEqual([
      "src/payments/charge.ts",
      "docs/payments.md",
    ]);
    expect(
      instruction?.economics.incrementalStats.observations.every(
        (stats) => stats.modulesTotal === 2,
      ),
    ).toBe(true);
  });

  it("retains thrown pair failures as invalid report rows", () => {
    const run = measureL5ProductionIncrementalPairsSafely(() => {
      throw new Error("clock unavailable");
    });

    expect(run.reports).toEqual([]);
    expect(run.invalidOrExcluded.map((row) => row.pairId)).toEqual(
      L5_CORPUS.incrementalPairs.map((pair) => pair.id),
    );
    expect(
      run.invalidOrExcluded.every((row) =>
        row.error.includes("clock unavailable"),
      ),
    ).toBe(true);
  });
});
