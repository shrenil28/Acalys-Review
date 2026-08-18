/**
 * What the verifier is competent to judge, decided before it judges anything.
 *
 * P1-J.2 found the same defect three times, through three different branches:
 *
 * ```
 * a shape it could not parse            → rejected  "mechanism not present"
 * a signature claim on a declaration    → rejected  "mechanism not present"
 * a retry-idempotency claim on `await`  → rejected  "guarded on all paths"
 * ```
 *
 * The third is the clearest. The claim was *"retrying charge() may duplicate
 * the payment because the provider is not idempotent"*. The verifier looked at
 * the claimed line, saw `await charge(100)`, concluded the promise was handled,
 * and refuted the claim. The promise **is** handled. The claim was never about
 * the promise.
 *
 * One root cause: the verifier applies the single mechanism it models to every
 * claim it is given, so a syntactic observation about async values gets to
 * refute propositions about payment semantics. Widening its reach would have
 * added branches that misfire the same way on more claims.
 *
 * So there is a boundary before adjudication, and it asks a different question:
 *
 * ```
 * competence:  do I have a procedure capable of settling THIS KIND of claim?
 * adjudication: given that procedure, is the claim true?
 * ```
 *
 * # Not a boolean
 *
 * `canVerify(): boolean` is the mistake this project has now made twice —
 * `SiteObservation.found` collapsed three situations into one bit and cost four
 * true findings. An unsupported assessment carries **why**, because "we do not
 * model this claim family" and "this needs semantics no repository contains"
 * lead to different work: the first is a capability to build, the second may be
 * permanently out of reach.
 *
 * # Conservative by default
 *
 * A claim is unsupported unless it is *positively recognized*. That inversion
 * is the fix: the previous behaviour was to adjudicate anything and refute what
 * it could not follow, so an unrecognized claim was maximally dangerous. Now it
 * is merely unanswered.
 *
 * # What this deliberately does NOT do
 *
 * It does not widen any mechanism. Recall does not improve here, and
 * abstentions go **up** — a signature-compatibility claim that was being
 * refuted by accident now correctly reads as one the verifier cannot settle.
 * Trading a coincidentally-right answer for an honest abstention is a quality
 * improvement even though the score falls.
 */

import type { VerificationReason } from "./decide.js";
import type { VerificationInput } from "./input.js";

/**
 * Procedures the verifier has.
 *
 * One, today. The list is short on purpose: a capability is a claim family the
 * verifier can genuinely adjudicate, and claiming more than it has is exactly
 * the failure above.
 */
export const VERIFICATION_CAPABILITIES = [
  /**
   * Whether an asynchronous value produced at a call site is consumed.
   *
   * Covers "the promise is discarded", "the rejection is never handled", and
   * their refutations. Does **not** cover what the asynchronous operation
   * means — idempotency, ordering, transactional scope — which is why the
   * provider-semantics claim must not reach it.
   */
  "async_value_use",
] as const;

export type VerificationCapability = (typeof VERIFICATION_CAPABILITIES)[number];

/**
 * Why no procedure applies. Closed, and each entry implies different work.
 */
export const COMPETENCE_FAILURES = [
  /** No capability adjudicates claims of this kind. Build one, or do not. */
  "unsupported_claim_family",
  /**
   * The claim turns on semantics of something outside the repository — a
   * provider's idempotency, a service's ordering guarantee.
   *
   * Distinct from `unsupported_claim_family` because no amount of TypeScript
   * analysis will ever settle it. The evidence would have to come from a
   * contract, a test against the real service, or an authority.
   */
  "requires_external_semantics",
  /** Settling it needs analysis across call boundaries the verifier lacks. */
  "requires_interprocedural_analysis",
  /** The claim names more than one mechanism, or none identifiably. */
  "ambiguous_claim_target",
] as const;

export type CompetenceFailure = (typeof COMPETENCE_FAILURES)[number];

export type CompetenceAssessment =
  | { readonly kind: "supported"; readonly capability: VerificationCapability }
  | { readonly kind: "unsupported"; readonly reason: CompetenceFailure };

/**
 * Which reasons each capability may produce.
 *
 * The next dimension of the table-driven discipline already applied to
 * `decision ↔ reason`. `guarded_on_all_paths` is not globally available: a
 * guard refutes *"this promise is unhandled"* and refutes nothing at all about
 * *"this operation is not idempotent"*, so the combination
 *
 * ```
 * claim   provider retry is not idempotent
 * reason  guarded_on_all_paths
 * ```
 *
 * is now unconstructible rather than merely wrong — which is stronger than
 * adding another `if`, because the next capability cannot reintroduce it by
 * forgetting.
 */
