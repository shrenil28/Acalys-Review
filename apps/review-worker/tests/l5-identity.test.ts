import { describe, expect, it } from "vitest";

import { analyzerCacheKey } from "../src/analysis.js";
import {
  compareSubstantiveHashes,
  evaluateAnalyzerCacheIdentity,
  L5_CACHE_IDENTITY_CATEGORIES,
  substantiveOutcomeHashes,
  type L5AnalyzerCacheInput,
  type L5CacheIdentityPair,
  type L5SubstantiveOutcome,
} from "../src/eval/l5-identity.js";

const BASE_CACHE_INPUT: L5AnalyzerCacheInput = {
  repositoryId: "0192f8a1-0000-7000-8000-0000000000aa",
  headSha: "a".repeat(40),
  contextDigest: "c".repeat(64),
  modelIdentity: "provider/model@procedure",
};

function pair(
  pairId: string,
  category: L5CacheIdentityPair["gold"]["category"],
  expectation: L5CacheIdentityPair["gold"]["expectation"],
  after: L5AnalyzerCacheInput,
): L5CacheIdentityPair {
  return {
    pairId,
    gold: {
      category,
      expectation,
      rationale: `Authored semantic rationale for ${pairId}`,
    },
    before: BASE_CACHE_INPUT,
    after,
  };
}

describe("P1-L.5 analyzer-input identity", () => {
  const pairs: readonly L5CacheIdentityPair[] = [
    pair("unchanged-reused", "unchanged_input_reuse", "reuse_expected", {
      ...BASE_CACHE_INPUT,
    }),
    pair("unchanged-invalidated", "unchanged_input_reuse", "reuse_expected", {
      ...BASE_CACHE_INPUT,
      contextDigest: "d".repeat(64),
    }),
    pair(
      "config-invalidated",
      "config_only_invalidation",
      "invalidation_expected",
      { ...BASE_CACHE_INPUT, contextDigest: "e".repeat(64) },
    ),
    pair(
      "config-false-reuse",
      "config_only_invalidation",
      "invalidation_expected",
      { ...BASE_CACHE_INPUT },
    ),
    pair(
      "instruction-invalidated",
      "instruction_only_invalidation",
      "invalidation_expected",
      { ...BASE_CACHE_INPUT, contextDigest: "f".repeat(64) },
    ),
    pair(
      "selection-invalidated",
      "context_selection_invalidation",
      "invalidation_expected",
      { ...BASE_CACHE_INPUT, contextDigest: "0".repeat(64) },
    ),
  ];

  it("records all four confusion outcomes and exposes dangerous false reuse", () => {
    const report = evaluateAnalyzerCacheIdentity(pairs);

    expect(report.matrix).toEqual({
      reuse_expected: { key_reused: 1, key_changed: 1 },
      invalidation_expected: { key_reused: 1, key_changed: 3 },
    });
    expect(report.pairs.map((row) => row.outcome)).toEqual([
      "true_cache_reuse",
      "unnecessary_invalidation",
      "correct_invalidation",
      "dangerous_false_reuse",
      "correct_invalidation",
      "correct_invalidation",
    ]);
    expect(report.dangerousFalseReuse).toBe(1);
    expect(report.dangerousFalseReusePairIds).toEqual(["config-false-reuse"]);
  });

  it("preserves a separate row for every pre-registered category", () => {
    const report = evaluateAnalyzerCacheIdentity(pairs);

    expect(report.categories.map((row) => row.category)).toEqual(
      L5_CACHE_IDENTITY_CATEGORIES,
    );
    expect(report.categories).toEqual([
      {
        category: "unchanged_input_reuse",
        pairs: 2,
        trueCacheReuse: 1,
        unnecessaryInvalidation: 1,
        correctInvalidation: 0,
        dangerousFalseReuse: 0,
      },
      {
        category: "config_only_invalidation",
        pairs: 2,
        trueCacheReuse: 0,
        unnecessaryInvalidation: 0,
        correctInvalidation: 1,
        dangerousFalseReuse: 1,
      },
      {
        category: "instruction_only_invalidation",
        pairs: 1,
        trueCacheReuse: 0,
        unnecessaryInvalidation: 0,
        correctInvalidation: 1,
        dangerousFalseReuse: 0,
      },
      {
        category: "context_selection_invalidation",
        pairs: 1,
        trueCacheReuse: 0,
        unnecessaryInvalidation: 0,
        correctInvalidation: 1,
        dangerousFalseReuse: 0,
      },
    ]);
  });

  it("uses the exact production analyzerCacheKey result", () => {
    const [row] = evaluateAnalyzerCacheIdentity([pairs[2]!]).pairs;

    expect(row?.beforeKey).toBe(analyzerCacheKey(BASE_CACHE_INPUT));
    expect(row?.afterKey).toBe(analyzerCacheKey(pairs[2]!.after));
  });

  it("rejects absent, duplicate, or category-inconsistent authored gold", () => {
    const valid = pairs[0]!;
    expect(() =>
      evaluateAnalyzerCacheIdentity([
        { ...valid, gold: { ...valid.gold, rationale: " " } },
      ]),
    ).toThrow(/authored semantic rationale/);
    expect(() => evaluateAnalyzerCacheIdentity([valid, valid])).toThrow(
      /Duplicate.*pairId/,
    );
    expect(() =>
      evaluateAnalyzerCacheIdentity([
        {
          ...valid,
          gold: { ...valid.gold, expectation: "invalidation_expected" },
        },
      ]),
    ).toThrow(/expected reuse_expected/);
  });
});

