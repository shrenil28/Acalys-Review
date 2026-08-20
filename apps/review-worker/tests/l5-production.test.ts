import { accountL5Context } from "../../../packages/code-intelligence/src/eval/l5-context.js";
import { describe, expect, it } from "vitest";

import { runRealAnalysis } from "../src/analysis.js";
import { L5_CORPUS, type L5CorpusCase } from "../src/eval/l5-corpus.js";
import { L5_CACHE_IDENTITY_CATEGORIES } from "../src/eval/l5-identity.js";
import {
  L5_FACT_FAMILIES,
  L5_MODES,
  equivalenceIdentity,
} from "../src/eval/l5-run.js";
import {
  L5_PRODUCTION_STAGE_CAPABILITY,
  adaptL5CacheIdentityPairs,
  adaptL5CorpusCase,
  contextAccountingInputForTrace,
  inspectL5RequiredExposurePremises,
  plannerAvailabilityForMode,
  runL5ProductionAnalysis,
} from "../src/eval/l5-production.js";

const OPTIONS = {
  repositoryId: "0192f8a1-0000-7000-8000-0000000000a5",
  tenantId: "tenant-l5-production",
  policies: {
    verifierPolicyVersion: "acalys.verifier/v1",
    publicationPolicy: { version: "acalys.publication/v1" },
    premergePolicy: { version: "acalys.premerge/v1" },
  },
} as const;

function caseById(id: string): L5CorpusCase {
  const found = L5_CORPUS.cases.find((corpusCase) => corpusCase.id === id);
  if (found === undefined) throw new Error(`Missing L.5 case: ${id}`);
  return found;
}

function withoutLabels(corpusCase: L5CorpusCase): L5CorpusCase {
  return {
    ...corpusCase,
    gold: {
      ...corpusCase.gold,
      requiredContext: [],
      forbiddenContext: [],
    },
  };
}

function allFamilyCase(): L5CorpusCase {
  const corpusCase = withoutLabels(
    caseById("interaction-binding-and-test-delivery"),
  );
  return {
    ...corpusCase,
    syntheticRevision: "l5/adapter/all-families/h1",
    files: {
      ...corpusCase.files,
      "AGENTS.md": "Reviews must preserve asynchronous completion contracts.",
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true },
        include: ["src/**/*.ts", "test/**/*.ts"],
      }),
    },
    contextSelection: {
      budgetTokens: 10_000,
      enabledFamilies: [...L5_FACT_FAMILIES],
    },
  };
}

function analysisSubstance(
  outcome: Awaited<ReturnType<typeof runRealAnalysis>>,
) {
  const { durationMs: _durationMs, ...report } = outcome.report;
  return {
    candidates: outcome.candidates,
    report,
    context: outcome.context,
    contextDigest: outcome.contextDigest,
    cacheKey: outcome.cacheKey,
    configFactsDigest: outcome.configFactsDigest,
    instructionFactsDigest: outcome.instructionFactsDigest,
  };
}

