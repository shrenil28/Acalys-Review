import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUBLICATION_CONFIG,
  PUBLICATION_REASONS,
  REASON_DECIDES,
  assertReasonDecides,
  funnelOf,
  planPublication,
  promoteVerified,
  type PublishableFinding,
  type VerificationAttempt,
  type VerifiedCandidate,
} from "../src/index.js";

/**
 * The trust boundary.
 *
 * Before it, Acalys may hypothesize and be wrong. After it, Acalys has decided
 * a defect is established enough and actionable enough to consume a developer's
 * attention. These tests exist to make that transition hard to bypass.
 */

/** Narrowed to the completed branch, so fixtures can override `severity`. */
const completed = (
  decision: "verified" | "rejected" | "inconclusive",
): Extract<VerificationAttempt, { status: "completed" }> => ({
  status: "completed",
  decision,
  reasons:
    decision === "verified"
      ? ["independent_context_confirms"]
      : decision === "rejected"
        ? ["claim_contradicted_by_context"]
        : ["insufficient_evidence"],
  confidence: 0.9,
  severity: "medium",
});

const unavailable: VerificationAttempt = {
  status: "unavailable",
  failure: "model_timeout",
};

const candidate = (
  id: string,
  attempt: VerificationAttempt,
  overrides: Partial<VerifiedCandidate> = {},
): VerifiedCandidate => ({
  candidateId: id,
  fingerprint: `fp-${id}`,
  severity: "medium",
  category: "correctness",
  path: "src/a.ts",
  attempt,
  ...overrides,
});

describe("Only verification promotes", () => {
  it("promotes a verified candidate", () => {
    const outcome = promoteVerified([candidate("a", completed("verified"))]);
    expect(outcome.kind).toBe("promoted");
    if (outcome.kind !== "promoted") return;
    expect(outcome.findings).toHaveLength(1);
  });

  it.each(["rejected", "inconclusive"] as const)(
    "never promotes a %s candidate",
    (decision) => {
      const outcome = promoteVerified([candidate("a", completed(decision))]);
      expect(outcome.kind).toBe("promoted");
      if (outcome.kind !== "promoted") return;
      expect(outcome.findings).toEqual([]);
      // Retained rather than discarded: "the analyzer said this and the
      // verifier disagreed" is what tells you whether analyzer confidence is
      // calibrated.
      expect(outcome.notPromoted).toEqual([{ candidateId: "a", decision }]);
    },
  );

  it("blocks the whole run when any verification was unavailable", () => {
    // The subtle failure this prevents: publishing what did verify makes a
    // verifier outage render as fewer comments on a successful review —
    // indistinguishable from good news, and every metric agrees.
    const outcome = promoteVerified([
      candidate("a", completed("verified")),
      candidate("b", unavailable),
    ]);

    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") return;
    expect(outcome.block).toBe("verification_unavailable");
    expect(outcome.candidateIds).toEqual(["b"]);
  });

  it("promotes idempotently under retry", () => {
    // Keyed on the fingerprint, so a crash-and-retry converges on one finding
    // instead of inserting a second.
    const candidates = [candidate("a", completed("verified"))];
    const first = promoteVerified(candidates);
    const second = promoteVerified(candidates);
    expect(second).toEqual(first);
    if (first.kind !== "promoted") return;
    expect(first.findings[0]?.findingId).toBe("fp-a");
  });

  it("takes severity from the verification, not from the analyzer's proposal", () => {
    const outcome = promoteVerified([
      candidate(
        "a",
        { ...completed("verified"), severity: "high" },
        {
          severity: "info",
        },
      ),
    ]);
    if (outcome.kind !== "promoted") return;
    expect(outcome.findings[0]?.severity).toBe("high");
  });
});

describe("The funnel stays disaggregated", () => {
  it("counts each outcome separately and never folds unavailable into rejected", () => {
    const funnel = funnelOf([
      candidate("a", completed("verified")),
      candidate("b", completed("rejected")),
      candidate("c", completed("inconclusive")),
      candidate("d", unavailable),
    ]);

    expect(funnel).toEqual({
      candidates: 4,
      verified: 1,
      rejected: 1,
      inconclusive: 1,
      unavailable: 1,
    });
  });
});

