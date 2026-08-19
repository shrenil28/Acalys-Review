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
    // Five, since `signature-callers-migrated` was reclassified. Its claim is
    // about a POPULATION of callers against an exported declaration, and
    // refuting that needs a closed world the verifier cannot establish —
    // "findReferences returned four" is not "four consumers exist".
    // Ten, with the claim that `map`'s result is discarded by the CALLER — a
    // true statement about the code that no capability adjudicates. Abstaining
    // names the gap; refuting it because `map` preserves promises would answer
    // a question nobody asked.
    expect(abstentions).toHaveLength(10);
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
    // Six of seven. The `map` pair discriminates in the sharpest way available:
    // byte-identical code, two claims, one refuted and one abstained. Proving a
    // nearby language fact is not proving the claim that was made.
    //
    // The callback pair discriminates: `items.forEach(async …)`
    // verifies and `await queue.forEach(async …)` is refuted — the same syntax
    // and the same method name, separated only by the declared contract.
    //
    // The exception pair discriminates too: a suppressed failure followed by an
    // assertion of success verifies, and a suppression supplying a fallback is
    // refuted.
    //
    // The fifth is `empty-catch-real` / `empty-catch-unprovable-intent`, and it
    // does NOT discriminate — deliberately. Both are `catch {}` with nothing
    // downstream, and nothing in either repository says which was meant. That
    // is the pair the capability is designed to abstain on.
    expect(report.pairsTotal).toBe(7);
    expect(report.pairsDiscriminated).toBe(6);
  });

  it("still filters the candidate the analyzer used to produce", () => {
    // ── Regression cover that survives the analyzer being fixed ───────────
    //
    // The live corpus case now asserts the analyzer stays SILENT, which
    // protects analyzer precision and exercises the verifier not at all. This
    // replays the candidate the analyzer really produced before the fix, with
    // its original claim, evidence and location.
    //
    // With both, the two regressions are distinguishable:
    //
    //     analyzer regression   the live case starts speaking again
    //     verifier regression   this replay stops being filtered
    //
    // Without it, fixing the analyzer would have quietly deleted the only
    // evidence that the verifier catches anything.
    const report = evaluateChallenges(VERIFIER_CHALLENGES);
    const replay = report.outcomes.find(
      (outcome) => outcome.id === "historical-shadowed-parameter",
    );

    expect(replay, "the historical replay is missing").toBeDefined();
    // The requirement is that it is not CONFIRMED. Refuting it is better and is
    // the recorded gold; abstaining still stops publication.
    expect(replay?.actual).not.toBe("verified");
  });

  it("cannot be talked out of a finding by a comment", () => {
    // ── The adversarial case, at the capability level ─────────────────────
    //
    // `// best effort: intentionally ignored` beside a real suppressed failure.
    // If a comment could refute the claim, anyone could silence the reviewer by
    // typing the right words next to a defect — and the corpus already contains
    // a case that does exactly that.
    //
    // Comments can say where to look for a contract. They are not the contract.
    const report = evaluateChallenges(VERIFIER_CHALLENGES);
    const commented = report.outcomes.find(
      (outcome) => outcome.id === "catch-comment-is-not-a-contract",
    );
    expect(commented, "the fixture is missing").toBeDefined();
    expect(commented?.actual).not.toBe("rejected");
    expect(commented?.correct).toBe(true);
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
        // 5 → 6: `Array.forEach` dropping its callback's promise, with a
        // statement afterwards that proceeds as though the work finished.
        // `empty-catch-real` stays inconclusive and stays a MISS.
        verified: 6,
        rejected: 0,
        inconclusive: 1,
        unavailable: 0,
      },
      should_reject: {
        verified: 0,
        // 12 → 16: a receiver that awaits its callback, `map` propagating the
        // promises out (twice, once in each half of the proposition pair), and
        // a synchronous callback with nothing to drop.
        rejected: 16,
        // One: the historical replay. The replay
        // comes back `inconclusive` rather than `rejected` because the
        // verifier's own binding says the callee is synchronous while the
        // analyzer's supplied evidence says asynchronous, and it treats that as
        // a conflict rather than trusting its own derivation over evidence
        // handed to it.
        //
        // Recorded as a MISS, not relabelled. Carried forward through the
        // signature work untouched: it is verifier-capability debt, and fixing
        // it changes evidence-combination semantics, which deserves its own
        // checkpoint.
        inconclusive: 1,
        unavailable: 0,
      },
      should_abstain: {
        verified: 0,
        rejected: 0,
        // Ten. The untyped callback receiver, and the caller-discards-the-array
        // claim: the same code as the `map` refutation, a different
        // proposition, and no capability for it.
        inconclusive: 10,
        unavailable: 0,
      },
    });
  });

  it("actually ran every challenge", () => {
    // Fail-closed: an empty matrix satisfies every zero above.
    const report = evaluateChallenges(VERIFIER_CHALLENGES);
    expect(report.outcomes).toHaveLength(VERIFIER_CHALLENGES.length);
    expect(report.outcomes.length).toBeGreaterThanOrEqual(33);
    expect(report.provenance).toBe("injected");
    for (const gold of ["should_verify", "should_reject", "should_abstain"]) {
      expect(
        VERIFIER_CHALLENGES.some((challenge) => challenge.gold === gold),
        `no challenge with gold outcome ${gold}`,
      ).toBe(true);
    }
  });
});
