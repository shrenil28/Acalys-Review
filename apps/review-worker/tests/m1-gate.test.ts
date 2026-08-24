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

import { render } from "@acalys/review-engine";

import {
  BASELINE_PUBLISHED_TRUE_POSITIVES,
  evaluateM1Gate,
  renderM1Gate,
  verifierCompletion,
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
    verifier: { expectedDefectOutcomes: [], inconclusive: 2, unavailable: 0 },
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

const measurementWith = (patch: Partial<M1FunnelMeasurement>) => ({
  ...passing(),
  ...patch,
});

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
    // Also fails 7, and that coupling is the point of deriving the economics
    // rather than receiving them. A published false positive grows condition
    // 7's denominator without its numerator. While those numbers arrived from
    // the caller, a checkpoint could report a published false positive AND a
    // perfect yield ratio in the same breath.
    expect(verdict.failing).toEqual([3, 7]);
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
      verifier: {
        expectedDefectOutcomes: [
          {
            kind: "incorrect_verifier_reject",
            caseId: "e2-some-in-scope-case",
            because: "inside the contract and refused anyway",
          },
        ],
        inconclusive: 0,
        unavailable: 0,
      },
    });
    expect(verdict.failing).toEqual([6]);
  });

  it("6. refuses verifier unavailability", () => {
    const verdict = verdictFor({
      verifier: { expectedDefectOutcomes: [], inconclusive: 0, unavailable: 1 },
    });
    expect(verdict.failing).toEqual([6]);
  });

  it("7. refuses a yield ratio below 1.0", () => {
    // One published false positive on the historical split: the denominator
    // grows and the numerator does not.
    const verdict = verdictFor({
      historical: {
        planted: 12,
        publishedTruePositives: 8,
        publishedFalsePositives: 1,
      },
    });
    expect(verdict.failing).toEqual([3, 7]);
  });

  it("6. does NOT accuse the verifier of a capability recall miss", () => {
    // Epoch 2's finding, as machinery. A case the frozen capability contract
    // places out of scope still costs recall — conditions 1 and 2 feel it —
    // but it is not evidence of a broken verifier, and reporting it as one
    // points the next checkpoint at the wrong repair.
    const verdict = verdictFor({
      verifier: {
        expectedDefectOutcomes: [
          {
            kind: "capability_recall_miss",
            caseId: "family-level-case",
            because: "a wrapper return is outside the frozen capability",
          },
        ],
        inconclusive: 0,
        unavailable: 0,
      },
    });

    expect(verdict.failing).toEqual([]);
  });

  it("6. names the offending case when it does accuse the verifier", () => {
    const verdict = verdictFor({
      verifier: {
        expectedDefectOutcomes: [
          {
            kind: "incorrect_verifier_reject",
            caseId: "e2-some-in-scope-case",
            because: "inside the contract and refused anyway",
          },
        ],
        inconclusive: 0,
        unavailable: 0,
      },
    });

    expect(
      verdict.conditions.find((condition) => condition.id === 6)?.observed,
    ).toContain("e2-some-in-scope-case");
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
      historical: {
        planted: 12,
        publishedTruePositives: 2,
        publishedFalsePositives: 0,
      },
      holdout: {
        planted: 8,
        publishedTruePositives: 0,
        publishedFalsePositives: 0,
      },
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
      verifier: {
        expectedDefectOutcomes: [
          {
            kind: "incorrect_verifier_reject",
            caseId: "e2-some-in-scope-case",
            because: "inside the contract and refused anyway",
          },
        ],
        inconclusive: 0,
        unavailable: 0,
      },
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

describe("condition 7's economics reproduce the recorded epochs", () => {
  /** Only the inputs the formula reads; everything else is irrelevant here. */
  const economicsFor = (
    historical: [number, number],
    development: [number, number],
    holdout: [number, number],
  ) =>
    verdictFor({
      historical: {
        planted: 12,
        publishedTruePositives: historical[0],
        publishedFalsePositives: historical[1],
      },
      development: {
        planted: 8,
        publishedTruePositives: development[0],
        publishedFalsePositives: development[1],
      },
      holdout: {
        planted: 8,
        publishedTruePositives: holdout[0],
        publishedFalsePositives: holdout[1],
      },
    }).conditions.find((condition) => condition.id === 7)?.observed;

  it("reproduces Epoch 1 exactly: 0.75 (3 TP / 4 comments)", () => {
    // The formula was derived from the contract's ECONOMICS line and the L.5
    // baseline of two published true positives, then validated against THIS
    // recorded number alone. Epoch 2 is a consequence of it, never an input
    // to choosing it.
    expect(economicsFor([5, 0], [1, 0], [0, 1])).toContain(
      "0.75 (3 TP / 4 comments)",
    );
  });

  it("excluding development is forced by that record, not preferred", () => {
    // Including the development split gives 4/5 = 0.8, which contradicts what
    // was reported. The arithmetic settles it; the contract agrees, since
    // perfect scores on the visible fixtures alone cannot close P1-M.
    const observed = economicsFor([5, 0], [1, 0], [0, 1]);
    expect(observed).not.toContain("4 TP / 5 comments");
    expect(observed).not.toContain("0.8");
  });

  it("reproduces Epoch 2 exactly: 1.0 (4 TP / 4 comments)", () => {
    expect(economicsFor([6, 0], [3, 0], [0, 0])).toContain(
      "1 (4 TP / 4 comments)",
    );
  });

  it("counts a published false positive against the denominator only", () => {
    const clean = economicsFor([6, 0], [3, 0], [0, 0]);
    const withFalsePositive = economicsFor([6, 0], [3, 0], [0, 1]);

    expect(clean).toContain("4 TP / 4 comments");
    expect(withFalsePositive).toContain("4 TP / 5 comments");
  });

  it("counts holdout true positives in the numerator", () => {
    // Needs a published false positive to be observable at all. With none,
    // comments == true positives and the ratio is 1.0 whatever the numerator,
    // so dropping the holdout term scales both sides equally and hides
    // itself. The false positive is what separates them.
    expect(economicsFor([8, 0], [0, 0], [4, 1])).toContain(
      "10 TP / 11 comments",
    );
  });

  it("ignores the development split entirely", () => {
    // Publishing on the visible split, correctly or otherwise, must not move
    // the ratio in either direction.
    expect(economicsFor([6, 0], [8, 4], [0, 0])).toContain("4 TP / 4 comments");
  });

  it("lets a regression below the baseline go negative rather than hide it", () => {
    // Clamping to zero would conceal a regression inside an economics number.
    // Condition 5 is what names it; this declines to launder it.
    expect(economicsFor([1, 0], [0, 0], [0, 0])).toContain("-1 TP");
  });
});

describe("the outcome an epoch needed and could not express", () => {
  const inScope = {
    kind: "verifier_in_scope_inconclusive" as const,
    caseId: "e4-barrel-narrowed",
    because: "the consumer environment was not delivered to the verifier",
  };

  it("does not count as an incorrect verifier reject", () => {
    // Epoch 4's flagship primary case: proposed, in scope, and the verifier
    // reached no verdict. Blaming the verifier would send the next checkpoint
    // to repair something that behaved as specified.
    const verdict = verdictFor({
      verifier: {
        expectedDefectOutcomes: [inScope],
        inconclusive: 1,
        unavailable: 0,
      },
    });

    expect(verdict.failing).toEqual([]);
  });

  it("is nonetheless reported beside condition 6, by case", () => {
    // The half that Epoch 4 lacked. Condition 6 keeps its frozen meaning, and
    // a reader can no longer take its PASS as evidence that verification
    // performed well.
    const verdict = verdictFor({
      verifier: {
        expectedDefectOutcomes: [inScope],
        inconclusive: 1,
        unavailable: 0,
      },
    });

    const observed = verdict.conditions.find(
      (condition) => condition.id === 6,
    )?.observed;

    expect(observed).toContain("0 incorrect rejects");
    expect(observed).toContain("1 in-scope inconclusive");
    expect(observed).toContain("e4-barrel-narrowed");
  });

  it("says nothing extra when every expected defect was settled", () => {
    const verdict = verdictFor({
      verifier: {
        expectedDefectOutcomes: [],
        inconclusive: 0,
        unavailable: 0,
      },
    });

    expect(
      verdict.conditions.find((condition) => condition.id === 6)?.observed,
    ).not.toContain("in-scope inconclusive");
  });
});

describe("verifier completion, advisory only", () => {
  const base = {
    historical: {
      planted: 12,
      publishedTruePositives: 6,
      publishedFalsePositives: 0,
    },
    development: {
      planted: 8,
      publishedTruePositives: 3,
      publishedFalsePositives: 0,
    },
    holdout: {
      planted: 8,
      publishedTruePositives: 1,
      publishedFalsePositives: 1,
    },
  };

  it("is 1.0 when every proposed expected defect was settled", () => {
    expect(
      render(
        verifierCompletion(
          measurementWith({
            ...base,
            verifier: {
              expectedDefectOutcomes: [],
              inconclusive: 0,
              unavailable: 0,
            },
          }),
        ),
      ),
    ).toBe("1");
  });

  it("falls below 1.0 when an in-scope case reached no verdict", () => {
    // Epoch 4's shape: ten published, one proposed and never settled.
    const quantity = verifierCompletion(
      measurementWith({
        ...base,
        verifier: {
          expectedDefectOutcomes: [
            {
              kind: "verifier_in_scope_inconclusive",
              caseId: "e4-barrel-narrowed",
              because: "environment not delivered",
            },
          ],
          inconclusive: 1,
          unavailable: 0,
        },
      }),
    );

    expect(render(quantity)).not.toBe("1");
  });

  it("does not count a capability recall miss against the verifier", () => {
    // Out of frozen scope is not the verifier's to decide, so it belongs in
    // neither the numerator nor the denominator.
    const withMiss = verifierCompletion(
      measurementWith({
        ...base,
        verifier: {
          expectedDefectOutcomes: [
            {
              kind: "capability_recall_miss",
              caseId: "e4-class-member",
              because: "outside the frozen contract",
            },
          ],
          inconclusive: 0,
          unavailable: 0,
        },
      }),
    );

    expect(render(withMiss)).toBe("1");
  });

  it("is undefined when nothing was proposed", () => {
    // 0/0 is the absence of a measurement, not a perfect score.
    expect(
      render(
        verifierCompletion(
          measurementWith({
            historical: {
              planted: 12,
              publishedTruePositives: 0,
              publishedFalsePositives: 0,
            },
            development: {
              planted: 8,
              publishedTruePositives: 0,
              publishedFalsePositives: 0,
            },
            holdout: {
              planted: 8,
              publishedTruePositives: 0,
              publishedFalsePositives: 0,
            },
            verifier: {
              expectedDefectOutcomes: [],
              inconclusive: 0,
              unavailable: 0,
            },
          }),
        ),
      ),
    ).toContain("undefined");
  });
});
