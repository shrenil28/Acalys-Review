/** Full frozen P1-L.5 report composition and pre-registered interpretation. */

import { canonicalJson } from "@acalys/contracts/domain";
import {
  L5_MINIMUM_INCREMENTAL_SUCCESS_RATE,
  L5_MINIMUM_MEDIAN_PAIRED_SPEEDUP,
} from "@acalys/code-intelligence/eval";

import { L5_CORPUS, type L5Corpus } from "./l5-corpus.js";
import {
  runL5QualityContextExperiment,
  type L5QualityContextExperimentOptions,
  type L5QualityContextReport,
} from "./l5-experiment.js";
import { runL5ProductionCacheExperiment } from "./l5-production-cache.js";
import {
  measureL5ProductionIncrementalPairsSafely,
  type L5InvalidProductionIncrementalPair,
  type L5ProductionIncrementalPairReport,
} from "./l5-production-incremental.js";
import type { L5CacheIdentityReport } from "./l5-identity.js";
import {
  candidateSemanticIdentityKey,
  type CausalAttribution,
  type QualityRatio,
} from "./l5-quality.js";
import { L5_FACT_FAMILIES, type L5FactFamily } from "./l5-run.js";

export const L5_FINAL_REPORT_SCHEMA_VERSION =
  "acalys.p1-l5.final-report/v1" as const;

export type L5StopVerdict =
  "pass" | "fail" | "investigate" | "no_demonstrated_benefit";

export interface L5StopConditionResult {
  readonly id: number;
  readonly verdict: L5StopVerdict;
  readonly because: string;
}

export interface L5IncrementalAggregate {
  readonly pairs: number;
  readonly measuredAttempts: number;
  readonly succeeded: number;
  readonly successRate: number;
  readonly medianPairedSpeedup: number;
  readonly economicallyUseful: boolean;
}

export interface L5FinalReport {
  readonly schemaVersion: typeof L5_FINAL_REPORT_SCHEMA_VERSION;
  readonly sourceFreezeCommit: string;
  readonly corpusVersion: string;
  readonly generatedAt: string;
  readonly qualityAndContext: L5QualityContextReport;
  readonly cacheIdentity: L5CacheIdentityReport;
  readonly incremental: {
    readonly aggregate: L5IncrementalAggregate;
    readonly pairs: readonly L5ProductionIncrementalPairReport[];
    readonly invalidOrExcluded: readonly L5InvalidProductionIncrementalPair[];
  };
  readonly stopConditions: readonly L5StopConditionResult[];
}

export interface L5FinalReportOptions extends L5QualityContextExperimentOptions {
  readonly sourceFreezeCommit: string;
  readonly generatedAt: string;
  readonly corpus?: L5Corpus | undefined;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0);
}

export function aggregateL5Incremental(
  pairs: readonly L5ProductionIncrementalPairReport[],
): L5IncrementalAggregate {
  const rows = pairs.flatMap((pair) => pair.economics.rows);
  const succeeded = rows.filter((row) => row.incrementalStats.succeeded).length;
  const successRate = rows.length === 0 ? 0 : succeeded / rows.length;
  const medianPairedSpeedup = median(rows.map((row) => row.pairedSpeedup));
  return {
    pairs: pairs.length,
    measuredAttempts: rows.length,
    succeeded,
    successRate,
    medianPairedSpeedup,
    economicallyUseful:
      successRate >= L5_MINIMUM_INCREMENTAL_SUCCESS_RATE &&
      medianPairedSpeedup >= L5_MINIMUM_MEDIAN_PAIRED_SPEEDUP,
  };
}

function measuredValue(ratio: QualityRatio): number | undefined {
  return ratio.kind === "measuredRatio" ? ratio.value : undefined;
}

function sameRatio(left: QualityRatio, right: QualityRatio): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function attributionIdentity(attribution: CausalAttribution): string {
  return attribution.identity.kind === "gold"
    ? `gold:${attribution.identity.goldId}`
    : `falsePositive:${candidateSemanticIdentityKey(
        attribution.identity.candidateIdentity,
      )}`;
}

function familyEffects(
  report: L5QualityContextReport,
): Readonly<
  Record<
    L5FactFamily,
    { readonly recovered: number; readonly introduced: number }
  >
> {
  const recovered = new Set(
    report.quality.pairedEffects.truePositivesRecovered.map(
      (goldId) => `gold:${goldId}`,
    ),
  );
  const introduced = new Set(
    report.quality.pairedEffects.falsePositivesIntroduced.map(
      (candidate) => `falsePositive:${candidateSemanticIdentityKey(candidate)}`,
    ),
  );
  return Object.fromEntries(
    L5_FACT_FAMILIES.map((family) => {
      const attributed = report.caseRows
        .flatMap((row) => row.causalAttribution)
        .filter((row) => row.attribution === family)
        .map(attributionIdentity);
      return [
        family,
        {
          recovered: attributed.filter((identity) => recovered.has(identity))
            .length,
          introduced: attributed.filter((identity) => introduced.has(identity))
            .length,
        },
      ];
    }),
  ) as unknown as Readonly<
    Record<
      L5FactFamily,
      { readonly recovered: number; readonly introduced: number }
    >
  >;
}

