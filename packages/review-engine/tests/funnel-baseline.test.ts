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

  it("verification currently COSTS precision — the P1-J.3 target", async () => {
    // ── The finding the false-positive bucket exists to produce ───────────
    //
    // The aspiration is that verification may cost recall — that is the trade
    // it exists to make — but never precision. Right now it costs both:
    //
    //     candidate precision   10/11   the analyzer's own accuracy
    //     published precision    5/6    after verification
    //
    // It lost five true defects to `inconclusive` and caught **zero** of the
    // analyzer's false positives. Asserted in its true, wrong direction rather
    // than aspirationally, because a test that asserts the goal fails from the
    // day it is written and gets deleted, while one that asserts reality has to
    // be edited deliberately when reality changes.
    //
    // When P1-J.3 inverts this, this test flips and its comment goes with it.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    expect(report.candidatePrecision).toBeDefined();
    expect(report.publishedPrecision).toBeDefined();
    expect(report.publishedPrecision ?? 1).toBeLessThan(
      report.candidatePrecision ?? 0,
    );
  });

  it("the verifier shares the analyzer's blind spot", async () => {
    // ── Structural independence is not epistemic independence ─────────────
    //
    // P1-H goes to real lengths to stop the verifier seeing the analyzer's
    // context, confidence, reasoning or rule identity, and there is no API
    // through which any of it could arrive. All of that holds.
    //
    // And the verifier still confirms `fp-shadowed-by-parameter`, because
    // `declaredAsync` resolves callees **by name** — exactly as the analyzer
    // does. `save` is a synchronous parameter shadowing an imported async
    // function; both components look up the name, both find the import, and the
    // second one agreeing with the first is not corroboration. It is the same
    // mistake made twice.
    //
    // The lesson for the model-backed verifier: independence of *inputs* buys
    // nothing if the *method* is shared. A second opinion from a copy of the
    // same reasoning is not a second opinion.
    const report = await evaluateFunnel(ANALYZER_CORPUS);

    const shadowed = report.journeys.filter(
      (journey) => journey.caseId === "fp-shadowed-by-parameter",
    );
    expect(shadowed.length, "the analyzer no longer produces this").toBe(1);
    expect(shadowed[0]?.wanted).toBe(false);
    expect(
      shadowed[0]?.published,
      "if this is now false, the verifier learned to resolve scope — update the comment above",
    ).toBe(true);
    expect(report.falsePositivesPublished).toBe(1);
  });

  it("distinguishes a measured zero from an absent denominator", async () => {
    // `0 / 0` is not `0`. The first funnel report showed
    // `falsePositivesCaught = 0` against a corpus with no false positives, and
    // rendered as a zero it reads as "verification caught nothing" — an
    // argument for deleting the verifier, when it was an argument about the
    // corpus. Now the corpus has one, so the rate is defined and genuinely 0.
    const report = await evaluateFunnel(ANALYZER_CORPUS);
    expect(report.falsePositiveCatchRate).toBe(0);

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
    //     published precision      LOWER than the analyzer's own. Verification
    //                              currently costs precision as well as recall,
    //                              which is the case against it that P1-J.3 has
    //                              to answer.
    //     false positives caught 0 and now genuinely measured, against one real
    //                              analyzer false positive rather than against
    //                              an empty denominator.
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
      verified: 6,
      rejected: 0,
      inconclusive: 5,
      promoted: 6,
      published: 6,
      publishedRecall: 0.5,
      // 5 of 6 published findings are real. The sixth is
      // `fp-shadowed-by-parameter`, verified by a verifier that resolves names
      // the same way the analyzer does.
      publishedPrecision: 0.8333,
    });
  });
});
