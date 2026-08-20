/**
 * Production adapters for the frozen P1-L.5 measurement contract.
 *
 * The adapter observes the existing planner and analyzer seams. It does not
 * change production planning, analysis, verification, or publication policy.
 */

import { createHash } from "node:crypto";

import {
  PLANNER_FACT_FAMILIES,
  classifyInstructionCandidate,
  planContextWithTrace,
  type ContextCandidate,
  type ContextPlanningTrace,
  type PlannerFactFamilyAvailability,
  type PlannerInput,
} from "@acalys/code-intelligence";
import { canonicalJson } from "@acalys/contracts/domain";
import {
  ANALYZER_ID,
  ANALYZER_VERSION,
  ALL_ANALYZER_IDS,
  DEFAULT_LIMITS,
  DEFAULT_PREMERGE_CONFIG,
  DEFAULT_PUBLICATION_CONFIG,
  DEFAULT_VERIFICATION_POLICY,
  SIGNATURE_ANALYZER_ID,
  SIGNATURE_ANALYZER_VERSION,
  SWALLOWED_ERROR_ANALYZER_ID,
  SWALLOWED_ERROR_VERSION,
  evaluatePreMerge,
  planPublication,
  planVerificationContext,
  promoteVerified,
  toVerificationInput,
  verifyDeterministically,
  type CandidateFinding,
  type ExecutionLimits,
  type PreMergeCheckPlan,
  type PreMergeConfig,
  type PromotionOutcome,
  type PublicationConfig,
  type PublicationPlan,
  type VerificationPolicy,
  type VerifiedCandidate,
} from "@acalys/review-engine";

import {
  candidateFingerprint,
  runRealAnalysis,
  type AnalysisInstructionObservation,
  type AnalysisSource,
  type AnalysisSourceSnapshot,
  type RealAnalysisOptions,
  type RealAnalysisOutcome,
} from "../analysis.js";
import {
  L5_CORPUS_VERSION,
  L5_EXPERIMENT_SCHEMA_VERSION,
  type L5CacheIdentityPair as L5CorpusCacheIdentityPair,
  type L5CachePairCategory,
  type L5ContextLabel as L5CorpusContextLabel,
  type L5Corpus,
  type L5CorpusCase,
  type L5RevisionFixture,
} from "./l5-corpus.js";
import type {
  L5AnalyzerCacheInput,
  L5CacheIdentityCategory,
  L5CacheIdentityPair,
} from "./l5-identity.js";
import type { GoldFinding, QualityCandidate } from "./l5-quality.js";
import {
  L5_FACT_FAMILIES,
  L5_MODES,
  type L5EquivalenceInput,
  type L5FactFamily,
  type L5FactFamilyOfferManifest,
  type L5ModeAttestation,
  type L5ModeDefinition,
  type L5ModeId,
  type L5Recorder,
  type L5SubstantiveHashes,
} from "./l5-run.js";

export const L5_PRODUCTION_PLANNER_SCHEMA_VERSION =
  "acalys.planner.fact-family-availability/v1" as const;
export const L5_PRODUCTION_ADAPTER_SCHEMA_VERSION =
  "acalys.p1-l5.production-adapter/v1" as const;

const L5_PRODUCTION_ANALYZERS = [
  { id: ANALYZER_ID, procedureVersion: ANALYZER_VERSION },
  {
    id: SIGNATURE_ANALYZER_ID,
    procedureVersion: SIGNATURE_ANALYZER_VERSION,
  },
  {
    id: SWALLOWED_ERROR_ANALYZER_ID,
    procedureVersion: SWALLOWED_ERROR_VERSION,
  },
] as const;

export const L5_PRODUCTION_STAGE_CAPABILITY = Object.freeze({
  candidates: true,
  verificationDecisions: true,
  promotions: true,
  publicationDecisions: true,
  premergeDecisions: true,
  limitation: null,
});

export interface L5ProductionPolicies {
  readonly verifierPolicy: VerificationPolicy;
  readonly publicationPolicy: PublicationConfig;
  readonly premergePolicy: PreMergeConfig;
}

export const L5_DEFAULT_PRODUCTION_POLICIES: L5ProductionPolicies =
  Object.freeze({
    verifierPolicy: DEFAULT_VERIFICATION_POLICY,
    publicationPolicy: DEFAULT_PUBLICATION_CONFIG,
    premergePolicy: DEFAULT_PREMERGE_CONFIG,
  });

export interface L5ProductionCaseOptions {
  readonly repositoryId: string;
  readonly tenantId?: string | undefined;
  readonly policies: L5ProductionPolicies;
  readonly limits?: Partial<ExecutionLimits> | undefined;
}

export interface L5AdaptedProductionCase {
  readonly corpusCase: L5CorpusCase;
  readonly repositoryId: string;
  readonly headSha: string;
  readonly source: AnalysisSource;
  readonly snapshot: AnalysisSourceSnapshot;
  readonly policies: L5ProductionPolicies;
  readonly equivalence: L5EquivalenceInput;
  readonly analysisOptions: Omit<
    RealAnalysisOptions,
    "contextPlanner" | "previousIndex"
  >;
}

