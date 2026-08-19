import { describe, expect, it } from "vitest";

import { ANALYZER_CORPUS, evaluateFunnel } from "../src/eval/index.js";

/**
 * The end-to-end baseline: the corpus run through the whole funnel.
 *
 * The analyzer dashboard reports recall 1.0 and precision 1.0. Running the same
 * corpus through verification, promotion and policy reports **published recall
 * 0.8** — two of ten real defects the analyzer found still never reach a
 * developer, and both are silent catches whose intent the repository does not
 * record.
 *
 * Neither number is wrong. They measure different systems, and only the second
 * is the product. This file exists so the difference cannot quietly grow, and
 * so that every movement in it is attributable to one named capability.
 */
describe("The funnel baseline", () => {
  it("never rejects a true defect", async () => {
    // ── The invariant that matters most, measured end to end ──────────────
    //
    // P1-H's rule is that missing evidence may degrade `verified →
    // inconclusive` and must NEVER reach `rejected`. It held in the verifier's
    // own unit tests, which only ever fed it shapes it models.
    //
    // Run over the corpus, the first version rejected FOUR of ten real defects
    // — a `Promise` in an `if` condition, an empty `catch`, a changed
    // signature — because `observeSite` returned one boolean for three
    // different situations:
    //
    //     nothing at the claimed line          the planner failed
    //     a shape I do not model               my reach failed
    //     the mechanism is provably absent     a real refutation
    //
    // and the caller turned all three into `rejected` at 0.8 confidence. Every
    // precision metric stayed at 1.0 while the verifier silently deleted the
    // analyzer's work and recorded it as the analyzer being wrong.
    //
    // A rejection blames the analyzer. `inconclusive` blames the verifier or
    // the planner. Getting that backwards sends every future investigation to
    // the wrong component.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    const wronglyRejected = report.journeys.filter(
      (journey) =>
        journey.wanted &&
        journey.attempt.status === "completed" &&
        journey.attempt.decision === "rejected",
    );

    expect(
      wronglyRejected.map((journey) => journey.caseId),
      "the verifier refuted a defect the corpus says is real",
    ).toEqual([]);
  });

  it("the analyzer no longer produces the false positive at all", async () => {
    // ── Where the natural corpus stands after 2b ──────────────────────────
    //
    //     analyzer precision    10/11 → 1.0    lexical scope walk
    //     published precision     5/5   → 1.0   unchanged
    //     published recall        0.5   → 0.5   unchanged at the time
    //
    // The order mattered. The verifier was given independent binding first and
    // shown to stop the candidate — the only natural evidence that verification
    // filters anything — and the analyzer was fixed only after that evidence
    // was collected. Reversed, the fix would have deleted the measurement.
    //
    // And the two components were fixed by DIFFERENT means: the analyzer walks
    // lexical scopes in `@acalys/code-intelligence`, the verifier binds through
    // the TypeScript checker. Fixing both with one shared resolver would have
    // restored precision and quietly undone the independence that produced it.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    expect(report.candidatePrecision).toBe(1);
    expect(report.publishedPrecision).toBe(1);
    expect(report.falsePositivesPublished).toBe(0);

    // No candidate at all for the shadowed case.
    expect(
      report.journeys.filter(
        (journey) => journey.caseId === "shadowed-parameter-is-not-a-defect",
      ),
    ).toEqual([]);
  });

  it("reports an absent denominator rather than a flattering zero", async () => {
    // ── The consequence the metric split was built for ────────────────────
    //
    // With the analyzer fixed, the natural corpus contains no false positives,
    // so the live filter rate has no denominator. It is `undefined`, not `0`
    // and not `1`:
    //
    //     0 / 0 rendered as 0   "verification caught nothing"
    //     0 / 0 rendered as 1   "verification caught everything"
    //
    // Both are claims about a measurement that was never taken. The evidence
    // that the verifier filters this candidate is not lost — it moved to the
    // historical replay challenge, where it is measured against the verifier
    // rather than against a pipeline that no longer produces the input.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    expect(report.falsePositivesFiltered).toBe(0);
    expect(report.falsePositiveFilterRate).toBeUndefined();
    expect(report.falsePositiveRefutationRate).toBeUndefined();
  });

  it("an empty corpus yields undefined ratios, not flattering ones", async () => {
    // The degenerate case, kept separate from the live one above because they
    // fail for different reasons: this catches a harness that evaluated
    // nothing, that one catches a corpus that lost its false positives.
    const empty = await evaluateFunnel([]);
    expect(empty.candidatePrecision).toBeUndefined();
    expect(empty.publishedPrecision).toBeUndefined();
    expect(empty.publishedRecall).toBeUndefined();
    expect(empty.falsePositiveFilterRate).toBeUndefined();
    expect(empty.falsePositiveRefutationRate).toBeUndefined();
    expect(empty.tokensPerPublishedFinding).toBeUndefined();
  });

  it("records whether the two sides agreed by different means", async () => {
    // ── Descriptive, not a score ──────────────────────────────────────────
    //
    // The shadowed-parameter false positive survived two structurally
    // independent components because both searched for a declaration by NAME.
    // The second agreeing carried no information, and nothing in the report
    // said so — "two stages concurred" and "two stages called the same broken
    // helper" looked identical.
    //
    // Every verdict now names how each side settled its fact. Zero correlation
    // today: the analyzer proposes from the symbol graph, and every capability
    // adjudicates through the checker, its diagnostics, or consequence
    // analysis.
    //
    // Deliberately NOT `independenceScore = 0.73`. Sometimes the compiler is
    // the authoritative evidence and both sides should use it; a number would
    // become something to optimize before anyone knows what it means.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    expect(report.correlatedDerivations).toBe(0);
    for (const journey of report.journeys) {
      expect(journey.derivation?.candidate).toBe(
        "code_intelligence_symbol_graph",
      );
      expect(journey.derivation?.shared).toBeUndefined();
    }

    // And the channels are actually varied, so "no correlation" is a
    // measurement rather than a consequence of every capability being the same.
    const channels = new Set(
      report.journeys.map((journey) => journey.derivation?.verification),
    );
    expect(channels.size).toBeGreaterThanOrEqual(2);
  });

  it("attributes every lost defect to exactly one stage", async () => {
    // `publishedRecall = 0.8` is equally consistent with a planner that fetched
    // nothing, an analyzer that saw nothing, a verifier that refused, a verifier
    // that could not tell, an outage, and a policy that withheld. Six fixes,
    // three owners. The decomposition is what makes the number actionable.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    const attributed = Object.values(report.losses).reduce(
      (total, value) => total + value,
      0,
    );
    // Every loss accounted for. An attribution that does not add up is one that
    // is hiding the losses it cannot explain.
    expect(attributed).toBe(report.planted - report.truePositivesPublished);

    // Still one stage, which is the whole diagnosis: the analyzer and planner
    // lost nothing, policy withheld nothing, nothing was refuted, and nothing
    // was unavailable. The verifier could not tell.
    expect(report.losses).toEqual({
      not_proposed: 0,
      verifier_refuted: 0,
      // 5 → 4 → 3 → 2. Signature, condition-value and now the async callback
      // contract each took one. The remaining two are both exception-flow, and
      // both may be permanent: a `catch {}` in a function that does nothing
      // afterwards is best-effort teardown and a forgotten handler at the same
      // time, and the repository does not say which.
      verifier_abstained: 2,
      verification_unavailable: 0,
      policy_withheld: 0,
    });
  });

  it("exercises the whole funnel, not a prefix of it", async () => {
    // Guards the vacuity this project keeps finding: a baseline computed over
    // zero candidates would satisfy every assertion above.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    expect(report.cases).toBeGreaterThan(0);
    expect(report.candidates).toBeGreaterThan(0);
    expect(report.verified).toBeGreaterThan(0);
    expect(report.published).toBeGreaterThan(0);
    // Every candidate reached a decision; none was left unexamined.
    expect(
      report.verified +
        report.rejected +
        report.inconclusive +
        report.unavailable,
    ).toBe(report.candidates);
    expect(report.verificationTokens).toBeGreaterThan(0);
  });

  it("records the committed baseline", async () => {
    // ── Census, not a frozen contract ────────────────────────────────────
    //
    // These numbers are expected to move, and moving them is the point of the
    // next checkpoint. They are asserted so a change is *deliberate* — a silent
    // drop in published recall is indistinguishable from a quiet regression,
    // and the analyzer dashboard would keep reporting 1.0 throughout.
    //
    // What each number is currently saying:
    //
    //     published recall 0.8     two defects sit at `inconclusive`, both
    //                              silent catches. Unlike every earlier
    //                              abstention, these may be permanent rather
    //                              than a capability yet to be built.
    //     published precision 1.0  every published finding is real, against an
    //                              analyzer precision of 10/11 — verification
    //                              now buys precision instead of costing it.
    //     FP rates undefined       no false positives left in the natural
    //                              corpus. Not zero — there is no denominator,
    //                              and the evidence moved to the replay corpus.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    expect({
      candidates: report.candidates,
      verified: report.verified,
      rejected: report.rejected,
      inconclusive: report.inconclusive,
      promoted: report.promoted,
      published: report.published,
      publishedRecall: report.publishedRecall,
      publishedPrecision: report.publishedPrecision,
    }).toEqual({
      candidates: 10,
      verified: 8,
      rejected: 0,
      inconclusive: 2,
      promoted: 8,
      published: 8,
      // 0.7 → 0.8, attributable to the async callback contract capability:
      // `async-callback-in-foreach` moved from `inconclusive` to `verified`,
      // and no other journey changed. The two catch cases in particular did
      // not — if they had, the capability would have escaped its boundary.
      publishedRecall: 0.8,
      // Every published finding is real, and so is every candidate: the
      // analyzer's one false positive is gone at source. The verifier's
      // ability to stop it is preserved as a historical replay challenge.
      publishedPrecision: 1,
    });
  });
});
