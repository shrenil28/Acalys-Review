import {
  DEFAULT_PREMERGE_CONFIG,
  DEFAULT_PUBLICATION_CONFIG,
  DEFAULT_VERIFICATION_POLICY,
} from "@acalys/review-engine";
import { describe, expect, it } from "vitest";

import { L5_CORPUS } from "../src/eval/l5-corpus.js";
import { runL5QualityContextExperiment } from "../src/eval/l5-experiment.js";
import { runL5ProductionCacheExperiment } from "../src/eval/l5-production-cache.js";
import { measureL5ProductionIncrementalPair } from "../src/eval/l5-production-incremental.js";
import {
  aggregateL5Incremental,
  evaluateL5StopConditions,
} from "../src/eval/l5-report.js";

const OPTIONS = {
  repositoryId: "0192f8a1-0000-7000-8000-0000000000a5",
  tenantId: "tenant-l5-report",
  policies: {
    verifierPolicy: DEFAULT_VERIFICATION_POLICY,
    publicationPolicy: DEFAULT_PUBLICATION_CONFIG,
    premergePolicy: DEFAULT_PREMERGE_CONFIG,
  },
} as const;

const unitClock = (): (() => number) => {
  let tick = 0;
  return () => tick++;
};

describe("P1-L.5 final report", () => {
  it("evaluates all ten frozen stop conditions from composed evidence", async () => {
    const corpusCase = L5_CORPUS.cases.find(
      (candidate) => candidate.id === "binding-floating-reservation",
    );
    const cachePair = L5_CORPUS.cacheIdentityPairs.find(
      (candidate) => candidate.id === "cache-reuse-identical-binding-input",
    );
    const incrementalPair = L5_CORPUS.incrementalPairs[0];
    if (
      corpusCase === undefined ||
      cachePair === undefined ||
      incrementalPair === undefined
    ) {
      throw new Error("missing L.5 report fixtures");
    }
    const corpus = {
      ...L5_CORPUS,
      cases: [corpusCase],
      cacheIdentityPairs: [cachePair],
    };
    const qualityAndContext = await runL5QualityContextExperiment({
      ...OPTIONS,
      corpus,
    });
    const cacheIdentity = (
      await runL5ProductionCacheExperiment(corpus, OPTIONS)
    ).identity;
    const incremental = aggregateL5Incremental([
      measureL5ProductionIncrementalPair(incrementalPair, unitClock()),
    ]);
    const stopConditions = evaluateL5StopConditions({
      qualityAndContext,
      cacheIdentity,
      incremental,
    });

    expect(stopConditions.map((condition) => condition.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(
      stopConditions.every((condition) => condition.because.trim() !== ""),
    ).toBe(true);
  });
});
