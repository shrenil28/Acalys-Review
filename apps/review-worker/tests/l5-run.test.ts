import { describe, expect, it, vi } from "vitest";

import {
  CONTROL,
  L5_FACT_FAMILIES,
  L5_MODE_IDS,
  L5_MODES,
  L5InvalidPairError,
  L5ModeAttestationError,
  L5RecorderInterferenceError,
  TREATMENT,
  equivalenceIdentity,
  modeIdentity,
  projectPlanningInputForMode,
  recorderOrderForCase,
  runL5Pair,
  type L5EquivalenceInput,
  type L5ExecutionRequest,
  type L5ModeAttestation,
  type L5ModeDefinition,
  type L5SubstantiveHashes,
} from "../src/eval/l5-run.js";

const MINIATURE_IDENTITY: L5EquivalenceInput = {
  experimentSchemaVersion: "l5-test-v1",
  caseId: "planted-await",
  corpusVersion: "miniature-v1",
  plannerSchemaVersion: "planner-v1",
  experimentHarnessSchemaVersion: "harness-v1",
  syntheticRevision: "revision-2",
  repositoryManifest: [
    { path: "src/caller.ts", content: "save();" },
    { path: "src/save.ts", content: "export async function save() {}" },
  ],
  changedSource: [
    { path: "src/caller.ts", content: "save();", changedLines: [1] },
  ],
  goldFindingLabels: [{ id: "missing-await", path: "src/caller.ts" }],
  requiredContextLabels: [{ id: "save-declaration" }],
  forbiddenContextLabels: [{ id: "unrelated-helper" }],
  analyzers: [{ id: "async-completion", procedureVersion: "1" }],
  verifierPolicyVersion: "verify-v1",
  publicationPolicy: { minimumSeverity: "warning" },
  premergePolicy: { blocking: false },
  contextTokenBudget: 500,
  executionLimits: { maxCandidates: 10 },
  modelIdentity: null,
  providerIdentity: null,
  initialAnalysisCacheState: { kind: "empty" },
  previousIndexIdentityAndAvailability: { kind: "absent" },
  instructionTraversalObservation: { status: "complete" },
  instructionArtifactReadObservations: [
    { path: "src/caller.ts", status: "read" },
    { path: "src/save.ts", status: "read" },
  ],
};

function identityWith(
  overrides: Partial<L5EquivalenceInput>,
): L5EquivalenceInput {
  return { ...MINIATURE_IDENTITY, ...overrides };
}

function fakeHashes(seed: string): L5SubstantiveHashes {
  return {
    candidates: `${seed}:candidates`,
    verificationDecisions: `${seed}:verification`,
    promotions: `${seed}:promotions`,
    publicationDecisions: `${seed}:publication`,
    premergeDecisions: `${seed}:premerge`,
  };
}

function attestationFor(
  mode: L5ModeDefinition,
  directSourceCandidateIdentitiesBeforeCompetition: readonly string[] = [
    "changed_hunk:src/caller.ts:1",
    "containing_symbol:src/caller.ts:run",
  ],
): L5ModeAttestation {
  const counts = Object.fromEntries(
    L5_FACT_FAMILIES.map((family) => [family, mode.families[family] ? 1 : 0]),
  ) as Record<(typeof L5_FACT_FAMILIES)[number], number>;
  const fullTreatmentFactFamilyOfferManifest = {
    structural_index: ["structural_index:miniature-fact"],
    binding: ["binding:miniature-fact"],
    test_relationship: ["test_relationship:miniature-fact"],
    config_governance: ["config_governance:miniature-fact"],
    instruction_governance: ["instruction_governance:miniature-fact"],
  };
  return {
    ablationAppliedAt: "fact_input",
    factInputAvailability: { ...mode.families },
    fullTreatmentFactFamilyOfferManifest,
    factFamilyOfferManifest: {
      structural_index: mode.families.structural_index
        ? fullTreatmentFactFamilyOfferManifest.structural_index
        : [],
      binding: mode.families.binding
        ? fullTreatmentFactFamilyOfferManifest.binding
        : [],
      test_relationship: mode.families.test_relationship
        ? fullTreatmentFactFamilyOfferManifest.test_relationship
        : [],
      config_governance: mode.families.config_governance
        ? fullTreatmentFactFamilyOfferManifest.config_governance
        : [],
      instruction_governance: mode.families.instruction_governance
        ? fullTreatmentFactFamilyOfferManifest.instruction_governance
        : [],
    },
    provenanceCounts: {
      offered: { ...counts },
      scored: { ...counts },
      selected: { ...counts },
    },
    directSourceCandidateIdentitiesBeforeCompetition,
  };
}

