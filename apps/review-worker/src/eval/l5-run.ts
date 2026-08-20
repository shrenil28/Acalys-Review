/**
 * P1-L.5 execution guardrails.
 *
 * This module deliberately knows nothing about the frozen corpus or its
 * metrics. Those layers compose through the generic case, executor, hasher,
 * recorder, and scorer ports below. Keeping those ports narrow also makes the
 * important ordering enforceable here: equivalence first, execution second,
 * recorder non-interference third, and scoring last.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "@acalys/contracts/domain";

export const L5_FACT_FAMILIES = [
  "structural_index",
  "binding",
  "test_relationship",
  "config_governance",
  "instruction_governance",
] as const;

export type L5FactFamily = (typeof L5_FACT_FAMILIES)[number];

export const L5_MODE_IDS = [
  "CONTROL",
  "TREATMENT",
  "TREATMENT_MINUS_STRUCTURAL_INDEX",
  "TREATMENT_MINUS_BINDING",
  "TREATMENT_MINUS_TEST_RELATIONSHIP",
  "TREATMENT_MINUS_CONFIG_GOVERNANCE",
  "TREATMENT_MINUS_INSTRUCTION_GOVERNANCE",
] as const;

export type L5ModeId = (typeof L5_MODE_IDS)[number];

export interface L5ModeDefinition {
  readonly id: L5ModeId;
  readonly families: Readonly<Record<L5FactFamily, boolean>>;
}

function defineMode(
  id: L5ModeId,
  options: {
    readonly disabledFamilies?: readonly L5FactFamily[] | undefined;
  },
): L5ModeDefinition {
  const disabled = new Set(options.disabledFamilies ?? []);
  return Object.freeze({
    id,
    families: Object.freeze({
      structural_index: !disabled.has("structural_index"),
      binding: !disabled.has("binding"),
      test_relationship: !disabled.has("test_relationship"),
      config_governance: !disabled.has("config_governance"),
      instruction_governance: !disabled.has("instruction_governance"),
    }),
  });
}

export const CONTROL = defineMode("CONTROL", {
  disabledFamilies: L5_FACT_FAMILIES,
});

export const TREATMENT = defineMode("TREATMENT", {});

export const TREATMENT_MINUS_STRUCTURAL_INDEX = defineMode(
  "TREATMENT_MINUS_STRUCTURAL_INDEX",
  { disabledFamilies: ["structural_index"] },
);

export const TREATMENT_MINUS_BINDING = defineMode("TREATMENT_MINUS_BINDING", {
  disabledFamilies: ["binding"],
});

export const TREATMENT_MINUS_TEST_RELATIONSHIP = defineMode(
  "TREATMENT_MINUS_TEST_RELATIONSHIP",
  {
    disabledFamilies: ["test_relationship"],
  },
);

export const TREATMENT_MINUS_CONFIG_GOVERNANCE = defineMode(
  "TREATMENT_MINUS_CONFIG_GOVERNANCE",
  {
    disabledFamilies: ["config_governance"],
  },
);

export const TREATMENT_MINUS_INSTRUCTION_GOVERNANCE = defineMode(
  "TREATMENT_MINUS_INSTRUCTION_GOVERNANCE",
  {
    disabledFamilies: ["instruction_governance"],
  },
);

export const L5_MODES: Readonly<Record<L5ModeId, L5ModeDefinition>> =
  Object.freeze({
    CONTROL,
    TREATMENT,
    TREATMENT_MINUS_STRUCTURAL_INDEX,
    TREATMENT_MINUS_BINDING,
    TREATMENT_MINUS_TEST_RELATIONSHIP,
    TREATMENT_MINUS_CONFIG_GOVERNANCE,
    TREATMENT_MINUS_INSTRUCTION_GOVERNANCE,
  });

/**
 * The generic planner seam used by every mode.
 *
 * `base` is intentionally opaque and returned by reference. A production
 * adapter puts changed source and the pre-L syntactic planning inputs there.
 * Projection happens before candidate generation, so an ablation can never be
 * implemented by deleting already-selected context.
 */
export interface L5PlanningInput<
  TBase,
  TRepositoryIndex,
  TBinding,
  TTestRelationship,
  TConfigGovernance,
  TInstructionGovernance,