export interface L5ProductionTraceSet {
  readonly CONTROL: ContextPlanningTrace;
  readonly TREATMENT: ContextPlanningTrace;
  readonly TREATMENT_MINUS_STRUCTURAL_INDEX: ContextPlanningTrace;
  readonly TREATMENT_MINUS_BINDING: ContextPlanningTrace;
  readonly TREATMENT_MINUS_TEST_RELATIONSHIP: ContextPlanningTrace;
  readonly TREATMENT_MINUS_CONFIG_GOVERNANCE: ContextPlanningTrace;
  readonly TREATMENT_MINUS_INSTRUCTION_GOVERNANCE: ContextPlanningTrace;
}

export interface L5ProductionAnalysisOutcome {
  readonly analysis: RealAnalysisOutcome;
  readonly mode: L5ModeDefinition;
  readonly trace: ContextPlanningTrace;
  readonly traces: L5ProductionTraceSet;
  readonly attestation: L5ModeAttestation;
  readonly contextAccountingInput: ReturnType<
    typeof contextAccountingInputForTrace
  >;
}

export interface L5ProductionFunnelOutcome extends L5ProductionAnalysisOutcome {
  readonly verifiedCandidates: readonly VerifiedCandidate[];
  readonly promotion: PromotionOutcome;
  readonly publication: PublicationPlan | null;
  readonly premerge: readonly PreMergeCheckPlan[] | null;
  readonly qualityCandidates: readonly QualityCandidate[];
  readonly goldFindings: readonly GoldFinding[];
}

