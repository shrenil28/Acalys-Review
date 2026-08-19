import { describe, expect, it } from "vitest";

import {
  DETERMINISTIC_VERIFIER_ID,
  DETERMINISTIC_VERIFIER_VERSION,
  REASON_SUPPORTS,
  VERIFICATION_REASONS,
  assertReasonsSupport,
  claimIdentity,
  planVerificationContext,
  toVerificationInput,
  verificationCacheKey,
  verifyDeterministically,
  type CandidateFinding,
  type VerificationAttempt,
  type VerificationInput,
  type VerificationReason,
} from "../src/index.js";

/**
 * The deterministic verifier.
 *
 * First because a model-backed verifier cannot be trusted until there is a
 * baseline to compare it against. Everything here is a gate on that baseline.
 */

const REPO = "0192f8a1-0000-7000-8000-0000000000aa";
const REVISION = "0192f8a1-0000-7000-8000-0000000000d1";

const CALLER = [
  'import { save } from "./store.js";',
  "export function run(): void {",
  "  save();",
  "}",
].join("\n");

const ASYNC_STORE = "export async function save(): Promise<void> {}";
const SYNC_STORE = "export function save(): void {}";

function inputFor(
  overrides: Partial<VerificationInput> = {},
): VerificationInput {
  return {
    candidateId: "cand-1",
    claim: {
      statement: "The promise returned by `save()` is discarded.",
      steps: ["`save` is asynchronous", "the statement discards the promise"],
      trigger: "any execution in which the call rejects",
      consequence: "an unhandled rejection",
    },
    location: { path: "src/caller.ts", startLine: 3, endLine: 3 },
    evidence: [
      {
        type: "static_analysis",
        observation:
          "`save` is declared at src/store.ts:1 with the `async` keyword",
        location: { path: "src/store.ts", startLine: 1, endLine: 1 },
      },
    ],
    remediation: "Add `await`, or `void` if discarding it is deliberate.",
    revisionId: REVISION,
    repositoryId: REPO,
    proposedSeverity: "medium",
    ...overrides,
  };
}

const repositoryOf = (files: Record<string, string>) => ({
  revisionId: REVISION,
  files: new Map(Object.entries(files)),
});

function verify(
  files: Record<string, string>,
  overrides: Partial<VerificationInput> = {},
): VerificationAttempt {
  const input = inputFor(overrides);
  const context = planVerificationContext({
    verificationInput: input,
    repository: repositoryOf(files),
  });
  return verifyDeterministically(input, context);
}

const decisionOf = (attempt: VerificationAttempt) =>
  attempt.status === "completed" ? attempt.decision : `unavailable`;
const reasonsOf = (attempt: VerificationAttempt) =>
  attempt.status === "completed" ? attempt.reasons : [];

describe("The verifier re-derives rather than agrees", () => {
  it("verifies a claim its own context confirms", () => {
    const attempt = verify({
      "src/caller.ts": CALLER,
      "src/store.ts": ASYNC_STORE,
    });
    expect(decisionOf(attempt)).toBe("verified");
    expect(reasonsOf(attempt)).toContain("independent_context_confirms");
  });

  it("rejects a claim its own context contradicts", () => {
    // The declaration is not asynchronous, so the mechanism the claim describes
    // cannot occur — established independently, not taken from the evidence.
    const attempt = verify(
      { "src/caller.ts": CALLER, "src/store.ts": SYNC_STORE },
      { evidence: [] },
    );
    expect(decisionOf(attempt)).toBe("rejected");
    expect(reasonsOf(attempt)).toEqual(["claim_contradicted_by_context"]);
  });

  it("rejects a claim whose mechanism is not at the location it names", () => {
    const attempt = verify({
      "src/caller.ts": "export function run(): void {\n  return;\n}\n",
      "src/store.ts": ASYNC_STORE,
    });
    expect(decisionOf(attempt)).toBe("rejected");
    expect(reasonsOf(attempt)).toEqual(["claimed_mechanism_not_present"]);
  });

  it("rejects a claim the code already guards", () => {
    const attempt = verify({
      "src/caller.ts": CALLER.replace("  save();", "  void save();"),
      "src/store.ts": ASYNC_STORE,
    });
    expect(decisionOf(attempt)).toBe("rejected");
    expect(reasonsOf(attempt)).toEqual(["guarded_on_all_paths"]);
  });

  it("degrades to inconclusive when the settling declaration is missing", () => {
    // The rule that is easy to get wrong. "We could not confirm it" is not
    // "we established it is false" — collapsing them would make precision
    // improve as the planner got worse.
    const attempt = verify(
      { "src/caller.ts": CALLER },
      {
        evidence: [
          {
            type: "static_analysis",
            observation: "`save` is declared with the `async` keyword",
          },
        ],
      },
    );
    expect(decisionOf(attempt)).toBe("inconclusive");
    expect(reasonsOf(attempt)).toEqual(["insufficient_evidence"]);
  });

  it("gives contradictory evidence its own path", () => {
    // Something *is* known and it conflicts with the supplied support. Folding
    // this into generic insufficiency would hide the most interesting signal a
    // verifier produces.
    const attempt = verify({
      "src/caller.ts": CALLER,
      "src/store.ts": SYNC_STORE,
    });
    expect(decisionOf(attempt)).toBe("inconclusive");
    expect(reasonsOf(attempt)).toEqual(["conflicting_independent_evidence"]);
  });

  it("reports incomplete context as inconclusive, not as a rejection", () => {
    const attempt = verify(
      { "src/caller.ts": CALLER, "src/store.ts": ASYNC_STORE },
      {
        evidence: [
          {
            type: "static_analysis",
            observation: "declared elsewhere",
            location: { path: "src/missing.ts", startLine: 1, endLine: 1 },
          },
        ],
      },
    );
    expect(decisionOf(attempt)).toBe("inconclusive");
    expect(reasonsOf(attempt)).toEqual(["context_incomplete"]);
  });
});

