/**
 * Production index adapter for the frozen P1-L.5 incremental experiment.
 *
 * This module measures only repository-index construction. Config and
 * instruction governance are discovered separately by production analysis,
 * so their artifacts are filtered from both snapshots exactly as they are in
 * `analysis.ts` before either the full or incremental path runs.
 */

import {
  buildRepositoryIndex,
  canonicalSerialization,
  classifyInstructionCandidate,
  indexDigest,
  indexIdentity,
  updateRepositoryIndex,
  type RepositoryIndex,
  type RepositoryIndexIdentity,
} from "@acalys/code-intelligence";
import { gitObjectId } from "@acalys/contracts/domain";
import {
  measureIncrementalEconomics,
  type IncrementalTimingReport,
  type MonotonicClock,
} from "@acalys/code-intelligence/eval";

import {
  L5_CORPUS,
  type L5CorpusCase,
  type L5IncrementalPair,
  type L5RevisionFixture,
} from "./l5-corpus.js";
import { l5RevisionObjectId } from "./l5-production.js";

export const L5_PRODUCTION_INCREMENTAL_SCHEMA_VERSION =
  "acalys.p1-l5.production-incremental/v1" as const;

export interface L5ProductionIncrementalSnapshot {
  readonly syntheticRevision: string;
  readonly indexedPaths: readonly string[];
  readonly identity: RepositoryIndexIdentity;
}

export interface L5ProductionIncrementalEquivalence {
  readonly equivalent: boolean;
  readonly fullIndexDigest: string;
  readonly incrementalIndexDigest: string;
}

export interface L5ProductionIncrementalPairReport {
  readonly pairId: string;
  readonly baseCaseId: string;
  readonly because: string;
  readonly base: L5ProductionIncrementalSnapshot;
  readonly next: L5ProductionIncrementalSnapshot;
  readonly indexEquivalence: L5ProductionIncrementalEquivalence;
  readonly economics: IncrementalTimingReport;
}

export interface L5InvalidProductionIncrementalPair {
  readonly pairId: string;
  readonly baseCaseId: string;
  readonly because: string;
  readonly error: string;
}

export interface L5ProductionIncrementalRun {
  readonly reports: readonly L5ProductionIncrementalPairReport[];
  readonly invalidOrExcluded: readonly L5InvalidProductionIncrementalPair[];
}

const TSCONFIG_PATH = /(^|\/)tsconfig(\.[\w.-]+)?\.json$/;

function productionIndexSnapshot(
  files: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(files).filter(([path]) => {
      if (TSCONFIG_PATH.test(path)) return false;
      const instruction = classifyInstructionCandidate(path);
      return (
        instruction === undefined ||
        instruction.instructionClass === "documentation"
      );
    }),
  );
}

function identityFor(
  pair: L5IncrementalPair,
  revision: L5RevisionFixture,
): RepositoryIndexIdentity {
  return indexIdentity({
    tenant: {
      kind: "unscoped",
      why: "the frozen L.5 index is isolated to one in-memory measurement pair",
    },
    provider: "github",
    repositoryId: `p1-l5/incremental/${pair.baseCaseId}`,
    revision: gitObjectId(l5RevisionObjectId(revision.syntheticRevision)),
  });
}

function snapshotReport(
  revision: L5RevisionFixture,
  snapshot: ReadonlyMap<string, string>,
  identity: RepositoryIndexIdentity,
): L5ProductionIncrementalSnapshot {
  return {
    syntheticRevision: revision.syntheticRevision,
    indexedPaths: [...snapshot.keys()],
    identity,
  };
}

function baseCaseFor(pair: L5IncrementalPair): L5CorpusCase {
  const corpusPair = L5_CORPUS.incrementalPairs.find(
    (candidate) => candidate.id === pair.id,
  );
  if (corpusPair !== pair) {
    throw new Error(
      `Incremental pair is not the frozen corpus value: ${pair.id}`,
    );
  }

  const baseCase = L5_CORPUS.cases.find(
    (candidate) => candidate.id === pair.baseCaseId,
  );
  if (baseCase === undefined) {
    throw new Error(
      `Frozen incremental pair ${pair.id} has no base case ${pair.baseCaseId}`,
    );
  }
  return baseCase;
}

/** Measures one frozen pair; setup and equivalence checks stay outside timing. */
export function measureL5ProductionIncrementalPair(
  pair: L5IncrementalPair,
  clock?: MonotonicClock,
): L5ProductionIncrementalPairReport {
  const baseCase = baseCaseFor(pair);
  const baseSnapshot = productionIndexSnapshot(baseCase.files);
  const nextSnapshot = productionIndexSnapshot(pair.to.files);
  const baseIdentity = identityFor(pair, baseCase);
  const nextIdentity = identityFor(pair, pair.to);
  const baseIndex = buildRepositoryIndex({
    identity: baseIdentity,
    snapshot: baseSnapshot,
  });

  let lastFullIndex: RepositoryIndex | undefined;
  let lastIncrementalIndex: RepositoryIndex | undefined;
  const economics = measureIncrementalEconomics({
    full: () => {
      const index = buildRepositoryIndex({
        identity: nextIdentity,
        snapshot: nextSnapshot,
      });
      lastFullIndex = index;
      return index;
    },
    incremental: () => {
      const outcome = updateRepositoryIndex({
        previous: baseIndex,
        nextIdentity,
        snapshot: nextSnapshot,
      });
      lastIncrementalIndex = outcome.index;
      return outcome;
    },
    ...(clock === undefined ? {} : { clock }),
  });

  if (lastFullIndex === undefined || lastIncrementalIndex === undefined) {
    throw new Error(
      `Incremental protocol did not execute both paths: ${pair.id}`,
    );
  }

  const fullIndexDigest = indexDigest(lastFullIndex);
  const incrementalIndexDigest = indexDigest(lastIncrementalIndex);
  const equivalent =
    fullIndexDigest === incrementalIndexDigest &&
    canonicalSerialization(lastFullIndex) ===
      canonicalSerialization(lastIncrementalIndex);

  return {
    pairId: pair.id,
    baseCaseId: pair.baseCaseId,
    because: pair.because,
    base: snapshotReport(baseCase, baseSnapshot, baseIdentity),
    next: snapshotReport(pair.to, nextSnapshot, nextIdentity),
    indexEquivalence: {
      equivalent,
      fullIndexDigest,
      incrementalIndexDigest,
    },
    economics,
  };
}

/** Returns one production economics report for every frozen incremental pair. */
export function measureAllL5ProductionIncrementalPairs(
  clock?: MonotonicClock,
): readonly L5ProductionIncrementalPairReport[] {
  return L5_CORPUS.incrementalPairs.map((pair) =>
    measureL5ProductionIncrementalPair(pair, clock),
  );
}

/** Retains pair-level failures for the final report instead of dropping them. */
export function measureL5ProductionIncrementalPairsSafely(
  clock?: MonotonicClock,
): L5ProductionIncrementalRun {
  const reports: L5ProductionIncrementalPairReport[] = [];
  const invalidOrExcluded: L5InvalidProductionIncrementalPair[] = [];
  for (const pair of L5_CORPUS.incrementalPairs) {
    try {
      reports.push(measureL5ProductionIncrementalPair(pair, clock));
    } catch (error) {
      invalidOrExcluded.push({
        pairId: pair.id,
        baseCaseId: pair.baseCaseId,
        because: pair.because,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { reports, invalidOrExcluded };
}
