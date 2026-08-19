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
  /**
   * Whether a call still satisfies a changed callable contract.
   *
   * Covers a **named call site** and nothing else. Claims about "existing
   * callers" or external consumers are a different proposition — a population
   * rather than a site — and are declined, because refuting them needs a closed
   * world this verifier cannot establish.
   */
  "signature_compatibility",
  /**
   * Whether a branch tests the truthiness of a promise instead of the boolean
   * the author intended.
   *
   * Deliberately not "control flow". `items.forEach(async …)` is an async
   * defect and is **not** this proposition — it is about a callback contract
   * and an iterator discarding the promise it is handed. Folding them together
   * is the road back to one procedure that recognises many shapes and is
   * eventually confident about a claim it never checked.
   */
  "condition_value_semantics",
  /**
   * Whether a suppressed failure violates a contract or honours one.
   *
   * The capability most likely to be wrong if it is decisive, so it is built to
   * abstain unless one direction has affirmative evidence. `catch {}` is a
   * syntax; the defect is a consequence.
   */
  "exception_flow",
  /**
   * Whether the API receiving an async callback drops the promise it returns,
   * and whether anything depended on that work finishing.
   *
   * Separate from `async_value_use` because the disputed fact is about the
   * RECEIVER's contract, not the callee's. `items.forEach(async …)` and
   * `await queue.forEach(async …)` are the same syntax with opposite verdicts.
   */
  "async_callback_contract",
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
  async_callback_contract: [
    "callback_result_discarded_by_receiver",
    "receiver_awaits_callback_result",
    "callback_returns_no_promise",
    "receiver_contract_unavailable",
    "completion_relevance_unestablished",
    "context_incomplete",
  ],
  exception_flow: [
    "suppressed_failure_reported_as_success",
    "failure_suppression_is_contracted",
    "intent_not_establishable",
    "conflicting_independent_evidence",
    "context_incomplete",
  ],
  condition_value_semantics: [
    "condition_branches_on_promise",
    "condition_value_is_not_a_promise",
    "insufficient_evidence",
    "context_incomplete",
  ],
  signature_compatibility: [
    "contract_violated_at_call_site",
    "call_site_satisfies_contract",
    "consumer_scope_unbounded",
    "context_incomplete",
  ],
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
 * The capability registry.
 *
 * Declarative on purpose. The first implementation was a chain —
 * `if (external) … else if (async) …` — and it worked because there were two
 * cases and the order happened to be right. That does not survive step 3: with
 * async, exception flow, signature compatibility, transaction semantics and
 * concurrency, one claim can syntactically resemble three capabilities, and the
 * answer would depend on which `else if` a contributor happened to add first.
 *
 * So selection is: match every entry, then decide from how many matched.
 *
 * ```
 * 0 matched   no_applicable_procedure   → inconclusive
 * 1 matched   run that procedure
 * n matched   an explicit dominance rule, or ambiguous_claim_target
 * ```
 *
 * Registration order is therefore not load-bearing, and a property test
 * asserts it: shuffling this array must not change any assessment.
 *
 * # Dominance, where semantics genuinely require it
 *
 * `external_semantics` dominates everything it overlaps with, and that is a
 * claim about the world rather than a tie-break. The provider case says
 * *"retrying `charge()` may double-charge because the provider is not
 * idempotent"* — it mentions an asynchronous call, so the async matcher fires
 * too, and it is genuinely a claim about payment semantics that no amount of
 * TypeScript can settle. Dominance is declared as data, not encoded in
 * position.
 */
export interface ClaimMatcher {
  /** The capability this routes to, or `undefined` when it only declines. */
  readonly capability: VerificationCapability | undefined;
  /** Reported when this matcher wins and has no capability. */
  readonly declines: CompetenceFailure | undefined;
  readonly patterns: readonly RegExp[];
  /**
   * Matchers this one overrides when both fire.
   *
   * Declared rather than positional, so adding a capability cannot silently
   * change an existing routing decision by landing above or below it.
   */
  readonly dominates: readonly string[];
  readonly id: string;
}

