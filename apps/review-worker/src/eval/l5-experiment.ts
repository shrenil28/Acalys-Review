/** Canonical execution and reporting for the frozen P1-L.5 experiment. */

import {
  L5_FACT_FAMILIES as CONTEXT_REPORT_FAMILIES,
  L5_REPORT_REASONS,
  accountL5Context,
  type L5ContextAccounting,
  type L5ContextBucket,
  type L5FactFamily as ContextReportFamily,
  type L5ReportReason,
} from "../../../../packages/code-intelligence/src/eval/l5-context.js";

import { L5_CORPUS, type L5Corpus, type L5CorpusCase } from "./l5-corpus.js";
import {
  adaptL5CorpusCase,
  l5ProductionSubstantiveHashes,
  runL5ProductionFunnel,
  type L5ProductionCaseOptions,
  type L5ProductionFunnelOutcome,
} from "./l5-production.js";
import {
  L5_FACT_FAMILIES,
  L5_MODES,
  runL5Pair,
  type L5CanonicalIdentity,
  type L5FactFamily,
  type L5ModeAttestation,
  type L5ModeId,
  type L5Recorder,
  type L5SubstantiveHashes,
} from "./l5-run.js";
import {
  attributeCausalOutcomes,
  candidateSemanticIdentityKey,
  comparePublishedQuality,
  matchFindings,
  scoreQuality,
  type CausalAttribution,
  type CausalOutcomeObservation,
  type CausalRun,
  type GoldFinding,
  type PairedQualityEffects,
  type QualityCandidate,
  type QualityScore,
} from "./l5-quality.js";

export const L5_EXPERIMENT_REPORT_SCHEMA_VERSION =
  "acalys.p1-l5.experiment-report/v1" as const;

export interface L5ModeCaseReport {
  readonly modeId: L5ModeId;
  readonly modeIdentity: L5CanonicalIdentity;
  readonly substantiveHashes: L5SubstantiveHashes;
  readonly modeAttestation: L5ModeAttestation;
  readonly recorderAudit: { readonly passed: true };
  readonly quality: QualityScore;
  readonly qualityCandidates: readonly QualityCandidate[];
  readonly context: L5ContextAccounting;
}

export interface L5CaseExperimentReport {
  readonly caseId: string;
  readonly equivalenceIdentity: L5CanonicalIdentity;
  readonly goldFindings: readonly GoldFinding[];
  readonly modes: Readonly<Record<L5ModeId, L5ModeCaseReport>>;
  readonly pairedQualityEffects: PairedQualityEffects;
  readonly causalAttribution: readonly CausalAttribution[];
}

export interface L5ContextAggregate {
  readonly cases: number;
  readonly totals: L5ContextBucket;
  readonly byReason: Readonly<Record<L5ReportReason, L5ContextBucket>>;
  readonly byFamily: Readonly<Record<ContextReportFamily, L5ContextBucket>>;
  readonly duplicatesSuppressed: number;
  readonly selectedClassification: {
    readonly usefulBytes: number;
    readonly usefulEstimatedTokens: number;
    readonly irrelevantBytes: number;
    readonly irrelevantEstimatedTokens: number;
    readonly unlabelledBytes: number;
    readonly unlabelledEstimatedTokens: number;
    readonly contextEfficiency:
      | { readonly kind: "measuredRatio"; readonly value: number }
      | { readonly kind: "undefinedRatio"; readonly because: string };
  };
  readonly selectedTokensPerCase: {
    readonly median: number;
    readonly max: number;
  };
}

export interface L5QualityContextReport {
  readonly schemaVersion: typeof L5_EXPERIMENT_REPORT_SCHEMA_VERSION;
  readonly corpusVersion: string;
  readonly caseRows: readonly L5CaseExperimentReport[];
  readonly quality: {
    readonly control: QualityScore;
    readonly treatment: QualityScore;
    readonly pairedEffects: PairedQualityEffects;
  };
  readonly context: {
    readonly control: L5ContextAggregate;
    readonly treatment: L5ContextAggregate;
  };
  readonly audits: {
    readonly equivalencePairs: number;
    readonly recorderModeExecutions: number;
    readonly invalidOrExcludedRuns: readonly never[];
  };
}

