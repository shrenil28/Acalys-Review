/**
 * The verification decision, and the ways it must not be reached.
 *
 * Three outcomes, and `inconclusive` is the one that carries the design:
 *
 * ```
 * verified      independent support is sufficient
 * rejected      independent evidence contradicts the claim
 * inconclusive  neither threshold was reached
 * ```
 *
 * `inconclusive` is a legitimate answer, not a failure to be tuned away. The
 * pressure on it is real and predictable — recall looks better if uncertain
 * candidates are promoted — and giving in converts the verifier from a quality
 * gate into a formality. So publication policy, not the verifier, decides what
 * happens to it, and the default is to suppress.
 *
 * # Execution failure is not a judgement
 *
 * ```
 * model timeout        ≠ rejected
 * context unavailable  ≠ rejected
 * parse failure        ≠ rejected
 * ```
 *
 * Each of those means *we could not verify*, which is `unavailable` — a
 * separate outcome that never suppresses a finding on the pretence that it was
 * examined and found wanting. Collapsing them into `rejected` would make an
 * outage look like a quality improvement, and the metrics would agree.
 */

import type { FindingSeverity } from "@acalys/contracts/domain";

import type { VerificationInput } from "./input.js";

export const VERIFICATION_DECISIONS = [
  "verified",
  "rejected",
  "inconclusive",
] as const;

export type VerificationDecision = (typeof VERIFICATION_DECISIONS)[number];

/**
 * Closed vocabulary for *why*.
 *
 * Free text would make rejection reasons unaggregatable, and the first question
 * asked of a verifier is always "what is it rejecting, and is that right?".
 */
export const VERIFICATION_REASONS = [
  "evidence_supports_claim",
  "independent_context_confirms",
  "claim_contradicted_by_context",
  "claimed_mechanism_not_present",
  "guarded_on_all_paths",
  // Declared, and NOT produced by the P1-H verifier. Ownership is explicit
  // rather than implied: change attribution is decided at the
  // candidate-generation boundary, where base/head data exists, and a
  // pre-existing defect is suppressed *before* verification. Measured as
  // `change-attribution suppression`, never as a verifier rejection —
  // conflating them would report a working counterfactual filter as the
  // verifier disproving claims.
  //
  // Reserved here so that if the verifier is later given its own base/head
  // planner and derives attribution independently, the vocabulary already
  // holds the reason.
  "not_caused_by_change",
  "insufficient_evidence",
  "context_incomplete",
  // No procedure applies to this kind of claim.
  //
  // Distinct from both of the above, and the distinction is the P1-J.3
  // correction. `insufficient_evidence` and `context_incomplete` both say *we
  // looked and could not settle it*; this says *we never had a way to look*.
  // Collapsing them hides the difference between a planner to improve and a
  // capability to build — and, worse, lets a verifier that adjudicated the
  // wrong proposition report it as an evidence problem.
  "no_applicable_procedure",

  // ── signature compatibility ──────────────────────────────────────────
  /** The compiler reports the call does not satisfy the changed contract. */
  "contract_violated_at_call_site",
  /** The compiler accepts the call against the changed contract. */
  "call_site_satisfies_contract",
  /**
   * The claim is about consumers the verifier cannot enumerate.
   *
   * The load-bearing reason of this capability. "I found no stale callers" is
   * not "none exist" — a `findReferences` over a context subset, or over a
   * repository that does not contain a published package's consumers, cannot
   * establish a closed world. Refuting an API-break claim on that basis is the
   * commonest static-analysis overclaim there is.
   */
  "consumer_scope_unbounded",

  // ── condition value semantics ────────────────────────────────────────
  /** The branch consumes a promise object rather than a resolved boolean. */
  "condition_branches_on_promise",
  /**
   * The condition's value is not a promise — the callee is synchronous, or the
   * value is already awaited.
   */
  "condition_value_is_not_a_promise",

  // ── exception flow ───────────────────────────────────────────────────
  /** The failure is suppressed and something downstream reports success. */
  "suppressed_failure_reported_as_success",
  /** The suppression is contracted: a rethrow, a fallback, a handled error. */
  "failure_suppression_is_contracted",
  /**
   * Neither direction has affirmative evidence.
   *
   * Distinct from `insufficient_evidence`, which says the verifier could not
   * reach what it needed. This says it looked and the repository genuinely does
   * not record whether the author meant it — which for some silent catches is
   * the permanent right answer, not a gap to close.
   */
  "intent_not_establishable",
  // Independent context and the supplied evidence disagree. Distinct from
  // insufficiency: something *is* known, and what is known conflicts. Folding
  // it into `insufficient_evidence` would hide the most interesting signal a
  // verifier produces — a claim whose own support contradicts the repository.
  "conflicting_independent_evidence",
] as const;

export type VerificationReason = (typeof VERIFICATION_REASONS)[number];

/**
 * Which decision each reason can justify. Exhaustive and table-driven, like the
 * lifecycle matrices.
 *
 * Without it, `{ decision: "verified", reasons: ["claim_contradicted_by_context"] }`
 * is well-typed and semantically impossible — and the first person to hit it
 * will be reading a published finding.
 */
export const REASON_SUPPORTS: Readonly<
  Record<VerificationReason, VerificationDecision>
