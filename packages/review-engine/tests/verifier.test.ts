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

/**
 * Real P1-M.3 verifications, used both as behaviour and as the reachability
 * evidence for the five compatibility reason codes.
 */
function verifyCompatibility(options: {
  readonly statement: string;
  readonly path: string;
  readonly head: Record<string, string>;
  readonly base?: Record<string, string> | undefined;
}): VerificationAttempt {
  const input = inputFor({
    claim: {
      statement: options.statement,
      steps: [],
      trigger: "a consumer written against the base revision is compiled",
      consequence: "the consumer no longer compiles",
    },
    location: { path: options.path, startLine: 1, endLine: 1 },
    evidence: [],
  });

  const context = planVerificationContext({
    verificationInput: input,
    repository: repositoryOf(options.head),
    ...(options.base === undefined
      ? {}
      : {
          comparison: {
            revisionId: "b".repeat(40),
            files: new Map(Object.entries(options.base)),
          },
        }),
  });

  return verifyDeterministically(input, context);
}

const REMOVAL_CLAIM =
  "`parse` was reachable through src/parser.ts at the base revision and may no longer be reachable through that boundary, so consumers importing it stop compiling.";
const ARITY_CLAIM =
  "`save` accepted 1 required argument(s) at the base revision and now declares 2, so a call written against the previous contract may no longer compile.";
const BASE_PARSER =
  "export function parse(raw: string): number {\n  return Number(raw);\n}";

describe("P1-M.3 compatibility verification", () => {
  it("VERIFIES a removal a base-valid consumer can no longer perform", () => {
    const attempt = verifyCompatibility({
      statement: REMOVAL_CLAIM,
      path: "src/parser.ts",
      base: { "src/parser.ts": BASE_PARSER },
      head: { "src/parser.ts": "export function other(): void {}" },
    });

    expect(decisionOf(attempt)).toBe("verified");
    expect(reasonsOf(attempt)).toContain("public_export_unreachable_at_head");
  });

  it("REJECTS a removal the head revision still satisfies", () => {
    const attempt = verifyCompatibility({
      statement: REMOVAL_CLAIM,
      path: "src/parser.ts",
      base: { "src/parser.ts": BASE_PARSER },
      head: {
        "src/parser.ts": 'export { parse } from "./impl";',
        "src/impl.ts": BASE_PARSER,
      },
    });

    expect(decisionOf(attempt)).toBe("rejected");
    expect(reasonsOf(attempt)).toContain("public_export_still_reachable");
  });

  it("VERIFIES an arity break against a base-valid call", () => {
    const attempt = verifyCompatibility({
      statement: ARITY_CLAIM,
      path: "src/api.ts",
      base: { "src/api.ts": "export function save(value: string): void {}" },
      head: {
        "src/api.ts":
          "export function save(value: string, flush: boolean): void {}",
      },
    });

    expect(decisionOf(attempt)).toBe("verified");
    expect(reasonsOf(attempt)).toContain("base_valid_call_rejected_at_head");
  });

  it("REJECTS an arity claim when the new parameter is optional", () => {
    const attempt = verifyCompatibility({
      statement: ARITY_CLAIM,
      path: "src/api.ts",
      base: { "src/api.ts": "export function save(value: string): void {}" },
      head: {
        "src/api.ts":
          "export function save(value: string, flush?: boolean): void {}",
      },
    });

    expect(decisionOf(attempt)).toBe("rejected");
    expect(reasonsOf(attempt)).toContain("base_valid_call_still_accepted");
  });

  it("abstains, never concludes, when no comparison revision was supplied", () => {
    // The reading this forbids is "no base, so nothing was removed" — a
    // negative conclusion drawn from a missing input, which is silent when it
    // is wrong because the review simply comes back clean.
    const attempt = verifyCompatibility({
      statement: REMOVAL_CLAIM,
      path: "src/parser.ts",
      head: { "src/parser.ts": "export function other(): void {}" },
    });

    expect(decisionOf(attempt)).toBe("inconclusive");
    expect(reasonsOf(attempt)).toContain("comparison_revision_unavailable");
  });
});

const DISCARD_CLAIM =
  "The result of `validate(raw)` was used at the base revision and is discarded here, so any replacement value it returns for `raw` is lost.";

const DISCARDING_CALLER = [
  'import { validate } from "./validator.js";',
  "export function route(raw: string): string {",
  "  validate(raw);",
  "  return raw;",
  "}",
].join("\n");