export interface L5QualityContextExperimentOptions extends L5ProductionCaseOptions {
  readonly corpus?: L5Corpus | undefined;
  readonly createRealRecorder?: (() => L5Recorder) | undefined;
}

const emptyBucket = (): L5ContextBucket => ({
  offered: { items: 0, estimatedTokens: 0 },
  scored: { items: 0, estimatedTokens: 0 },
  selected: { items: 0, estimatedTokens: 0 },
  omitted: { items: 0, estimatedTokens: 0 },
  truncated: {
    items: 0,
    originalEstimatedTokens: 0,
    suppliedEstimatedTokens: 0,
    droppedEstimatedTokens: 0,
  },
});

function addBucket(
  left: L5ContextBucket,
  right: L5ContextBucket,
): L5ContextBucket {
  return {
    offered: {
      items: left.offered.items + right.offered.items,
      estimatedTokens:
        left.offered.estimatedTokens + right.offered.estimatedTokens,
    },
    scored: {
      items: left.scored.items + right.scored.items,
      estimatedTokens:
        left.scored.estimatedTokens + right.scored.estimatedTokens,
    },
    selected: {
      items: left.selected.items + right.selected.items,
      estimatedTokens:
        left.selected.estimatedTokens + right.selected.estimatedTokens,
    },
    omitted: {
      items: left.omitted.items + right.omitted.items,
      estimatedTokens:
        left.omitted.estimatedTokens + right.omitted.estimatedTokens,
    },
    truncated: {
      items: left.truncated.items + right.truncated.items,
      originalEstimatedTokens:
        left.truncated.originalEstimatedTokens +
        right.truncated.originalEstimatedTokens,
      suppliedEstimatedTokens:
        left.truncated.suppliedEstimatedTokens +
        right.truncated.suppliedEstimatedTokens,
      droppedEstimatedTokens:
        left.truncated.droppedEstimatedTokens +
        right.truncated.droppedEstimatedTokens,
    },
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0);
}

export function aggregateL5Context(
  rows: readonly L5ContextAccounting[],
): L5ContextAggregate {
  const sumFor = (pick: (row: L5ContextAccounting) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);
  const totals = rows.reduce(
    (total, row) => addBucket(total, row.totals),
    emptyBucket(),
  );
  const byReason = Object.fromEntries(
    L5_REPORT_REASONS.map((reason) => [
      reason,
      rows.reduce(
        (total, row) => addBucket(total, row.byReason[reason]),
        emptyBucket(),
      ),
    ]),
  ) as unknown as Readonly<Record<L5ReportReason, L5ContextBucket>>;
  const byFamily = Object.fromEntries(
    CONTEXT_REPORT_FAMILIES.map((family) => [
      family,
      rows.reduce(
        (total, row) => addBucket(total, row.byFamily[family]),
        emptyBucket(),
      ),
    ]),
  ) as unknown as Readonly<Record<ContextReportFamily, L5ContextBucket>>;
  const usefulEstimatedTokens = sumFor(
    (row) => row.selectedClassification.usefulEstimatedTokens,
  );
  const selectedEstimatedTokens = totals.selected.estimatedTokens;
  const selectedPerCase = rows.map(
    (row) => row.totals.selected.estimatedTokens,
  );

  return {
    cases: rows.length,
    totals,
    byReason,
    byFamily,
    duplicatesSuppressed: sumFor((row) => row.duplicatesSuppressed),
    selectedClassification: {
      usefulBytes: sumFor((row) => row.selectedClassification.usefulBytes),
      usefulEstimatedTokens,
      irrelevantBytes: sumFor(
        (row) => row.selectedClassification.irrelevantBytes,
      ),
      irrelevantEstimatedTokens: sumFor(
        (row) => row.selectedClassification.irrelevantEstimatedTokens,
      ),
      unlabelledBytes: sumFor(
        (row) => row.selectedClassification.unlabelledBytes,
      ),
      unlabelledEstimatedTokens: sumFor(
        (row) => row.selectedClassification.unlabelledEstimatedTokens,
      ),
      contextEfficiency:
        selectedEstimatedTokens === 0
          ? {
              kind: "undefinedRatio",
              because: "no selected context tokens",
            }
          : {
              kind: "measuredRatio",
              value: usefulEstimatedTokens / selectedEstimatedTokens,
            },
    },
    selectedTokensPerCase: {
      median: median(selectedPerCase),
      max: Math.max(0, ...selectedPerCase),
    },
  };
}

