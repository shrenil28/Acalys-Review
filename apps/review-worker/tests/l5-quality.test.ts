import { describe, expect, it } from "vitest";

import {
  L5_FACT_FAMILIES,
  attributeCausalOutcomes,
  candidateSemanticIdentityKey,
  comparePublishedQuality,
  matchFindings,
  scoreQuality,
  type CausalOutcomeObservation,
  type CausalOutcomeState,
  type GoldFinding,
  type L5FactFamily,
  type QualityCandidate,
} from "../src/eval/l5-quality.js";

const candidate = (
  overrides: Partial<QualityCandidate> = {},
): QualityCandidate => ({
  caseId: "case-a",
  ruleId: "acalys/rule-a",
  family: "data_flow",
  category: "correctness",
  path: "src/a.ts",
  startLine: 10,
  endLine: 10,
  analyzerIdentityHint: "defect-a",
  verificationDecision: "verified",
  promoted: true,
  published: true,
  ...overrides,
});

const gold = (overrides: Partial<GoldFinding> = {}): GoldFinding => ({
  goldId: "gold-a",
  caseId: "case-a",
  matcher: {
    ruleId: "acalys/rule-a",
    family: "data_flow",
    path: "src/a.ts",
    allowedAnchorLines: { startLine: 9, endLine: 11 },
  },
  ...overrides,
});

describe("L.5 exact one-to-one quality matching", () => {
  it("counts duplicate findings as false positives", () => {
    const duplicate = candidate();
    const result = matchFindings([gold()], [duplicate, duplicate]);

    expect(result.matches).toHaveLength(1);
    expect(result.unmatchedGoldIds).toEqual([]);
    expect(result.unmatchedFalsePositiveIdentities).toHaveLength(1);
    expect(
      candidateSemanticIdentityKey(result.unmatchedFalsePositiveIdentities[0]!),
    ).toBe(candidateSemanticIdentityKey(duplicate));
  });

  it("distinguishes two defects in the same correctness family", () => {
    const goldA = gold();
    const goldB = gold({
      goldId: "gold-b",
      matcher: {
        ...gold().matcher,
        allowedAnchorLines: { startLine: 19, endLine: 21 },
      },
    });
    const candidateB = candidate({
      startLine: 20,
      endLine: 20,
      analyzerIdentityHint: "defect-b",
    });

    const result = matchFindings([goldA, goldB], [candidateB, candidate()]);

    expect(result.matches.map((match) => match.goldId)).toEqual([
      "gold-a",
      "gold-b",
    ]);
    expect(result.unmatchedFalsePositiveIdentities).toEqual([]);
  });

  it("rejects candidates on the wrong path or outside the authored range", () => {
    const result = matchFindings(
      [gold()],
      [
        candidate({ ruleId: "acalys/wrong-rule" }),
        candidate({ family: "boundary" }),
        candidate({ path: "src/wrong.ts" }),
        candidate({ startLine: 8, endLine: 10 }),
        candidate({ startLine: 10, endLine: 12 }),
      ],
    );

    expect(result.matches).toEqual([]);
    expect(result.unmatchedGoldIds).toEqual(["gold-a"]);
    expect(result.unmatchedFalsePositiveIdentities).toHaveLength(5);
  });

  it("does not let one candidate satisfy two gold findings", () => {
    const result = matchFindings(
      [gold({ goldId: "gold-b" }), gold({ goldId: "gold-a" })],
      [candidate()],
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.goldId).toBe("gold-a");
    expect(result.unmatchedGoldIds).toEqual(["gold-b"]);
  });

  it("uses goldId then semantic identity for deterministic maximum ties", () => {
    const broadMatcher = {
      ...gold().matcher,
      allowedAnchorLines: { startLine: 9, endLine: 12 },
    };
    const goldFindings = [
      gold({ goldId: "gold-b", matcher: broadMatcher }),
      gold({ goldId: "gold-a", matcher: broadMatcher }),
    ];
    const laterIdentity = candidate({
      startLine: 11,
      endLine: 11,
      analyzerIdentityHint: "z",
    });
    const earlierIdentity = candidate({ analyzerIdentityHint: "a" });

    const forward = matchFindings(goldFindings, [
      laterIdentity,
      earlierIdentity,
    ]);
    const reversed = matchFindings([...goldFindings].reverse(), [
      earlierIdentity,
      laterIdentity,
    ]);

    expect(forward).toEqual(reversed);
    expect(forward.matches).toEqual([
      {
        goldId: "gold-a",
        candidateIdentity: expect.objectContaining({
          analyzerIdentityHint: "a",
        }),
      },
      {
        goldId: "gold-b",
        candidateIdentity: expect.objectContaining({
          analyzerIdentityHint: "z",
        }),
      },
    ]);
  });
});

