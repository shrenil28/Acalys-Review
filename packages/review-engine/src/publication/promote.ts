/**
 * The promotion gate: the only path from a candidate to a product finding.
 *
 * Three things must be impossible after this module, and each has been a real
 * bug in some review product:
 *
 * ```
 * a rejected candidate becomes a comment
 * an unverified candidate becomes a comment
 * an outage becomes a clean review
 * ```
 *
 * The third is the subtle one. If verification is `unavailable` for one
 * candidate and the run publishes the rest, a verifier outage renders as
 * *fewer comments on a successful review* — indistinguishable from good news,
 * and every metric agrees. So an unavailable verification **blocks the run**
 * rather than being quietly skipped. Partial verification may become a product
 * feature later; it must not be acquired by accident.
 */

import type { FindingSeverity } from "@acalys/contracts/domain";

import type { VerificationAttempt } from "../verification/decide.js";
import type { PublishableFinding } from "./policy.js";

/** A candidate paired with what verification concluded about it. */
export interface VerifiedCandidate {
  readonly candidateId: string;
  readonly fingerprint: string;
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly path: string;
  readonly attempt: VerificationAttempt;
}

export const PROMOTION_BLOCKS = [
  "verification_unavailable",
  "verification_missing",
] as const;

export type PromotionBlock = (typeof PROMOTION_BLOCKS)[number];

export type PromotionOutcome =
  | {
      readonly kind: "promoted";
      /** Verified candidates, as findings a policy may consider. */
      readonly findings: readonly PublishableFinding[];
      /**
       * Retained for audit, never promoted.
       *
       * Kept rather than discarded: "the analyzer said this and the verifier
       * disagreed" is the signal that tells you whether analyzer confidence is
       * calibrated, and throwing it away makes that unanswerable.
       */
      readonly notPromoted: readonly {
        readonly candidateId: string;
        readonly decision: "rejected" | "inconclusive";
      }[];
    }
  /**
   * The run cannot proceed.
   *
   * Not a partial success. Publishing what did verify would let an outage read
   * as a clean review.
   */
  | {
      readonly kind: "blocked";
      readonly block: PromotionBlock;
      readonly candidateIds: readonly string[];
    };

/**
 * Promotes only what verification established.
 *
 * `verified` is *necessary* for promotion — the sole path — and this function
 * is the sole place that decides it. A policy that could promote an unverified
 * candidate, or an analyzer that could skip here, would make every downstream
 * guarantee decorative.
 */
export function promoteVerified(
  candidates: readonly VerifiedCandidate[],
): PromotionOutcome {
  const unavailable = candidates.filter(
    (candidate) => candidate.attempt.status === "unavailable",
  );

  if (unavailable.length > 0) {
    return {
      kind: "blocked",
      block: "verification_unavailable",
      candidateIds: unavailable.map((candidate) => candidate.candidateId),
    };
  }

  const findings: PublishableFinding[] = [];
  const notPromoted: {
    candidateId: string;
    decision: "rejected" | "inconclusive";
  }[] = [];

  for (const candidate of candidates) {
    const attempt = candidate.attempt;
    if (attempt.status !== "completed") continue;

    if (attempt.decision === "verified") {
      findings.push({
        // Promotion is keyed on the fingerprint, so a retry converges on the
        // same finding rather than inserting a second one, and the same
        // semantic defect on the next push reconciles to the existing finding
        // instead of being reported again.
        findingId: candidate.fingerprint,
        fingerprint: candidate.fingerprint,
        // The verifier's severity, not the analyzer's proposal. Once the defect
        // is independently established, the verification is the authority.
        severity: attempt.severity,
        category: candidate.category,
        path: candidate.path,
      });
      continue;
    }

    notPromoted.push({
      candidateId: candidate.candidateId,
      decision: attempt.decision,
    });
  }

  return { kind: "promoted", findings, notPromoted };
}

/**
 * The funnel, kept as separate numbers.
 *
 * Deliberately not collapsed into one "acceptance rate". The ratios that matter
 * answer different questions and have different fixes:
 *
 * ```
 * candidate → verified          analyzer precision
 * candidate → rejected          analyzer over-generation
 * candidate → inconclusive      planner or verifier reach
 * verification unavailable      infrastructure, and never analyzer quality
 * verified → withheld           policy, not truth
 * ```
 */
export interface VerificationFunnel {
  readonly candidates: number;
  readonly verified: number;
  readonly rejected: number;
  readonly inconclusive: number;
  readonly unavailable: number;
}

export function funnelOf(
  candidates: readonly VerifiedCandidate[],
): VerificationFunnel {
  const count = (
    predicate: (candidate: VerifiedCandidate) => boolean,
  ): number => candidates.filter(predicate).length;

  return {
    candidates: candidates.length,
    verified: count(
      (c) =>
        c.attempt.status === "completed" && c.attempt.decision === "verified",
    ),
    rejected: count(
      (c) =>
        c.attempt.status === "completed" && c.attempt.decision === "rejected",
    ),
    inconclusive: count(
      (c) =>
        c.attempt.status === "completed" &&
        c.attempt.decision === "inconclusive",
    ),
    // Never folded into `rejected`: an outage is not a judgement, and counting
    // it as one makes analyzer precision improve when the verifier is down.
    unavailable: count((c) => c.attempt.status === "unavailable"),
  };
}
