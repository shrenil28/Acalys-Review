/**
 * P1-M gate — proving it can refuse.
 *
 * A gate that has never failed is a claim, not a control (invariant 5). This
 * gate decides whether P1-M may close, so every one of its nine conditions is
 * shown to fail on its own, from a measurement that is otherwise passing.
 *
 * One condition per fixture. A fixture violating three conditions would let
 * bugs in two of them hide behind whichever was checked first — the same
 * vacuity the validator tests in L.3 were restructured to avoid.
 */

import { describe, expect, it } from "vitest";

import {
  BASELINE_PUBLISHED_TRUE_POSITIVES,
  evaluateM1Gate,
  renderM1Gate,
  type M1FunnelMeasurement,
} from "../src/eval/m1-gate.js";

/**
 * A measurement that satisfies every condition.
 *
 * Deliberately at the thresholds rather than far above them, so a fixture that
 * violates one condition is one edit away and cannot accidentally violate a
 * second.
 */
function passing(): M1FunnelMeasurement {
  return {
    historical: {
      planted: 12,
      publishedTruePositives: 8,
      publishedFalsePositives: 0,
    },
    development: {
      planted: 8,
      publishedTruePositives: 4,
      publishedFalsePositives: 0,
    },
    holdout: {
      planted: 8,
      publishedTruePositives: 4,
      publishedFalsePositives: 0,
    },
    historicalTruePositiveIds: [
      ...BASELINE_PUBLISHED_TRUE_POSITIVES,
      "config-exact-optional-assignment",
      "config-unchecked-index-access",
      "structural-index-public-signature-declaration",
      "structural-index-export-declaration-drift",
      "binding-shadowed-validator-contract",
      "test-relationship-expiry-boundary",
    ],
    naturalFalsePositivesReplayed: 1,
    naturalFalsePositivesPublished: 0,
    verifier: { incorrectRejects: 0, inconclusive: 2, unavailable: 0 },
    additionalTruePositivesPublished: 6,
    additionalCommentsPublished: 6,
    capabilities: [
      {
        family: "configuration_sensitive_type_safety",
        productionWitness: "apps/review-worker/tests/m2-wiring.test.ts",
        semanticMutationIds: [200, 201],
        demandSelectedFactFamilies: ["config_governance"],
      },
    ],
  };
}

const verdictFor = (patch: Partial<M1FunnelMeasurement>) =>
  evaluateM1Gate({ ...passing(), ...patch });

