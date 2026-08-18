import { describe, expect, it } from "vitest";

import { VERIFIER_CHALLENGES, evaluateChallenges } from "../src/eval/index.js";

/**
 * What the verifier can actually do, measured over injected challenges.
 *
 * Never averaged with the analyzer corpus. These claims measure a *capability*
 * — can it recognize this refutation pattern? The analyzer corpus measures the
 * *product* — does verification improve what a developer receives. Combining
 * them would let a rich set of hand-written challenges flatter a pipeline that
 * never encounters them.
 */
describe("Verifier capability, on injected challenges", () => {
  it("never refutes a real defect", () => {
    // The cell that must stay at zero. It suppresses a true bug *and* records
    // the suppression as an analyzer false positive, so the investigation goes
    // to the wrong component entirely.
    const report = evaluateChallenges(VERIFIER_CHALLENGES);
    const refuted = report.outcomes.filter(
      (outcome) =>
        outcome.gold === "should_verify" && outcome.actual === "rejected",
    );
    expect(refuted.map((outcome) => outcome.id)).toEqual([]);
    expect(report.catastrophic).toBe(0);
  });

  it("never confirms a refutable claim", () => {
    const report = evaluateChallenges(VERIFIER_CHALLENGES);
    expect(report.falseConfirmations).toBe(0);
  });

  it("decides an undecidable claim exactly once, and that is a defect", () => {
    // ── The third instance of one root cause ──────────────────────────────
    //
    // `unknowable-provider-semantics` claims a retry double-charges because the
    // provider call is not idempotent. Whether the provider is idempotent is
    // not in the repository at all, so the only honest answer is abstention.
    //
    // The verifier returns **rejected**, via `guarded_on_all_paths`: the
    // claimed line is `await charge(100)`, it sees an `await`, and concludes
    // the promise is handled. It is — and the claim was never about the
    // promise. The verifier applied the one mechanism it models to a claim
    // about a different mechanism, and refuted it.
    //
    // Same root cause as the two before it: *the verifier does not know which
    // claims it is competent to judge.* P1-J.1 fixed it firing through the
    // `not found` path; this is the same failure through the `guarded` path.
    // Asserted here in its wrong state deliberately, because P1-J.2's job is to
    // make it measurable and P1-J.3's is to fix it — and a fix applied while
    // building the instrument leaves nothing to measure the fix against.
    const report = evaluateChallenges(VERIFIER_CHALLENGES);

    const overclaimed = report.outcomes.filter(
      (outcome) =>
        outcome.gold === "should_abstain" && outcome.correct === false,
    );
    expect(overclaimed.map((outcome) => outcome.id)).toEqual([
      "unknowable-provider-semantics",
    ]);
    expect(overclaimed[0]?.actual).toBe("rejected");
    expect(report.overclaims).toBe(1);
  });

  it("discriminates only the mechanism it models", () => {
    // A pair is a real defect beside near-identical correct code. Getting both
    // halves right is the only evidence that a mechanism was learned rather
    // than a pattern — and a pattern would score well on every other line of
    // this report.
    //
    // One of three: the async pair discriminates. The condition pair and the
    // catch pair abstain on both halves, which is safe and useless. Each is a
    // named target for P1-J.3, and the cost of leaving it is exactly the recall
    // this line reports.
    const report = evaluateChallenges(VERIFIER_CHALLENGES);
    expect(report.pairsTotal).toBe(3);
    expect(report.pairsDiscriminated).toBe(1);
  });

  it("records the committed capability matrix", () => {
    const report = evaluateChallenges(VERIFIER_CHALLENGES);

    // Census, not a contract. Expected to improve; asserted so improvement is
    // deliberate and regression is loud.
    expect(report.matrix).toEqual({
      should_verify: {
        verified: 1,
        rejected: 0,
        inconclusive: 2,
        unavailable: 0,
      },
      should_reject: {
        verified: 0,
        rejected: 4,
        inconclusive: 1,
        unavailable: 0,
      },
      should_abstain: {
        verified: 0,
        rejected: 1,
        inconclusive: 2,
        unavailable: 0,
      },
    });
  });

  it("actually ran every challenge", () => {
    // Fail-closed: an empty matrix satisfies every zero above.
    const report = evaluateChallenges(VERIFIER_CHALLENGES);
    expect(report.outcomes).toHaveLength(VERIFIER_CHALLENGES.length);
    expect(report.outcomes.length).toBeGreaterThanOrEqual(10);
    expect(report.provenance).toBe("injected");
    for (const gold of ["should_verify", "should_reject", "should_abstain"]) {
      expect(
        VERIFIER_CHALLENGES.some((challenge) => challenge.gold === gold),
        `no challenge with gold outcome ${gold}`,
      ).toBe(true);
    }
  });
});
