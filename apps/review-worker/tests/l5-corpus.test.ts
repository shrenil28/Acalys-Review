import { describe, expect, it } from "vitest";

import {
  L5_CASE_CATEGORIES,
  L5_CONTEXT_FAMILIES,
  L5_CORPUS,
  L5_CORPUS_VERSION,
  L5_EXPERIMENT_SCHEMA_VERSION,
  L5_FAMILY_EXPOSURE_KINDS,
  L5_MINIMUM_COMPOSITION,
  validateL5Corpus,
  type L5Corpus,
} from "../src/eval/l5-corpus.js";

const replaceCase = (
  corpus: L5Corpus,
  id: string,
  replace: (corpusCase: L5Corpus["cases"][number]) => L5Corpus["cases"][number],
): L5Corpus => ({
  ...corpus,
  cases: corpus.cases.map((corpusCase) =>
    corpusCase.id === id ? replace(corpusCase) : corpusCase,
  ),
});

describe("the frozen P1-L.5 corpus premises", () => {
  it("uses canonical versions, is deeply frozen, and validates without execution", () => {
    expect(L5_CORPUS.experimentSchemaVersion).toBe(
      L5_EXPERIMENT_SCHEMA_VERSION,
    );
    expect(L5_CORPUS.corpusVersion).toBe(L5_CORPUS_VERSION);
    expect(validateL5Corpus(L5_CORPUS)).toEqual([]);

    expect(Object.isFrozen(L5_CORPUS)).toBe(true);
    expect(Object.isFrozen(L5_CORPUS.cases)).toBe(true);
    expect(Object.isFrozen(L5_CORPUS.cases[0]?.files)).toBe(true);
    expect(Object.isFrozen(L5_CORPUS.cacheIdentityPairs[0]?.to)).toBe(true);
  });

  it("counts distinct eligible cases for every required category", () => {
    for (const category of L5_CASE_CATEGORIES) {
      const ids = new Set(
        L5_CORPUS.cases
          .filter((corpusCase) => corpusCase.category === category)
          .map((corpusCase) => corpusCase.id),
      );
      expect(ids.size, category).toBeGreaterThanOrEqual(
        L5_MINIMUM_COMPOSITION[category],
      );
    }

    for (const corpusCase of L5_CORPUS.cases) {
      expect(
        corpusCase.eligibility.because.length,
        corpusCase.id,
      ).toBeGreaterThan(0);
      if (corpusCase.category === "clean_control") {
        expect(corpusCase.eligibility.witness, corpusCase.id).toBe(
          "authored_no_finding",
        );
      } else {
        expect(
          corpusCase.gold.expectedFindings.length,
          corpusCase.id,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("authors at least two distinct exact gold opportunities per family", () => {
    const goldIds = new Set<string>();
    const matcherKeys = new Set<string>();

    for (const family of L5_CONTEXT_FAMILIES) {
      const findings = L5_CORPUS.cases.flatMap((corpusCase) =>
        corpusCase.gold.expectedFindings.filter(
          (finding) => finding.family === family,
        ),
      );
      expect(
        new Set(findings.map((finding) => finding.goldId)).size,
        family,
      ).toBeGreaterThanOrEqual(L5_MINIMUM_COMPOSITION.goldFindingsPerFamily);

      for (const finding of findings) {
        const matcherKey = [
          finding.ruleId,
          finding.family,
          finding.path,
          finding.allowedAnchor.startLine,
          finding.allowedAnchor.endLine,
        ].join("|");
        expect(goldIds.has(finding.goldId), finding.goldId).toBe(false);
        expect(matcherKeys.has(matcherKey), matcherKey).toBe(false);
        expect(finding.because.length, finding.goldId).toBeGreaterThan(0);
        goldIds.add(finding.goldId);
        matcherKeys.add(matcherKey);
      }
    }
  });

  it("gives every positive family a selector-scoped ablation exposure", () => {
    const selectorKinds = new Set<string>();

    for (const corpusCase of L5_CORPUS.cases) {
      for (const label of [
        ...corpusCase.gold.requiredContext,
        ...corpusCase.gold.forbiddenContext,
      ]) {
        selectorKinds.add(label.selector.kind);
      }

      if (corpusCase.category === "clean_control") continue;
      for (const family of corpusCase.families) {
        expect(
          corpusCase.gold.requiredContext.some(
            (label) =>
              label.family === family &&
              label.requiredExposure?.disappearsUnderAblation === family &&
              label.requiredExposure.factKind ===
                L5_FAMILY_EXPOSURE_KINDS[family],
          ),
          `${corpusCase.id}:${family}`,
        ).toBe(true);
      }
    }

    expect(selectorKinds).toEqual(
      new Set(["whole_artifact", "line_range", "content"]),
    );
  });

  it("uses indexed declarations, never callers, for structural-index eligibility", () => {
    const structuralCases = L5_CORPUS.cases.filter(
      (corpusCase) => corpusCase.category === "structural_index_positive",
    );
    expect(structuralCases).toHaveLength(2);
    for (const corpusCase of structuralCases) {
      expect(
        corpusCase.gold.requiredContext.length,
        corpusCase.id,
      ).toBeGreaterThan(0);
      for (const label of corpusCase.gold.requiredContext) {
        expect(label.family, label.id).toBe("structural_index");
        expect(label.reason, label.id).toBe("declaration");
        expect(label.requiredExposure?.factKind, label.id).toBe(
          "indexed_declaration",
        );
      }
    }
  });

  it("contains all incremental and independently authored cache witnesses", () => {
    expect(L5_CORPUS.incrementalPairs).toHaveLength(
      L5_MINIMUM_COMPOSITION.incrementalPairs,
    );
    expect(L5_CORPUS.cacheIdentityPairs).toHaveLength(
      L5_MINIMUM_COMPOSITION.cacheIdentityPairs,
    );

    const cacheCounts = new Map<string, number>();
    for (const pair of L5_CORPUS.cacheIdentityPairs) {
      cacheCounts.set(pair.category, (cacheCounts.get(pair.category) ?? 0) + 1);
      expect(pair.expectationBecause.length, pair.id).toBeGreaterThan(0);
      expect(pair.expectationBecause, pair.id).not.toMatch(
        /produced (?:key|digest|output)/u,
      );
    }
    expect(cacheCounts).toEqual(
      new Map([
        ["unchanged_input", 2],
        ["config_only", 2],
        ["instruction_only", 2],
        ["context_selection_only", 2],
      ]),
    );

    const deletion = L5_CORPUS.cacheIdentityPairs.find(
      (pair) => pair.id === "cache-invalidate-instruction-deletion",
    );
    const base = L5_CORPUS.cases.find(
      (corpusCase) => corpusCase.id === deletion?.baseCaseId,
    );
    expect(base?.files["AGENTS.md"]).toBeDefined();
    expect(deletion?.to.files["AGENTS.md"]).toBeUndefined();
    expect(deletion?.to.changeManifest).toEqual(base?.changeManifest);

    const configStable = L5_CORPUS.cacheIdentityPairs.filter(
      (pair) => pair.category === "config_only",
    );
    const instructionStable = L5_CORPUS.cacheIdentityPairs.filter(
      (pair) => pair.category === "instruction_only",
    );
    for (const pair of [...configStable, ...instructionStable]) {
      const pairBase = L5_CORPUS.cases.find(
        (corpusCase) => corpusCase.id === pair.baseCaseId,
      );
      expect(pair.to.changeManifest, pair.id).toEqual(pairBase?.changeManifest);
    }
  });

  it("retains a known positive while instruction coverage is incomplete", () => {
    const outageCase = L5_CORPUS.cases.find(
      (corpusCase) => corpusCase.outageWitness !== undefined,
    );
    expect(outageCase?.coverage.status).toBe("incomplete");
    expect(
      outageCase?.gold.expectedFindings.some(
        (finding) =>
          finding.goldId === outageCase.outageWitness?.knownPositiveFindingId,
      ),
    ).toBe(true);
  });
});

describe("L.5 corpus validation failures", () => {
  it("detects duplicate ids and semantic opportunities", () => {
    const duplicateCase: L5Corpus = {
      ...L5_CORPUS,
      cases: [...L5_CORPUS.cases, L5_CORPUS.cases[0]!],
    };
    expect(validateL5Corpus(duplicateCase)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("duplicate id"),
        expect.stringContaining("duplicate semantic gold opportunity"),
      ]),
    );
  });

  it("detects missing referenced paths", () => {
    const target = L5_CORPUS.cases.find(
      (corpusCase) =>
        corpusCase.id === "structural-index-public-signature-declaration",
    )!;
    const missingPath = replaceCase(L5_CORPUS, target.id, (corpusCase) => ({
      ...corpusCase,
      gold: {
        ...corpusCase.gold,
        expectedFindings: corpusCase.gold.expectedFindings.map((finding) => ({
          ...finding,
          path: "src/missing.ts",
        })),
      },
    }));
    expect(validateL5Corpus(missingPath)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing path src/missing.ts"),
      ]),
    );
  });

  it("detects vacuous categories, absent exposure, and minimum-count failures", () => {
    const target = L5_CORPUS.cases.find(
      (corpusCase) => corpusCase.id === "binding-floating-reservation",
    )!;
    const vacuous = replaceCase(L5_CORPUS, target.id, (corpusCase) => ({
      ...corpusCase,
      gold: {
        ...corpusCase.gold,
        expectedFindings: [],
        requiredContext: [],
      },
    }));
    const issues = validateL5Corpus(vacuous);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("positive category is vacuous"),
        expect.stringContaining(
          "missing required exposure for binding ablation",
        ),
      ]),
    );

    const withoutBindingGold: L5Corpus = {
      ...L5_CORPUS,
      cases: L5_CORPUS.cases.map((corpusCase) => ({
        ...corpusCase,
        gold: {
          ...corpusCase.gold,
          expectedFindings: corpusCase.gold.expectedFindings.filter(
            (finding) => finding.family !== "binding",
          ),
        },
      })),
    };
    expect(validateL5Corpus(withoutBindingGold)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("binding requires 2 distinct gold findings"),
      ]),
    );

    const tooSmall: L5Corpus = {
      ...L5_CORPUS,
      cases: L5_CORPUS.cases.filter(
        (corpusCase) => corpusCase.id !== "clean-sibling-instruction-scope",
      ),
    };
    expect(validateL5Corpus(tooSmall)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("clean_control requires 4"),
      ]),
    );
  });
});