> {
  readonly base: TBase;
  readonly repositoryIndex: TRepositoryIndex;
  readonly binding: TBinding;
  readonly testRelationship: TTestRelationship;
  readonly configGovernance: TConfigGovernance;
  readonly instructionGovernance: TInstructionGovernance;
}

export interface L5ProjectedPlanningInput<
  TBase,
  TRepositoryIndex,
  TBinding,
  TTestRelationship,
  TConfigGovernance,
  TInstructionGovernance,
> {
  readonly base: TBase;
  readonly repositoryIndex: TRepositoryIndex | undefined;
  readonly binding: TBinding | undefined;
  readonly testRelationship: TTestRelationship | undefined;
  readonly configGovernance: TConfigGovernance | undefined;
  readonly instructionGovernance: TInstructionGovernance | undefined;
}

export function projectPlanningInputForMode<
  TBase,
  TRepositoryIndex,
  TBinding,
  TTestRelationship,
  TConfigGovernance,
  TInstructionGovernance,
>(
  mode: L5ModeDefinition,
  input: L5PlanningInput<
    TBase,
    TRepositoryIndex,
    TBinding,
    TTestRelationship,
    TConfigGovernance,
    TInstructionGovernance
  >,
): L5ProjectedPlanningInput<
  TBase,
  TRepositoryIndex,
  TBinding,
  TTestRelationship,
  TConfigGovernance,
  TInstructionGovernance
> {
  return {
    base: input.base,
    repositoryIndex: mode.families.structural_index
      ? input.repositoryIndex
      : undefined,
    binding: mode.families.binding ? input.binding : undefined,
    testRelationship: mode.families.test_relationship
      ? input.testRelationship
      : undefined,
    configGovernance: mode.families.config_governance
      ? input.configGovernance
      : undefined,
    instructionGovernance: mode.families.instruction_governance
      ? input.instructionGovernance
      : undefined,
  };
}

export interface L5RepositoryManifestEntry {
  readonly path: string;
  readonly content: string;
}

export interface L5ChangedSourceIdentity extends L5RepositoryManifestEntry {
  readonly changedLines: readonly number[];
}

export interface L5AnalyzerIdentity {
  readonly id: string;
  readonly procedureVersion: string;
}

/** The exact mode-independent identity pre-registered by the L.5 contract. */
export interface L5EquivalenceInput {
  readonly experimentSchemaVersion: string;
  readonly caseId: string;
  readonly corpusVersion: string;
  readonly plannerSchemaVersion: string;
  readonly experimentHarnessSchemaVersion: string;
  readonly syntheticRevision: string;
  readonly repositoryManifest: readonly L5RepositoryManifestEntry[];
  readonly changedSource: readonly L5ChangedSourceIdentity[];
  readonly goldFindingLabels: readonly unknown[];
  readonly requiredContextLabels: readonly unknown[];
  readonly forbiddenContextLabels: readonly unknown[];
  readonly analyzers: readonly L5AnalyzerIdentity[];
  readonly verifierPolicyVersion: string;
  readonly publicationPolicy: unknown;
  readonly premergePolicy: unknown;
  readonly contextTokenBudget: number;
  readonly executionLimits: unknown;
  readonly modelIdentity: string | null;
  readonly providerIdentity: string | null;
  readonly initialAnalysisCacheState: unknown;
  readonly previousIndexIdentityAndAvailability: unknown;
  readonly instructionTraversalObservation: unknown;
  readonly instructionArtifactReadObservations: readonly unknown[];
}

export interface L5CanonicalIdentity {
  readonly algorithm: "sha256";
  readonly hash: string;
  /** Retained for a field-level audit without putting mode into equivalence. */
  readonly canonical: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCanonical(left: unknown, right: unknown): number {
  const leftCanonical = canonicalJson(left);
  const rightCanonical = canonicalJson(right);
  return leftCanonical < rightCanonical
    ? -1
    : leftCanonical > rightCanonical
      ? 1
      : 0;
}

function sortedUniqueBy<T>(
  values: readonly T[],
  identity: (value: T) => string,
  label: string,
): readonly T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (seen.has(key)) {
      throw new Error(
        `L.5 equivalence identity has duplicate ${label}: ${key}`,
      );
    }
    seen.add(key);
  }
  return [...values].sort((left, right) =>
    identity(left) < identity(right)
      ? -1
      : identity(left) > identity(right)
        ? 1
        : 0,
  );
}

