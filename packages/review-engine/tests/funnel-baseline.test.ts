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

  it("never makes precision worse than the analyzer alone", async () => {
    // Verification may cost recall — that is the trade it exists to make. It
    // must never cost precision, because a verifier that admits a candidate the
    // analyzer would not have produced is not filtering anything.
    const report = await evaluateFunnel(ANALYZER_CORPUS);
    expect(report.publishedPrecision).toBeGreaterThanOrEqual(
      report.candidatePrecision,
    );
    expect(report.falsePositivesPublished).toBe(0);
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
    //     false positives caught 0 the corpus contains NO analyzer false
    //                              positives, so it cannot yet answer whether
    //                              verification earns its cost. Fixing that is
    //                              corpus work, not verifier work.
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
      verified: 5,
      rejected: 0,
      inconclusive: 5,
      promoted: 5,
      published: 5,
      publishedRecall: 0.5,
      publishedPrecision: 1,
    });
  });
});
