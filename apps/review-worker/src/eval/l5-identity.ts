/**
 * P1-L.5 analyzer-input identity and recorder non-interference measurements.
 *
 * Gold expectations enter this module as authored data. The evaluator computes
 * the production worker cache key only after that data exists; it never infers
 * an expectation from key equality or from analyzer output.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "@acalys/contracts/domain";
import type {
  FindingSeverity,
  PreMergeCheckStatus,
} from "@acalys/contracts/domain";
import type {
  ExecutionFailure,
  PublicationReason,
  VerificationDecision,
  VerificationReason,
} from "@acalys/review-engine";

import { analyzerCacheKey } from "../analysis.js";

export const L5_CACHE_IDENTITY_CATEGORIES = [
  "unchanged_input_reuse",
  "config_only_invalidation",
  "instruction_only_invalidation",
  "context_selection_invalidation",
] as const;

export type L5CacheIdentityCategory =
  (typeof L5_CACHE_IDENTITY_CATEGORIES)[number];

export const L5_CACHE_EXPECTATIONS = [
  "reuse_expected",
  "invalidation_expected",
] as const;

export type L5CacheExpectation = (typeof L5_CACHE_EXPECTATIONS)[number];

export type L5CacheKeyDisposition = "key_reused" | "key_changed";

export const L5_CACHE_OUTCOMES = [
  "true_cache_reuse",
  "unnecessary_invalidation",
  "correct_invalidation",
  "dangerous_false_reuse",
] as const;

export type L5CacheOutcome = (typeof L5_CACHE_OUTCOMES)[number];

/** The exact input accepted by the production `analyzerCacheKey` seam. */
export interface L5AnalyzerCacheInput {
  readonly repositoryId: string;
  readonly headSha: string;
  readonly contextDigest: string;
  readonly modelIdentity?: string | undefined;
}

export interface L5CachePairGold {
  readonly category: L5CacheIdentityCategory;
  readonly expectation: L5CacheExpectation;
  /** Authored semantic argument, committed before either key is computed. */
  readonly rationale: string;
}

export interface L5CacheIdentityPair {
  readonly pairId: string;
  readonly gold: L5CachePairGold;
  readonly before: L5AnalyzerCacheInput;
  readonly after: L5AnalyzerCacheInput;
}

export interface L5CacheIdentityOutcome {
  readonly pairId: string;
  readonly category: L5CacheIdentityCategory;
  readonly expectation: L5CacheExpectation;
  readonly rationale: string;
  readonly beforeKey: string;
  readonly afterKey: string;
  readonly disposition: L5CacheKeyDisposition;
  readonly outcome: L5CacheOutcome;
}

export interface L5CacheConfusionMatrix {
  readonly reuse_expected: Readonly<{
    key_reused: number;
    key_changed: number;
  }>;
  readonly invalidation_expected: Readonly<{
    key_reused: number;
    key_changed: number;
  }>;
}

export interface L5CacheCategoryRow {
  readonly category: L5CacheIdentityCategory;
  readonly pairs: number;
  readonly trueCacheReuse: number;
  readonly unnecessaryInvalidation: number;
  readonly correctInvalidation: number;
  readonly dangerousFalseReuse: number;
}

export interface L5CacheIdentityReport {
  readonly pairs: readonly L5CacheIdentityOutcome[];
  readonly matrix: L5CacheConfusionMatrix;
  readonly categories: readonly L5CacheCategoryRow[];
  /** Stop-condition count. This must be zero before L.5 can pass. */
  readonly dangerousFalseReuse: number;
  readonly dangerousFalseReusePairIds: readonly string[];
}

function expectedForCategory(
  category: L5CacheIdentityCategory,
): L5CacheExpectation {
  return category === "unchanged_input_reuse"
    ? "reuse_expected"
    : "invalidation_expected";
}