export function equivalenceIdentity(
  input: L5EquivalenceInput,
): L5CanonicalIdentity {
  const repositoryManifest = sortedUniqueBy(
    input.repositoryManifest,
    (entry) => entry.path,
    "repository path",
  );
  const changedSource = sortedUniqueBy(
    input.changedSource,
    (entry) => entry.path,
    "changed path",
  ).map((entry) => ({
    ...entry,
    changedLines: [...entry.changedLines].sort((left, right) => left - right),
  }));
  const analyzers = sortedUniqueBy(
    input.analyzers,
    (analyzer) => `${analyzer.id}\u0000${analyzer.procedureVersion}`,
    "analyzer procedure",
  );

  const canonical = canonicalJson({
    experimentSchemaVersion: input.experimentSchemaVersion,
    caseId: input.caseId,
    corpusVersion: input.corpusVersion,
    plannerSchemaVersion: input.plannerSchemaVersion,
    experimentHarnessSchemaVersion: input.experimentHarnessSchemaVersion,
    syntheticRevision: input.syntheticRevision,
    repositoryManifest,
    changedSource,
    goldFindingLabels: [...input.goldFindingLabels].sort(compareCanonical),
    requiredContextLabels: [...input.requiredContextLabels].sort(
      compareCanonical,
    ),
    forbiddenContextLabels: [...input.forbiddenContextLabels].sort(
      compareCanonical,
    ),
    analyzers,
    verifierPolicyVersion: input.verifierPolicyVersion,
    publicationPolicy: input.publicationPolicy,
    premergePolicy: input.premergePolicy,
    contextTokenBudget: input.contextTokenBudget,
    executionLimits: input.executionLimits,
    modelIdentity: input.modelIdentity,
    providerIdentity: input.providerIdentity,
    initialAnalysisCacheState: input.initialAnalysisCacheState,
    previousIndexIdentityAndAvailability:
      input.previousIndexIdentityAndAvailability,
    instructionTraversalObservation: input.instructionTraversalObservation,
    instructionArtifactReadObservations: [
      ...input.instructionArtifactReadObservations,
    ].sort(compareCanonical),
  });

  return { algorithm: "sha256", hash: sha256(canonical), canonical };
}

export type L5FactFamilyOfferManifest = Readonly<
  Record<L5FactFamily, readonly string[]>
>;

function canonicalFactFamilyOfferManifest(
  manifest: L5FactFamilyOfferManifest,
): Readonly<Record<L5FactFamily, readonly string[]>> {
  return {
    structural_index: [...manifest.structural_index].sort(),
    binding: [...manifest.binding].sort(),
    test_relationship: [...manifest.test_relationship].sort(),
    config_governance: [...manifest.config_governance].sort(),
    instruction_governance: [...manifest.instruction_governance].sort(),
  };
}

function modeDefinitionCanonical(mode: L5ModeDefinition): string {
  return canonicalJson({
    schema: "acalys.p1-l5.mode.v1",
    id: mode.id,
    families: mode.families,
  });
}

export function modeIdentity(
  mode: L5ModeDefinition,
  factFamilyOfferManifest: L5FactFamilyOfferManifest,
): L5CanonicalIdentity {
  const canonical = canonicalJson({
    mode: modeDefinitionCanonical(mode),
    factFamilyOfferManifest: canonicalFactFamilyOfferManifest(
      factFamilyOfferManifest,
    ),
  });
  return { algorithm: "sha256", hash: sha256(canonical), canonical };
}

export const L5_SUBSTANTIVE_HASH_KINDS = [
  "candidates",
  "verificationDecisions",
  "promotions",
  "publicationDecisions",
  "premergeDecisions",
] as const;

export type L5SubstantiveHashKind = (typeof L5_SUBSTANTIVE_HASH_KINDS)[number];

/** Agent F supplies the substantive projection and hash implementation. */
export type L5SubstantiveHashes = Readonly<
  Record<L5SubstantiveHashKind, string>
>;

export interface L5Recorder {
  record(event: unknown): void;
}

export const L5_NULL_RECORDER: L5Recorder = Object.freeze({
  record: (_event: unknown) => undefined,
});

export type L5RecorderKind = "null" | "real";

export const L5_PLANNER_ATTESTATION_STAGES = [
  "offered",
  "scored",
  "selected",
] as const;

