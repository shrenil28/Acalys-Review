import { describe, expect, it } from "vitest";

import { ANALYZER_CORPUS, evaluateFunnel } from "../src/eval/index.js";

/**
 * The end-to-end baseline: the corpus run through the whole funnel.
 *
 * The analyzer dashboard reports recall 1.0 and precision 1.0. Running the same
 * corpus through verification, promotion and policy reports **published recall
 * 0.5** — half the real defects the analyzer found never reach a developer,
 * because the deterministic verifier cannot re-derive their mechanism.
 *
 * Neither number is wrong. They measure different systems, and only the second
 * is the product. This file exists so the difference cannot quietly grow.
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

  it("verification now BUYS precision, without costing more recall", async () => {
    // ── The demonstration step 2 exists to produce ────────────────────────
    //
    // Before epistemic independence:
    //
    //     candidate precision   10/11
    //     published precision    5/6     verification made it WORSE
    //     published recall       0.5
    //
    // After:
    //
    //     candidate precision   10/11
    //     published precision    5/5     the analyzer's false positive stopped
    //     published recall       0.5     unchanged
    //
    // The verifier removed the analyzer's only false positive and cost nothing
    // extra in recall. That is the first point at which it pays for itself on
    // the natural corpus rather than on hand-written challenges.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    expect(report.publishedPrecision).toBe(1);
    expect(report.candidatePrecision).toBe(0.9091);
    expect(report.publishedPrecision ?? 0).toBeGreaterThan(
      report.candidatePrecision ?? 1,
    );
    expect(report.falsePositivesPublished).toBe(0);
    expect(report.falsePositivesCaught).toBe(1);
  });

  it("no longer shares the analyzer's blind spot", async () => {
    // ── Structural independence was never the hard part ───────────────────
    //
    // P1-H stopped the analyzer's context, confidence, reasoning and rule
    // identity reaching the verifier, and there is no API through which any of
    // it could. All of that held — and the verifier still confirmed
    // `fp-shadowed-by-parameter`, because both sides settled the disputed fact
    // the same way: find a declaration whose NAME matches.
    //
    //     structural independence   inputs are not shared
    //     epistemic independence    the METHOD of settling the fact is not
    //
    // Only the second buys anything. The verifier now asks the TypeScript
    // checker which declaration the callee binds to; `save` binds to the
    // synchronous parameter shadowing the async import, and the claim stops.
    //
    // It stops as `inconclusive` rather than `rejected`, which is the better
    // answer: the verifier's own binding says synchronous while the analyzer's
    // supplied evidence says asynchronous, and
    // `conflicting_independent_evidence` is exactly what that reason is for.
    // Something IS known, and what is known disagrees.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    const shadowed = report.journeys.filter(
      (journey) => journey.caseId === "fp-shadowed-by-parameter",
    );
    expect(shadowed.length, "the analyzer no longer produces this").toBe(1);
    expect(shadowed[0]?.wanted).toBe(false);
    expect(shadowed[0]?.promoted).toBe(false);
    expect(shadowed[0]?.published).toBe(false);
  });

  it("distinguishes a measured zero from an absent denominator", async () => {
    // `0 / 0` is not `0`. The first funnel report showed
    // `falsePositivesCaught = 0` against a corpus with no false positives, and
    // rendered as a zero it reads as "verification caught nothing" — an
    // argument for deleting the verifier, when it was an argument about the
    // corpus. Now the corpus has one, so the rate is defined and genuinely 0.
    const report = await evaluateFunnel(ANALYZER_CORPUS);
    expect(report.falsePositiveCatchRate).toBe(1);

    const empty = await evaluateFunnel([]);
    // No candidates at all: every ratio is undefined rather than a confident 0
    // or a flattering 1.
    expect(empty.candidatePrecision).toBeUndefined();
    expect(empty.publishedPrecision).toBeUndefined();
    expect(empty.publishedRecall).toBeUndefined();
    expect(empty.falsePositiveCatchRate).toBeUndefined();
    expect(empty.tokensPerPublishedFinding).toBeUndefined();
  });

  it("attributes every lost defect to exactly one stage", async () => {
    // `publishedRecall = 0.5` is equally consistent with a planner that fetched
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

    // And today they are all one stage, which is the whole diagnosis: the
    // analyzer and planner lost nothing, policy withheld nothing, nothing was
    // refuted, and nothing was unavailable. The verifier could not tell.
    expect(report.losses).toEqual({
      not_proposed: 0,
      verifier_refuted: 0,
      verifier_abstained: 5,
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
    //     published recall 0.5     the verifier's reach, not the analyzer's
    //                              accuracy. Five defects sit at
    //                              `inconclusive`.
    //     published precision 1.0  every published finding is real, against an
    //                              analyzer precision of 10/11 — verification
    //                              now buys precision instead of costing it.
    //     false positives caught 1 measured against a real denominator.
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
      candidates: 11,
      verified: 5,
      rejected: 0,
      inconclusive: 6,
      promoted: 5,
      published: 5,
      publishedRecall: 0.5,
      // Every published finding is real. The analyzer's one false positive is
      // stopped by a verifier that binds callees through the checker rather
      // than by name.
      publishedPrecision: 1,
    });
  });
});