function assertAuthoredGold(pairs: readonly L5CacheIdentityPair[]): void {
  const ids = new Set<string>();

  for (const pair of pairs) {
    if (pair.pairId.trim() === "") {
      throw new Error("An L.5 cache pair must have a non-empty pairId");
    }
    if (ids.has(pair.pairId)) {
      throw new Error(`Duplicate L.5 cache pairId: ${pair.pairId}`);
    }
    ids.add(pair.pairId);

    if (pair.gold.rationale.trim() === "") {
      throw new Error(
        `L.5 cache pair ${pair.pairId} needs an authored semantic rationale`,
      );
    }

    const expected = expectedForCategory(pair.gold.category);
    if (pair.gold.expectation !== expected) {
      throw new Error(
        `L.5 cache pair ${pair.pairId} has ${pair.gold.category} but ` +
          `${pair.gold.expectation}; expected ${expected}`,
      );
    }
  }
}

function outcomeFor(
  expectation: L5CacheExpectation,
  disposition: L5CacheKeyDisposition,
): L5CacheOutcome {
  if (expectation === "reuse_expected") {
    return disposition === "key_reused"
      ? "true_cache_reuse"
      : "unnecessary_invalidation";
  }
  return disposition === "key_changed"
    ? "correct_invalidation"
    : "dangerous_false_reuse";
}

/** Evaluates authored gold against the exact worker-level production key. */
export function evaluateAnalyzerCacheIdentity(
  pairs: readonly L5CacheIdentityPair[],
): L5CacheIdentityReport {
  assertAuthoredGold(pairs);

  const outcomes = pairs.map((pair): L5CacheIdentityOutcome => {
    const beforeKey = analyzerCacheKey(pair.before);
    const afterKey = analyzerCacheKey(pair.after);
    const disposition: L5CacheKeyDisposition =
      beforeKey === afterKey ? "key_reused" : "key_changed";

    return {
      pairId: pair.pairId,
      category: pair.gold.category,
      expectation: pair.gold.expectation,
      rationale: pair.gold.rationale,
      beforeKey,
      afterKey,
      disposition,
      outcome: outcomeFor(pair.gold.expectation, disposition),
    };
  });

  const count = (
    expectation: L5CacheExpectation,
    disposition: L5CacheKeyDisposition,
  ): number =>
    outcomes.filter(
      (outcome) =>
        outcome.expectation === expectation &&
        outcome.disposition === disposition,
    ).length;

  const categories = L5_CACHE_IDENTITY_CATEGORIES.map(
    (category): L5CacheCategoryRow => {
      const rows = outcomes.filter((outcome) => outcome.category === category);
      const outcomeCount = (wanted: L5CacheOutcome): number =>
        rows.filter((row) => row.outcome === wanted).length;
      return {
        category,
        pairs: rows.length,
        trueCacheReuse: outcomeCount("true_cache_reuse"),
        unnecessaryInvalidation: outcomeCount("unnecessary_invalidation"),
        correctInvalidation: outcomeCount("correct_invalidation"),
        dangerousFalseReuse: outcomeCount("dangerous_false_reuse"),
      };
    },
  );

  const dangerousFalseReusePairIds = outcomes
    .filter((outcome) => outcome.outcome === "dangerous_false_reuse")
    .map((outcome) => outcome.pairId);

  return {
    pairs: outcomes,
    matrix: {
      reuse_expected: {
        key_reused: count("reuse_expected", "key_reused"),
        key_changed: count("reuse_expected", "key_changed"),
      },
      invalidation_expected: {
        key_reused: count("invalidation_expected", "key_reused"),
        key_changed: count("invalidation_expected", "key_changed"),
      },
    },
    categories,
    dangerousFalseReuse: dangerousFalseReusePairIds.length,
    dangerousFalseReusePairIds,
  };
}

export interface L5CandidateSubstance {
  readonly semanticIdentity: string;
  readonly producerId: string;
  readonly producerVersion: string;
  readonly inputDigest: string;
  readonly ruleId: string;
  readonly family: string;
  readonly category: string;
  readonly claim: string;
  readonly explanation: string;
  readonly proposedSeverity: FindingSeverity;
  readonly confidenceScore: number;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly fingerprintValue: string;
}

