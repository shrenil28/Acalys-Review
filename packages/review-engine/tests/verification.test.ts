import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_INPUT_KEYS,
  PUBLICATION_POLICY,
  assertNoAnalyzerAuthority,
  claimIdentity,
  isPublishable,
  propose,
  readsAsArgument,
  toVerificationInput,
  verificationCacheKey,
  type CandidateFinding,
  type Proposal,
} from "../src/index.js";

/**
 * The verification boundary.
 *
 * The verifier's job is *is this claim true?*, not *does this analyzer usually
 * get it right?*. These tests exist because the second question is easier and
 * a verifier that can see the answer will drift towards it.
 */

const baseProposal: Proposal = {
  ruleId: "acalys.correctness.async-completion/floating-promise",
  family: "error_handling",
  claim: "The promise returned by `save()` is discarded.",
  causal: {
    anchor: { path: "src/a.ts", startLine: 3, endLine: 3 },
    steps: ["`save` is asynchronous", "the statement discards the promise"],
    trigger: "any execution in which the call rejects",
    consequence: "an unhandled rejection",
  },
  remediation: "Add `await`, or `void` if discarding it is deliberate.",
  counterfactual: { existsWithoutChange: false, because: "the line is new" },
  proposedSeverity: "medium",
  location: { path: "src/a.ts", startLine: 3, endLine: 3 },
  evidence: [
    {
      type: "static_analysis",
      strength: "deterministic",
      observation:
        "`save` is declared at src/store.ts:1 with the `async` keyword",
    },
  ],
  identityHint: "src/a.ts:save:floating",
  clusterId: "cluster:src/a.ts",
};

function candidateWith(overrides: Partial<Proposal> = {}): CandidateFinding {
  const outcome = propose({ ...baseProposal, ...overrides });
  if (outcome.kind !== "finding") throw new Error("fixture must be a finding");
  return outcome.finding;
}

const REPO = "0192f8a1-0000-7000-8000-0000000000aa";
const REVISION = "0192f8a1-0000-7000-8000-0000000000d1";
const project = (candidate: CandidateFinding) =>
  toVerificationInput("cand-1", candidate, {
    repositoryId: REPO,
    revisionId: REVISION,
  });

describe("The verifier cannot see analyzer authority", () => {
  it("carries no forbidden key, checked on the serialized shape", () => {
    // A compile-time type says nothing about an adapter that spread an object
    // on the way past. The type stops the honest mistake; this stops the
    // clever one.
    const { input } = project(candidateWith());
    const serialized = JSON.stringify(input);

    for (const key of FORBIDDEN_INPUT_KEYS) {
      expect(`${key}:${String(serialized.includes(`"${key}"`))}`).toBe(
        `${key}:false`,
      );
    }
    expect(() => {
      assertNoAnalyzerAuthority(input);
    }).not.toThrow();
  });

  it("refuses an input that acquired analyzer authority", () => {
    const { input } = project(candidateWith());
    const leaked = { ...input, confidenceScore: 0.95 } as typeof input;
    expect(() => {
      assertNoAnalyzerAuthority(leaked);
    }).toThrow(/analyzer authority/i);
  });

  it("finds a forbidden key nested inside evidence", () => {
    const { input } = project(candidateWith());
    const leaked = {
      ...input,
      evidence: [{ ...input.evidence[0], ruleId: "x" }],
    } as unknown as typeof input;
    expect(() => {
      assertNoAnalyzerAuthority(leaked);
    }).toThrow(/ruleId/);
  });

  it("keeps the claim, which is the thing being checked", () => {
    // Over-stripping would leave the verifier nothing to verify.
    const { input } = project(candidateWith());
    expect(input.claim.statement).toContain("save()");
    expect(input.claim.steps.length).toBeGreaterThan(0);
    expect(input.claim.trigger).not.toBe("");
    expect(input.evidence).toHaveLength(1);
    expect(input.remediation).not.toBe("");
  });
});

describe("Evidence is fact, not argument", () => {
  it.each([
    "I am 97% confident this is definitely a bug",
    "the analyzer believes this will fail",
    "I think the caller is wrong",
    "this is clearly a defect",
  ])("drops an observation that reads as argument: %s", (observation) => {
    // The subtler leak: confidence and reasoning can cross with no field named
    // after them, simply by being written into an observation.
    expect(readsAsArgument(observation)).toBe(true);

    const { input, droppedEvidence } = project(
      candidateWith({
        evidence: [
          { type: "agent_observation", strength: "strong", observation },
          {
            type: "static_analysis",
            strength: "deterministic",
            observation: "`save` is declared at src/store.ts:1 with `async`",
          },
        ],
      }),
    );

    expect(droppedEvidence).toContain(observation);
    expect(JSON.stringify(input)).not.toContain("confident");
    // The factual item survived — dropping everything would be over-stripping.
    expect(input.evidence).toHaveLength(1);
  });

  it("keeps ordinary observational evidence", () => {
    for (const observation of [
      "`save` is declared at src/store.ts:1 with the `async` keyword",
      "the call is a statement on its own, with no `await`",
      "tsc reported no error at this location",
    ]) {
      expect(readsAsArgument(observation)).toBe(false);
    }
  });
});

