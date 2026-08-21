/**
 * The P1-M quality gate, as code rather than as prose.
 *
 * `m1-capability-contract.md` states nine conditions P1-M must satisfy before
 * it may close. Until this module existed they were a numbered list in a
 * document, which means closure would have been decided by a person reading
 * that list and comparing it against a report — at exactly the moment that
 * person most wants to be generous, having just spent several checkpoints
 * building the thing being judged.
 *
 * Every prior checkpoint in this project that went wrong went wrong there: a
 * claim that sounded satisfied, checked by the author of the work, against
 * evidence the author also produced. P1-K closed once on a false central
 * claim with three passing reviews. So the gate is computed, and it is
 * computable by something other than the person who wants it to pass.
 *
 * # Undefined is a verdict, not a zero
 *
 * Condition 7 divides additional true positives by additional published
 * comments. A checkpoint that published nothing has an UNDEFINED ratio, not a
 * perfect one. Rendering that as `1.0` would let a capability that publishes
 * nothing at all satisfy the strictest-looking condition in the gate.
 *
 * `Quantity` already encodes this distinction, so it is reused rather than
 * re-derived — the fourth variant, `undefinedRatio`, exists for exactly this.
 *
 * # What this module deliberately does not do
 *
 * It does not measure. It takes a measurement and renders a verdict. Anything
 * that both produces the numbers and judges them would be the same
 * self-certification the contract forbids between analyzer and verifier, one
 * level up.
 */

import { ratio, render, type Quantity } from "@acalys/review-engine";
import type { M1CapabilityFamily } from "./m1-corpus.js";

/** What one corpus split produced at publication. */
export interface M1SplitOutcome {
  readonly planted: number;
  readonly publishedTruePositives: number;
  readonly publishedFalsePositives: number;
}

/**
 * What a capability checkpoint attests structurally.
 *
 * Conditions 8 and 9 are not numeric. They are claims about how a capability
 * was built, and a gate that ignored them would let a family with excellent
 * corpus numbers and no production witness count toward closure — which is
 * precisely the P1-K failure restated in evaluation terms.
 */
export interface M1CapabilityAttestation {
  readonly family: M1CapabilityFamily;
  /** Path of a test that drives the real production entry, not a library call. */
  readonly productionWitness: string;
  /** Mutation ids that kill on this capability's semantics. */
  readonly semanticMutationIds: readonly number[];
  /**
   * Fact families this capability asked for by name.
   *
   * Empty is legitimate — a capability may need no repository fact. What is
   * forbidden is broad generic enrichment, which shows up here as a family
   * the capability never uses.
   */
  readonly demandSelectedFactFamilies: readonly string[];
}

export interface M1FunnelMeasurement {
  readonly historical: M1SplitOutcome;
  readonly development: M1SplitOutcome;
  readonly holdout: M1SplitOutcome;
  /**
   * Ids of historical cases published as true positives at this checkpoint.
   *
   * Compared against the baseline's own two, so a capability that gains four
   * and silently loses one cannot net out to progress.
   */
  readonly historicalTruePositiveIds: readonly string[];
  readonly naturalFalsePositivesReplayed: number;
  readonly naturalFalsePositivesPublished: number;
  readonly verifier: {
    readonly incorrectRejects: number;
    readonly inconclusive: number;
    readonly unavailable: number;
  };
  readonly additionalTruePositivesPublished: number;
  readonly additionalCommentsPublished: number;
  readonly capabilities: readonly M1CapabilityAttestation[];
}

export interface M1GateCondition {
  readonly id: number;
  readonly requirement: string;
  readonly satisfied: boolean;
  /** What was actually observed, rendered honestly. */
  readonly observed: string;
}

export interface M1GateVerdict {
  readonly closes: boolean;
  readonly conditions: readonly M1GateCondition[];
  readonly failing: readonly number[];
}

const publishedRecall = (split: M1SplitOutcome): Quantity =>
  ratio(
    split.publishedTruePositives,
    split.planted,
    "no planted defects in this split",
  );

const publishedPrecision = (split: M1SplitOutcome): Quantity =>
  ratio(
    split.publishedTruePositives,
    split.publishedTruePositives + split.publishedFalsePositives,
    "nothing was published in this split",
  );

/** True only for a `measured` quantity at or above a threshold. */
function atLeast(quantity: Quantity, threshold: number): boolean {
  return quantity.kind === "measured" && quantity.value >= threshold;
}

/** True only for a `measured` quantity exactly equal to a value. */
function exactly(quantity: Quantity, value: number): boolean {
  return quantity.kind === "measured" && quantity.value === value;
}

/**
 * Evaluates the frozen gate.
 *
 * Returns every condition with its observation, not merely a boolean, because
 * "the gate failed" is not actionable and "condition 3 failed: published
 * precision on holdout is 0.875" is.
 */