function scoreOneMode(
  caseId: string,
  goldFindings: readonly GoldFinding[],
  candidates: readonly QualityCandidate[],
): QualityScore {
  return scoreQuality({ caseIds: [caseId], goldFindings, candidates });
}

function causalRunFor(
  goldFindings: readonly GoldFinding[],
  outcome: L5ProductionFunnelOutcome,
  context: L5ContextAccounting,
): CausalRun {
  const matching = matchFindings(goldFindings, outcome.qualityCandidates);
  const goldByCandidate = new Map<string, string[]>();
  for (const match of matching.matches) {
    const key = candidateSemanticIdentityKey(match.candidateIdentity);
    const ids = goldByCandidate.get(key) ?? [];
    ids.push(match.goldId);
    goldByCandidate.set(key, ids);
  }
  for (const ids of goldByCandidate.values()) ids.sort();
  const exposedFamilies = L5_FACT_FAMILIES.filter(
    (family) => context.byFamily[family].selected.items > 0,
  );
  const outcomes: CausalOutcomeObservation[] = outcome.qualityCandidates.map(
    (candidate) => {
      const key = candidateSemanticIdentityKey(candidate);
      const goldIds = goldByCandidate.get(key) ?? [];
      const goldId = goldIds.shift();
      return {
        identity:
          goldId === undefined
            ? {
                kind: "falsePositive" as const,
                candidateIdentity: candidate,
              }
            : { kind: "gold" as const, goldId },
        state: {
          candidatePresent: true,
          verificationDecision: candidate.verificationDecision,
          promoted: candidate.promoted,
          published: candidate.published,
        },
        exposedFamilies,
      };
    },
  );
  for (const goldId of matching.unmatchedGoldIds) {
    outcomes.push({
      identity: { kind: "gold", goldId },
      state: {
        candidatePresent: false,
        verificationDecision: undefined,
        promoted: false,
        published: false,
      },
      exposedFamilies,
    });
  }
  return { outcomes };
}

function modeCaseReport(
  caseId: string,
  modeId: L5ModeId,
  modeIdentity: L5CanonicalIdentity,
  substantiveHashes: L5SubstantiveHashes,
  modeAttestation: L5ModeAttestation,
  output: L5ProductionFunnelOutcome,
): L5ModeCaseReport {
  const context = accountL5Context(output.contextAccountingInput);
  return {
    modeId,
    modeIdentity,
    substantiveHashes,
    modeAttestation,
    recorderAudit: { passed: true },
    quality: scoreOneMode(
      caseId,
      output.goldFindings,
      output.qualityCandidates,
    ),
    qualityCandidates: output.qualityCandidates,
    context,
  };
}