describe("L.5 count-first quality metrics", () => {
  it("matches candidates and published outputs independently", () => {
    const withheldMatch = candidate({ promoted: true, published: false });
    const publishedDuplicate = candidate({ analyzerIdentityHint: "duplicate" });
    const score = scoreQuality({
      caseIds: ["case-a", "clean-case"],
      goldFindings: [gold()],
      candidates: [withheldMatch, publishedDuplicate],
    });

    expect(score.counts).toMatchObject({
      cases: 2,
      plantedFindings: 1,
      candidates: 2,
      candidateTruePositives: 1,
      candidateFalsePositives: 1,
      candidateFalseNegatives: 0,
      verified: 2,
      promoted: 2,
      published: 1,
      withheld: 1,
      publishedTruePositives: 1,
      publishedFalsePositives: 0,
      publishedFalseNegatives: 0,
    });
  });

  it("represents every zero-denominator ratio explicitly", () => {
    const score = scoreQuality({
      caseIds: ["clean-case"],
      goldFindings: [],
      candidates: [],
    });

    expect(score.counts.candidatePrecision).toEqual({
      kind: "undefinedRatio",
      numerator: 0,
      denominator: 0,
      because: "no candidates",
    });
    expect(score.counts.publishedPrecision.kind).toBe("undefinedRatio");
    expect(score.counts.publishedRecall.kind).toBe("undefinedRatio");
  });

  it("reports recovered gold and introduced false positives as multisets", () => {
    const falsePositive = candidate({
      ruleId: "acalys/unwanted",
      analyzerIdentityHint: "same-unwanted-output",
    });
    const control = scoreQuality({
      caseIds: ["case-a"],
      goldFindings: [gold()],
      candidates: [falsePositive],
    });
    const treatment = scoreQuality({
      caseIds: ["case-a"],
      goldFindings: [gold()],
      candidates: [candidate(), falsePositive, falsePositive],
    });

    const effects = comparePublishedQuality(control, treatment);
    expect(effects.truePositivesRecovered).toEqual(["gold-a"]);
    expect(effects.falsePositivesIntroduced).toHaveLength(1);
    expect(
      candidateSemanticIdentityKey(effects.falsePositivesIntroduced[0]!),
    ).toBe(candidateSemanticIdentityKey(falsePositive));
  });
});

const published: CausalOutcomeState = {
  candidatePresent: true,
  verificationDecision: "verified",
  promoted: true,
  published: true,
};

const absent: CausalOutcomeState = {
  candidatePresent: false,
  verificationDecision: undefined,
  promoted: false,
  published: false,
};

const observation = (
  state: CausalOutcomeState,
  exposedFamilies: readonly L5FactFamily[] = [],
): CausalOutcomeObservation => ({
  identity: { kind: "gold", goldId: "gold-a" },
  state,
  exposedFamilies,
});

describe("L.5 outcome-level causal attribution", () => {
  it.each(L5_FACT_FAMILIES)(
    "attributes the same gold outcome to %s when only its ablation matters",
    (family) => {
      const ablations = Object.fromEntries(
        L5_FACT_FAMILIES.map((name) => [
          name,
          { outcomes: [observation(name === family ? absent : published)] },
        ]),
      ) as Record<L5FactFamily, { outcomes: CausalOutcomeObservation[] }>;

      const [attribution] = attributeCausalOutcomes({
        control: { outcomes: [observation(absent)] },
        treatment: { outcomes: [observation(published, [family])] },
        ablations,
      });

      expect(attribution).toMatchObject({
        treatmentEffect: true,
        exposedFamilies: [family],
        matteredFamilies: [family],
        attribution: family,
      });
    },
  );

  it("uses multiple for redundant or interactive movement", () => {
    const unchangedAblations = Object.fromEntries(
      L5_FACT_FAMILIES.map((family) => [
        family,
        { outcomes: [observation(published)] },
      ]),
    ) as Record<L5FactFamily, { outcomes: CausalOutcomeObservation[] }>;

    const [attribution] = attributeCausalOutcomes({
      control: { outcomes: [observation(absent)] },
      treatment: {
        outcomes: [observation(published, ["binding", "structural_index"])],
      },
      ablations: unchangedAblations,
    });

    expect(attribution).toMatchObject({
      treatmentEffect: true,
      exposedFamilies: ["structural_index", "binding"],
      matteredFamilies: [],
      attribution: "multiple",
    });
  });

  it("compares duplicate false positives by semantic identity, not position", () => {
    const identity = candidate();
    const fp = (state: CausalOutcomeState): CausalOutcomeObservation => ({
      identity: {
        kind: "falsePositive",
        candidateIdentity: identity,
      },
      state,
      exposedFamilies: ["binding"],
    });
    const treatmentOutcomes = [fp(published), fp(absent)];
    const ablations = Object.fromEntries(
      L5_FACT_FAMILIES.map((family) => [
        family,
        {
          outcomes:
            family === "binding"
              ? [fp(absent)]
              : [...treatmentOutcomes].reverse(),
        },
      ]),
    ) as Record<L5FactFamily, { outcomes: CausalOutcomeObservation[] }>;

    const [attribution] = attributeCausalOutcomes({
      control: { outcomes: [] },
      treatment: { outcomes: treatmentOutcomes },
      ablations,
    });

    expect(attribution).toMatchObject({
      treatmentEffect: true,
      matteredFamilies: ["binding"],
      attribution: "binding",
    });
  });
});