describe("P1-L.5 production measurement adapter", () => {
  it("adapts frozen source and every common equivalence field without mode", async () => {
    const corpusCase = caseById("binding-floating-reservation");
    const adapted = adaptL5CorpusCase(corpusCase, OPTIONS);
    const snapshot = await adapted.source.read({
      repositoryId: OPTIONS.repositoryId,
      headSha: adapted.headSha,
    });

    expect(Object.fromEntries(snapshot.repository)).toEqual(corpusCase.files);
    expect(snapshot.changed).toEqual(
      corpusCase.changeManifest.map((changed) => ({
        path: changed.path,
        content: changed.headContent,
        changedLines: changed.changedLines,
      })),
    );
    expect(adapted.equivalence.caseId).toBe(corpusCase.id);
    expect(adapted.equivalence.repositoryManifest).toHaveLength(
      Object.keys(corpusCase.files).length,
    );
    expect(adapted.equivalence.analyzers).toHaveLength(3);
    expect(adapted.equivalence.instructionTraversalObservation).toBeDefined();
    expect(adapted.equivalence.initialAnalysisCacheState).toEqual({
      kind: "empty",
    });
    expect(equivalenceIdentity(adapted.equivalence).canonical).not.toMatch(
      /TREATMENT|CONTROL/,
    );
  });

  it("maps every mode to the exact planner fact-input availability", () => {
    expect(plannerAvailabilityForMode(L5_MODES.CONTROL)).toEqual({
      structural_index: false,
      binding: false,
      test_relationship: false,
      config_governance: false,
      instruction_governance: false,
    });
    for (const family of L5_FACT_FAMILIES) {
      const mode =
        L5_MODES[
          `TREATMENT_MINUS_${family.toUpperCase()}` as keyof typeof L5_MODES
        ];
      const availability = plannerAvailabilityForMode(mode);
      expect(availability[family], family).toBe(false);
      expect(
        L5_FACT_FAMILIES.filter((candidate) => candidate !== family).every(
          (candidate) => availability[candidate],
        ),
        family,
      ).toBe(true);
    }
  });

  it("adapts every frozen corpus case and audits every required exposure before analysis", async () => {
    const adapted = L5_CORPUS.cases.map((corpusCase) =>
      adaptL5CorpusCase(corpusCase, OPTIONS),
    );
    expect(adapted.map((item) => item.equivalence.caseId)).toEqual(
      L5_CORPUS.cases.map((corpusCase) => corpusCase.id),
    );

    const issues = (
      await Promise.all(
        adapted.map((item) => inspectL5RequiredExposurePremises(item)),
      )
    ).flat();
    expect(issues, issues.join("\n")).toEqual([]);
  });

  it("attests control and all five single-family ablations at every stage", async () => {
    const adapted = adaptL5CorpusCase(allFamilyCase(), OPTIONS);
    const treatment = await runL5ProductionAnalysis(
      adapted,
      L5_MODES.TREATMENT,
    );

    for (const stage of ["offered", "scored", "selected"] as const) {
      for (const family of L5_FACT_FAMILIES) {
        expect(
          treatment.attestation.provenanceCounts[stage][family],
          `${stage}:${family}`,
        ).toBeGreaterThan(0);
      }
    }
    expect(
      new Set(
        Object.values(L5_MODES).map(
          () => equivalenceIdentity(adapted.equivalence).hash,
        ),
      ),
    ).toHaveLength(1);

    const control = await runL5ProductionAnalysis(adapted, L5_MODES.CONTROL);
    for (const stage of ["offered", "scored", "selected"] as const) {
      expect(
        Object.values(control.attestation.provenanceCounts[stage]),
      ).toEqual([0, 0, 0, 0, 0]);
    }

    for (const family of L5_FACT_FAMILIES) {
      const mode =
        L5_MODES[
          `TREATMENT_MINUS_${family.toUpperCase()}` as keyof typeof L5_MODES
        ];
      const ablated = await runL5ProductionAnalysis(adapted, mode);
      expect(ablated.attestation.factInputAvailability).toEqual({
        ...treatment.attestation.factInputAvailability,
        [family]: false,
      });
      for (const stage of ["offered", "scored", "selected"] as const) {
        expect(ablated.attestation.provenanceCounts[stage][family]).toBe(0);
        for (const retained of L5_FACT_FAMILIES) {
          if (retained === family) continue;
          expect(
            ablated.attestation.provenanceCounts[stage][retained],
            `${mode.id}:${stage}:${retained}`,
          ).toBe(treatment.attestation.provenanceCounts[stage][retained]);
        }
      }
      expect(ablated.traces.CONTROL.offered).toEqual(
        treatment.traces.CONTROL.offered,
      );
    }
  });

  it("preserves default runRealAnalysis substance under explicit full treatment", async () => {
    const adapted = adaptL5CorpusCase(
      withoutLabels(caseById("binding-floating-reservation")),
      OPTIONS,
    );
    const ordinary = await runRealAnalysis(adapted.analysisOptions);
    const measured = await runL5ProductionAnalysis(adapted, L5_MODES.TREATMENT);

    expect(analysisSubstance(measured.analysis)).toEqual(
      analysisSubstance(ordinary),
    );
    expect(
      accountL5Context(measured.contextAccountingInput).reconciliation,
    ).toEqual({
      scoredPartition: true,
      reasonRows: true,
      familyRows: true,
      selectedBytes: true,
    });
  });

  it("emits stable candidate ids and exact excerpt source-slice mappings", () => {
    const originalContent = "x".repeat(400);
    const offered = {
      kind: "source_file" as const,
      path: "src/large.ts",
      reason: "changed_hunk" as const,
      trust: "repository_source" as const,
      content: originalContent,
    };
    const trace = {
      offered: [offered],
      scored: [{ ...offered, score: 1, estimatedTokens: 100 }],
      context: {
        items: [
          {
            ...offered,
            score: 1,
            estimatedTokens: 100,
            representation: "excerpt" as const,
            ordinal: 0,
            suppliedContent: originalContent.slice(0, 200),
          },
        ],
        omissions: [],
        budget: { limit: 50, consumed: 50 },
      },
    };
    const corpusCase = withoutLabels(caseById("clean-shadowed-async-name"));
    const first = contextAccountingInputForTrace(corpusCase, trace);
    const second = contextAccountingInputForTrace(corpusCase, trace);

    expect(second).toEqual(first);
    expect(first.selected).toEqual([
      {
        candidateId: first.offered[0]?.candidateId,
        suppliedContent: originalContent.slice(0, 200),
        truncated: true,
        sourceSlices: [
          {
            originalStartByte: 0,
            suppliedStartByte: 0,
            byteLength: 200,
          },
        ],
      },
    ]);
    expect(accountL5Context(first).totals.truncated).toEqual({
      items: 1,
      originalEstimatedTokens: 100,
      suppliedEstimatedTokens: 50,
      droppedEstimatedTokens: 50,
    });
  });

  it("maps every frozen cache pair exhaustively into the exact key evaluator", () => {
    const observations = Object.fromEntries(
      L5_CORPUS.cacheIdentityPairs.map((pair, index) => [
        pair.id,
        {
          beforeContextDigest: `${String(index).padStart(2, "0")}${"a".repeat(62)}`,
          afterContextDigest: `${String(index).padStart(2, "0")}${"b".repeat(62)}`,
        },
      ]),
    );
    const adapted = adaptL5CacheIdentityPairs(
      L5_CORPUS,
      OPTIONS.repositoryId,
      observations,
    );

    expect(adapted.map((pair) => pair.pairId)).toEqual(
      L5_CORPUS.cacheIdentityPairs.map((pair) => pair.id),
    );
    expect(new Set(adapted.map((pair) => pair.gold.category))).toEqual(
      new Set(L5_CACHE_IDENTITY_CATEGORIES),
    );
    expect(adapted.map((pair) => pair.gold.expectation)).toEqual(
      L5_CORPUS.cacheIdentityPairs.map((pair) => pair.expectation),
    );
    expect(
      adapted.every(
        (pair) =>
          pair.before.repositoryId === OPTIONS.repositoryId &&
          pair.after.repositoryId === OPTIONS.repositoryId &&
          pair.before.headSha.length === 40 &&
          pair.after.headSha.length === 40,
      ),
    ).toBe(true);
    expect(() =>
      adaptL5CacheIdentityPairs(L5_CORPUS, OPTIONS.repositoryId, {}),
    ).toThrow(/not exhaustive/);
  });

  it("reports the honest published-stage composition boundary", () => {
    expect(L5_PRODUCTION_STAGE_CAPABILITY).toEqual({
      candidates: true,
      verificationDecisions: false,
      promotions: false,
      publicationDecisions: false,
      premergeDecisions: false,
      limitation: expect.stringContaining("no verifier"),
    });
  });
});