export type L5PlannerAttestationStage =
  (typeof L5_PLANNER_ATTESTATION_STAGES)[number];

type L5FamilyCounts = Readonly<Record<L5FactFamily, number>>;

/**
 * Evidence that a mode was applied at the factual input boundary.
 *
 * Direct-source identities describe candidates before factual candidates
 * compete with them. They are a multiset: duplicate identities remain
 * observable and are compared pairwise after sorting.
 */
export interface L5ModeAttestation {
  readonly ablationAppliedAt: "fact_input";
  readonly factInputAvailability: Readonly<Record<L5FactFamily, boolean>>;
  /** Producer output before any mode gate; common across all modes. */
  readonly fullTreatmentFactFamilyOfferManifest: L5FactFamilyOfferManifest;
  /** Facts actually admitted to this mode's planner input. */
  readonly factFamilyOfferManifest: L5FactFamilyOfferManifest;
  readonly provenanceCounts: Readonly<
    Record<L5PlannerAttestationStage, L5FamilyCounts>
  >;
  readonly directSourceCandidateIdentitiesBeforeCompetition: readonly string[];
}

export interface L5ExecutionUnit<TCase> {
  readonly case: TCase;
  readonly equivalence: L5EquivalenceInput;
  readonly mode: L5ModeDefinition;
}

export interface L5ExecutionRequest<TCase> extends L5ExecutionUnit<TCase> {
  readonly recorderKind: L5RecorderKind;
  readonly recorder: L5Recorder;
  /** Fresh and empty for every null/real execution. */
  readonly analysisCache: Map<string, unknown>;
}

export interface L5PairScoreInput<TCase, TOutput> {
  readonly control: {
    readonly unit: L5ExecutionUnit<TCase>;
    readonly output: TOutput;
  };
  readonly treatment: {
    readonly unit: L5ExecutionUnit<TCase>;
    readonly output: TOutput;
  };
}

export interface L5PairRunOptions<TCase, TOutput, TScore> {
  readonly control: L5ExecutionUnit<TCase>;
  readonly treatment: L5ExecutionUnit<TCase>;
  readonly execute: (request: L5ExecutionRequest<TCase>) => Promise<TOutput>;
  readonly substantiveHashes: (output: TOutput) => L5SubstantiveHashes;
  readonly modeAttestation: (output: TOutput) => L5ModeAttestation;
  readonly createRealRecorder: () => L5Recorder;
  readonly createNullRecorder?: (() => L5Recorder) | undefined;
  readonly score: (input: L5PairScoreInput<TCase, TOutput>) => TScore;
}

export interface L5PairRunResult<
  TCase,
  TOutput,
  TScore,
> extends L5PairScoreInput<TCase, TOutput> {
  readonly equivalenceIdentity: L5CanonicalIdentity;
  readonly controlModeIdentity: L5CanonicalIdentity;
  readonly treatmentModeIdentity: L5CanonicalIdentity;
  readonly substantiveHashes: {
    readonly control: L5SubstantiveHashes;
    readonly treatment: L5SubstantiveHashes;
  };
  readonly modeAttestations: {
    readonly control: L5ModeAttestation;
    readonly treatment: L5ModeAttestation;
  };
  readonly score: TScore;
}

export class L5InvalidPairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "L5InvalidPairError";
  }
}

export class L5RecorderInterferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "L5RecorderInterferenceError";
  }
}

export class L5ModeAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "L5ModeAttestationError";
  }
}

function assertKnownMode(mode: L5ModeDefinition): void {
  const expected = L5_MODES[mode.id];
  if (modeDefinitionCanonical(mode) !== modeDefinitionCanonical(expected)) {
    throw new L5InvalidPairError(`Unknown or modified L.5 mode: ${mode.id}`);
  }
}

function assertPairModes(
  control: L5ModeDefinition,
  treatment: L5ModeDefinition,
): void {
  assertKnownMode(control);
  assertKnownMode(treatment);
  if (control.id !== "CONTROL") {
    throw new L5InvalidPairError("The control side must use CONTROL mode");
  }
  if (treatment.id === "CONTROL") {
    throw new L5InvalidPairError(
      "The treatment side must use TREATMENT or a single-family ablation",
    );
  }

  if (modeDefinitionCanonical(control) === modeDefinitionCanonical(treatment)) {
    throw new L5InvalidPairError(
      "Control and treatment mode identities must differ",
    );
  }
}