const BASE_SUBSTANTIVE_OUTCOME: L5SubstantiveOutcome = {
  candidates: [
    {
      semanticIdentity: "case|rule|error_handling|correctness|src/a.ts|2|2|a",
      producerId: "acalys",
      producerVersion: "1",
      inputDigest: "input-a",
      ruleId: "acalys/swallowed-error",
      family: "error_handling",
      category: "correctness",
      claim: "the error is swallowed",
      explanation: "the catch returns success",
      proposedSeverity: "high",
      confidenceScore: 0.95,
      path: "src/a.ts",
      startLine: 2,
      endLine: 2,
      fingerprintValue: "fingerprint-a",
    },
    {
      semanticIdentity: "case|rule|api_contract|correctness|src/b.ts|4|4|b",
      producerId: "acalys",
      producerVersion: "1",
      inputDigest: "input-a",
      ruleId: "acalys/signature-compatibility",
      family: "api_contract",
      category: "correctness",
      claim: "a caller violates the contract",
      explanation: "the call has the old shape",
      proposedSeverity: "medium",
      confidenceScore: 0.8,
      path: "src/b.ts",
      startLine: 4,
      endLine: 4,
      fingerprintValue: "fingerprint-b",
    },
  ],
  verificationDecisions: [
    {
      candidateSemanticIdentity:
        "case|rule|error_handling|correctness|src/a.ts|2|2|a",
      status: "completed",
      decision: "verified",
      reasons: ["independent_context_confirms", "evidence_supports_claim"],
      confidence: 0.9,
      severity: "high",
    },
    {
      candidateSemanticIdentity:
        "case|rule|api_contract|correctness|src/b.ts|4|4|b",
      status: "completed",
      decision: "rejected",
      reasons: ["call_site_satisfies_contract"],
      confidence: 0.9,
      severity: "medium",
    },
  ],
  promotions: [
    {
      candidateSemanticIdentity:
        "case|rule|error_handling|correctness|src/a.ts|2|2|a",
      outcome: "promoted",
      fingerprintValue: "fingerprint-a",
      severity: "high",
      category: "correctness",
      path: "src/a.ts",
      startLine: 2,
      endLine: 2,
      title: "Swallowed error",
      explanation: "the catch returns success",
    },
    {
      candidateSemanticIdentity:
        "case|rule|api_contract|correctness|src/b.ts|4|4|b",
      outcome: "not_promoted",
      reason: "rejected",
    },
  ],
  publicationDecisions: [
    {
      findingFingerprint: "fingerprint-a",
      decision: "publish",
      reason: "actionable",
    },
  ],
  premergeDecisions: [
    {
      checkId: "acalys.premerge.correctness",
      name: "Correctness",
      status: "failed",
      explanation: "1 verified finding at or above high severity.",
      blocking: true,
    },
  ],
};