export const CLAIM_MATCHERS: readonly ClaimMatcher[] = [
  {
    id: "external_semantics",
    capability: undefined,
    declines: "requires_external_semantics",
    patterns: [
      /\bidempoten/i,
      /\bexactly[- ]once\b/i,
      /\bat[- ]least[- ]once\b/i,
      /\bprovider\b/i,
      /\bthird[- ]party\b/i,
      /\bupstream service\b/i,
      /\brate[- ]limit/i,
    ],
    // A claim about provider semantics that also mentions a promise is still a
    // claim about provider semantics.
    dominates: [
      "async_value_use",
      "signature_compatibility",
      "condition_value_semantics",
      "exception_flow",
      "async_callback_contract",
    ],
  },
  {
    id: "condition_value_semantics",
    capability: "condition_value_semantics",
    declines: undefined,
    // The analyzer's exact phrasing — "`isReady()` returns a promise and is
    // used directly as a condition", with a step reading "a Promise object is
    // always truthy". Narrow on purpose: a claim merely mentioning a promise
    // belongs to the async capability, and only a claim about the BRANCH
    // belongs here.
    patterns: [
      /\bused directly as a condition\b/i,
      /\balways truthy\b/i,
      /\bguard never fails\b/i,
      /\bbranch(?:es)? on\b/i,
    ],
    // A condition claim mentions a promise by construction, so it matches the
    // async matcher too. Dominance says which proposition is actually being
    // made, rather than leaving it to whichever matcher is written first.
    dominates: ["async_value_use"],
  },
  {
    id: "async_value_use",
    capability: "async_value_use",
    declines: undefined,
    // Written against the vocabulary the analyzers actually emit — "the promise
    // returned by `f()` is discarded", "its rejection is never handled",
    // "returns a promise and is used directly as a condition" — rather than a
    // hypothetical phrasing. A classifier tuned to language nobody produces
    // routes everything to `unsupported` and looks conservative while doing
    // nothing.
    patterns: [
      /\bpromise\b/i,
      /\brejection\b/i,
      /\bawait\b/i,
      /\basynchronous\b/i,
    ],
    dominates: [],
  },
  {
    id: "signature_compatibility",
    capability: "signature_compatibility",
    declines: undefined,
    // The vocabulary the signature analyzer emits — "`send()` is called without
    // `b`, which this change made required" — plus the population phrasings,
    // which route here and are then declined *inside* the capability. Declining
    // there rather than here is deliberate: "we have no procedure for signature
    // claims" and "we have one, and this particular claim needs a closed world"
    // are different diagnoses.
    patterns: [
      /\bis called without\b/i,
      /\bmade required\b/i,
      /\bnew parameter\b/i,
      /\bexisting callers\b/i,
      /\bsignature\b/i,
      /\bbreaks? (?:existing )?(?:callers|consumers)\b/i,
    ],
    dominates: [],
  },
  {
    id: "async_callback_contract",
    capability: "async_callback_contract",
    declines: undefined,
    // The analyzer's phrasing: "`forEach` discards the promise its async
    // callback returns." Matches on the RECEIVER relationship rather than on
    // the word `promise`, which every async claim contains.
    // Keyed on the RECEIVER relationship, not on the word "promise".
    //
    // The first draft matched `/\bdiscards the promise\b/`, which a plain
    // floating-promise claim legitimately says in its own steps — "the
    // statement discards the promise". That claim was then routed here, found
    // no async callback, and came back REJECTED: a true defect refuted by a
    // capability it was never about. The over-match cost more than the
    // under-match would have.
    patterns: [
      /\basync callback\b/i,
      /\bcallback(?:'s)? (?:return|result)\b/i,
      /\bdiscards the promise its\b/i,
    ],
    // Mentions a promise by construction, so it overlaps the async matcher.
    dominates: ["async_value_use"],
  },
  {
    id: "exception_flow",
    capability: "exception_flow",
    declines: undefined,
    // The swallowed-error analyzer's phrasings: "This `catch` discards the
    // error and does nothing." and "This `catch` binds `e` and never uses it."
    patterns: [
      /\bcatch\b/i,
      /\bdiscards the error\b/i,
      /\bnever uses it\b/i,
      /\bswallow/i,
    ],
    dominates: [],
  },
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
  /**
   * The registry to consult. Injectable **only** so the order-independence
   * property can genuinely reorder it — a test that shuffled a copy this
   * function never reads would assert nothing, which is the exact vacuity this
   * project keeps finding.
   */
  matchers: readonly ClaimMatcher[] = CLAIM_MATCHERS,
): CompetenceAssessment {
  const text = [input.claim.statement, ...input.claim.steps].join(" ");

  const matched = matchers.filter((matcher) =>
    matcher.patterns.some((pattern) => pattern.test(text)),
  );

  if (matched.length === 0) {
    // No matcher fired. There is no "declines everything else" entry in the
    // registry — one existed, carrying the same patterns as the exception-flow
    // matcher, and the result was that every catch claim matched two entries
    // and was reported as `ambiguous_claim_target`. A capability that works
    // perfectly is worth nothing behind a router that will not reach it.
    return { kind: "unsupported", reason: "unsupported_claim_family" };
  }

  // Drop anything a matched matcher dominates. Order-independent: the result
  // is the same whichever order the registry is written in.
  const dominated = new Set(matched.flatMap((matcher) => matcher.dominates));
  const surviving = matched.filter((matcher) => !dominated.has(matcher.id));

  if (surviving.length > 1) {
    // A claim naming two mechanism families with no declared dominance between
    // them. Guessing which half to adjudicate is how a confident answer gets
    // produced about the half that was not checked.
    return { kind: "unsupported", reason: "ambiguous_claim_target" };
  }

  const winner = surviving[0] ?? matched[0];
  if (winner === undefined || winner.capability === undefined) {
    return {
      kind: "unsupported",
      reason: winner?.declines ?? "unsupported_claim_family",
    };
  }
  return { kind: "supported", capability: winner.capability };
}
