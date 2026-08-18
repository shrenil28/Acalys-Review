/**
 * The verifier's confusion matrix.
 *
 * `verifier accuracy = 83%` is not a number anyone can act on. These four
 * outcomes have completely different consequences, and a single percentage
 * averages them into noise:
 *
 * ```
 * gold ↓  /  actual →   verified      rejected       inconclusive   unavailable
 * real defect           correct       CATASTROPHIC   recall loss    operational
 * refuted claim         FALSE POSITIVE correct       missed filter  operational
 * undecidable           overclaim     over-refutation correct       operational
 * ```
 *
 * The capitalised cells are the ones that cost the product something a user
 * notices. `real defect → rejected` is the worst: a true bug suppressed, and
 * recorded as the analyzer being wrong so nobody investigates the verifier.
 *
 * Reported only over injected challenges, never mixed with the analyzer corpus.
 * These claims measure a *capability*; the analyzer corpus measures the
 * *product*, and combining them lets hand-written challenges flatter a pipeline
 * that never sees them.
 */

import type { VerificationAttempt } from "../verification/decide.js";
import { verifyDeterministically } from "../verification/deterministic.js";
import {
  DEFAULT_VERIFICATION_POLICY,
  planVerificationContext,
} from "../verification/plan-context.js";
import type { GoldOutcome, VerifierChallenge } from "./verifier-corpus.js";

export const ACTUAL_OUTCOMES = [
  "verified",
  "rejected",
  "inconclusive",
  "unavailable",
] as const;

export type ActualOutcome = (typeof ACTUAL_OUTCOMES)[number];

export interface ChallengeOutcome {
  readonly id: string;
  readonly gold: GoldOutcome;
  readonly actual: ActualOutcome;
  readonly correct: boolean;
  readonly attempt: VerificationAttempt;
  readonly because: string;
  readonly pairedWith?: string | undefined;
}

export type ConfusionMatrix = Readonly<
  Record<GoldOutcome, Readonly<Record<ActualOutcome, number>>>
>;

export interface VerifierReport {
  /** Always `injected`. Stated in the type so it cannot be silently merged. */
  readonly provenance: "injected";
  readonly outcomes: readonly ChallengeOutcome[];
  readonly matrix: ConfusionMatrix;

  /**
   * A true defect the verifier affirmatively refuted.
   *
   * The cell that must stay at zero. It suppresses a real bug *and* records the
   * suppression as an analyzer false positive, so the investigation goes to the
   * wrong component.
   */
  readonly catastrophic: number;
  /** A refuted claim the verifier confirmed. A published false positive. */
  readonly falseConfirmations: number;
  /** Real defects it could not settle. Reach, and the cost of the abstain list. */
  readonly recallLoss: number;
  /** Refutable claims it could not settle. Filtering it failed to do. */
  readonly missedFiltering: number;
  /**
   * Undecidable claims it decided anyway.
   *
   * Watched because every pressure on this corpus pushes toward deciding more
   * often, and a verifier that invents refutations scores better on every other
   * line of this report.
   */
  readonly overclaims: number;

  /**
   * Pairs where both halves were graded correctly.
   *
   * The discrimination check. A mechanism that verifies the defect and also
   * confirms its safe lookalike has learned a pattern, not a mechanism, and
   * would score well on everything above.
   */
  readonly pairsDiscriminated: number;
  readonly pairsTotal: number;
}

function actualOf(attempt: VerificationAttempt): ActualOutcome {
  return attempt.status === "unavailable" ? "unavailable" : attempt.decision;
}

const CORRECT: Readonly<Record<GoldOutcome, ActualOutcome>> = {
  should_verify: "verified",
  should_reject: "rejected",
  should_abstain: "inconclusive",
};

export function runChallenge(challenge: VerifierChallenge): ChallengeOutcome {
  const context = planVerificationContext({
    verificationInput: {
      ...challenge.input,
      repositoryId: "eval",
      revisionId: `eval:${challenge.id}`,
    },
    repository: {
      revisionId: `eval:${challenge.id}`,
      files: new Map(Object.entries(challenge.files)),
    },
    policy: DEFAULT_VERIFICATION_POLICY,
  });

  const attempt = verifyDeterministically(
    {
      ...challenge.input,
      repositoryId: "eval",
      revisionId: `eval:${challenge.id}`,
    },
    context,
  );

  const actual = actualOf(attempt);
  return {
    id: challenge.id,
    gold: challenge.gold,
    actual,
    correct: actual === CORRECT[challenge.gold],
    attempt,
    because: challenge.because,
    pairedWith: challenge.pairedWith,
  };
}

export function evaluateChallenges(
  challenges: readonly VerifierChallenge[],
): VerifierReport {
  const outcomes = challenges.map(runChallenge);

  const matrix = Object.fromEntries(
    (["should_verify", "should_reject", "should_abstain"] as const).map(
      (gold) => [
        gold,
        Object.fromEntries(
          ACTUAL_OUTCOMES.map((actual) => [
            actual,
            outcomes.filter(
              (outcome) => outcome.gold === gold && outcome.actual === actual,
            ).length,
          ]),
        ),
      ],
    ),
  ) as unknown as ConfusionMatrix;

  const cell = (gold: GoldOutcome, actual: ActualOutcome): number =>
    matrix[gold][actual];

  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const pairs = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.pairedWith === undefined) continue;
    // Canonical, so a pair is counted once rather than once per half.
    pairs.add([outcome.id, outcome.pairedWith].sort().join("|"));
  }
  const pairsDiscriminated = [...pairs].filter((pair) => {
    const [left, right] = pair.split("|");
    return (
      byId.get(left ?? "")?.correct === true &&
      byId.get(right ?? "")?.correct === true
    );
  }).length;

  return {
    provenance: "injected",
    outcomes,
    matrix,
    catastrophic: cell("should_verify", "rejected"),
    falseConfirmations: cell("should_reject", "verified"),
    recallLoss: cell("should_verify", "inconclusive"),
    missedFiltering: cell("should_reject", "inconclusive"),
    overclaims:
      cell("should_abstain", "verified") + cell("should_abstain", "rejected"),
    pairsDiscriminated,
    pairsTotal: pairs.size,
  };
}
