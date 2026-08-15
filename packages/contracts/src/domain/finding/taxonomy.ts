/**
 * Finding taxonomy: category, severity, confidence (P0.txt §24, §25, §26).
 *
 * Three axes that are routinely conflated and must not be:
 *
 *     category    what kind of problem is this?
 *     severity    how bad is it if real?
 *     confidence  how sure are we that it is real?
 *
 * All three are independent. A credential leak suspected from a weak hint is
 * `security` / `critical` / low confidence. A proven off-by-one in a log
 * message is `correctness` / `low` / very high confidence. Collapsing any pair
 * makes both unusable for policy: "fail the build on critical findings" would
 * fire on unverified guesses, and "show me what you are sure about" would hide
 * the dangerous ones.
 */

import { z } from "zod";

/**
 * What kind of problem (§24).
 *
 * Deliberately *not* overfitted to any one analyzer: these describe the issue,
 * while a tool's own rule identity lives in {@link ToolEvidenceProvenance.ruleId}
 * where it belongs (§24). Adding a category per analyzer would make the
 * vocabulary useless for cross-tool metrics and policy.
 *
 * Coarse enough to be stable and to filter usefully; a finer split (say,
 * `sql_injection` under `security`) belongs to the rule id, not here.
 */
export const FINDING_CATEGORIES = [
  "correctness",
  "security",
  "reliability",
  "concurrency",
  "data_integrity",
  "performance",
  "resource_management",
  "api_contract",
  "compatibility",
  "migration",
  "testing",
  "maintainability",
  "configuration",
  "dependency",
  "other",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const findingCategorySchema = z.enum(FINDING_CATEGORIES);

/**
 * Impact if the finding is real (§25).
 *
 * Documented meanings, so two agents grade the same way:
 *
 * | Severity   | Means |
 * | ---------- | ----- |
 * | `critical` | catastrophic or immediately exploitable — RCE, auth bypass, credential exposure, severe data corruption, destructive production failure |
 * | `high`     | major correctness, security, or reliability impact |
 * | `medium`   | a real bug that should normally be fixed |
 * | `low`      | limited impact |
 * | `info`     | a useful observation, not normally blocking |
 *
 * Severity says nothing about certainty — a `critical` finding may be under
 * investigation with low confidence (§25).
 */
export const FINDING_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const findingSeveritySchema = z.enum(FINDING_SEVERITIES);

/**
 * Explicit ordering, most severe first.
 *
 * Required because lexical order is nonsense here: sorted as strings,
 * `critical` < `high` < `info` < `low` < `medium`, which would put `info`
 * above `low` and `medium` last. Any code that sorts severities must use
 * {@link compareSeverity}.
 */
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
});

/** Sorts most-severe-first. Negative when `left` is more severe. */
export function compareSeverity(
  left: FindingSeverity,
  right: FindingSeverity,
): number {
  return SEVERITY_RANK[left] - SEVERITY_RANK[right];
}

/** True when `left` is strictly more severe than `right`. */
export function isMoreSevere(
  left: FindingSeverity,
  right: FindingSeverity,
): boolean {
  return SEVERITY_RANK[left] < SEVERITY_RANK[right];
}

/** The most severe member of a set, or `undefined` when empty. */
export function highestSeverity(
  severities: readonly FindingSeverity[],
): FindingSeverity | undefined {
  let highest: FindingSeverity | undefined;
  for (const severity of severities) {
    if (highest === undefined || isMoreSevere(severity, highest)) {
      highest = severity;
    }
  }
  return highest;
}

/**
 * Coarse confidence bands (§26).
 *
 * Four bands rather than three because `very_high` carries a distinct
 * operational meaning: it is the level at which a finding may be acted on
 * automatically — blocking a merge, applying a fix — and merging it into
 * `high` would erase the line between "worth showing" and "safe to enforce".
 */
export const FINDING_CONFIDENCE_LEVELS = [
  "low",
  "medium",
  "high",
  "very_high",
] as const;

export type FindingConfidenceLevel = (typeof FINDING_CONFIDENCE_LEVELS)[number];

export const findingConfidenceLevelSchema = z.enum(FINDING_CONFIDENCE_LEVELS);

/**
 * How sure the platform is that a finding is real (§26).
 *
 * Carries **both** a score and a band, as §26 specifies, and the pairing is
 * enforced below so they can never disagree. The reason for both: the score
 * supports ranking and calibration measurement, while the band is what policy
 * and UI should key on — thresholds written against raw floats become
 * unstable the moment the scoring model is retuned.
 *
 * `score` is in [0, 1]. It must eventually be grounded in evidence rather than
 * a model's self-report (§26); nothing in Phase 0 computes it, and the
 * contract exists so that whatever does cannot invent its own shape.
 */
export interface FindingConfidence {
  /** Calibrated probability the finding is real, in [0, 1]. */
  readonly score: number;
  /** Band derived from `score`. Never assigned independently. */
  readonly level: FindingConfidenceLevel;
}

/**
 * Score thresholds for each band, as half-open intervals `[min, next)`.
 *
 * Fixed here so that two subsystems cannot band the same score differently —
 * which would let a finding be `high` in the API and `medium` in a policy
 * check.
 */
const CONFIDENCE_BAND_MINIMUM: Readonly<
  Record<FindingConfidenceLevel, number>
> = Object.freeze({
  low: 0,
  medium: 0.4,
  high: 0.7,
  very_high: 0.9,
});

/** The band a score falls into. The single source of the mapping. */
export function confidenceLevelForScore(score: number): FindingConfidenceLevel {
  if (score >= CONFIDENCE_BAND_MINIMUM.very_high) return "very_high";
  if (score >= CONFIDENCE_BAND_MINIMUM.high) return "high";
  if (score >= CONFIDENCE_BAND_MINIMUM.medium) return "medium";
  return "low";
}

/**
 * Builds a confidence value with the band derived, never supplied.
 *
 * The only sanctioned constructor: taking both from a caller would allow
 * `{ score: 0.05, level: "very_high" }`, a contradiction no consumer could
 * resolve (§C18).
 *
 * @throws {ValidationError} when the score is outside [0, 1] or not finite
 */
export function findingConfidence(score: number): FindingConfidence {
  return findingConfidenceSchema.parse({
    score,
    level: confidenceLevelForScore(score),
  });
}

export const findingConfidenceSchema = z
  .strictObject({
    score: z
      .number()
      .min(0, { error: "Confidence score is a probability in [0, 1]" })
      .max(1, { error: "Confidence score is a probability in [0, 1]" })
      .refine(Number.isFinite, { error: "Confidence score must be finite" }),
    level: findingConfidenceLevelSchema,
  })
  .superRefine((confidence, ctx) => {
    const expected = confidenceLevelForScore(confidence.score);
    if (confidence.level !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["level"],
        message: `Confidence level '${confidence.level}' contradicts score ${String(confidence.score)}, which is '${expected}'`,
      });
    }
  });

/**
 * Whether a finding is certain enough to enforce automatically.
 *
 * Named for the decision rather than the threshold so the bar can move in one
 * place if calibration shows it should.
 */
export function isActionableConfidence(confidence: FindingConfidence): boolean {
  return confidence.level === "very_high";
}