describe("the passing baseline is genuinely passing", () => {
  it("closes on a measurement that satisfies every condition", () => {
    // The premise for every test below. If this failed, each "condition N
    // fails" assertion could be passing for the wrong reason.
    const verdict = evaluateM1Gate(passing());
    expect(verdict.failing).toEqual([]);
    expect(verdict.closes).toBe(true);
  });

  it("sits exactly on the thresholds, so one edit crosses them", () => {
    const measurement = passing();
    expect(measurement.historical.publishedTruePositives / 12).toBeCloseTo(
      8 / 12,
    );
    expect(measurement.development.publishedTruePositives / 8).toBe(0.5);
    expect(measurement.holdout.publishedTruePositives / 8).toBe(0.5);
  });

  it("declares exactly the nine conditions it is supposed to", () => {
    // A proof inventory proves its own completeness before it proves the
    // items it contains. The mutation harness just failed this way: 194
    // definitions existed, the loader loaded none, and preflight had nothing
    // to validate. A gate that evaluated seven conditions and reported
    // "7/7 passed" would be the same failure with higher stakes.
    const verdict = evaluateM1Gate(passing());
    expect(verdict.conditions.map((condition) => condition.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(new Set(verdict.conditions.map((c) => c.id)).size).toBe(9);
    for (const condition of verdict.conditions) {
      expect(condition.requirement.trim()).not.toBe("");
      expect(condition.observed.trim()).not.toBe("");
    }
  });

  it("treats the threshold as inclusive, not exclusive", () => {
    // `>=` becoming `>` is invisible to a fixture that sits above the
    // threshold and invisible to one that sits below it. Only a measurement
    // exactly AT the boundary distinguishes them, and every numeric condition
    // in this gate is inclusive.
    const atBoundary = evaluateM1Gate(passing());
    expect(atBoundary.failing).toEqual([]);

    // 8/12 exactly, 4/8 exactly, 4/8 exactly — all three must pass.
    expect(passing().historical.publishedTruePositives).toBe(8);
    expect(passing().development.publishedTruePositives).toBe(4);
    expect(passing().holdout.publishedTruePositives).toBe(4);
  });

  it("refuses one below each inclusive boundary", () => {
    // The other side of the same comparator. Together these two tests pin
    // `>=` from both directions.
    expect(
      verdictFor({
        development: {
          planted: 8,
          publishedTruePositives: 3,
          publishedFalsePositives: 0,
        },
      }).failing,
    ).toEqual([2]);
  });
});

describe("each condition can refuse on its own", () => {
  it("1. refuses historical recall below 8/12", () => {
    const verdict = verdictFor({
      historical: {
        planted: 12,
        publishedTruePositives: 7,
        publishedFalsePositives: 0,
      },
      historicalTruePositiveIds: [
        ...BASELINE_PUBLISHED_TRUE_POSITIVES,
        "config-exact-optional-assignment",
        "config-unchecked-index-access",
        "structural-index-public-signature-declaration",
        "structural-index-export-declaration-drift",
        "binding-shadowed-validator-contract",
      ],
      additionalTruePositivesPublished: 5,
      additionalCommentsPublished: 5,
    });
    expect(verdict.failing).toEqual([1]);
  });

  it("2. refuses when holdout recall lags development", () => {
    // The condition that stops development-set overfitting from closing P1-M.
    const verdict = verdictFor({
      holdout: {
        planted: 8,
        publishedTruePositives: 3,
        publishedFalsePositives: 0,
      },
    });
    expect(verdict.failing).toEqual([2]);
  });

  it("3. refuses a single published false positive", () => {
    const verdict = verdictFor({
      holdout: {
        planted: 8,
        publishedTruePositives: 4,
        publishedFalsePositives: 1,
      },
    });
    expect(verdict.failing).toEqual([3]);
  });

  it("4. refuses a published natural false positive", () => {
    const verdict = verdictFor({ naturalFalsePositivesPublished: 1 });
    expect(verdict.failing).toEqual([4]);
  });

  it("4. also refuses when no natural false positive was replayed at all", () => {
    // Zero published is trivially true if nothing ran. The condition requires
    // the guard to have been exercised, not merely to have not fired.
    const verdict = verdictFor({
      naturalFalsePositivesReplayed: 0,
      naturalFalsePositivesPublished: 0,
    });
    expect(verdict.failing).toEqual([4]);
  });

  it("5. refuses a regression even when total recall rises", () => {
    // Six gained, one baseline lost. Aggregate recall still meets 8/12, and
    // the checkpoint still must not close.
    const verdict = verdictFor({
      historicalTruePositiveIds: [
        "binding-floating-reservation",
        "config-exact-optional-assignment",
        "config-unchecked-index-access",
        "structural-index-public-signature-declaration",
        "structural-index-export-declaration-drift",
        "binding-shadowed-validator-contract",
        "test-relationship-expiry-boundary",
        "instruction-auth-denial-audit",
      ],
    });
    expect(verdict.failing).toEqual([5]);
    expect(
      verdict.conditions.find((condition) => condition.id === 5)?.observed,
    ).toContain("interaction-binding-and-test-delivery");
  });

  it("6. refuses an incorrect verifier reject", () => {
    const verdict = verdictFor({
      verifier: { incorrectRejects: 1, inconclusive: 0, unavailable: 0 },
    });
    expect(verdict.failing).toEqual([6]);
  });

  it("6. refuses verifier unavailability", () => {
    const verdict = verdictFor({
      verifier: { incorrectRejects: 0, inconclusive: 0, unavailable: 1 },
    });
    expect(verdict.failing).toEqual([6]);
  });

  it("7. refuses a yield ratio below 1.0", () => {
    const verdict = verdictFor({ additionalCommentsPublished: 7 });
    expect(verdict.failing).toEqual([7]);
  });

  it("8. refuses a capability with no production witness", () => {
    const verdict = verdictFor({
      capabilities: [
        {
          family: "configuration_sensitive_type_safety",
          productionWitness: "",
          semanticMutationIds: [200],
          demandSelectedFactFamilies: ["config_governance"],
        },
      ],
    });
    expect(verdict.failing).toEqual([8]);
  });

  it("8. refuses a capability with no semantic mutations", () => {
    const verdict = verdictFor({
      capabilities: [
        {
          family: "configuration_sensitive_type_safety",
          productionWitness: "apps/review-worker/tests/m2-wiring.test.ts",
          semanticMutationIds: [],
          demandSelectedFactFamilies: ["config_governance"],
        },
      ],
    });
    expect(verdict.failing).toEqual([8]);
  });

  it("8. refuses closure with no capabilities attested at all", () => {
    // The degenerate case: perfect corpus numbers, nothing built. Without this
    // the gate would close on a measurement nobody earned.
    const verdict = verdictFor({ capabilities: [] });
    expect(verdict.failing).toEqual([8]);
  });
});

describe("undefined ratios are never rendered as favourable", () => {
  it("refuses condition 7 when nothing was published", () => {
    // 0/0 is undefined, not 1.0. A capability that published nothing has
    // avoided being measured, not achieved perfect yield — and this is the
    // strictest-looking condition in the gate, so it is the most tempting
    // place for a zero denominator to read as success.
    const verdict = verdictFor({
      additionalTruePositivesPublished: 0,
      additionalCommentsPublished: 0,
    });

    const condition = verdict.conditions.find((entry) => entry.id === 7);
    expect(condition?.satisfied).toBe(false);
    expect(condition?.observed).toContain("undefined");
  });

  it("refuses a recall condition when a split has no planted defects", () => {
    // An emptied split makes recall 0/0 — undefined, not perfect. Without this
    // fixture nothing in the suite ever produced an undefined RECALL, so a
    // threshold check that accepted non-measured quantities survived a
    // mutation. A gate that closes because the holdout was truncated is the
    // worst possible failure of a gate.
    const verdict = verdictFor({
      holdout: {
        planted: 0,
        publishedTruePositives: 0,
        publishedFalsePositives: 0,
      },
    });

    const recall = verdict.conditions.find((entry) => entry.id === 2);
    expect(recall?.satisfied).toBe(false);
    expect(recall?.observed).toContain("undefined");
    expect(verdict.closes).toBe(false);
  });

  it("refuses a precision condition when a split published nothing", () => {
    const verdict = verdictFor({
      holdout: {
        planted: 8,
        publishedTruePositives: 0,
        publishedFalsePositives: 0,
      },
    });

    // Both 2 (recall) and 3 (precision) fail — and 3 must fail on
    // `undefinedRatio` rather than being quietly treated as 100%.
    expect(verdict.failing).toContain(3);
    expect(
      verdict.conditions.find((entry) => entry.id === 3)?.observed,
    ).toContain("undefined");
  });
});

describe("the verdict is actionable", () => {
  it("names which conditions failed rather than only that it failed", () => {
    const verdict = verdictFor({
      naturalFalsePositivesPublished: 2,
      verifier: { incorrectRejects: 1, inconclusive: 0, unavailable: 0 },
    });

    expect(verdict.failing).toEqual([4, 6]);
    const report = renderM1Gate(verdict);
    expect(report).toContain("FAIL  4.");
    expect(report).toContain("FAIL  6.");
    expect(report).toContain("failing conditions: 4, 6");
  });

  it("reports every condition, passing ones included", () => {
    // A report that listed only failures would make a passing gate
    // indistinguishable from an unevaluated one.
    const verdict = evaluateM1Gate(passing());
    expect(verdict.conditions).toHaveLength(9);
    expect(renderM1Gate(verdict)).toContain("P1-M GATE SATISFIED");
  });
});