/** A real M.4 verification, used as behaviour and as reachability evidence. */
function verifyDiscard(validator: string | undefined): VerificationAttempt {
  const input = inputFor({
    claim: {
      statement: DISCARD_CLAIM,
      steps: [],
      trigger: "calling `validate` and continuing with `raw`",
      consequence: "the untransformed value flows onward",
    },
    location: { path: "src/route.ts", startLine: 3, endLine: 3 },
    evidence: [],
  });

  const files: Record<string, string> = { "src/route.ts": DISCARDING_CALLER };
  if (validator !== undefined) files["src/validator.ts"] = validator;

  return verifyDeterministically(
    input,
    planVerificationContext({
      verificationInput: input,
      repository: repositoryOf(files),
    }),
  );
}

describe("P1-M.4 discarded replacement verification", () => {
  it("VERIFIES when the callee returned a transformed replacement", () => {
    const attempt = verifyDiscard(
      "export function validate(raw: string): string {\n  return raw.trim();\n}",
    );

    expect(decisionOf(attempt)).toBe("verified");
    expect(reasonsOf(attempt)).toContain("discarded_value_carried_replacement");
  });

  it("REJECTS a predicate, whose result cannot replace the argument", () => {
    const attempt = verifyDiscard(
      "export function validate(raw: string): boolean {\n  return raw.length > 0;\n}",
    );

    expect(decisionOf(attempt)).toBe("rejected");
    expect(reasonsOf(attempt)).toContain("discarded_value_carried_nothing");
  });

  it("abstains when the callee cannot be reached at all", () => {
    const attempt = verifyDiscard(undefined);

    expect(decisionOf(attempt)).toBe("inconclusive");
    expect(reasonsOf(attempt)).toContain("replacement_evidence_unavailable");
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

    // P1-M.4, produced by real verifications rather than asserted into the set.
    record(
      verifyDiscard(
        "export function validate(raw: string): string {\n  return raw.trim();\n}",
      ),
    );
    record(
      verifyDiscard(
        "export function validate(raw: string): boolean {\n  return raw.length > 0;\n}",
      ),
    );
    record(verifyDiscard(undefined));

    // P1-M.3, produced by real verifications rather than asserted into the set.
    record(
      verifyCompatibility({
        statement: REMOVAL_CLAIM,
        path: "src/parser.ts",
        base: { "src/parser.ts": BASE_PARSER },
        head: { "src/parser.ts": "export function other(): void {}" },
      }),
    );
    record(
      verifyCompatibility({
        statement: REMOVAL_CLAIM,
        path: "src/parser.ts",
        base: { "src/parser.ts": BASE_PARSER },
        head: {
          "src/parser.ts": 'export { parse } from "./impl";',
          "src/impl.ts": BASE_PARSER,
        },
      }),
    );
    record(
      verifyCompatibility({
        statement: ARITY_CLAIM,
        path: "src/api.ts",
        base: { "src/api.ts": "export function save(value: string): void {}" },
        head: {
          "src/api.ts":
            "export function save(value: string, flush: boolean): void {}",
        },
      }),
    );
    record(
      verifyCompatibility({
        statement: ARITY_CLAIM,
        path: "src/api.ts",
        base: { "src/api.ts": "export function save(value: string): void {}" },
        head: {
          "src/api.ts":
            "export function save(value: string, flush?: boolean): void {}",
        },
      }),
    );
    record(
      verifyCompatibility({
        statement: REMOVAL_CLAIM,
        path: "src/parser.ts",
        head: { "src/parser.ts": "export function other(): void {}" },
      }),
    );
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

    // P1-M.2's three reasons, each from a real compiler adjudication.
    //
    // The middle one matters most: `governing_compiler_permits_write` is a
    // REFUTATION produced by successfully rebuilding the project and finding
    // nothing. If it were unreachable, the capability could only ever agree
    // with its analyzer.
    const exactOptional = (
      files: Record<string, string>,
      line: number,
    ): VerificationAttempt =>
      verify(files, {
        claim: {
          statement:
            "Writing `undefined` to the optional property `tag` is rejected under exactOptionalPropertyTypes, which is enabled by tsconfig.json.",
          steps: [],
          trigger: "compiling the change under its governing project",
          consequence: "the project fails to typecheck",
        },
        location: { path: "src/cache.ts", startLine: line, endLine: line },
        // Evidence citing the governing config, exactly as the real analyzer
        // emits it. The verifier's planner admits every path evidence points
        // at, which is how the config reaches the program — without this the
        // procedure cannot build the project and correctly reports
        // `governing_project_unavailable` instead.
        evidence: [
          {
            type: "static_analysis",
            observation:
              "tsconfig.json governs src/cache.ts and enables exactOptionalPropertyTypes.",
            location: { path: "tsconfig.json", startLine: 1, endLine: 1 },
          },
        ],
      });

    const STRICT =
      '{"compilerOptions":{"strict":true,"exactOptionalPropertyTypes":true}}';

    record(
      exactOptional(
        {
          "tsconfig.json": STRICT,
          "src/cache.ts":
            "interface Entry { tag?: string }\nexport function clear(entry: Entry): void {\n  entry.tag = undefined;\n}",
        },
        3,
      ),
    );
    record(
      exactOptional(
        {
          "tsconfig.json": STRICT,
          "src/cache.ts":
            "type Maybe<T> = T | undefined;\ninterface Entry { tag?: Maybe<string> }\nexport function clear(entry: Entry): void {\n  entry.tag = undefined;\n}",
        },
        4,
      ),
    );
    record(
      exactOptional(
        {
          "src/cache.ts":
            "interface Entry { tag?: string }\nexport function clear(entry: Entry): void {\n  entry.tag = undefined;\n}",
        },
        3,
      ),
    );

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

    // The exception capability's three reasons, from real adjudications.
    const exception = (lines: readonly string[]): VerificationAttempt =>
      verify(
        { "src/commit.ts": lines.join("\n") },
        {
          claim: {
            statement: "This `catch` discards the error and does nothing.",
            steps: [],
            trigger: "the guarded operation throws",
            consequence: "the failure disappears",
          },
          location: { path: "src/commit.ts", startLine: 4, endLine: 4 },
        },
      );

    record(
      exception([
        "export function commit(): boolean {",
        "  try {",
        "    write();",
        "  } catch {}",
        "  return true;",
        "}",
        "function write(): void {}",
      ]),
    );
    record(
      exception([
        "export function commit(): void {",
        "  try {",
        "    write();",
        "  } catch (error) {",
        "    throw error;",
        "  }",
        "}",
        "function write(): void {}",
      ]),
    );
    record(
      exception([
        "export function shutdown(): void {",
        "  try {",
        "    release();",
        "  } catch {}",
        "}",
        "function release(): void {}",
      ]),
    );

    // The callback capability's five reasons, each from a real adjudication.
    const callback = (
      lines: readonly string[],
      line: number,
      statement = "`forEach` discards the promise its async callback returns.",
    ): VerificationAttempt =>
      verify(
        { "src/loop.ts": lines.join("\n") },
        {
          claim: {
            statement,
            steps: ["`forEach` ignores its callback's return value"],
            trigger: "the iteration runs",
            consequence: "the caller proceeds before the work finishes",
          },
          location: { path: "src/loop.ts", startLine: line, endLine: line },
        },
      );

    const SAVE =
      "async function save(item: number): Promise<void> {\n  return;\n}";

    // discarded by the receiver, and something proceeds afterwards
    record(
      callback(
        [
          SAVE,
          "export function run(items: number[]): void {",
          "  items.forEach(async (item) => {",
          "    await save(item);",
          "  });",
          "  done();",
          "}",
          "function done(): void {}",
        ],
        5,
      ),
    );
    // the receiver accepts a promise back
    record(
      callback(
        [
          SAVE,
          "interface Queue {",
          "  forEach(cb: (item: number) => Promise<void>): Promise<void>;",
          "}",
          "export async function run(q: Queue): Promise<void> {",
          "  await q.forEach(async (item) => {",
          "    await save(item);",
          "  });",
          "}",
        ],
        8,
      ),
    );
    // a synchronous callback: nothing to drop
    record(
      callback(
        [
          "function save(item: number): void {}",
          "export function run(items: number[]): void {",
          "  items.forEach((item) => {",
          "    save(item);",
          "  });",
          "}",
        ],
        3,
      ),
    );
    // the receiver's contract cannot be read
    record(
      callback(
        [
          SAVE,
          "export function run(x: { each(cb: unknown): unknown }): void {",
          "  x.each(async (item: number) => {",
          "    await save(item);",
          "  });",
          "}",
        ],
        5,
      ),
    );
    // dropped, but nothing establishes that completion mattered
    record(
      callback(
        [
          SAVE,
          "export async function run(items: number[]): Promise<void> {",
          "  items.forEach(async (item) => {",
          "    await save(item);",
          "  });",
          "}",
        ],
        5,
      ),
    );

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