function reverseCollections(
  outcome: L5SubstantiveOutcome,
): L5SubstantiveOutcome {
  return {
    candidates: [...outcome.candidates].reverse(),
    verificationDecisions: [...outcome.verificationDecisions]
      .reverse()
      .map((decision) =>
        decision.status === "completed"
          ? { ...decision, reasons: [...decision.reasons].reverse() }
          : decision,
      ),
    promotions: [...outcome.promotions].reverse(),
    publicationDecisions: [...outcome.publicationDecisions].reverse(),
    premergeDecisions: [...outcome.premergeDecisions].reverse(),
  };
}

describe("P1-L.5 recorder substantive hashes", () => {
  it("is invariant to semantically irrelevant collection and reason order", () => {
    const first = substantiveOutcomeHashes(BASE_SUBSTANTIVE_OUTCOME);
    const reordered = substantiveOutcomeHashes(
      reverseCollections(BASE_SUBSTANTIVE_OUTCOME),
    );

    expect(reordered).toEqual(first);
    expect(compareSubstantiveHashes(first, reordered)).toEqual({
      identical: true,
      differingStages: [],
    });
  });

  it("produces one SHA-256 digest for each of the five stages", () => {
    const hashes = substantiveOutcomeHashes(BASE_SUBSTANTIVE_OUTCOME);

    expect(Object.keys(hashes)).toEqual([
      "candidates",
      "verificationDecisions",
      "promotions",
      "publicationDecisions",
      "premergeDecisions",
    ]);
    expect(
      Object.values(hashes).every((hash) => /^[0-9a-f]{64}$/.test(hash)),
    ).toBe(true);
    expect(new Set(Object.values(hashes))).toHaveLength(5);
  });

  it("is sensitive to a substantive change at each stage, and only that stage", () => {
    const baseline = substantiveOutcomeHashes(BASE_SUBSTANTIVE_OUTCOME);
    const variants: readonly [
      keyof L5SubstantiveOutcome,
      L5SubstantiveOutcome,
    ][] = [
      [
        "candidates",
        {
          ...BASE_SUBSTANTIVE_OUTCOME,
          candidates: BASE_SUBSTANTIVE_OUTCOME.candidates.map(
            (candidate, index) =>
              index === 0
                ? { ...candidate, claim: "the error escapes as success" }
                : candidate,
          ),
        },
      ],
      [
        "verificationDecisions",
        {
          ...BASE_SUBSTANTIVE_OUTCOME,
          verificationDecisions:
            BASE_SUBSTANTIVE_OUTCOME.verificationDecisions.map(
              (decision, index) =>
                index === 0 && decision.status === "completed"
                  ? { ...decision, confidence: 0.91 }
                  : decision,
            ),
        },
      ],
      [
        "promotions",
        {
          ...BASE_SUBSTANTIVE_OUTCOME,
          promotions: BASE_SUBSTANTIVE_OUTCOME.promotions.map(
            (promotion, index) =>
              index === 0 && promotion.outcome === "promoted"
                ? { ...promotion, severity: "critical" }
                : promotion,
          ),
        },
      ],
      [
        "publicationDecisions",
        {
          ...BASE_SUBSTANTIVE_OUTCOME,
          publicationDecisions: [
            {
              findingFingerprint: "fingerprint-a",
              decision: "withhold",
              reason: "comment_budget_exhausted",
            },
          ],
        },
      ],
      [
        "premergeDecisions",
        {
          ...BASE_SUBSTANTIVE_OUTCOME,
          premergeDecisions: BASE_SUBSTANTIVE_OUTCOME.premergeDecisions.map(
            (decision) => ({ ...decision, status: "passed" }),
          ),
        },
      ],
    ];

    for (const [stage, variant] of variants) {
      expect(
        compareSubstantiveHashes(baseline, substantiveOutcomeHashes(variant)),
      ).toEqual({ identical: false, differingStages: [stage] });
    }
  });
});