export type L5VerificationSubstance =
  | {
      readonly candidateSemanticIdentity: string;
      readonly status: "completed";
      readonly decision: VerificationDecision;
      readonly reasons: readonly VerificationReason[];
      readonly confidence: number;
      readonly severity: FindingSeverity;
    }
  | {
      readonly candidateSemanticIdentity: string;
      readonly status: "unavailable";
      readonly failure: ExecutionFailure;
    }
  | {
      readonly candidateSemanticIdentity: string;
      readonly status: "missing";
    };

export type L5PromotionSubstance =
  | {
      readonly candidateSemanticIdentity: string;
      readonly outcome: "promoted";
      readonly fingerprintValue: string;
      readonly severity: FindingSeverity;
      readonly category: string;
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly title: string;
      readonly explanation: string;
    }
  | {
      readonly candidateSemanticIdentity: string;
      readonly outcome: "not_promoted";
      readonly reason: "rejected" | "inconclusive";
    }
  | {
      readonly candidateSemanticIdentity: string;
      readonly outcome: "blocked";
      readonly reason: "verification_unavailable" | "verification_missing";
    };

export interface L5PublicationDecisionSubstance {
  readonly findingFingerprint: string;
  readonly decision: "publish" | "withhold";
  readonly reason: PublicationReason;
}

export interface L5PremergeDecisionSubstance {
  readonly checkId: string;
  readonly name: string;
  readonly status: PreMergeCheckStatus;
  readonly explanation?: string | undefined;
  readonly blocking: boolean;
}

export interface L5SubstantiveOutcome {
  readonly candidates: readonly L5CandidateSubstance[];
  readonly verificationDecisions: readonly L5VerificationSubstance[];
  readonly promotions: readonly L5PromotionSubstance[];
  readonly publicationDecisions: readonly L5PublicationDecisionSubstance[];
  readonly premergeDecisions: readonly L5PremergeDecisionSubstance[];
}

export const L5_SUBSTANTIVE_HASH_KINDS = [
  "candidates",
  "verificationDecisions",
  "promotions",
  "publicationDecisions",
  "premergeDecisions",
] as const;

export type L5SubstantiveHashKind = (typeof L5_SUBSTANTIVE_HASH_KINDS)[number];

export type L5SubstantiveHashes = Readonly<
  Record<L5SubstantiveHashKind, string>
>;

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

function canonicalStage(
  kind: L5SubstantiveHashKind,
  records: readonly unknown[],
): string {
  return canonicalJson({
    schema: "acalys.p1-l5.substantive-output.v1",
    kind,
    records: [...records].sort(compareCanonical),
  });
}

/**
 * Hashes only review substance: no run, delivery, invocation, database row,
 * recorder, timestamp, or insertion-order identity is accepted by this type.
 */
export function substantiveOutcomeHashes(
  outcome: L5SubstantiveOutcome,
): L5SubstantiveHashes {
  const verificationDecisions = outcome.verificationDecisions.map((decision) =>
    decision.status === "completed"
      ? { ...decision, reasons: [...decision.reasons].sort() }
      : decision,
  );

  return {
    candidates: sha256(canonicalStage("candidates", outcome.candidates)),
    verificationDecisions: sha256(
      canonicalStage("verificationDecisions", verificationDecisions),
    ),
    promotions: sha256(canonicalStage("promotions", outcome.promotions)),
    publicationDecisions: sha256(
      canonicalStage("publicationDecisions", outcome.publicationDecisions),
    ),
    premergeDecisions: sha256(
      canonicalStage("premergeDecisions", outcome.premergeDecisions),
    ),
  };
}

export interface L5SubstantiveHashComparison {
  readonly identical: boolean;
  readonly differingStages: readonly L5SubstantiveHashKind[];
}

export function compareSubstantiveHashes(
  left: L5SubstantiveHashes,
  right: L5SubstantiveHashes,
): L5SubstantiveHashComparison {
  const differingStages = L5_SUBSTANTIVE_HASH_KINDS.filter(
    (kind) => left[kind] !== right[kind],
  );
  return { identical: differingStages.length === 0, differingStages };
}