describe("Decision and reason must be compatible", () => {
  it("permits exactly the pairings the table declares", () => {
    // Exhaustive, like the lifecycle matrices. Without it,
    // `{ verified, claim_contradicted_by_context }` is well-typed and
    // semantically impossible, and the first person to hit it is reading a
    // published finding.
    for (const reason of VERIFICATION_REASONS) {
      for (const decision of [
        "verified",
        "rejected",
        "inconclusive",
      ] as const) {
        const legal = REASON_SUPPORTS[reason] === decision;
        let threw = false;
        try {
          assertReasonsSupport(decision, [reason]);
        } catch {
          threw = true;
        }
        expect(`${reason}->${decision}:${String(!threw)}`).toBe(
          `${reason}->${decision}:${String(legal)}`,
        );
      }
    }
  });

  it("refuses a completed decision with no reason at all", () => {
    expect(() => {
      assertReasonsSupport("verified", []);
    }).toThrow(/must say why/i);
  });

  it("refuses a mixed set where one reason supports another decision", () => {
    expect(() => {
      assertReasonsSupport("verified", [
        "independent_context_confirms",
        "guarded_on_all_paths",
      ]);
    }).toThrow(/cannot justify/i);
  });
});

describe("Every reason code is reachable", () => {
  it("is exercised by a real verification, not merely declared", () => {
    // A reason nothing can produce is a vocabulary entry that will be misused
    // by whoever finds it first.
    const produced = new Set<VerificationReason>();
    const record = (attempt: VerificationAttempt): void => {
      for (const reason of reasonsOf(attempt)) produced.add(reason);
    };

    record(verify({ "src/caller.ts": CALLER, "src/store.ts": ASYNC_STORE }));
    // A claim no procedure adjudicates. Added when the competence boundary
    // landed: the verifier now abstains on a claim family it has no way to
    // settle, and that abstention has its own reason precisely so it is not
    // mistaken for a planner gap.
    record(
      verify(
        { "src/caller.ts": CALLER, "src/store.ts": ASYNC_STORE },
        {
          claim: {
            statement:
              "Retrying `charge()` may duplicate the payment because the provider operation is not idempotent.",
            steps: [],
            trigger: "a retry occurs",
            consequence: "the payment is taken twice",
          },
        },
      ),
    );
    record(
      verify(
        { "src/caller.ts": CALLER, "src/store.ts": SYNC_STORE },
        { evidence: [] },
      ),
    );
    record(verify({ "src/caller.ts": CALLER, "src/store.ts": SYNC_STORE }));
    record(
      verify({
        "src/caller.ts": "export function run(): void {\n  return;\n}\n",
        "src/store.ts": ASYNC_STORE,
      }),
    );
    record(
      verify({
        "src/caller.ts": CALLER.replace("  save();", "  void save();"),
        "src/store.ts": ASYNC_STORE,
      }),
    );
    record(
      verify(
        { "src/caller.ts": CALLER },
        {
          evidence: [
            {
              type: "static_analysis",
              observation: "`save` is declared `async`",
            },
          ],
        },
      ),
    );
    record(
      verify(
        { "src/caller.ts": CALLER, "src/store.ts": ASYNC_STORE },
        {
          evidence: [
            {
              type: "static_analysis",
              observation: "declared elsewhere",
              location: { path: "src/missing.ts", startLine: 1, endLine: 1 },
            },
          ],
        },
      ),
    );

    // The signature capability's three reasons, each from a real
    // adjudication rather than a declaration.
    const signature = (
      files: Record<string, string>,
      statement: string,
      line: number,
    ): VerificationAttempt =>
      verify(files, {
        claim: {
          statement,
          steps: [],
          trigger: "the call executes",
          consequence: "the contract is violated",
        },
        location: { path: "src/caller.ts", startLine: line, endLine: line },
      });

    const API_NEW =
      "export function send(id: string, urgent: boolean): void {\n  return;\n}";
    const CALLER_STALE =
      'import { send } from "./api.js";\nexport function run(id: string): void {\n  send(id);\n}';
    const CALLER_OK =
      'import { send } from "./api.js";\nexport function run(id: string): void {\n  send(id, false);\n}';

    record(
      signature(
        { "src/api.ts": API_NEW, "src/caller.ts": CALLER_STALE },
        "`send()` is called without `urgent`, which this change made required",
        3,
      ),
    );
    record(
      signature(
        { "src/api.ts": API_NEW, "src/caller.ts": CALLER_OK },
        "`send()` is called without `urgent`, which this change made required",
        3,
      ),
    );
    record(
      signature(
        { "src/api.ts": API_NEW, "src/caller.ts": CALLER_OK },
        "the new parameter breaks existing callers of send()",
        3,
      ),
    );

    // The condition capability's two reasons, from real adjudications: an
    // async callee in a branch, and the same branch with a synchronous one.
    const condition = (declaration: string): VerificationAttempt =>
      verify(
        {
          "src/gate.ts": [
            declaration,
            "export function run(): void {",
            "  if (enabled()) {",
            "    return;",
            "  }",
            "}",
          ].join("\n"),
        },
        {
          claim: {
            statement:
              "`enabled()` returns a promise and is used directly as a condition, so the guard never fails",
            steps: [],
            trigger: "the branch runs",
            consequence: "the guard does nothing",
          },
          location: { path: "src/gate.ts", startLine: 5, endLine: 5 },
        },
      );

    record(
      condition(
        "async function enabled(): Promise<boolean> {\n  return false;\n}",
      ),
    );
    record(condition("function enabled(): boolean {\n  return false;\n}"));

    // `not_caused_by_change` is declared and this verifier cannot yet produce
    // it: the counterfactual is decided in the analyzer, and re-deciding it
    // here would need change data the verifier is not given. Named explicitly
    // rather than left as a silent hole in the conformance check.
    const knownUnreachable = new Set<VerificationReason>([
      "not_caused_by_change",
    ]);

    const unreachable = VERIFICATION_REASONS.filter(
      (reason) => !produced.has(reason) && !knownUnreachable.has(reason),
    );
    expect(unreachable).toEqual([]);
  });
});