export const REASONS_BY_CAPABILITY: Readonly<
  Record<VerificationCapability, readonly VerificationReason[]>
> = {
  async_value_use: [
    "evidence_supports_claim",
    "independent_context_confirms",
    "claim_contradicted_by_context",
    "claimed_mechanism_not_present",
    "guarded_on_all_paths",
    "insufficient_evidence",
    "context_incomplete",
    "conflicting_independent_evidence",
  ],
};

/** Reasons available when no capability applied. */
export const UNSUPPORTED_REASONS: readonly VerificationReason[] = [
  "no_applicable_procedure",
];

export function assertReasonForCapability(
  capability: VerificationCapability,
  reasons: readonly VerificationReason[],
): void {
  const allowed = REASONS_BY_CAPABILITY[capability];
  const wrong = reasons.filter((reason) => !allowed.includes(reason));
  if (wrong.length > 0) {
    throw new Error(
      `Reason(s) ${wrong.join(", ")} are not available to capability \`${capability}\`. ` +
        "A syntactic observation must not be allowed to settle a proposition it " +
        "says nothing about.",
    );
  }
}

/**
 * Claims that turn on semantics no repository contains.
 *
 * Checked **first**, because such a claim often also mentions a promise — the
 * provider case says "retrying `charge()`" and `charge` is asynchronous — and
 * matching the async family first would route it to a procedure that cannot
 * settle it. Order here is the fix, not an optimisation.
 */
const EXTERNAL_SEMANTICS: readonly RegExp[] = [
  /\bidempoten/i,
  /\bexactly[- ]once\b/i,
  /\bat[- ]least[- ]once\b/i,
  /\bprovider\b/i,
  /\bthird[- ]party\b/i,
  /\bupstream service\b/i,
  /\brate[- ]limit/i,
];

/**
 * Claims about whether an asynchronous value is consumed.
 *
 * Written against the vocabulary the analyzers actually emit — "the promise
 * returned by `f()` is discarded", "its rejection is never handled", "returns a
 * promise and is used directly as a condition" — rather than against a
 * hypothetical phrasing. A classifier tuned to language nobody produces routes
 * everything to `unsupported` and looks conservative while doing nothing.
 */
const ASYNC_VALUE_USE: readonly RegExp[] = [
  /\bpromise\b/i,
  /\brejection\b/i,
  /\bawait\b/i,
  /\basynchronous\b/i,
];

/**
 * Claims about control flow, exception flow and interface compatibility.
 *
 * Recognized only to be *declined*. Naming them is what makes the gap
 * diagnosable: `unsupported_claim_family` on a swallowed-error claim is a
 * capability to build, and the funnel's stage attribution can say so.
 */
const OTHER_FAMILIES: readonly RegExp[] = [
  /\bcatch\b/i,
  /\bdiscards the error\b/i,
  /\bnever uses it\b/i,
  /\bis called without\b/i,
  /\brequired\b/i,
];

/**
 * Decides which procedure, if any, can settle this claim.
 *
 * Reads the **proposition** — the claim's own statement and steps — not the
 * syntax at the claimed line. The provider case is why: its line is a perfectly
 * ordinary `await`, and any classifier working from the line would route it to
 * the async procedure and get a confident, irrelevant answer.
 */
export function assessCompetence(
  input: VerificationInput,
): CompetenceAssessment {
  const text = [input.claim.statement, ...input.claim.steps].join(" ");

  if (EXTERNAL_SEMANTICS.some((pattern) => pattern.test(text))) {
    return { kind: "unsupported", reason: "requires_external_semantics" };
  }

  const asyncClaim = ASYNC_VALUE_USE.some((pattern) => pattern.test(text));
  const otherClaim = OTHER_FAMILIES.some((pattern) => pattern.test(text));

  // A claim naming two mechanism families is one this verifier cannot target.
  // Guessing which half to adjudicate is how a confident answer gets produced
  // about the half that was not checked.
  if (asyncClaim && otherClaim) {
    return { kind: "unsupported", reason: "ambiguous_claim_target" };
  }
  if (asyncClaim) {
    return { kind: "supported", capability: "async_value_use" };
  }

  return { kind: "unsupported", reason: "unsupported_claim_family" };
}