async function runCase(
  corpusCase: L5CorpusCase,
  options: L5QualityContextExperimentOptions,
): Promise<L5CaseExperimentReport> {
  const adapted = adaptL5CorpusCase(corpusCase, options);
  const createRealRecorder =
    options.createRealRecorder ?? (() => ({ record: () => undefined }));
  const runPair = (treatmentMode: Exclude<L5ModeId, "CONTROL">) =>
    runL5Pair({
      control: {
        case: adapted,
        equivalence: adapted.equivalence,
        mode: L5_MODES.CONTROL,
      },
      treatment: {
        case: adapted,
        equivalence: adapted.equivalence,
        mode: L5_MODES[treatmentMode],
      },
      execute: ({ case: productionCase, mode, recorder, analysisCache }) =>
        runL5ProductionFunnel(productionCase, mode, recorder, analysisCache),
      substantiveHashes: l5ProductionSubstantiveHashes,
      modeAttestation: (output) => output.attestation,
      createRealRecorder,
      score: () => null,
    });

  const treatmentPair = await runPair("TREATMENT");
  const ablationPairs = await Promise.all(
    L5_FACT_FAMILIES.map((family) =>
      runPair(
        `TREATMENT_MINUS_${family.toUpperCase()}` as Exclude<
          L5ModeId,
          "CONTROL"
        >,
      ),
    ),
  );
  const modes = {
    CONTROL: modeCaseReport(
      corpusCase.id,
      "CONTROL",
      treatmentPair.controlModeIdentity,
      treatmentPair.substantiveHashes.control,
      treatmentPair.modeAttestations.control,
      treatmentPair.control.output,
    ),
    TREATMENT: modeCaseReport(
      corpusCase.id,
      "TREATMENT",
      treatmentPair.treatmentModeIdentity,
      treatmentPair.substantiveHashes.treatment,
      treatmentPair.modeAttestations.treatment,
      treatmentPair.treatment.output,
    ),
    ...Object.fromEntries(
      ablationPairs.map((pair) => [
        pair.treatment.unit.mode.id,
        modeCaseReport(
          corpusCase.id,
          pair.treatment.unit.mode.id,
          pair.treatmentModeIdentity,
          pair.substantiveHashes.treatment,
          pair.modeAttestations.treatment,
          pair.treatment.output,
        ),
      ]),
    ),
  } as unknown as Readonly<Record<L5ModeId, L5ModeCaseReport>>;
  const goldFindings = treatmentPair.treatment.output.goldFindings;
  const causalRuns = Object.fromEntries(
    Object.values(L5_MODES).map((mode) => [
      mode.id,
      causalRunFor(
        goldFindings,
        mode.id === "CONTROL"
          ? treatmentPair.control.output
          : mode.id === "TREATMENT"
            ? treatmentPair.treatment.output
            : (ablationPairs.find(
                (pair) => pair.treatment.unit.mode.id === mode.id,
              )?.treatment.output ??
              (() => {
                throw new Error(`Missing L.5 ablation output: ${mode.id}`);
              })()),
        modes[mode.id].context,
      ),
    ]),
  ) as unknown as Readonly<Record<L5ModeId, CausalRun>>;
  const ablations = Object.fromEntries(
    L5_FACT_FAMILIES.map((family) => [
      family,
      causalRuns[`TREATMENT_MINUS_${family.toUpperCase()}` as L5ModeId],
    ]),
  ) as unknown as Readonly<Record<L5FactFamily, CausalRun>>;

  return {
    caseId: corpusCase.id,
    equivalenceIdentity: treatmentPair.equivalenceIdentity,
    goldFindings,
    modes,
    pairedQualityEffects: comparePublishedQuality(
      modes.CONTROL.quality,
      modes.TREATMENT.quality,
    ),
    causalAttribution: attributeCausalOutcomes({
      control: causalRuns.CONTROL,
      treatment: causalRuns.TREATMENT,
      ablations,
    }),
  };
}

export async function runL5QualityContextExperiment(
  options: L5QualityContextExperimentOptions,
): Promise<L5QualityContextReport> {
  const corpus = options.corpus ?? L5_CORPUS;
  const caseRows: L5CaseExperimentReport[] = [];
  for (const corpusCase of corpus.cases) {
    caseRows.push(await runCase(corpusCase, options));
  }
  const caseIds = caseRows.map((row) => row.caseId);
  const goldFindings = caseRows.flatMap((row) => row.goldFindings);
  const aggregateQuality = (mode: "CONTROL" | "TREATMENT") =>
    scoreQuality({
      caseIds,
      goldFindings,
      candidates: caseRows.flatMap((row) => row.modes[mode].qualityCandidates),
    });
  const controlQuality = aggregateQuality("CONTROL");
  const treatmentQuality = aggregateQuality("TREATMENT");

  return {
    schemaVersion: L5_EXPERIMENT_REPORT_SCHEMA_VERSION,
    corpusVersion: corpus.corpusVersion,
    caseRows,
    quality: {
      control: controlQuality,
      treatment: treatmentQuality,
      pairedEffects: comparePublishedQuality(controlQuality, treatmentQuality),
    },
    context: {
      control: aggregateL5Context(
        caseRows.map((row) => row.modes.CONTROL.context),
      ),
      treatment: aggregateL5Context(
        caseRows.map((row) => row.modes.TREATMENT.context),
      ),
    },
    audits: {
      equivalencePairs: caseRows.length * (1 + L5_FACT_FAMILIES.length),
      recorderModeExecutions: caseRows.length * (2 + L5_FACT_FAMILIES.length),
      invalidOrExcludedRuns: [],
    },
  };
}