> = {
  evidence_supports_claim: "verified",
  independent_context_confirms: "verified",

  claim_contradicted_by_context: "rejected",
  claimed_mechanism_not_present: "rejected",
  guarded_on_all_paths: "rejected",
  not_caused_by_change: "rejected",

  insufficient_evidence: "inconclusive",
  context_incomplete: "inconclusive",
  no_applicable_procedure: "inconclusive",

  contract_violated_at_call_site: "verified",
  call_site_satisfies_contract: "rejected",
  consumer_scope_unbounded: "inconclusive",

  condition_branches_on_promise: "verified",
  condition_value_is_not_a_promise: "rejected",

  suppressed_failure_reported_as_success: "verified",
  failure_suppression_is_contracted: "rejected",
  intent_not_establishable: "inconclusive",
  conflicting_independent_evidence: "inconclusive",
};

/**
 * Rejects a decision its reasons cannot justify.
 *
 * Called on the way out of every verifier, so a confirming reason can never
 * appear under a rejection and a refuting one can never appear under a
 * verification.
 */
export function assertReasonsSupport(
  decision: VerificationDecision,
  reasons: readonly VerificationReason[],
): void {
  if (reasons.length === 0) {
    throw new Error(
      `A completed verification must say why. \`${decision}\` arrived with no reason code.`,
    );
  }

  const wrong = reasons.filter(
    (reason) => REASON_SUPPORTS[reason] !== decision,
  );
  if (wrong.length > 0) {
    throw new Error(
      `Reason(s) ${wrong.join(", ")} cannot justify \`${decision}\` — ` +
        `they support \`${REASON_SUPPORTS[wrong[0] as VerificationReason]}\`.`,
    );
  }
}

/**
 * Why verification could not run.
 *
 * A separate vocabulary from {@link VerificationReason} on purpose. These are
 * facts about our infrastructure; those are facts about the claim. One enum
 * holding both would let a provider outage be counted as a rejection, and every
 * dashboard would report a quality improvement.
 */
export const EXECUTION_FAILURES = [
  "model_timeout",
  "context_unavailable",
  "provider_error",
  "parse_failure",
  "budget_exhausted",
] as const;

export type ExecutionFailure = (typeof EXECUTION_FAILURES)[number];

/**
 * One attempt to verify a claim.
 *
 * ```
 * VerificationAttempt
 * ├── completed   → decision: verified | rejected | inconclusive
 * └── unavailable → execution failure: timeout | provider_error | …
 * ```
 *
 * The shape is the point. `unavailable` is deliberately **not** a fourth
 * decision: adding it to the semantic vocabulary would mix infrastructure state
 * with epistemic state, and every consumer switching on a decision would then
 * have to remember that one of the cases is not a judgement at all.
 */
export type VerificationAttempt =
  | {
      readonly status: "completed";
      readonly decision: VerificationDecision;
      readonly reasons: readonly VerificationReason[];
      /**
       * The verifier's own confidence, formed from its own evidence.
       *
       * Never seeded from the analyzer's — that number does not reach this
       * module. See `input.ts`.
       */
      readonly confidence: number;
      readonly severity: FindingSeverity;
    }
  /**
   * Verification could not run. The claim has not been examined.
   *
   * Carries an {@link ExecutionFailure} rather than a free string, so
   * "how often are we failing to verify, and why?" is answerable.
   */
  | { readonly status: "unavailable"; readonly failure: ExecutionFailure };

export interface Verifier {
  readonly id: string;
  readonly version: string;
  verify(
    input: VerificationInput,
    context: VerificationContext,
  ): Promise<VerificationAttempt> | VerificationAttempt;
}

/**
 * Context the verifier assembled for itself.
 *
 * The independence that matters is not "a different model" — it is that this
 * was derivable **without knowing what the analyzer selected**. Overlap is
 * expected and fine: two planners asked about the same defect should often
 * choose the same file. What must not happen is the verifier being handed the
 * analyzer's selection, because then it inherits the analyzer's blind spots
 * exactly where they matter.
 */
export interface VerificationContext {
  readonly items: readonly {
    readonly path: string;
    readonly content: string;
    readonly reason: string;
  }[];
  /** Digest of what was actually shown, not of what was intended. */
  readonly digest: string;
  /** True when the planner could not supply something it wanted. */
  readonly incomplete: boolean;
}

/**
 * What publication does with each outcome.
 *
 * The default is deliberately conservative: a reviewer earns the right to
 * interrupt people by being right, and the cost of a suppressed true finding is
 * paid once while the cost of a published false one is paid every time someone
 * learns to skim.
 *
 * Only `verified` reaches a developer until the corpus says otherwise.
 */
export const PUBLICATION_POLICY: Readonly<
  Record<VerificationDecision, "publish" | "suppress">
> = {
  verified: "publish",
  rejected: "suppress",
  inconclusive: "suppress",
};

export function isPublishable(attempt: VerificationAttempt): boolean {
  // `unavailable` is not publishable and is not a rejection either: the
  // candidate is still owed a verification.
  return (
    attempt.status === "completed" &&
    PUBLICATION_POLICY[attempt.decision] === "publish"
  );
}

/**
 * Whether an attempt is a judgement about the claim.
 *
 * Used by metrics. A rejection rate that counts `unavailable` is measuring our
 * uptime and calling it precision.
 */
export function isJudgement(attempt: VerificationAttempt): boolean {
  return attempt.status === "completed";
}