describe("L.5 mode definitions", () => {
  it("defines exactly control, treatment, and five single-family ablations", () => {
    expect(Object.keys(L5_MODES).sort()).toEqual([...L5_MODE_IDS].sort());
    expect(CONTROL.families).toEqual({
      structural_index: false,
      binding: false,
      test_relationship: false,
      config_governance: false,
      instruction_governance: false,
    });
    expect(Object.values(TREATMENT.families)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);

    for (const family of L5_FACT_FAMILIES) {
      const id =
        `TREATMENT_MINUS_${family.toUpperCase()}` as keyof typeof L5_MODES;
      const mode = L5_MODES[id];
      expect(mode.families[family]).toBe(false);
      expect(
        L5_FACT_FAMILIES.filter((candidate) => candidate !== family).every(
          (candidate) => mode.families[candidate],
        ),
      ).toBe(true);
    }
  });

  it("preserves changed source and syntactic planning while control nulls intelligence", () => {
    const base = {
      changedSource: [{ path: "src/caller.ts", content: "save();" }],
      syntacticPlanning: [
        { reason: "containing_symbol", path: "src/caller.ts" },
      ],
    };
    const input = {
      base,
      repositoryIndex: { declaration: "save" },
      binding: { caller: "run" },
      testRelationship: { test: "save.test.ts" },
      configGovernance: { project: "tsconfig.json" },
      instructionGovernance: { artifact: "AGENTS.md" },
    };

    const projected = projectPlanningInputForMode(CONTROL, input);
    expect(projected.base).toBe(base);
    expect(projected.base.changedSource).toBe(base.changedSource);
    expect(projected.base.syntacticPlanning).toBe(base.syntacticPlanning);
    expect(projected).toEqual({
      base,
      repositoryIndex: undefined,
      binding: undefined,
      testRelationship: undefined,
      configGovernance: undefined,
      instructionGovernance: undefined,
    });
  });

  it("removes only the named family from each ablation", () => {
    const input = {
      base: { changedSource: "planted source", syntacticPlanning: "symbol" },
      repositoryIndex: "index",
      binding: "binding",
      testRelationship: "test_relationship",
      configGovernance: "config_governance",
      instructionGovernance: "instruction_governance",
    };

    for (const family of L5_FACT_FAMILIES) {
      const mode =
        L5_MODES[
          `TREATMENT_MINUS_${family.toUpperCase()}` as keyof typeof L5_MODES
        ];
      const projected = projectPlanningInputForMode(mode, input);
      expect(projected.base).toBe(input.base);
      expect(projected.repositoryIndex).toBe(
        family === "structural_index" ? undefined : input.repositoryIndex,
      );
      expect(projected.binding).toBe(
        family === "binding" ? undefined : input.binding,
      );
      expect(projected.testRelationship).toBe(
        family === "test_relationship" ? undefined : input.testRelationship,
      );
      expect(projected.configGovernance).toBe(
        family === "config_governance" ? undefined : input.configGovernance,
      );
      expect(projected.instructionGovernance).toBe(
        family === "instruction_governance"
          ? undefined
          : input.instructionGovernance,
      );
    }
  });
});

