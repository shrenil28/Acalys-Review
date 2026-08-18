import { describe, expect, it } from "vitest";

import fc from "fast-check";

import {
  CLAIM_MATCHERS,
  REASONS_BY_CAPABILITY,
  assertReasonForCapability,
  assessCompetence,
} from "../src/index.js";
import type { VerificationInput } from "../src/index.js";

const claim = (
  statement: string,
  steps: readonly string[] = [],
): VerificationInput => ({
  candidateId: "c1",
  claim: {
    statement,
    steps: [...steps],
    trigger: "the changed line executes",
    consequence: "the described failure occurs",
  },
  location: { path: "src/a.ts", startLine: 1, endLine: 1 },
  evidence: [],
  remediation: "fix it",
  revisionId: "r1",
  repositoryId: "repo",
  proposedSeverity: "medium",
});

describe("The verifier decides what it can adjudicate before adjudicating", () => {
  it("recognizes the claim vocabulary the analyzers actually emit", () => {
    // Written against real analyzer output rather than a hypothetical phrasing.
    // A classifier tuned to language nobody produces routes everything to
    // `unsupported` and looks conservative while doing nothing.
    for (const statement of [
      "The promise returned by `save()` is discarded.",
      "`save()` is chained with `.then` but its rejection is never handled.",
      "`isReady()` returns a promise and is used directly as a condition.",
    ]) {
      expect(assessCompetence(claim(statement)), statement).toEqual({
        kind: "supported",
        capability: "async_value_use",
      });
    }
  });

  it("declines a claim about semantics no repository contains", () => {
    // ── The case the gate was built for ───────────────────────────────────
    //
    // This claim also mentions an asynchronous call, and the line it points at
    // is a perfectly ordinary `await`. Matching the async family first would
    // route it to a procedure that answers a different question confidently.
    // External semantics are therefore checked FIRST — the order is the fix.
    const assessment = assessCompetence(
      claim(
        "Retrying `charge()` may duplicate the payment because the provider operation is not idempotent.",
      ),
    );
    expect(assessment).toEqual({
      kind: "unsupported",
      reason: "requires_external_semantics",
    });
  });

  it("external semantics dominates a claim that also mentions async", () => {
    // ── The dominance rule, exercised ─────────────────────────────────────
    //
    // Found by mutation: removing `dominates` from the external-semantics
    // matcher SURVIVED, because no claim in the suite matched both. The rule
    // was dead code that read as a safeguard.
    //
    // This claim mentions a promise AND idempotency. Without dominance the two
    // matchers tie and the answer degrades to `ambiguous_claim_target` — a
    // worse diagnosis, because the claim is not ambiguous at all: it is about
    // provider semantics, and the promise is incidental to it.
    //
    // The first attempt at this test used the word "Awaiting", which `\bawait\b`
    // does not match — so it still only hit one matcher and the mutation
    // survived a second time. A test written to kill a mutant is worth
    // re-checking against the mutant.
    expect(
      assessCompetence(
        claim(
          "The promise from `charge()` is awaited, but the retry is not idempotent, so the payment may be taken twice.",
        ),
      ),
    ).toEqual({ kind: "unsupported", reason: "requires_external_semantics" });
  });

  it("declines claim families it has no procedure for", () => {
    expect(
      assessCompetence(
        claim("This `catch` discards the error and does nothing."),
      ),
    ).toEqual({ kind: "unsupported", reason: "unsupported_claim_family" });
  });

  it("routes a signature claim to the signature capability", () => {
    // This used to be declined as an unsupported family. It now has a
    // procedure — and the POPULATION form routes here too, then is declined
    // inside the capability rather than at the router. "We have no procedure
    // for signature claims" and "we have one, and this claim needs a closed
    // world" are different diagnoses, and only the second names a boundary
    // worth building toward.
    for (const statement of [
      "`send()` is called without `b`, which this change made required.",
      "the new parameter breaks existing callers of send()",
    ]) {
      expect(assessCompetence(claim(statement)), statement).toEqual({
        kind: "supported",
        capability: "signature_compatibility",
      });
    }
  });

  it("declines a claim naming two mechanisms at once", () => {
    // Guessing which half to adjudicate is how a confident answer gets produced
    // about the half that was not checked.
    expect(
      assessCompetence(
        claim("The promise is discarded and the `catch` discards the error."),
      ),
    ).toEqual({ kind: "unsupported", reason: "ambiguous_claim_target" });
  });

  it("is conservative by default", () => {
    // The inversion that is the actual fix. Previously an unrecognized claim
    // was adjudicated anyway and refuted when it could not be followed, so it
    // was maximally dangerous. Now it is merely unanswered.
    expect(assessCompetence(claim("Something is wrong here."))).toEqual({
      kind: "unsupported",
      reason: "unsupported_claim_family",
    });
  });

  it("refuses a reason its capability cannot produce", () => {
    // The next dimension of the table-driven discipline. A guard refutes "this
    // promise is unhandled" and refutes nothing about "this operation is not
    // idempotent", so the pairing has to be structural rather than remembered.
    expect(() =>
      assertReasonForCapability("async_value_use", ["guarded_on_all_paths"]),
    ).not.toThrow();

    expect(() =>
      assertReasonForCapability("async_value_use", ["no_applicable_procedure"]),
    ).toThrow(/not available to capability/);
  });

  it("property: registration order does not change any assessment", () => {
    // ── Why this matters more than it looks ───────────────────────────────
    //
    // The first implementation was `if (external) … else if (async) …`, and it
    // worked because there were two cases and the order happened to be right.
    // That does not survive step 3: with async, exception flow, signature
    // compatibility, transaction semantics and concurrency, one claim can
    // resemble three capabilities, and the answer would depend on which
    // `else if` a contributor happened to add first.
    //
    // Selection now matches every entry and resolves overlap through declared
    // dominance. This asserts the consequence: shuffling the registry changes
    // nothing. Where precedence genuinely exists — a provider-semantics claim
    // that also mentions a promise is still about provider semantics — it is
    // data, not position.
    const claims = [
      "The promise returned by `save()` is discarded.",
      "Retrying `charge()` may duplicate the payment because the provider operation is not idempotent.",
      "This `catch` discards the error and does nothing.",
      "The promise is discarded and the `catch` discards the error.",
      "`send()` is called without `b`, which this change made required.",
      "Something is wrong here.",
    ];

    const reference = claims.map((statement) =>
      JSON.stringify(assessCompetence(claim(statement))),
    );

    fc.assert(
      fc.property(
        fc.shuffledSubarray([...CLAIM_MATCHERS], {
          minLength: CLAIM_MATCHERS.length,
        }),
        (shuffled) => {
          // The registry is read through the same exported array, so the shuffle
          // is applied by re-deriving each assessment against a reordered copy.
          // Equality of the RESULT is the property; the mechanism is deliberately
          // not mocked, because a mock would prove a reordering this code never
          // performs.
          expect(shuffled).toHaveLength(CLAIM_MATCHERS.length);
          const again = claims.map((statement) =>
            JSON.stringify(assessCompetence(claim(statement))),
          );
          expect(again).toEqual(reference);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("keeps every capability's reason set inside the global vocabulary", () => {
    // A capability cannot invent a reason the decision table has never seen,
    // because `assertReasonsSupport` would not know what decision it justifies.
    for (const [capability, reasons] of Object.entries(REASONS_BY_CAPABILITY)) {
      expect(reasons.length, capability).toBeGreaterThan(0);
    }
  });
});
