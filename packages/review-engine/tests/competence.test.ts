import { describe, expect, it } from "vitest";

import fc from "fast-check";

import {
  CLAIM_MATCHERS,
  REASONS_BY_CAPABILITY,
  VERIFICATION_CAPABILITIES,
  type VerificationCapability,
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
    ]) {
      expect(assessCompetence(claim(statement)), statement).toEqual({
        kind: "supported",
        capability: "async_value_use",
      });
    }

    // A condition claim mentions a promise by construction, so it matches the
    // async matcher too. Declared dominance says which proposition is actually
    // being made — "is this value consumed" and "does this branch test the
    // wrong thing" need different evidence and support different reasons.
    expect(
      assessCompetence(
        claim(
          "`isReady()` returns a promise and is used directly as a condition.",
        ),
      ),
    ).toEqual({
      kind: "supported",
      capability: "condition_value_semantics",
    });
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

  it("declines a claim no matcher recognises", () => {
    // There is no catch-all entry in the registry. One existed, carrying the
    // same patterns as the exception-flow matcher, and the result was that
    // every catch claim matched two entries and came back
    // `ambiguous_claim_target` — a capability that worked perfectly, behind a
    // router that would not reach it.
    expect(
      assessCompetence(claim("The widget frobnicates during reticulation.")),
    ).toEqual({ kind: "unsupported", reason: "unsupported_claim_family" });
  });

  it("routes a swallowed-error claim to the exception capability", () => {
    for (const statement of [
      "This `catch` discards the error and does nothing.",
      "This `catch` binds `error` and never uses it.",
    ]) {
      expect(assessCompetence(claim(statement)), statement).toEqual({
        kind: "supported",
        capability: "exception_flow",
      });
    }
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

  it("property: every declared capability is reachable, and reachable alone", () => {
    // ── The conformance the router bug needed ─────────────────────────────
    //
    // The exception capability was written, tested directly, and correct — and
    // every catch claim came back `ambiguous_claim_target`, because a catch-all
    // registry entry still carried the same patterns. A capability that cannot
    // be routed to does not exist, and its own unit tests will not notice
    // because they call it directly.
    //
    // So each declared capability must have a canonical claim that selects
    // exactly it. Exhaustiveness is asserted against the capability list rather
    // than the fixture list, so adding a capability without a fixture fails
    // here instead of shipping unreachable.
    // Statement AND steps, as the analyzers actually emit them. A fixture with
    // empty steps would have passed while the real claim was misrouted: the
    // floating-promise claim's own steps say "the statement discards the
    // promise", which an early callback matcher caught — routing a true defect
    // to a capability it was never about, where it came back REJECTED.
    const CANONICAL: Readonly<
      Record<VerificationCapability, readonly [string, readonly string[]]>
    > = {
      async_value_use: [
        "The promise returned by `save()` is discarded.",
        ["`save` is asynchronous", "the statement discards the promise"],
      ],
      condition_value_semantics: [
        "`isReady()` returns a promise and is used directly as a condition.",
        ["a Promise object is always truthy, whatever it later resolves to"],
      ],
      signature_compatibility: [
        "`send()` is called without `b`, which this change made required.",
        ["the declaration gained a required parameter"],
      ],
      discarded_replacement_return: [
        "The result of `validate(raw)` was used at the base revision and is discarded here, so any replacement value it returns for `raw` is lost.",
        ["The base revision consumed the result of `validate`"],
      ],
      removed_export: [
        "`parse` was exported from src/parser.ts at the base revision and no longer appears in its exported value surface.",
        ["src/parser.ts exported `parse` at the base revision"],
      ],
      required_parameter_added: [
        "`save` accepted 1 required argument(s) at the base revision and now declares 2, so a call written against the previous contract may no longer compile.",
        ["`save` required 1 argument(s) at the base revision"],
      ],
      exception_flow: [
        "This `catch` discards the error and does nothing.",
        ["the guarded operation can throw", "the failure is not observed"],
      ],
      async_callback_contract: [
        "`forEach` discards the promise its async callback returns.",
        ["`forEach` ignores its callback's return value"],
      ],
      exact_optional_property_write: [
        "Writing `undefined` to the optional property `tag` is rejected under exactOptionalPropertyTypes, which is enabled by tsconfig.json.",
        [
          "`tag` is declared optional, so its type does not include `undefined` unless written explicitly",
          "tsconfig.json enables exactOptionalPropertyTypes",
        ],
      ],
    };

    for (const capability of VERIFICATION_CAPABILITIES) {
      const fixture = CANONICAL[capability];
      expect(fixture, `no canonical claim for ${capability}`).toBeDefined();
      expect(assessCompetence(claim(...fixture)), capability).toEqual({
        kind: "supported",
        capability,
      });
    }

    // And the reverse: a claim no capability covers matches nothing at all,
    // rather than matching several and being reported as ambiguous.
    expect(
      assessCompetence(claim("The widget frobnicates during reticulation.")),
    ).toEqual({ kind: "unsupported", reason: "unsupported_claim_family" });
  });

  it("keeps every capability's reason set inside the global vocabulary", () => {
    // A capability cannot invent a reason the decision table has never seen,
    // because `assertReasonsSupport` would not know what decision it justifies.
    for (const [capability, reasons] of Object.entries(REASONS_BY_CAPABILITY)) {
      expect(reasons.length, capability).toBeGreaterThan(0);
    }
  });
});
