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

  it("never decides a claim no procedure can settle", () => {
    // ── What the competence gate bought, and what it cost ─────────────────
    //
    // Before it, `unknowable-provider-semantics` came back **rejected** via
    // `guarded_on_all_paths`: the claimed line is `await charge(100)`, the
    // verifier saw an `await`, concluded the promise was handled, and refuted a
    // claim about payment idempotency. The promise IS handled. The claim was
    // never about the promise.
    //
    // The gate reads the proposition rather than the syntax at the line, finds
    // no procedure that adjudicates provider semantics, and abstains before
    // `guarded_on_all_paths` is eligible to run.
    //
    // It cost one apparently-correct answer: `signature-callers-migrated` was
    // being rejected because line 1 of a declaration contains no call, which is
    // the right verdict reached by an argument that has nothing to do with
    // signature compatibility. It is now an honest abstention and shows up as
    // missed filtering — a capability to build, stated as such.
    const report = evaluateChallenges(VERIFIER_CHALLENGES);

    expect(report.overclaims).toBe(0);
    const abstentions = report.outcomes.filter(
      (outcome) => outcome.gold === "should_abstain",
    );
    expect(abstentions).toHaveLength(3);
    expect(abstentions.every((outcome) => outcome.correct)).toBe(true);
  });

  it("discriminates only the mechanism it models", () => {
    // A pair is a real defect beside near-identical correct code. Getting both
    // halves right is the only evidence that a mechanism was learned rather
    // than a pattern — and a pattern would score well on every other line of
    // this report.
    //
    // One of three, and deliberately unchanged by the competence gate: that
    // step widened nothing. The condition pair and the catch pair abstain on
    // both halves, which is safe and useless. Each is a named target for the
    // mechanism work, and the cost of leaving them is exactly the recall this
    // line reports.
    const report = evaluateChallenges(VERIFIER_CHALLENGES);
    expect(report.pairsTotal).toBe(3);
    expect(report.pairsDiscriminated).toBe(1);
  });

  it("records the committed capability matrix", () => {
    const report = evaluateChallenges(VERIFIER_CHALLENGES);

    // Census, not a contract. Expected to improve; asserted so improvement is
    // deliberate and regression is loud.
    // Moved from the P1-J.2 freeze by exactly one change — the competence
    // gate — and in exactly the two cells it should have:
    //
    //     should_abstain / rejected   1 → 0   the provider claim, fixed
    //     should_reject  / rejected   4 → 3   the signature claim, honest now
    //
    // Everything else is identical, which is the evidence that the gate did
    // what it claims and nothing else. A change that improved several cells at
    // once would leave attribution worse, not better.
    expect(report.matrix).toEqual({
      should_verify: {
        verified: 1,
        rejected: 0,
        inconclusive: 2,
        unavailable: 0,
      },
      should_reject: {
        verified: 0,
        rejected: 3,
        inconclusive: 2,
        unavailable: 0,
      },
      should_abstain: {
        verified: 0,
        rejected: 0,
        inconclusive: 3,
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