export class L5ProductionPremiseError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid L.5 production premise:\n${issues.join("\n")}`);
    this.name = "L5ProductionPremiseError";
    this.issues = issues;
  }
}

function sha1(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function l5RevisionObjectId(revision: string): string {
  return sha1(`${L5_PRODUCTION_ADAPTER_SCHEMA_VERSION}\u0000${revision}`);
}

function instructionObservationFor(
  fixture: L5RevisionFixture,
): AnalysisInstructionObservation {
  const discoveryOutages =
    fixture.coverage.status === "incomplete"
      ? fixture.coverage.outages.filter(
          (outage) => outage.operation === "discovery",
        )
      : [];
  const observedPaths = Object.keys(fixture.files)
    .filter((path) => !discoveryOutages.some((outage) => outage.path === path))
    .sort();

  return {
    listPaths: () =>
      fixture.coverage.status === "complete"
        ? { status: "complete", paths: observedPaths }
        : {
            status: "incomplete",
            paths: observedPaths,
            why: fixture.coverage.outages
              .map(
                (outage) =>
                  `${outage.operation}:${outage.path}:${outage.because}`,
              )
              .join("; "),
          },
    readArtifact: (path) => {
      const outage =
        fixture.coverage.status === "incomplete"
          ? fixture.coverage.outages.find(
              (candidate) =>
                candidate.path === path && candidate.operation !== "discovery",
            )
          : undefined;
      if (outage?.operation === "parse") {
        return { status: "malformed", detail: outage.because };
      }
      if (outage?.operation === "read") {
        return { status: "unreadable", detail: outage.because };
      }
      const content = fixture.files[path];
      return content === undefined
        ? {
            status: "unreadable",
            detail: "the frozen revision has no content for the observed path",
          }
        : { status: "available", content };
    },
  };
}

function instructionIdentityObservations(fixture: L5RevisionFixture): {
  readonly traversal: ReturnType<AnalysisInstructionObservation["listPaths"]>;
  readonly reads: readonly unknown[];
} {
  const observation = instructionObservationFor(fixture);
  const traversal = observation.listPaths();
  const reads = traversal.paths
    .filter((path) => {
      const classification = classifyInstructionCandidate(path);
      return (
        classification !== undefined &&
        classification.instructionClass !== "documentation"
      );
    })
    .map((path) => ({ path, observation: observation.readArtifact(path) }));
  return { traversal, reads };
}

function assertCaseSnapshot(corpusCase: L5CorpusCase): void {
  for (const changed of corpusCase.changeManifest) {
    if (corpusCase.files[changed.path] !== changed.headContent) {
      throw new Error(
        `L.5 case ${corpusCase.id} changed head content disagrees with repository manifest at ${changed.path}`,
      );
    }
  }
}

export function adaptL5CorpusCase(
  corpusCase: L5CorpusCase,
  options: L5ProductionCaseOptions,
): L5AdaptedProductionCase {
  assertCaseSnapshot(corpusCase);
  const headSha = l5RevisionObjectId(corpusCase.syntheticRevision);
  const instruction = instructionIdentityObservations(corpusCase);
  const snapshot: AnalysisSourceSnapshot = {
    changed: corpusCase.changeManifest.map((changed) => ({
      path: changed.path,
      content: changed.headContent,
      changedLines: [...changed.changedLines],
    })),
    repository: new Map(Object.entries(corpusCase.files)),
    instructionObservation: instructionObservationFor(corpusCase),
  };
  const source: AnalysisSource = {
    read: (input) => {
      if (
        input.repositoryId !== options.repositoryId ||
        input.headSha !== headSha
      ) {
        throw new Error(
          `L.5 source identity mismatch for ${corpusCase.id}: ${input.repositoryId}@${input.headSha}`,
        );
      }
      return Promise.resolve(snapshot);
    },
  };
  const executionLimits: ExecutionLimits = {
    ...DEFAULT_LIMITS,
    ...options.limits,
  };
  const equivalence: L5EquivalenceInput = {
    experimentSchemaVersion: L5_EXPERIMENT_SCHEMA_VERSION,
    caseId: corpusCase.id,
    corpusVersion: L5_CORPUS_VERSION,
    plannerSchemaVersion: L5_PRODUCTION_PLANNER_SCHEMA_VERSION,
    experimentHarnessSchemaVersion: L5_PRODUCTION_ADAPTER_SCHEMA_VERSION,
    syntheticRevision: corpusCase.syntheticRevision,
    repositoryManifest: Object.entries(corpusCase.files).map(
      ([path, content]) => ({ path, content }),
    ),
    changedSource: corpusCase.changeManifest.map((changed) => ({
      path: changed.path,
      content: changed.headContent,
      changedLines: [...changed.changedLines],
    })),
    goldFindingLabels: [...corpusCase.gold.expectedFindings],
    requiredContextLabels: [...corpusCase.gold.requiredContext],
    forbiddenContextLabels: [...corpusCase.gold.forbiddenContext],
    analyzers: L5_PRODUCTION_ANALYZERS,
    verifierPolicyVersion: options.policies.verifierPolicy.version,
    publicationPolicy: options.policies.publicationPolicy,
    premergePolicy: options.policies.premergePolicy,
    contextTokenBudget: corpusCase.contextSelection.budgetTokens,
    executionLimits,
    modelIdentity: null,
    providerIdentity: null,
    initialAnalysisCacheState: { kind: "empty" },
    previousIndexIdentityAndAvailability: { kind: "absent" },
    instructionTraversalObservation: instruction.traversal,
    instructionArtifactReadObservations: instruction.reads,
  };

  return {
    corpusCase,
    repositoryId: options.repositoryId,
    headSha,
    source,
    snapshot,
    policies: options.policies,
    equivalence,
    analysisOptions: {
      repositoryId: options.repositoryId,
      headSha,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      provider: "github",
      source,
      contextTokenBudget: corpusCase.contextSelection.budgetTokens,
      limits: executionLimits,
    },
  };
}

export function plannerAvailabilityForMode(
  mode: L5ModeDefinition,
): PlannerFactFamilyAvailability {
  const expected = L5_MODES[mode.id];
  if (canonicalJson(mode) !== canonicalJson(expected)) {
    throw new Error(`Unknown or modified L.5 mode: ${mode.id}`);
  }
  return {
    structural_index: mode.families.structural_index,
    binding: mode.families.binding,
    test_relationship: mode.families.test_relationship,
    config_governance: mode.families.config_governance,
    instruction_governance: mode.families.instruction_governance,
  };
}

export function traceL5PlannerModes(
  input: PlannerInput,
  budgetTokens: number,
): L5ProductionTraceSet {
  return {
    CONTROL: planContextWithTrace(
      {
        ...input,
        factFamilyAvailability: plannerAvailabilityForMode(L5_MODES.CONTROL),
      },
      budgetTokens,
    ),
    TREATMENT: planContextWithTrace(
      {
        ...input,
        factFamilyAvailability: plannerAvailabilityForMode(L5_MODES.TREATMENT),
      },
      budgetTokens,
    ),
    TREATMENT_MINUS_STRUCTURAL_INDEX: planContextWithTrace(
      {
        ...input,
        factFamilyAvailability: plannerAvailabilityForMode(
          L5_MODES.TREATMENT_MINUS_STRUCTURAL_INDEX,
        ),
      },
      budgetTokens,
    ),
    TREATMENT_MINUS_BINDING: planContextWithTrace(
      {
        ...input,
        factFamilyAvailability: plannerAvailabilityForMode(
          L5_MODES.TREATMENT_MINUS_BINDING,
        ),
      },
      budgetTokens,
    ),
    TREATMENT_MINUS_TEST_RELATIONSHIP: planContextWithTrace(
      {
        ...input,
        factFamilyAvailability: plannerAvailabilityForMode(
          L5_MODES.TREATMENT_MINUS_TEST_RELATIONSHIP,
        ),
      },
      budgetTokens,
    ),
    TREATMENT_MINUS_CONFIG_GOVERNANCE: planContextWithTrace(
      {
        ...input,
        factFamilyAvailability: plannerAvailabilityForMode(
          L5_MODES.TREATMENT_MINUS_CONFIG_GOVERNANCE,
        ),
      },
      budgetTokens,
    ),
    TREATMENT_MINUS_INSTRUCTION_GOVERNANCE: planContextWithTrace(
      {
        ...input,
        factFamilyAvailability: plannerAvailabilityForMode(
          L5_MODES.TREATMENT_MINUS_INSTRUCTION_GOVERNANCE,
        ),
      },
      budgetTokens,
    ),
  };
}

function candidateFamily(
  candidate: ContextCandidate,
): L5FactFamily | undefined {
  const source = candidate.provenance?.source ?? "direct_source";
  if (source === "repository_index") {
    if (candidate.reason === "indexed_declaration") return "structural_index";
    if (
      candidate.reason === "referenced_symbol" ||
      candidate.reason === "caller"
    ) {
      return "binding";
    }
    if (candidate.reason === "associated_test") return "test_relationship";
  }
  if (
    source === "configuration_facts" &&
    candidate.reason === "configuration"
  ) {
    return "config_governance";
  }
  if (
    (source === "instruction_facts" &&
      (candidate.reason === "repository_instruction" ||
        candidate.reason === "path_instruction")) ||
    (source === "instruction_coverage" &&
      candidate.reason === "instruction_coverage")
  ) {
    return "instruction_governance";
  }
  return undefined;
}

function candidateIdentityCore(candidate: ContextCandidate): string {
  return canonicalJson({
    kind: candidate.kind,
    path: candidate.path,
    reason: candidate.reason,
    trust: candidate.trust,
    contentDigest: sha256(candidate.content),
    startLine: candidate.startLine ?? null,
    endLine: candidate.endLine ?? null,
    deduplicationKey: candidate.deduplicationKey ?? null,
    provenance: candidate.provenance ?? { source: "direct_source" },
  });
}

export function l5PlannerCandidateSemanticIdentity(
  candidate: ContextCandidate,
): string {
  return `l5-context:${sha256(candidateIdentityCore(candidate))}`;
}

function stageCandidateIds(
  offered: readonly ContextCandidate[],
  stage: readonly ContextCandidate[],
): readonly string[] {
  const offeredIds = new Map<string, string[]>();
  for (const candidate of offered) {
    const core = candidateIdentityCore(candidate);
    const occurrences = offeredIds.get(core) ?? [];
    occurrences.push(
      `${l5PlannerCandidateSemanticIdentity(candidate)}:${String(occurrences.length)}`,
    );
    offeredIds.set(core, occurrences);
  }
  const used = new Map<string, number>();
  return stage.map((candidate) => {
    const core = candidateIdentityCore(candidate);
    const occurrence = used.get(core) ?? 0;
    const id = offeredIds.get(core)?.[occurrence];
    if (id === undefined) {
      throw new Error("L.5 planner stage contains a candidate not offered");
    }
    used.set(core, occurrence + 1);
    return id;
  });
}

function familyManifest(
  trace: ContextPlanningTrace,
): L5FactFamilyOfferManifest {
  const ids = stageCandidateIds(trace.offered, trace.offered);
  return Object.fromEntries(
    L5_FACT_FAMILIES.map((family) => [
      family,
      trace.offered.flatMap((candidate, index) =>
        candidateFamily(candidate) === family ? [ids[index]!] : [],
      ),
    ]),
  ) as unknown as L5FactFamilyOfferManifest;
}

function familyCounts(
  candidates: readonly ContextCandidate[],
): Readonly<Record<L5FactFamily, number>> {
  return Object.fromEntries(
    L5_FACT_FAMILIES.map((family) => [
      family,
      candidates.filter((candidate) => candidateFamily(candidate) === family)
        .length,
    ]),
  ) as unknown as Readonly<Record<L5FactFamily, number>>;
}

export function modeAttestationForTrace(
  mode: L5ModeDefinition,
  traces: L5ProductionTraceSet,
): L5ModeAttestation {
  const trace = traces[mode.id];
  return {
    ablationAppliedAt: "fact_input",
    factInputAvailability: plannerAvailabilityForMode(mode),
    fullTreatmentFactFamilyOfferManifest: familyManifest(traces.TREATMENT),
    factFamilyOfferManifest: familyManifest(trace),
    provenanceCounts: {
      offered: familyCounts(trace.offered),
      scored: familyCounts(trace.scored),
      selected: familyCounts(trace.context.items),
    },
    directSourceCandidateIdentitiesBeforeCompetition: stageCandidateIds(
      traces.CONTROL.offered,
      traces.CONTROL.offered,
    ),
  };
}

function reportReason(
  candidate: ContextCandidate,
): L5CorpusContextLabel["reason"] {
  switch (candidate.reason) {
    case "containing_symbol":
    case "indexed_declaration":
    case "referenced_symbol":
      return "declaration";
    case "caller":
      return "caller";
    case "associated_test":
      return "test";
    case "configuration":
      return "config";
    case "repository_instruction":
    case "path_instruction":
      return "instruction";
    case "instruction_coverage":
      return "coverage";
    case "changed_hunk":
      return "changed_source";
    case "prior_finding":
    case "git_history":
      return "other";
  }
}

function selectorMatches(
  label: L5CorpusContextLabel,
  candidate: ContextCandidate,
): boolean {
  if (candidate.path !== label.path) return false;
  if (label.selector.kind === "whole_artifact") return true;
  if (label.selector.kind === "content") {
    return candidate.content.includes(label.selector.contains);
  }
  const startLine = candidate.startLine ?? 1;
  const endLine =
    candidate.endLine ?? startLine + candidate.content.split("\n").length - 1;
  return (
    startLine <= label.selector.endLine && endLine >= label.selector.startLine
  );
}

function requiredExposureMatches(
  label: L5CorpusContextLabel,
  candidate: ContextCandidate,
): boolean {
  const exposure = label.requiredExposure;
  if (
    exposure === undefined ||
    candidateFamily(candidate) !== label.family ||
    reportReason(candidate) !== label.reason ||
    !selectorMatches(label, candidate)
  ) {
    return false;
  }
  switch (exposure.factKind) {
    case "indexed_declaration":
      return candidate.reason === "indexed_declaration";
    case "binding":
      return (
        candidate.reason === "referenced_symbol" ||
        candidate.reason === "caller"
      );
    case "test_relationship":
      return candidate.reason === "associated_test";
    case "config_governance":
      return candidate.reason === "configuration";
    case "instruction_governance":
      return (
        candidate.reason === "repository_instruction" ||
        candidate.reason === "path_instruction" ||
        candidate.reason === "instruction_coverage"
      );
  }
}

function observedCandidate(candidate: ContextCandidate): string {
  return [
    candidate.path,
    candidate.reason,
    candidate.provenance?.source ?? "direct_source",
    `${String(candidate.startLine ?? 1)}-${String(
      candidate.endLine ?? candidate.content.split("\n").length,
    )}`,
  ].join("|");
}

function ablationModeFor(family: L5FactFamily): L5ModeId {
  return `TREATMENT_MINUS_${family.toUpperCase()}` as L5ModeId;
}

export function requiredExposurePremiseIssues(
  corpusCase: L5CorpusCase,
  traces: L5ProductionTraceSet,
): readonly string[] {
  const issues: string[] = [];
  for (const label of corpusCase.gold.requiredContext) {
    if (label.requiredExposure === undefined) continue;
    const fullMatches = traces.TREATMENT.offered.filter((candidate) =>
      requiredExposureMatches(label, candidate),
    );
    const ablationMode = ablationModeFor(
      label.requiredExposure.disappearsUnderAblation,
    );
    const ablationMatches = traces[ablationMode].offered.filter((candidate) =>
      requiredExposureMatches(label, candidate),
    );
    if (fullMatches.length === 0) {
      issues.push(
        `${corpusCase.id}:${label.id} is absent from full-treatment offered trace; expected ${label.path}|${label.requiredExposure.factKind}; observed [${traces.TREATMENT.offered
          .map(observedCandidate)
          .sort()
          .join(", ")}]`,
      );
    }
    if (ablationMatches.length > 0) {
      issues.push(
        `${corpusCase.id}:${label.id} remains offered under ${ablationMode}; observed [${ablationMatches
          .map(observedCandidate)
          .sort()
          .join(", ")}]`,
      );
    }
  }
  return issues;
}

export function assertL5RequiredExposurePremises(
  corpusCase: L5CorpusCase,
  traces: L5ProductionTraceSet,
): void {
  const issues = requiredExposurePremiseIssues(corpusCase, traces);
  if (issues.length > 0) throw new L5ProductionPremiseError(issues);
}

/** Captures planner premises and stops before cluster/analyzer execution. */
export async function inspectL5RequiredExposurePremises(
  adapted: L5AdaptedProductionCase,
): Promise<readonly string[]> {
  const stopAfterTrace = new Error("L.5 premise trace captured");
  let issues: readonly string[] | undefined;
  try {
    await runRealAnalysis({
      ...adapted.analysisOptions,
      contextPlanner: (input, budgetTokens) => {
        issues = requiredExposurePremiseIssues(
          adapted.corpusCase,
          traceL5PlannerModes(input, budgetTokens),
        );
        throw stopAfterTrace;
      },
    });
  } catch (error) {
    if (error !== stopAfterTrace) throw error;
  }
  if (issues === undefined) {
    throw new Error("runRealAnalysis did not invoke the L.5 planner seam");
  }
  return issues;
}

function sourceSlicesFor(
  candidate: ContextCandidate,
  suppliedContent: string,
):
  | readonly {
      readonly originalStartByte: number;
      readonly suppliedStartByte: number;
      readonly byteLength: number;
    }[]
  | undefined {
  if (candidate.content === suppliedContent) return undefined;
  const original = Buffer.from(candidate.content, "utf8");
  const supplied = Buffer.from(suppliedContent, "utf8");
  const offset = original.indexOf(supplied);
  return offset < 0
    ? []
    : [
        {
          originalStartByte: offset,
          suppliedStartByte: 0,
          byteLength: supplied.length,
        },
      ];
}

export function contextAccountingInputForTrace(
  corpusCase: L5CorpusCase,
  trace: ContextPlanningTrace,
) {
  const offeredIds = stageCandidateIds(trace.offered, trace.offered);
  const scoredIds = stageCandidateIds(trace.offered, trace.scored);
  const selectedIds = stageCandidateIds(trace.offered, trace.context.items);
  const selectedIdSet = new Set(selectedIds);
  const offeredById = new Map(
    trace.offered.map((candidate, index) => [offeredIds[index]!, candidate]),
  );

  return {
    offered: trace.offered.map((candidate, index) => ({
      candidateId: offeredIds[index]!,
      path: candidate.path,
      reason: candidate.reason,
      provenanceSource: candidate.provenance?.source ?? "direct_source",
      originalContent: candidate.content,
      originalStartLine: candidate.startLine ?? 1,
    })),
    scoredCandidateIds: scoredIds,
    selected: trace.context.items.map((item, index) => {
      const candidateId = selectedIds[index]!;
      const original = offeredById.get(candidateId);
      if (original === undefined) {
        throw new Error(
          `Selected L.5 candidate was not offered: ${candidateId}`,
        );
      }
      return {
        candidateId,
        suppliedContent: item.suppliedContent,
        truncated: item.representation === "excerpt",
        sourceSlices: sourceSlicesFor(original, item.suppliedContent),
      };
    }),
    omittedCandidateIds: scoredIds.filter((id) => !selectedIdSet.has(id)),
    labels: [
      ...corpusCase.gold.requiredContext.map((label) => ({
        labelId: label.id,
        classification: "required" as const,
        selector: corpusSelector(label),
      })),
      ...corpusCase.gold.forbiddenContext.map((label) => ({
        labelId: label.id,
        classification: "forbidden" as const,
        selector: corpusSelector(label),
      })),
    ],
  };
}

function corpusSelector(label: L5CorpusContextLabel) {
  switch (label.selector.kind) {
    case "whole_artifact":
      return { kind: "whole_artifact" as const, path: label.path };
    case "line_range":
      return {
        kind: "line_range" as const,
        path: label.path,
        startLine: label.selector.startLine,
        endLine: label.selector.endLine,
      };
    case "content":
      return {
        kind: "content" as const,
        path: label.path,
        content: label.selector.contains,
      };
  }
}

export async function runL5ProductionAnalysis(
  adapted: L5AdaptedProductionCase,
  mode: L5ModeDefinition,
): Promise<L5ProductionAnalysisOutcome> {
  let traces: L5ProductionTraceSet | undefined;
  const analysis = await runRealAnalysis({
    ...adapted.analysisOptions,
    contextPlanner: (input, budgetTokens) => {
      traces = traceL5PlannerModes(input, budgetTokens);
      assertL5RequiredExposurePremises(adapted.corpusCase, traces);
      return traces[mode.id].context;
    },
  });
  if (traces === undefined) {
    throw new Error("runRealAnalysis did not invoke the L.5 planner seam");
  }
  const trace = traces[mode.id];
  return {
    analysis,
    mode,
    trace,
    traces,
    attestation: modeAttestationForTrace(mode, traces),
    contextAccountingInput: contextAccountingInputForTrace(
      adapted.corpusCase,
      trace,
    ),
  };
}

interface OrderedProductionCandidate {
  readonly candidateId: string;
  readonly finding: CandidateFinding;
  readonly fingerprint: string;
}

function orderedProductionCandidates(
  adapted: L5AdaptedProductionCase,
  findings: readonly CandidateFinding[],
): readonly OrderedProductionCandidate[] {
  const ordered = findings
    .map((finding, ordinal) => ({
      finding,
      ordinal,
      semantic: canonicalJson({
        ruleId: finding.ruleId,
        family: finding.family,
        category: finding.category,
        path: finding.location.path,
        startLine: finding.location.startLine,
        endLine: finding.location.endLine,
        analyzerIdentityHint: finding.identityHint,
      }),
    }))
    .sort((left, right) =>
      left.semantic < right.semantic
        ? -1
        : left.semantic > right.semantic
          ? 1
          : left.ordinal - right.ordinal,
    );
  const occurrences = new Map<string, number>();
  return ordered.map(({ finding, semantic }) => {
    const occurrence = occurrences.get(semantic) ?? 0;
    occurrences.set(semantic, occurrence + 1);
    return {
      candidateId: `${adapted.corpusCase.id}:${sha256(semantic)}:${String(occurrence)}`,
      finding,
      fingerprint: candidateFingerprint(adapted.repositoryId, finding),
    };
  });
}

function recordStage(
  recorder: L5Recorder | undefined,
  event: Readonly<Record<string, unknown>>,
): void {
  recorder?.record(
    Object.freeze({
      schema: "acalys.p1-l5.production-stage/v1",
      ...event,
    }),
  );
}

function fingerprintCounts(
  fingerprints: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const fingerprint of fingerprints) {
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

function consumeFingerprint(
  counts: Map<string, number>,
  fingerprint: string,
): boolean {
  const count = counts.get(fingerprint) ?? 0;
  if (count === 0) return false;
  counts.set(fingerprint, count - 1);
  return true;
}

export function adaptL5GoldFindings(
  corpusCase: L5CorpusCase,
): readonly GoldFinding[] {
  return corpusCase.gold.expectedFindings.map((finding) => ({
    goldId: finding.goldId,
    caseId: corpusCase.id,
    matcher: {
      ruleId: finding.ruleId,
      family: finding.correctnessFamily,
      path: finding.path,
      allowedAnchorLines: {
        startLine: finding.allowedAnchor.startLine,
        endLine: finding.allowedAnchor.endLine,
      },
    },
  }));
}

function qualityCandidatesFor(
  adapted: L5AdaptedProductionCase,
  candidates: readonly OrderedProductionCandidate[],
  verified: readonly VerifiedCandidate[],
  promotion: PromotionOutcome,
  publication: PublicationPlan | null,
): readonly QualityCandidate[] {
  const attemptById = new Map(
    verified.map((candidate) => [candidate.candidateId, candidate.attempt]),
  );
  const promoted = fingerprintCounts(
    promotion.kind === "promoted"
      ? promotion.findings.map((finding) => finding.fingerprint)
      : [],
  );
  const published = fingerprintCounts(
    publication?.publish.map((finding) => finding.fingerprint) ?? [],
  );

  return candidates.map(({ candidateId, finding, fingerprint }) => {
    const attempt = attemptById.get(candidateId);
    if (attempt === undefined) {
      throw new Error(`Missing L.5 verification attempt for ${candidateId}`);
    }
    return {
      caseId: adapted.corpusCase.id,
      ruleId: finding.ruleId,
      family: finding.family,
      category: finding.category,
      path: finding.location.path,
      startLine: finding.location.startLine,
      endLine: finding.location.endLine,
      analyzerIdentityHint: finding.identityHint,
      verificationDecision:
        attempt.status === "unavailable" ? "unavailable" : attempt.decision,
      promoted: consumeFingerprint(promoted, fingerprint),
      published: consumeFingerprint(published, fingerprint),
    };
  });
}

/** Runs the existing pure production decision kernels without persistence. */
export async function runL5ProductionFunnel(
  adapted: L5AdaptedProductionCase,
  mode: L5ModeDefinition,
  recorder?: L5Recorder,
): Promise<L5ProductionFunnelOutcome> {
  const analysisOutcome = await runL5ProductionAnalysis(adapted, mode);
  const candidates = orderedProductionCandidates(
    adapted,
    analysisOutcome.analysis.report.findings,
  );
  recordStage(recorder, {
    caseId: adapted.corpusCase.id,
    modeId: mode.id,
    stage: "candidates",
    count: candidates.length,
  });

  const repository = {
    revisionId: adapted.headSha,
    files: adapted.snapshot.repository,
  };
  const verifiedCandidates = candidates.map(
    ({ candidateId, finding, fingerprint }): VerifiedCandidate => {
      const { input } = toVerificationInput(candidateId, finding, {
        repositoryId: adapted.repositoryId,
        revisionId: adapted.headSha,
      });
      const context = planVerificationContext({
        verificationInput: input,
        repository,
        policy: adapted.policies.verifierPolicy,
      });
      return {
        candidateId,
        fingerprint,
        severity: finding.proposedSeverity,
        category: finding.category,
        path: finding.location.path,
        attempt: verifyDeterministically(input, context),
      };
    },
  );
  recordStage(recorder, {
    caseId: adapted.corpusCase.id,
    modeId: mode.id,
    stage: "verificationDecisions",
    count: verifiedCandidates.length,
  });

  const promotion = promoteVerified(verifiedCandidates);
  recordStage(recorder, {
    caseId: adapted.corpusCase.id,
    modeId: mode.id,
    stage: "promotions",
    kind: promotion.kind,
  });

  const promotedFindings =
    promotion.kind === "promoted" ? promotion.findings : null;
  const publication =
    promotedFindings === null
      ? null
      : planPublication(promotedFindings, adapted.policies.publicationPolicy);
  recordStage(recorder, {
    caseId: adapted.corpusCase.id,
    modeId: mode.id,
    stage: "publicationDecisions",
    count: publication?.decisions.length ?? 0,
    blocked: publication === null,
  });

  // Enforcement and attention branch independently from the same promotion.
  const premerge =
    promotedFindings === null
      ? null
      : evaluatePreMerge(promotedFindings, adapted.policies.premergePolicy);
  recordStage(recorder, {
    caseId: adapted.corpusCase.id,
    modeId: mode.id,
    stage: "premergeDecisions",
    count: premerge?.length ?? 0,
    blocked: premerge === null,
  });

  return {
    ...analysisOutcome,
    verifiedCandidates,
    promotion,
    publication,
    premerge,
    qualityCandidates: qualityCandidatesFor(
      adapted,
      candidates,
      verifiedCandidates,
      promotion,
      publication,
    ),
    goldFindings: adaptL5GoldFindings(adapted.corpusCase),
  };
}

function substantiveHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function l5ProductionSubstantiveHashes(
  outcome: L5ProductionFunnelOutcome,
): L5SubstantiveHashes {
  return {
    candidates: substantiveHash(
      outcome.qualityCandidates.map((candidate) => ({
        caseId: candidate.caseId,
        ruleId: candidate.ruleId,
        family: candidate.family,
        category: candidate.category,
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        analyzerIdentityHint: candidate.analyzerIdentityHint,
      })),
    ),
    verificationDecisions: substantiveHash(
      outcome.verifiedCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        attempt: candidate.attempt ?? null,
      })),
    ),
    promotions: substantiveHash(outcome.promotion),
    publicationDecisions: substantiveHash(outcome.publication),
    premergeDecisions: substantiveHash(outcome.premerge),
  };
}

const CACHE_CATEGORY_MAP = {
  unchanged_input: "unchanged_input_reuse",
  config_only: "config_only_invalidation",
  instruction_only: "instruction_only_invalidation",
  context_selection_only: "context_selection_invalidation",
} as const satisfies Readonly<
  Record<L5CachePairCategory, L5CacheIdentityCategory>
>;

export interface L5CachePairContextObservation {
  readonly beforeContextDigest: string;
  readonly afterContextDigest: string;
  readonly modelIdentity?: string | undefined;
}

function analyzerInputFor(
  repositoryId: string,
  revision: string,
  contextDigest: string,
  modelIdentity: string | undefined,
): L5AnalyzerCacheInput {
  return {
    repositoryId,
    headSha: l5RevisionObjectId(revision),
    contextDigest,
    ...(modelIdentity === undefined ? {} : { modelIdentity }),
  };
}

export function adaptL5CacheIdentityPair(
  corpus: L5Corpus,
  pair: L5CorpusCacheIdentityPair,
  repositoryId: string,
  observation: L5CachePairContextObservation,
): L5CacheIdentityPair {
  const base = corpus.cases.find(
    (corpusCase) => corpusCase.id === pair.baseCaseId,
  );
  if (base === undefined) {
    throw new Error(
      `L.5 cache pair ${pair.id} references missing base case ${pair.baseCaseId}`,
    );
  }
  return {
    pairId: pair.id,
    gold: {
      category: CACHE_CATEGORY_MAP[pair.category],
      expectation: pair.expectation,
      rationale: pair.expectationBecause,
    },
    before: analyzerInputFor(
      repositoryId,
      base.syntheticRevision,
      observation.beforeContextDigest,
      observation.modelIdentity,
    ),
    after: analyzerInputFor(
      repositoryId,
      pair.to.syntheticRevision,
      observation.afterContextDigest,
      observation.modelIdentity,
    ),
  };
}

export function adaptL5CacheIdentityPairs(
  corpus: L5Corpus,
  repositoryId: string,
  observations: Readonly<Record<string, L5CachePairContextObservation>>,
): readonly L5CacheIdentityPair[] {
  const expectedIds = new Set(corpus.cacheIdentityPairs.map((pair) => pair.id));
  const suppliedIds = Object.keys(observations);
  const missing = [...expectedIds].filter(
    (id) => observations[id] === undefined,
  );
  const unexpected = suppliedIds.filter((id) => !expectedIds.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `L.5 cache observations are not exhaustive; missing [${missing.sort().join(", ")}], unexpected [${unexpected.sort().join(", ")}]`,
    );
  }
  return corpus.cacheIdentityPairs.map((pair) =>
    adaptL5CacheIdentityPair(
      corpus,
      pair,
      repositoryId,
      observations[pair.id]!,
    ),
  );
}

export function assertPlannerFamilyNamesAreExact(): void {
  const planner = [...PLANNER_FACT_FAMILIES].sort();
  const experiment = [...L5_FACT_FAMILIES].sort();
  if (canonicalJson(planner) !== canonicalJson(experiment)) {
    throw new Error("Planner and L.5 fact-family names differ");
  }
}

export function assertProductionAnalyzerListIsExact(): void {
  const production = [...ALL_ANALYZER_IDS].sort();
  const measured = L5_PRODUCTION_ANALYZERS.map(
    (analyzer) => analyzer.id,
  ).sort();
  if (canonicalJson(production) !== canonicalJson(measured)) {
    throw new Error("Production and L.5 analyzer lists differ");
  }
}

assertPlannerFamilyNamesAreExact();
assertProductionAnalyzerListIsExact();