describe("L.5 equivalence identity", () => {
  it("is canonical across ordering that carries no experiment meaning", () => {
    const reordered = identityWith({
      repositoryManifest: [...MINIATURE_IDENTITY.repositoryManifest].reverse(),
      changedSource: [
        {
          path: "src/caller.ts",
          content: "save();",
          changedLines: [3, 1, 2],
        },
      ],
      goldFindingLabels: [{ path: "src/caller.ts", id: "missing-await" }],
    });
    const ordered = identityWith({
      changedSource: [
        {
          path: "src/caller.ts",
          content: "save();",
          changedLines: [1, 2, 3],
        },
      ],
    });

    expect(equivalenceIdentity(reordered)).toEqual(
      equivalenceIdentity(ordered),
    );
  });

  it("changes for source, policy, and budget changes but never includes mode", () => {
    const base = equivalenceIdentity(MINIATURE_IDENTITY);
    expect(
      equivalenceIdentity(
        identityWith({
          changedSource: [
            {
              path: "src/caller.ts",
              content: "await save();",
              changedLines: [1],
            },
          ],
        }),
      ).hash,
    ).not.toBe(base.hash);
    expect(
      equivalenceIdentity(
        identityWith({ publicationPolicy: { minimumSeverity: "error" } }),
      ).hash,
    ).not.toBe(base.hash);
    expect(
      equivalenceIdentity(identityWith({ contextTokenBudget: 501 })).hash,
    ).not.toBe(base.hash);

    const controlAttestation = attestationFor(CONTROL);
    const treatmentAttestation = attestationFor(TREATMENT);
    expect(
      modeIdentity(CONTROL, controlAttestation.factFamilyOfferManifest).hash,
    ).not.toBe(
      modeIdentity(TREATMENT, treatmentAttestation.factFamilyOfferManifest)
        .hash,
    );
    expect(base.canonical).not.toContain("CONTROL");
    expect(base.canonical).not.toContain("TREATMENT");
  });

  it("hashes actual planner-input offers into mode identity, not equivalence", () => {
    const attestation = attestationFor(TREATMENT);
    const changedOffers = {
      ...attestation.factFamilyOfferManifest,
      binding: ["binding:different-fact"],
    };

    expect(modeIdentity(TREATMENT, changedOffers).hash).not.toBe(
      modeIdentity(TREATMENT, attestation.factFamilyOfferManifest).hash,
    );
    expect(equivalenceIdentity(MINIATURE_IDENTITY)).toEqual(
      equivalenceIdentity(MINIATURE_IDENTITY),
    );
  });

  it.each([
    ["planner version", { plannerSchemaVersion: "planner-v2" }],
    ["harness version", { experimentHarnessSchemaVersion: "harness-v2" }],
    ["execution limits", { executionLimits: { maxCandidates: 11 } }],
    ["model identity", { modelIdentity: "model-mini" }],
    ["provider identity", { providerIdentity: "provider-mini" }],
    ["cache initial state", { initialAnalysisCacheState: { kind: "warm" } }],
    [
      "previous-index state",
      { previousIndexIdentityAndAvailability: { kind: "built" } },
    ],
    [
      "traversal observation",
      { instructionTraversalObservation: { status: "partial" } },
    ],
    [
      "read observations",
      {
        instructionArtifactReadObservations: [
          { path: "src/caller.ts", status: "unreadable" },
        ],
      },
    ],
  ] satisfies readonly (readonly [string, Partial<L5EquivalenceInput>])[])(
    "covers amended %s identity",
    (_label, override) => {
      expect(equivalenceIdentity(identityWith(override)).hash).not.toBe(
        equivalenceIdentity(MINIATURE_IDENTITY).hash,
      );
    },
  );
});

