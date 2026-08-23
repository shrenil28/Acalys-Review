/**
 * P1-M.3.2 production witnesses — `required_parameter_added`.
 *
 * ```
 * 1  a required positional parameter is added   -> VERIFIED
 * 2  the new parameter is optional              -> candidate, REJECTED
 * 3  the new parameter is defaulted             -> candidate, REJECTED
 * 4  the new parameter is a rest parameter      -> candidate, REJECTED
 * 5  an overload is added, the old one retained -> not published
 * 6  base absent / unavailable / not_indexed    -> no candidate
 * 7  no comparison revision                     -> never VERIFIED
 * 8  the historical natural FP                  -> still unpublished
 * ```
 *
 * Witnesses 2 through 4 are the substance. Every one of them increases the
 * parameter count, the analyzer proposes on exactly that signal, and the
 * compiler declines to call any of them a break. A capability that used
 * parameter count as its semantic rule would publish all three.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import {
  REQUIRED_PARAMETER_RULE_ID,
  planVerificationContext,
  verifyDeterministically,
  type CandidateFinding,
} from "@acalys/review-engine";

const REPO = "0192f8a1-0000-7000-8000-0000000000e2";
const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const BOUNDARY = "src/api.ts";

const BASE_ONE_ARG = "export function save(value: string): void {}";

type BaseState =
  | { kind: "present"; content: string }
  | { kind: "absent" }
  | { kind: "unavailable"; because: string }
  | { kind: "not_indexed" };

function sourceFor(options: {
  readonly head: Record<string, string>;
  readonly base?: BaseState | undefined;
  readonly baseSha?: string | undefined;
  readonly changedPath?: string | undefined;
}): AnalysisSource {
  const path = options.changedPath ?? BOUNDARY;
  return {
    read: () =>
      Promise.resolve({
        changed: [
          {
            path,
            content: options.head[path] ?? "",
            changedLines: [1, 2, 3, 4],
            ...(options.base === undefined ? {} : { base: options.base }),
          },
        ],
        repository: new Map(Object.entries(options.head)),
        ...(options.baseSha === undefined ? {} : { baseSha: options.baseSha }),
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

const arityFindings = (findings: readonly CandidateFinding[]) =>
  findings.filter((finding) => finding.ruleId === REQUIRED_PARAMETER_RULE_ID);

function adjudicate(
  candidate: CandidateFinding,
  head: Record<string, string>,
  base: Record<string, string>,
  withComparison = true,
) {
  const input = {
    candidateId: "m32-candidate",
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
      ...(withComparison
        ? {
            comparison: {
              revisionId: BASE_SHA,
              files: new Map(Object.entries(base)),
            },
          }
        : {}),
    }),
  );
}

/** Analyzes and adjudicates one head shape against the one-argument base. */
async function run(headSource: string) {
  const head = { [BOUNDARY]: headSource };
  const base = { [BOUNDARY]: BASE_ONE_ARG };

  const outcome = await review({
    head,
    base: { kind: "present", content: BASE_ONE_ARG },
    baseSha: BASE_SHA,
  });

  const candidates = arityFindings(outcome.report.findings);
  return {
    candidates,
    adjudicate: (candidate: CandidateFinding) =>
      adjudicate(candidate, head, base),
  };
}

// ---------------------------------------------------------------------------

describe("witness 1 — a required positional parameter is added", () => {
  const HEAD = "export function save(value: string, flush: boolean): void {}";

  it("produces exactly one M.3.2 candidate from the production entry", async () => {
    const { candidates } = await run(HEAD);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.claim).toContain("`save`");
  });

  it("is VERIFIED by compiling a base-valid call against head", async () => {
    const { candidates, adjudicate: judge } = await run(HEAD);
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("no M.3.2 candidate");

    const attempt = judge(candidate);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("verified");
    expect(attempt.reasons).toContain("base_valid_call_rejected_at_head");
  });
});

describe("witnesses 2-4 — a bigger parameter list is not a break", () => {
  it.each([
    [
      "optional",
      "export function save(value: string, flush?: boolean): void {}",
    ],
    [
      "defaulted",
      "export function save(value: string, flush: boolean = false): void {}",
    ],
    [
      "a rest parameter",
      "export function save(value: string, ...flush: boolean[]): void {}",
    ],
  ])("proposes on %s and is REJECTED by the compiler", async (_label, head) => {
    const { candidates, adjudicate: judge } = await run(head);

    // The premise: the analyzer really did hypothesize. Without this the
    // rejection below would be true of nothing.
    expect(candidates).toHaveLength(1);

    const attempt = judge(candidates[0]!);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("rejected");
    expect(attempt.reasons).toContain("base_valid_call_still_accepted");
  });
});

describe("witness 5 — an overload added beside a surviving one", () => {
  it("is never published as a break", async () => {
    const HEAD = [
      "export function save(value: string): void;",
      "export function save(value: string, flush: boolean): void;",
      "export function save(value: string, flush?: boolean): void {}",
    ].join("\n");

    const { candidates, adjudicate: judge } = await run(HEAD);

    // The analyzer may or may not propose here — taking the minimum arity
    // across the overload set, it should not. Either way, nothing may be
    // verified: the old call shape is still accepted.
    for (const candidate of candidates) {
      const attempt = judge(candidate);
      if (attempt.status !== "completed") continue;
      expect(attempt.decision).not.toBe("verified");
    }
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
        [BOUNDARY]: "export function save(v: string, f: boolean): void {}",
      },
      base,
      baseSha: BASE_SHA,
    });

    expect(arityFindings(outcome.report.findings)).toEqual([]);
  });
});

describe("witness 7 — no comparison revision reaches the verifier", () => {
  it("is INCONCLUSIVE, never VERIFIED", async () => {
    const HEAD = "export function save(value: string, flush: boolean): void {}";
    const { candidates } = await run(HEAD);
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("no M.3.2 candidate");

    const attempt = adjudicate(
      candidate,
      { [BOUNDARY]: HEAD },
      { [BOUNDARY]: BASE_ONE_ARG },
      false,
    );

    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("inconclusive");
    expect(attempt.reasons).toContain("comparison_revision_unavailable");
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
      baseSha: BASE_SHA,
      changedPath: "src/cache.ts",
    });

    expect(outcome.report.findings).toEqual([]);
  });
});