export function evaluateM1Gate(
  measurement: M1FunnelMeasurement,
): M1GateVerdict {
  const historicalRecall = publishedRecall(measurement.historical);
  const developmentRecall = publishedRecall(measurement.development);
  const holdoutRecall = publishedRecall(measurement.holdout);

  const historicalPrecision = publishedPrecision(measurement.historical);
  const developmentPrecision = publishedPrecision(measurement.development);
  const holdoutPrecision = publishedPrecision(measurement.holdout);

  // The baseline's own published true positives are the two that already
  // worked. Any of them missing at a later checkpoint is a regression, however
  // many new ones were gained.
  const nowPublished = new Set(measurement.historicalTruePositiveIds);
  const regressed = BASELINE_PUBLISHED_TRUE_POSITIVES.filter(
    (id) => !nowPublished.has(id),
  );

  const yieldRatio = ratio(
    measurement.additionalTruePositivesPublished,
    measurement.additionalCommentsPublished,
    "no additional comments were published",
  );

  const withoutWitness = measurement.capabilities.filter(
    (capability) =>
      capability.productionWitness.trim() === "" ||
      capability.semanticMutationIds.length === 0,
  );

  const conditions: M1GateCondition[] = [
    {
      id: 1,
      requirement: "historical published recall >= 8/12",
      satisfied: atLeast(historicalRecall, 8 / 12),
      observed: `${render(historicalRecall)} (${String(measurement.historical.publishedTruePositives)}/${String(measurement.historical.planted)})`,
    },
    {
      id: 2,
      requirement: "development and holdout published recall each >= 4/8",
      satisfied: atLeast(developmentRecall, 0.5) && atLeast(holdoutRecall, 0.5),
      observed: `development ${render(developmentRecall)}, holdout ${render(holdoutRecall)}`,
    },
    {
      id: 3,
      requirement: "published precision 100% on all three splits",
      satisfied:
        exactly(historicalPrecision, 1) &&
        exactly(developmentPrecision, 1) &&
        exactly(holdoutPrecision, 1),
      observed: `historical ${render(historicalPrecision)}, development ${render(developmentPrecision)}, holdout ${render(holdoutPrecision)}`,
    },
    {
      id: 4,
      requirement: "no observed natural false positive reaches publication",
      satisfied:
        measurement.naturalFalsePositivesPublished === 0 &&
        measurement.naturalFalsePositivesReplayed > 0,
      observed: `${String(measurement.naturalFalsePositivesPublished)} published of ${String(measurement.naturalFalsePositivesReplayed)} replayed`,
    },
    {
      id: 5,
      requirement: "existing historical true positives do not regress",
      satisfied: regressed.length === 0,
      observed:
        regressed.length === 0
          ? "both baseline true positives still published"
          : `regressed: ${regressed.join(", ")}`,
    },
    {
      id: 6,
      requirement: "incorrect verifier rejects and unavailability are zero",
      satisfied:
        measurement.verifier.incorrectRejects === 0 &&
        measurement.verifier.unavailable === 0,
      observed: `${String(measurement.verifier.incorrectRejects)} incorrect rejects, ${String(measurement.verifier.unavailable)} unavailable, ${String(measurement.verifier.inconclusive)} inconclusive`,
    },
    {
      id: 7,
      requirement:
        "additional true positives / additional published comments == 1.0",
      // `undefinedRatio` fails. A checkpoint that published nothing has not
      // satisfied a precision-shaped condition; it has avoided being measured.
      satisfied: exactly(yieldRatio, 1),
      observed: `${render(yieldRatio)} (${String(measurement.additionalTruePositivesPublished)} TP / ${String(measurement.additionalCommentsPublished)} comments)`,
    },
    {
      id: 8,
      requirement:
        "every capability has a production-path witness and semantic mutation kills",
      satisfied:
        measurement.capabilities.length > 0 && withoutWitness.length === 0,
      observed:
        measurement.capabilities.length === 0
          ? "no capabilities attested"
          : withoutWitness.length === 0
            ? `${String(measurement.capabilities.length)} capabilities attested`
            : `missing: ${withoutWitness.map((capability) => capability.family).join(", ")}`,
    },
    {
      id: 9,
      requirement: "repository context is demand-selected per capability",
      satisfied: measurement.capabilities.every((capability) =>
        capability.demandSelectedFactFamilies.every(
          (family) => family.trim() !== "",
        ),
      ),
      observed: measurement.capabilities
        .map(
          (capability) =>
            `${capability.family}: [${capability.demandSelectedFactFamilies.join(", ")}]`,
        )
        .join("; "),
    },
  ];

  const failing = conditions
    .filter((condition) => !condition.satisfied)
    .map((condition) => condition.id);

  return { closes: failing.length === 0, conditions, failing };
}

/**
 * The two historical cases P1-L.5 already published.
 *
 * Named rather than derived, because condition 5 is about *these two* not
 * regressing. Deriving "the ones that passed" from the current run would make
 * the regression check compare a measurement against itself.
 */
export const BASELINE_PUBLISHED_TRUE_POSITIVES = [
  "binding-floating-reservation",
  "interaction-binding-and-test-delivery",
] as const;

/** A human-readable gate report, for a checkpoint document. */
export function renderM1Gate(verdict: M1GateVerdict): string {
  const lines = verdict.conditions.map(
    (condition) =>
      `${condition.satisfied ? "PASS" : "FAIL"}  ${String(condition.id)}. ${condition.requirement}\n      observed: ${condition.observed}`,
  );
  return [
    ...lines,
    "",
    verdict.closes
      ? "P1-M GATE SATISFIED"
      : `P1-M GATE NOT SATISFIED — failing conditions: ${verdict.failing.join(", ")}`,
  ].join("\n");
}