describe("Independence properties", () => {
  it("changing only the analyzer's confidence leaves the verifier input identical", () => {
    // Tests the boundary *before* the verifier runs. If reasoning or confidence
    // can move the serialized input while the facts hold still, something
    // leaked.
    const strong = candidateWith();
    const weak: CandidateFinding = { ...strong, confidenceScore: 0.56 };

    expect(strong.confidenceScore).not.toBe(weak.confidenceScore);
    expect(project(weak).input).toEqual(project(strong).input);
  });

  it("changing only the analyzer's identity leaves the verifier input identical", () => {
    const original = candidateWith();
    const relabelled: CandidateFinding = {
      ...original,
      ruleId: "some.other.analyzer/other-rule",
      family: "concurrency",
      clusterId: "cluster:elsewhere",
    };

    // The verifier evaluates the claim, not its author.
    expect(project(relabelled).input).toEqual(project(original).input);
  });

  it("changing only the analyzer's causal prose does change the input", () => {
    // The complement, and the one that keeps the two above from passing
    // vacuously: the claim *is* under verification, so altering it must be
    // visible.
    const original = candidateWith();
    const altered: CandidateFinding = {
      ...original,
      causal: { ...original.causal, trigger: "only on Tuesdays" },
    };
    expect(project(altered).input).not.toEqual(project(original).input);
  });
});

describe("Verification cache identity", () => {
  const key = (candidate: CandidateFinding, model?: string) =>
    verificationCacheKey({
      claimIdentity: claimIdentity(project(candidate).input),
      verifierContextDigest: "c".repeat(64),
      verifierId: "acalys.verifier.deterministic",
      verifierVersion: "1",
      ...(model === undefined ? {} : { modelIdentity: model }),
    });

  it("does not move when only the analyzer's confidence changes", () => {
    // Stronger than "the decision was stable twice": the cache never even had
    // to be consulted differently.
    const strong = candidateWith();
    expect(key({ ...strong, confidenceScore: 0.56 })).toBe(key(strong));
  });

  it("does not move when only the analyzer's identity changes", () => {
    const original = candidateWith();
    expect(
      key({ ...original, ruleId: "other/rule", clusterId: "cluster:x" }),
    ).toBe(key(original));
  });

  it("moves when the claim changes", () => {
    const original = candidateWith();
    expect(
      key({
        ...original,
        claim: "Something entirely different is wrong.",
      }),
    ).not.toBe(key(original));
  });

  it("moves when the verifier's model changes", () => {
    const original = candidateWith();
    expect(key(original, "model-a")).not.toBe(key(original, "model-b"));
    expect(key(original)).not.toBe(key(original, "model-a"));
  });

  it("is the same for identical facts raised by different candidates", () => {
    // Two runs, two candidate rows, one claim. Keying on the candidate would
    // make every re-analysis a cache miss, and would quietly answer "did the
    // verifier change its mind?" with "we never asked it twice".
    const candidate = candidateWith();
    const asFirst = toVerificationInput("cand-1", candidate, {
      repositoryId: REPO,
      revisionId: REVISION,
    });
    const asSecond = toVerificationInput("cand-2", candidate, {
      repositoryId: REPO,
      revisionId: REVISION,
    });

    expect(asSecond.input.candidateId).not.toBe(asFirst.input.candidateId);
    expect(claimIdentity(asSecond.input)).toBe(claimIdentity(asFirst.input));
  });

  it("ignores the order evidence happened to be appended in", () => {
    const original = candidateWith();
    const reordered: CandidateFinding = {
      ...original,
      evidence: [...original.evidence].reverse(),
    };
    expect(claimIdentity(project(reordered).input)).toBe(
      claimIdentity(project(original).input),
    );
  });
});

describe("The decision contract", () => {
  it("publishes only what was verified", () => {
    // A reviewer earns the right to interrupt people by being right. The cost
    // of a suppressed true finding is paid once; a published false one is paid
    // every time someone learns to skim.
    expect(PUBLICATION_POLICY).toEqual({
      verified: "publish",
      rejected: "suppress",
      inconclusive: "suppress",
    });
  });

  it("treats an execution failure as unverified, never as rejected", () => {
    // Collapsing these would make an outage read as a quality improvement, and
    // every metric would agree.
    for (const code of [
      "model_timeout",
      "context_unavailable",
      "parse_failure",
    ]) {
      const outcome = { kind: "unavailable", code } as const;
      expect(isPublishable(outcome)).toBe(false);
      expect(outcome).not.toHaveProperty("decision");
    }
  });

  it("does not publish an inconclusive verification", () => {
    expect(
      isPublishable({
        kind: "decided",
        decision: "inconclusive",
        reasons: ["insufficient_evidence"],
        confidence: 0.4,
        severity: "medium",
      }),
    ).toBe(false);
  });

  it("publishes a verified one", () => {
    expect(
      isPublishable({
        kind: "decided",
        decision: "verified",
        reasons: ["independent_context_confirms"],
        confidence: 0.9,
        severity: "medium",
      }),
    ).toBe(true);
  });
});