describe("Publication policy decides interruption, not truth", () => {
  const finding = (
    id: string,
    overrides: Partial<PublishableFinding> = {},
  ): PublishableFinding => ({
    findingId: id,
    fingerprint: id,
    severity: "medium",
    category: "correctness",
    path: "src/a.ts",
    ...overrides,
  });

  it("publishes an actionable finding", () => {
    const plan = planPublication([finding("f1")]);
    expect(plan.publish).toHaveLength(1);
    expect(plan.decisions[0]?.reason).toBe("actionable");
    expect(plan.noActionableFindings).toBe(false);
  });

  it("withholds a verified finding below the severity floor", () => {
    // Verified and withheld is a legitimate combination. `verified → published`
    // must not be automatic.
    const plan = planPublication([finding("f1", { severity: "info" })], {
      ...DEFAULT_PUBLICATION_CONFIG,
      minimumSeverity: "high",
    });
    expect(plan.publish).toEqual([]);
    expect(plan.withheld[0]?.reason).toBe("severity_below_threshold");
    expect(plan.noActionableFindings).toBe(true);
  });

  it("withholds a defect the developer has already been shown", () => {
    // What the fingerprint work has been for: don't interrupt someone twice
    // about the same defect on the next push.
    const plan = planPublication([finding("f1")], DEFAULT_PUBLICATION_CONFIG, {
      alreadyCommented: new Set(["f1"]),
      superseded: new Set(),
    });
    expect(plan.withheld[0]?.reason).toBe("duplicate_existing_comment");
  });

  it("withholds an excluded path and a disabled category", () => {
    const excluded = planPublication([finding("f1", { path: "vendor/x.ts" })], {
      ...DEFAULT_PUBLICATION_CONFIG,
      excludedPaths: ["vendor/"],
    });
    expect(excluded.withheld[0]?.reason).toBe("path_excluded");

    const disabled = planPublication([finding("f1", { category: "style" })], {
      ...DEFAULT_PUBLICATION_CONFIG,
      disabledCategories: ["style"],
    });
    expect(disabled.withheld[0]?.reason).toBe("category_disabled");
  });

  it("spends the comment budget on the most severe findings first", () => {
    // A budget applied in arbitrary order silently makes review quality depend
    // on file naming.
    const plan = planPublication(
      [
        finding("low", { severity: "low" }),
        finding("critical", { severity: "critical" }),
        finding("high", { severity: "high" }),
      ],
      { ...DEFAULT_PUBLICATION_CONFIG, maxComments: 2 },
    );

    expect(plan.publish.map((f) => f.findingId)).toEqual(["critical", "high"]);
    expect(plan.withheld[0]?.reason).toBe("comment_budget_exhausted");
  });

  it("treats zero publishable findings as a successful outcome", () => {
    // Not an error, and not something to fill with a manufactured finding.
    const plan = planPublication([]);
    expect(plan.noActionableFindings).toBe(true);
    expect(plan.publish).toEqual([]);
    expect(plan.decisions).toEqual([]);
  });

  it("is deterministic for identical inputs", () => {
    const findings = [
      finding("b", { severity: "high" }),
      finding("a", { severity: "high" }),
    ];
    const first = planPublication(findings);
    for (let run = 0; run < 5; run += 1) {
      expect(planPublication(findings)).toEqual(first);
    }
  });

  it("permits exactly the reason/decision pairings the table declares", () => {
    for (const reason of PUBLICATION_REASONS) {
      for (const decision of ["publish", "withhold"] as const) {
        const legal = REASON_DECIDES[reason] === decision;
        let threw = false;
        try {
          assertReasonDecides({ findingId: "f", decision, reason });
        } catch {
          threw = true;
        }
        expect(`${reason}->${decision}:${String(!threw)}`).toBe(
          `${reason}->${decision}:${String(legal)}`,
        );
      }
    }
  });

  it("cannot see a verification decision to override", () => {
    // Structural: policy is not where verification is re-litigated, and a
    // policy that could read a decision could be tempted to second-guess it.
    const plan = planPublication([finding("f1")]);
    expect(JSON.stringify(plan)).not.toContain("verified");
    expect(JSON.stringify(plan)).not.toContain("confidence");
  });
});