function differingSubstantiveHashes(
  left: L5SubstantiveHashes,
  right: L5SubstantiveHashes,
): readonly L5SubstantiveHashKind[] {
  return L5_SUBSTANTIVE_HASH_KINDS.filter((kind) => left[kind] !== right[kind]);
}

export function recorderOrderForCase(
  caseId: string,
): readonly [L5RecorderKind, L5RecorderKind] {
  const firstByte = Number.parseInt(sha256(caseId).slice(0, 2), 16);
  return firstByte % 2 === 0 ? ["null", "real"] : ["real", "null"];
}

function assertModeAttestation(
  mode: L5ModeDefinition,
  attestation: L5ModeAttestation,
): void {
  if (attestation.ablationAppliedAt !== "fact_input") {
    throw new L5ModeAttestationError(
      `${mode.id} was not ablated at the fact-input seam`,
    );
  }

  for (const family of L5_FACT_FAMILIES) {
    if (attestation.factInputAvailability[family] !== mode.families[family]) {
      throw new L5ModeAttestationError(
        `${mode.id} fact-input availability disagrees for ${family}`,
      );
    }
    if (
      !mode.families[family] &&
      attestation.factFamilyOfferManifest[family].length !== 0
    ) {
      throw new L5ModeAttestationError(
        `${mode.id} offered facts from disabled family ${family}`,
      );
    }
    if (
      mode.families[family] &&
      canonicalJson([...attestation.factFamilyOfferManifest[family]].sort()) !==
        canonicalJson(
          [...attestation.fullTreatmentFactFamilyOfferManifest[family]].sort(),
        )
    ) {
      throw new L5ModeAttestationError(
        `${mode.id} changed enabled family ${family} instead of offering the full-treatment facts`,
      );
    }
    for (const stage of L5_PLANNER_ATTESTATION_STAGES) {
      const count = attestation.provenanceCounts[stage][family];
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new L5ModeAttestationError(
          `${mode.id} has an invalid ${stage} provenance count for ${family}`,
        );
      }
      if (!mode.families[family] && count !== 0) {
        throw new L5ModeAttestationError(
          `${mode.id} carried disabled ${family} provenance at ${stage}`,
        );
      }
    }
  }

  const absentFamilies = L5_FACT_FAMILIES.filter(
    (family) => !attestation.factInputAvailability[family],
  );
  const expectedAbsent =
    mode.id === "CONTROL"
      ? L5_FACT_FAMILIES.length
      : mode.id === "TREATMENT"
        ? 0
        : 1;
  if (absentFamilies.length !== expectedAbsent) {
    throw new L5ModeAttestationError(
      `${mode.id} must attest ${String(expectedAbsent)} absent fact families`,
    );
  }
}

function canonicalAttestation(attestation: L5ModeAttestation): string {
  return canonicalJson({
    ...attestation,
    factFamilyOfferManifest: canonicalFactFamilyOfferManifest(
      attestation.factFamilyOfferManifest,
    ),
    fullTreatmentFactFamilyOfferManifest: canonicalFactFamilyOfferManifest(
      attestation.fullTreatmentFactFamilyOfferManifest,
    ),
    directSourceCandidateIdentitiesBeforeCompetition: [
      ...attestation.directSourceCandidateIdentitiesBeforeCompetition,
    ].sort(),
  });
}

function assertDirectSourceEquivalence(
  control: L5ModeAttestation,
  treatment: L5ModeAttestation,
): void {
  if (
    canonicalJson(
      canonicalFactFamilyOfferManifest(
        control.fullTreatmentFactFamilyOfferManifest,
      ),
    ) !==
    canonicalJson(
      canonicalFactFamilyOfferManifest(
        treatment.fullTreatmentFactFamilyOfferManifest,
      ),
    )
  ) {
    throw new L5ModeAttestationError(
      "Control and treatment observed different pre-gate fact-family offers",
    );
  }
  const controlCandidates = [
    ...control.directSourceCandidateIdentitiesBeforeCompetition,
  ].sort();
  const treatmentCandidates = [
    ...treatment.directSourceCandidateIdentitiesBeforeCompetition,
  ].sort();
  if (canonicalJson(controlCandidates) !== canonicalJson(treatmentCandidates)) {
    throw new L5ModeAttestationError(
      "Control and treatment direct-source candidate multisets differ before competition",
    );
  }
}

