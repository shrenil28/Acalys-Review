/** Production analyzer-input identity observations for the frozen L.5 pairs. */

import {
  type L5Corpus,
  type L5CorpusCase,
  type L5RevisionFixture,
} from "./l5-corpus.js";
import { evaluateAnalyzerCacheIdentity } from "./l5-identity.js";
import {
  adaptL5CacheIdentityPairs,
  adaptL5CorpusCase,
  observeL5ProductionContext,
  type L5CachePairContextObservation,
  type L5ProductionCaseOptions,
} from "./l5-production.js";

export interface L5ProductionCacheReport {
  readonly contextObservations: Readonly<
    Record<string, L5CachePairContextObservation>
  >;
  readonly identity: ReturnType<typeof evaluateAnalyzerCacheIdentity>;
}

function observationCase(
  base: L5CorpusCase,
  revision: L5RevisionFixture,
  id: string,
): L5CorpusCase {
  return {
    ...base,
    ...revision,
    id,
    summary: `Analyzer-input identity observation for ${id}.`,
    gold: {
      expectedFindings: [],
      noFindingBecause:
        "This derived case observes context identity and is not quality-scored.",
      requiredContext: [],
      forbiddenContext: [],
    },
  };
}

export async function runL5ProductionCacheExperiment(
  corpus: L5Corpus,
  options: L5ProductionCaseOptions,
): Promise<L5ProductionCacheReport> {
  const observations: Record<string, L5CachePairContextObservation> = {};
  const baseDigests = new Map<string, string>();

  for (const pair of corpus.cacheIdentityPairs) {
    const base = corpus.cases.find(
      (corpusCase) => corpusCase.id === pair.baseCaseId,
    );
    if (base === undefined) {
      throw new Error(
        `L.5 cache pair ${pair.id} references missing base case ${pair.baseCaseId}`,
      );
    }
    let beforeContextDigest = baseDigests.get(base.id);
    if (beforeContextDigest === undefined) {
      const before = adaptL5CorpusCase(
        observationCase(base, base, `${pair.id}:before`),
        options,
      );
      beforeContextDigest = (await observeL5ProductionContext(before))
        .contextDigest;
      baseDigests.set(base.id, beforeContextDigest);
    }
    const after = adaptL5CorpusCase(
      observationCase(base, pair.to, `${pair.id}:after`),
      options,
    );
    observations[pair.id] = {
      beforeContextDigest,
      afterContextDigest: (await observeL5ProductionContext(after))
        .contextDigest,
    };
  }

  return {
    contextObservations: observations,
    identity: evaluateAnalyzerCacheIdentity(
      adaptL5CacheIdentityPairs(corpus, options.repositoryId, observations),
    ),
  };
}