describe("L.5 pair execution", () => {
  it("deterministically counterbalances recorder order by case", () => {
    const observed = new Set(
      Array.from({ length: 64 }, (_value, index) =>
        recorderOrderForCase(`miniature-case-${String(index)}`).join(","),
      ),
    );

    expect(recorderOrderForCase("planted-await")).toEqual(
      recorderOrderForCase("planted-await"),
    );
    expect(observed).toEqual(new Set(["null,real", "real,null"]));
  });

  it("rejects an inequivalent pair before execution or scoring", async () => {
    const execute =
      vi.fn<
        (request: L5ExecutionRequest<string>) => Promise<L5SubstantiveHashes>
      >();
    const score = vi.fn();

    await expect(
      runL5Pair({
        control: {
          case: "control miniature",
          equivalence: MINIATURE_IDENTITY,
          mode: CONTROL,
        },
        treatment: {
          case: "treatment miniature",
          equivalence: identityWith({ contextTokenBudget: 501 }),
          mode: TREATMENT,
        },
        execute,
        substantiveHashes: (output) => output,
        modeAttestation: () => attestationFor(CONTROL),
        createRealRecorder: () => ({ record: () => undefined }),
        score,
      }),
    ).rejects.toBeInstanceOf(L5InvalidPairError);
    expect(execute).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
  });

  it("runs null and real recorders for each side before scoring", async () => {
    const order: string[] = [];
    const recorded: unknown[] = [];
    const analysisCaches: Map<string, unknown>[] = [];
    const score = vi.fn(() => "miniature-scored");

    const result = await runL5Pair({
      control: {
        case: "control miniature",
        equivalence: MINIATURE_IDENTITY,
        mode: CONTROL,
      },
      treatment: {
        case: "treatment miniature",
        equivalence: MINIATURE_IDENTITY,
        mode: TREATMENT,
      },
      execute: (request) => {
        order.push(`${request.mode.id}:${request.recorderKind}`);
        expect(request.analysisCache.size).toBe(0);
        request.analysisCache.set("planted", request.mode.id);
        analysisCaches.push(request.analysisCache);
        request.recorder.record({ mode: request.mode.id });
        return Promise.resolve({
          mode: request.mode.id,
          hashes: fakeHashes(request.mode.id),
          attestation: attestationFor(request.mode),
        });
      },
      substantiveHashes: (output) => output.hashes,
      modeAttestation: (output) => output.attestation,
      createRealRecorder: () => ({
        record: (event) => recorded.push(event),
      }),
      score,
    });

    const recorderOrder = recorderOrderForCase(MINIATURE_IDENTITY.caseId);
    expect(order).toEqual([
      `CONTROL:${recorderOrder[0]}`,
      `CONTROL:${recorderOrder[1]}`,
      `TREATMENT:${recorderOrder[0]}`,
      `TREATMENT:${recorderOrder[1]}`,
    ]);
    expect(new Set(analysisCaches).size).toBe(4);
    expect(recorded).toEqual([{ mode: "CONTROL" }, { mode: "TREATMENT" }]);
    expect(score).toHaveBeenCalledOnce();
    expect(result.score).toBe("miniature-scored");
    expect(result.equivalenceIdentity).toEqual(
      equivalenceIdentity(MINIATURE_IDENTITY),
    );
    expect(result.controlModeIdentity.hash).not.toBe(
      result.treatmentModeIdentity.hash,
    );
  });

  it("invalidates recorder disagreement without scoring it", async () => {
    const score = vi.fn();

    await expect(
      runL5Pair({
        control: {
          case: "control miniature",
          equivalence: MINIATURE_IDENTITY,
          mode: CONTROL,
        },
        treatment: {
          case: "treatment miniature",
          equivalence: MINIATURE_IDENTITY,
          mode: TREATMENT,
        },
        execute: (request) =>
          Promise.resolve({
            hashes: {
              ...fakeHashes(request.mode.id),
              candidates:
                request.mode.id === "CONTROL" && request.recorderKind === "real"
                  ? "recorder-changed-candidates"
                  : `${request.mode.id}:candidates`,
            },
            attestation: attestationFor(request.mode),
          }),
        substantiveHashes: (output) => output.hashes,
        modeAttestation: (output) => output.attestation,
        createRealRecorder: () => ({ record: () => undefined }),
        score,
      }),
    ).rejects.toBeInstanceOf(L5RecorderInterferenceError);
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects L-family provenance in control before scoring", async () => {
    const score = vi.fn();

    await expect(
      runL5Pair({
        control: {
          case: "control miniature",
          equivalence: MINIATURE_IDENTITY,
          mode: CONTROL,
        },
        treatment: {
          case: "treatment miniature",
          equivalence: MINIATURE_IDENTITY,
          mode: TREATMENT,
        },
        execute: (request) => {
          const attestation = attestationFor(request.mode);
          return Promise.resolve({
            hashes: fakeHashes(request.mode.id),
            attestation:
              request.mode.id === "CONTROL"
                ? {
                    ...attestation,
                    provenanceCounts: {
                      ...attestation.provenanceCounts,
                      offered: {
                        ...attestation.provenanceCounts.offered,
                        structural_index: 1,
                      },
                    },
                  }
                : attestation,
          });
        },
        substantiveHashes: (output) => output.hashes,
        modeAttestation: (output) => output.attestation,
        createRealRecorder: () => ({ record: () => undefined }),
        score,
      }),
    ).rejects.toBeInstanceOf(L5ModeAttestationError);
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects unequal direct-source candidate multisets before scoring", async () => {
    const score = vi.fn();

    await expect(
      runL5Pair({
        control: {
          case: "control miniature",
          equivalence: MINIATURE_IDENTITY,
          mode: CONTROL,
        },
        treatment: {
          case: "treatment miniature",
          equivalence: MINIATURE_IDENTITY,
          mode: TREATMENT,
        },
        execute: (request) =>
          Promise.resolve({
            hashes: fakeHashes(request.mode.id),
            attestation: attestationFor(
              request.mode,
              request.mode.id === "CONTROL"
                ? ["changed_hunk:src/caller.ts:1"]
                : [
                    "changed_hunk:src/caller.ts:1",
                    "containing_symbol:src/caller.ts:run",
                  ],
            ),
          }),
        substantiveHashes: (output) => output.hashes,
        modeAttestation: (output) => output.attestation,
        createRealRecorder: () => ({ record: () => undefined }),
        score,
      }),
    ).rejects.toBeInstanceOf(L5ModeAttestationError);
    expect(score).not.toHaveBeenCalled();
  });

  it("rejects an ablation attested after the fact-input seam", async () => {
    const score = vi.fn();
    const ablation = L5_MODES.TREATMENT_MINUS_BINDING;

    await expect(
      runL5Pair({
        control: {
          case: "control miniature",
          equivalence: MINIATURE_IDENTITY,
          mode: CONTROL,
        },
        treatment: {
          case: "binding ablation miniature",
          equivalence: MINIATURE_IDENTITY,
          mode: ablation,
        },
        execute: (request) => {
          const attestation = attestationFor(request.mode);
          return Promise.resolve({
            hashes: fakeHashes(request.mode.id),
            attestation:
              request.mode.id === ablation.id
                ? {
                    ...attestation,
                    ablationAppliedAt:
                      "post_selection" as L5ModeAttestation["ablationAppliedAt"],
                  }
                : attestation,
          });
        },
        substantiveHashes: (output) => output.hashes,
        modeAttestation: (output) => output.attestation,
        createRealRecorder: () => ({ record: () => undefined }),
        score,
      }),
    ).rejects.toBeInstanceOf(L5ModeAttestationError);
    expect(score).not.toHaveBeenCalled();
  });
});