describe("The verifier ignores everything about the analyzer", () => {
  const files = { "src/caller.ts": CALLER, "src/store.ts": ASYNC_STORE };

  const attemptFor = (overrides: Partial<VerificationInput>) =>
    verify(files, overrides);

  it("reaches the same decision whatever the candidate id", () => {
    // Verification identity answers "have these facts been checked?", not
    // "have I checked this object?".
    expect(attemptFor({ candidateId: "cand-2" })).toEqual(
      attemptFor({ candidateId: "cand-1" }),
    );
  });

  it("is deterministic across repeated runs", () => {
    const first = verify(files);
    for (let run = 0; run < 5; run += 1) {
      expect(verify(files)).toEqual(first);
    }
  });

  it("keeps the cache key stable when only the candidate changes", () => {
    const key = (candidateId: string) =>
      verificationCacheKey({
        claimIdentity: claimIdentity(inputFor({ candidateId })),
        verifierContextDigest: "c".repeat(64),
        verifierId: DETERMINISTIC_VERIFIER_ID,
        verifierVersion: DETERMINISTIC_VERIFIER_VERSION,
      });
    expect(key("cand-2")).toBe(key("cand-1"));
  });
});

describe("A candidate's analyzer confidence never reaches the decision", () => {
  it("produces the same attempt for a confident and a hesitant analyzer", () => {
    // The end-to-end version of the boundary property: two candidates identical
    // except for how sure the analyzer was, projected and verified.
    const base: CandidateFinding = {
      ruleId: "acalys.correctness.async-completion/floating-promise",
      category: "correctness",
      family: "error_handling",
      claim: "The promise returned by `save()` is discarded.",
      causal: {
        anchor: { path: "src/caller.ts", startLine: 3, endLine: 3 },
        steps: ["`save` is asynchronous", "the statement discards the promise"],
        trigger: "any execution in which the call rejects",
        consequence: "an unhandled rejection",
      },
      remediation: "Add `await`.",
      counterfactual: {
        existsWithoutChange: false,
        because: "the line is new",
      },
      proposedSeverity: "medium",
      confidenceScore: 0.95,
      location: { path: "src/caller.ts", startLine: 3, endLine: 3 },
      evidence: [
        {
          type: "static_analysis",
          strength: "deterministic",
          observation: "`save` is declared at src/store.ts:1 with `async`",
          location: { path: "src/store.ts", startLine: 1, endLine: 1 },
        },
      ],
      identityHint: "src/caller.ts:save:floating",
      clusterId: "cluster:src/caller.ts",
    };

    const run = (candidate: CandidateFinding) => {
      const { input } = toVerificationInput("cand-1", candidate, {
        repositoryId: REPO,
        revisionId: REVISION,
      });
      const context = planVerificationContext({
        verificationInput: input,
        repository: repositoryOf({
          "src/caller.ts": CALLER,
          "src/store.ts": ASYNC_STORE,
        }),
      });
      return verifyDeterministically(input, context);
    };

    expect(run({ ...base, confidenceScore: 0.56 })).toEqual(run(base));
  });
});