async function executeWithRecorderAudit<TCase, TOutput>(
  unit: L5ExecutionUnit<TCase>,
  options: Pick<
    L5PairRunOptions<TCase, TOutput, unknown>,
    | "execute"
    | "substantiveHashes"
    | "modeAttestation"
    | "createRealRecorder"
    | "createNullRecorder"
  >,
): Promise<{
  readonly output: TOutput;
  readonly hashes: L5SubstantiveHashes;
  readonly attestation: L5ModeAttestation;
}> {
  const executions = new Map<
    L5RecorderKind,
    {
      readonly output: TOutput;
      readonly hashes: L5SubstantiveHashes;
      readonly attestation: L5ModeAttestation;
    }
  >();
  for (const recorderKind of recorderOrderForCase(unit.equivalence.caseId)) {
    const output = await options.execute({
      ...unit,
      recorderKind,
      recorder:
        recorderKind === "null"
          ? (options.createNullRecorder?.() ?? L5_NULL_RECORDER)
          : options.createRealRecorder(),
      analysisCache: new Map<string, unknown>(),
    });
    const attestation = options.modeAttestation(output);
    assertModeAttestation(unit.mode, attestation);
    executions.set(recorderKind, {
      output,
      hashes: options.substantiveHashes(output),
      attestation,
    });
  }

  const nullExecution = executions.get("null");
  const realExecution = executions.get("real");
  if (nullExecution === undefined || realExecution === undefined) {
    throw new L5RecorderInterferenceError(
      `Recorder audit did not execute both orders for ${unit.mode.id}`,
    );
  }
  const differences = differingSubstantiveHashes(
    nullExecution.hashes,
    realExecution.hashes,
  );
  if (differences.length > 0) {
    throw new L5RecorderInterferenceError(
      `Recorder changed substantive output for ${unit.mode.id}: ${differences.join(
        ", ",
      )}`,
    );
  }
  if (
    canonicalAttestation(nullExecution.attestation) !==
    canonicalAttestation(realExecution.attestation)
  ) {
    throw new L5RecorderInterferenceError(
      `Recorder changed mode attestation for ${unit.mode.id}`,
    );
  }

  return {
    output: realExecution.output,
    hashes: realExecution.hashes,
    attestation: realExecution.attestation,
  };
}

/**
 * Runs one equivalent control/treatment pair and scores only valid executions.
 *
 * Identity checks happen before either executor is called. Recorder agreement
 * is then proved independently for each mode before the scoring callback can
 * observe an output.
 */
export async function runL5Pair<TCase, TOutput, TScore>(
  options: L5PairRunOptions<TCase, TOutput, TScore>,
): Promise<L5PairRunResult<TCase, TOutput, TScore>> {
  assertPairModes(options.control.mode, options.treatment.mode);
  const controlEquivalence = equivalenceIdentity(options.control.equivalence);
  const treatmentEquivalence = equivalenceIdentity(
    options.treatment.equivalence,
  );
  if (controlEquivalence.hash !== treatmentEquivalence.hash) {
    throw new L5InvalidPairError(
      "Control and treatment equivalence identities differ; pair is invalid",
    );
  }

  const controlExecution = await executeWithRecorderAudit(
    options.control,
    options,
  );
  const treatmentExecution = await executeWithRecorderAudit(
    options.treatment,
    options,
  );
  assertDirectSourceEquivalence(
    controlExecution.attestation,
    treatmentExecution.attestation,
  );
  const scoreInput: L5PairScoreInput<TCase, TOutput> = {
    control: { unit: options.control, output: controlExecution.output },
    treatment: {
      unit: options.treatment,
      output: treatmentExecution.output,
    },
  };
  const score = options.score(scoreInput);

  return {
    ...scoreInput,
    equivalenceIdentity: controlEquivalence,
    controlModeIdentity: modeIdentity(
      options.control.mode,
      controlExecution.attestation.factFamilyOfferManifest,
    ),
    treatmentModeIdentity: modeIdentity(
      options.treatment.mode,
      treatmentExecution.attestation.factFamilyOfferManifest,
    ),
    substantiveHashes: {
      control: controlExecution.hashes,
      treatment: treatmentExecution.hashes,
    },
    modeAttestations: {
      control: controlExecution.attestation,
      treatment: treatmentExecution.attestation,
    },
    score,
  };
}
