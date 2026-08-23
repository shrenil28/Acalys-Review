/**
 * P1-M.4 production witnesses — `discarded_replacement_return`.
 *
 * ```
 * 1  a normalizer's result thrown away        -> VERIFIED, published
 * 2  a void procedure                         -> candidate, REJECTED
 * 3  a predicate                              -> candidate, REJECTED
 * 4  an identity function                     -> candidate, REJECTED
 * 5  the same-named decoy in another module   -> resolved correctly
 * 6  base absent / unavailable / not_indexed  -> no candidate
 * 7  the callee cannot be reached             -> never VERIFIED
 * 8  the natural false positive               -> still unpublished
 * ```
 *
 * Witnesses 2 through 4 are the substance. All three discard a result, the
 * analyzer proposes on all three, and none is a defect. A capability that
 * published them would be "unused return value", which the contract forbids by
 * name.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import {
  DISCARDED_REPLACEMENT_RULE_ID,
  planVerificationContext,
  verifyDeterministically,
  type CandidateFinding,
} from "@acalys/review-engine";

const REPO = "0192f8a1-0000-7000-8000-0000000000d4";
const SHA = "5".repeat(40);
const BASE_SHA = "6".repeat(40);
const CALLER = "src/route.ts";

const BASE_CALLER = [
  'import { validate } from "./validator.js";',
  "export function route(raw: string): string {",
  "  return validate(raw);",
  "}",
].join("\n");

const HEAD_CALLER = [
  'import { validate } from "./validator.js";',
  "export function route(raw: string): string {",
  "  validate(raw);",
  "  return raw;",
  "}",
].join("\n");

type BaseState =
  | { kind: "present"; content: string }
  | { kind: "absent" }
  | { kind: "unavailable"; because: string }
  | { kind: "not_indexed" };

function sourceFor(options: {
  readonly head: Record<string, string>;
  readonly base?: BaseState;
  readonly changedPath?: string;
}): AnalysisSource {
  const path = options.changedPath ?? CALLER;
  return {
    read: () =>
      Promise.resolve({
        changed: [
          {
            path,
            content: options.head[path] ?? "",
            changedLines: [1, 2, 3, 4, 5],
            ...(options.base === undefined ? {} : { base: options.base }),
          },
        ],
        repository: new Map(Object.entries(options.head)),
        baseSha: BASE_SHA,
      }),
  };
}

const review = (options: Parameters<typeof sourceFor>[0]) =>
  runRealAnalysis({
    repositoryId: REPO,
    headSha: SHA,
    tenantId: "tenant-1",
    source: sourceFor(options),
  });

const mine = (findings: readonly CandidateFinding[]) =>
  findings.filter(
    (finding) => finding.ruleId === DISCARDED_REPLACEMENT_RULE_ID,
  );

function adjudicate(candidate: CandidateFinding, head: Record<string, string>) {
  const input = {
    candidateId: "m4-candidate",
    repositoryId: REPO,
    revisionId: SHA,
    remediation: candidate.remediation,
    claim: {
      statement: candidate.claim,
      steps: candidate.causal.steps,
      trigger: candidate.causal.trigger,
      consequence: candidate.causal.consequence,
    },
    location: candidate.location,
    evidence: candidate.evidence.map((entry) => ({
      type: entry.type,
      observation: entry.observation,
      ...(entry.location === undefined ? {} : { location: entry.location }),
    })),
    proposedSeverity: candidate.proposedSeverity,
  };

  return verifyDeterministically(
    input,
    planVerificationContext({
      verificationInput: input,
      repository: { revisionId: SHA, files: new Map(Object.entries(head)) },
    }),
  );
}

/** Analyzes the standard caller change against a given validator body. */
async function run(validator: string, extra: Record<string, string> = {}) {
  const head = {
    [CALLER]: HEAD_CALLER,
    "src/validator.ts": validator,
    ...extra,
  };
  const outcome = await review({
    head,
    base: { kind: "present", content: BASE_CALLER },
  });
  return { candidates: mine(outcome.report.findings), head };
}

// ---------------------------------------------------------------------------

describe("witness 1 — a normalizer's result is thrown away", () => {
  const VALIDATOR =
    'export function validate(raw: string): string {\n  if (raw === "") throw new Error("empty");\n  return raw.trim();\n}';

  it("produces exactly one candidate, anchored at the discarding statement", async () => {
    const { candidates } = await run(VALIDATOR);

    expect(candidates).toHaveLength(1);
    // Line 3 is `validate(raw);`. Not line 1, and not a constant.
    expect(candidates[0]?.location).toEqual({
      path: CALLER,
      startLine: 3,
      endLine: 3,
    });
  });

  it("is VERIFIED against the resolved callee", async () => {
    const { candidates, head } = await run(VALIDATOR);
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("no M.4 candidate");

    const attempt = adjudicate(candidate, head);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("verified");
    expect(attempt.reasons).toContain("discarded_value_carried_replacement");
  });
});