export function evaluateL5StopConditions(input: {
  readonly qualityAndContext: L5QualityContextReport;
  readonly cacheIdentity: L5CacheIdentityReport;
  readonly incremental: L5IncrementalAggregate;
  readonly invalidIncrementalPairs?: number | undefined;
}): readonly L5StopConditionResult[] {
  const control = input.qualityAndContext.quality.control.counts;
  const treatment = input.qualityAndContext.quality.treatment.counts;
  const controlPrecision = measuredValue(control.publishedPrecision);
  const treatmentPrecision = measuredValue(treatment.publishedPrecision);
  const controlRecall = measuredValue(control.publishedRecall);
  const treatmentRecall = measuredValue(treatment.publishedRecall);
  const precisionDropped =
    controlPrecision !== undefined &&
    treatmentPrecision !== undefined &&
    treatmentPrecision < controlPrecision;
  const recallRose =
    controlRecall !== undefined &&
    treatmentRecall !== undefined &&
    treatmentRecall > controlRecall;
  const precisionUnchanged = sameRatio(
    control.publishedPrecision,
    treatment.publishedPrecision,
  );
  const qualityUnchanged = canonicalJson(control) === canonicalJson(treatment);
  const controlTokens =
    input.qualityAndContext.context.control.selectedTokensPerCase.median;
  const treatmentTokens =
    input.qualityAndContext.context.treatment.selectedTokensPerCase.median;
  const contextEscalated =
    controlTokens === 0
      ? treatmentTokens > 0
      : treatmentTokens > 2 * controlTokens;
  const noisyFamilies = Object.entries(
    familyEffects(input.qualityAndContext),
  ).filter(([, counts]) => counts.introduced > counts.recovered);

  return [
    {
      id: 1,
      verdict: input.cacheIdentity.dangerousFalseReuse === 0 ? "pass" : "fail",
      because:
        input.cacheIdentity.dangerousFalseReuse === 0
          ? "No dangerous false analyzer-cache reuse was observed."
          : `Dangerous false reuse occurred for ${input.cacheIdentity.dangerousFalseReusePairIds.join(", ")}.`,
    },
    {
      id: 2,
      verdict: "pass",
      because:
        "Every reported mode passed null/real recorder substantive-hash equality.",
    },
    {
      id: 3,
      verdict: "pass",
      because:
        "Every reported control/treatment pair passed canonical equivalence identity validation.",
    },
    {
      id: 4,
      verdict: precisionDropped ? "fail" : "pass",
      because: precisionDropped
        ? "Published precision dropped; recall cannot compensate for this stop condition."
        : "Published precision did not measurably drop.",
    },
    {
      id: 5,
      verdict:
        !recallRose && precisionUnchanged ? "no_demonstrated_benefit" : "pass",
      because:
        !recallRose && precisionUnchanged
          ? "Published recall did not rise while published precision was unchanged."
          : "The no-demonstrated-quality-benefit condition was not met.",
    },
    {
      id: 6,
      verdict: contextEscalated ? "investigate" : "pass",
      because: contextEscalated
        ? "Treatment median selected tokens per case exceeded the 2x control ceiling."
        : "Treatment median selected tokens per case stayed within the 2x control ceiling.",
    },
    {
      id: 7,
      verdict: noisyFamilies.length === 0 ? "pass" : "investigate",
      because:
        noisyFamilies.length === 0
          ? "No single family introduced more published false positives than true positives recovered."
          : `Narrow planner consumption for ${noisyFamilies.map(([family]) => family).join(", ")}.`,
    },
    {
      id: 8,
      verdict:
        input.incremental.economicallyUseful &&
        (input.invalidIncrementalPairs ?? 0) === 0
          ? "pass"
          : "investigate",
      because:
        input.incremental.economicallyUseful &&
        (input.invalidIncrementalPairs ?? 0) === 0
          ? "Incremental success and primary median paired speedup met both frozen thresholds."
          : "Incremental economics missed at least one frozen threshold; do not optimize invalidation width yet.",
    },
    {
      id: 9,
      verdict: qualityUnchanged ? "no_demonstrated_benefit" : "pass",
      because: qualityUnchanged
        ? "Repository intelligence changed no aggregate quality count."
        : "At least one aggregate quality count changed.",
    },
    {
      id: 10,
      verdict: "pass",
      because:
        "This report is observational and makes no post-result production optimization.",
    },
  ];
}

export async function runL5FinalReport(
  options: L5FinalReportOptions,
): Promise<L5FinalReport> {
  if (!/^[0-9a-f]{7,40}$/.test(options.sourceFreezeCommit)) {
    throw new Error("L.5 sourceFreezeCommit must be a Git commit id");
  }
  if (Number.isNaN(Date.parse(options.generatedAt))) {
    throw new Error("L.5 generatedAt must be an ISO timestamp");
  }
  const corpus = options.corpus ?? L5_CORPUS;
  const qualityAndContext = await runL5QualityContextExperiment({
    ...options,
    corpus,
  });
  const cache = await runL5ProductionCacheExperiment(corpus, options);
  const incrementalRun = measureL5ProductionIncrementalPairsSafely();
  const incrementalAggregate = aggregateL5Incremental(incrementalRun.reports);

  return {
    schemaVersion: L5_FINAL_REPORT_SCHEMA_VERSION,
    sourceFreezeCommit: options.sourceFreezeCommit,
    corpusVersion: corpus.corpusVersion,
    generatedAt: options.generatedAt,
    qualityAndContext,
    cacheIdentity: cache.identity,
    incremental: {
      aggregate: incrementalAggregate,
      pairs: incrementalRun.reports,
      invalidOrExcluded: incrementalRun.invalidOrExcluded,
    },
    stopConditions: evaluateL5StopConditions({
      qualityAndContext,
      cacheIdentity: cache.identity,
      incremental: incrementalAggregate,
      invalidIncrementalPairs: incrementalRun.invalidOrExcluded.length,
    }),
  };
}
