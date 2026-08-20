import {
  DEFAULT_PREMERGE_CONFIG,
  DEFAULT_PUBLICATION_CONFIG,
  DEFAULT_VERIFICATION_POLICY,
} from "@acalys/review-engine";
import { describe, expect, it } from "vitest";

import { L5_CORPUS } from "../src/eval/l5-corpus.js";
import { runL5ProductionCacheExperiment } from "../src/eval/l5-production-cache.js";

const OPTIONS = {
  repositoryId: "0192f8a1-0000-7000-8000-0000000000a5",
  tenantId: "tenant-l5-cache",
  policies: {
    verifierPolicy: DEFAULT_VERIFICATION_POLICY,
    publicationPolicy: DEFAULT_PUBLICATION_CONFIG,
    premergePolicy: DEFAULT_PREMERGE_CONFIG,
  },
} as const;

describe("P1-L.5 production cache experiment", () => {
  it("preserves head identity for authored reuse while varying traversal order", async () => {
    const pair = L5_CORPUS.cacheIdentityPairs.find(
      (candidate) => candidate.id === "cache-reuse-identical-binding-input",
    );
    if (pair === undefined) throw new Error("missing L.5 reuse fixture");
    const base = L5_CORPUS.cases.find(
      (candidate) => candidate.id === pair.baseCaseId,
    );
    if (base === undefined) throw new Error("missing L.5 base fixture");
    expect(pair.to.syntheticRevision).toBe(base.syntheticRevision);
    expect(Object.keys(pair.to.files)).toEqual(
      Object.keys(base.files).reverse(),
    );

    const report = await runL5ProductionCacheExperiment(
      { ...L5_CORPUS, cases: [base], cacheIdentityPairs: [pair] },
      OPTIONS,
    );
    expect(report.identity.pairs[0]?.outcome).toBe("true_cache_reuse");
  });

  it("derives both key inputs from production-selected context", async () => {
    const pair = L5_CORPUS.cacheIdentityPairs.find(
      (candidate) => candidate.id === "cache-invalidate-selection-family",
    );
    if (pair === undefined) throw new Error("missing L.5 cache fixture");
    const base = L5_CORPUS.cases.find(
      (candidate) => candidate.id === pair.baseCaseId,
    );
    if (base === undefined) throw new Error("missing L.5 base fixture");
    const report = await runL5ProductionCacheExperiment(
      { ...L5_CORPUS, cases: [base], cacheIdentityPairs: [pair] },
      OPTIONS,
    );

    expect(Object.keys(report.contextObservations)).toEqual([pair.id]);
    expect(report.contextObservations[pair.id]).toEqual({
      beforeContextDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      afterContextDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(report.identity.pairs).toHaveLength(1);
    expect(report.identity.pairs[0]?.pairId).toBe(pair.id);
    expect(report.contextObservations[pair.id]?.afterContextDigest).not.toBe(
      report.contextObservations[pair.id]?.beforeContextDigest,
    );
    expect(report.identity.pairs[0]?.outcome).toBe("correct_invalidation");
  });
});