describe("witnesses 2-4 — discarding a result is usually fine", () => {
  it.each([
    [
      "a void procedure",
      'export function validate(raw: string): void {\n  if (raw === "") throw new Error("empty");\n}',
    ],
    [
      "a predicate",
      "export function validate(raw: string): boolean {\n  return raw.length > 0;\n}",
    ],
    [
      "an identity function",
      "export function validate(raw: string): string {\n  return raw;\n}",
    ],
  ])("proposes on %s and is REJECTED", async (_label, validator) => {
    const { candidates, head } = await run(validator);

    // The premise. Without a candidate the refutation is true of nothing.
    expect(candidates).toHaveLength(1);

    const attempt = adjudicate(candidates[0]!, head);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("rejected");
    expect(attempt.reasons).toContain("discarded_value_carried_nothing");
  });
});

describe("witness 5 — the same-named decoy", () => {
  it("resolves the imported declaration, not the one that shares its name", async () => {
    const { candidates, head } = await run(
      "export function validate(raw: string): string {\n  return raw.trim();\n}",
      {
        "src/test-helper.ts":
          "export function validate(): boolean {\n  return true;\n}",
      },
    );

    const attempt = adjudicate(candidates[0]!, head);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    // Name matching reaches the boolean helper and rejects a real defect.
    expect(attempt.decision).toBe("verified");
  });
});

describe("witness 6 — the base revision was not established", () => {
  it.each([
    ["unavailable", { kind: "unavailable", because: "object store timeout" }],
    ["not_indexed", { kind: "not_indexed" }],
    ["absent", { kind: "absent" }],
  ] as const)("produces no candidate when the base is %s", async (_l, base) => {
    const outcome = await review({
      head: {
        [CALLER]: HEAD_CALLER,
        "src/validator.ts":
          "export function validate(raw: string): string {\n  return raw.trim();\n}",
      },
      base,
    });

    expect(mine(outcome.report.findings)).toEqual([]);
  });

  it("produces no candidate when head still consumes the result elsewhere", async () => {
    // The author kept a use of the value. This particular statement is not
    // where a replacement was lost, and reporting it would tell someone their
    // code discards a result they demonstrably still use.
    const STILL_USED = [
      'import { validate } from "./validator.js";',
      "export function route(raw: string, other: string): string {",
      "  validate(raw);",
      "  const kept = validate(other);",
      "  return kept;",
      "}",
    ].join("\n");

    const outcome = await review({
      head: {
        [CALLER]: STILL_USED,
        "src/validator.ts":
          "export function validate(raw: string): string {\n  return raw.trim();\n}",
      },
      base: { kind: "present", content: BASE_CALLER },
    });

    expect(mine(outcome.report.findings)).toEqual([]);
  });

  it("produces no candidate when the base already discarded the result", async () => {
    // Not a change this capability is about: the author did not lose anything
    // in this revision.
    const outcome = await review({
      head: {
        [CALLER]: HEAD_CALLER,
        "src/validator.ts":
          "export function validate(raw: string): string {\n  return raw.trim();\n}",
      },
      base: { kind: "present", content: HEAD_CALLER },
    });

    expect(mine(outcome.report.findings)).toEqual([]);
  });
});

describe("witness 7 — the callee cannot be reached", () => {
  it("is INCONCLUSIVE, never VERIFIED, when its module is absent", async () => {
    const head = { [CALLER]: HEAD_CALLER };
    const outcome = await review({
      head,
      base: { kind: "present", content: BASE_CALLER },
    });
    const candidate = mine(outcome.report.findings)[0];
    if (candidate === undefined) throw new Error("no M.4 candidate");

    const attempt = adjudicate(candidate, head);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("inconclusive");
    expect(attempt.reasons).toContain("replacement_evidence_unavailable");
  });
});

describe("witness 8 — the natural false positive stays unpublished", () => {
  it("does not resurrect the historical shadowed-parameter candidate", async () => {
    const HEAD = {
      "src/store.ts":
        "export async function save(): Promise<void> {\n  return;\n}",
      "src/cache.ts": [
        'import { save } from "./store.js";',
        "export function run(save: () => number): number {",
        "  return save();",
        "}",
      ].join("\n"),
    };

    const outcome = await review({
      head: HEAD,
      base: { kind: "present", content: HEAD["src/cache.ts"] },
      changedPath: "src/cache.ts",
    });

    expect(outcome.report.findings).toEqual([]);
  });
});
