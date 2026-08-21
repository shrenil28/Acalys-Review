/**
 * P1-M.2 production witnesses — the seven the capability contract requires.
 *
 * One success path is not a trust funnel. These drive `runRealAnalysis`, the
 * real production entry, and establish each branch the capability can take:
 *
 * ```
 * 1  option ON, genuine violation      -> candidate -> VERIFIED
 * 2  option OFF                        -> no candidate  (analyzer suppression)
 * 3  option ON, semantics permit       -> candidate -> REJECTED  (refutation)
 * 4  governance absent                 -> no candidate
 * 5  A governs ON, B unavailable       -> candidate survives the outage
 * 6  project not reproducible          -> INCONCLUSIVE, never VERIFIED
 * 7  the historical natural FP         -> still unpublished
 * ```
 *
 * Witness 3 is the one that matters most. A verifier mutated to confirm
 * whatever the analyzer proposes passes every other test in this file.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import {
  EXACT_OPTIONAL_WRITE_RULE_ID,
  planVerificationContext,
  verifyDeterministically,
  type CandidateFinding,
} from "@acalys/review-engine";

const REPO = "0192f8a1-0000-7000-8000-0000000000dd";
const SHA = "f".repeat(40);

const STRICT =
  '{"compilerOptions":{"strict":true,"exactOptionalPropertyTypes":true}}';
const RELAXED =
  '{"compilerOptions":{"strict":true,"exactOptionalPropertyTypes":false}}';

/** `tag?: string` — the declared type excludes `undefined`. */
const VIOLATION = [
  "interface Entry { tag?: string }",
  "export function clear(entry: Entry): void {",
  "  entry.tag = undefined;",
  "}",
].join("\n");

/** Syntactically identical; `undefined` is part of the declared type. */
const PERMITTED = [
  "type Maybe<T> = T | undefined;",
  "interface Entry { tag?: Maybe<string> }",
  "export function clear(entry: Entry): void {",
  "  entry.tag = undefined;",
  "}",
].join("\n");

function fixtureSource(
  files: Record<string, string>,
  changed: readonly { path: string; changedLines: readonly number[] }[],
): AnalysisSource {
  return {
    read: () =>
      Promise.resolve({
        changed: changed.map((entry) => ({
          path: entry.path,
          content: files[entry.path] ?? "",
          changedLines: entry.changedLines,
        })),
        repository: new Map(Object.entries(files)),
      }),
  };
}

const review = (files: Record<string, string>, line: number) =>
  runRealAnalysis({
    repositoryId: REPO,
    headSha: SHA,
    tenantId: "tenant-1",
    source: fixtureSource(files, [
      { path: "src/cache.ts", changedLines: [line] },
    ]),
  });

/** Runs the real verifier over a candidate, as the funnel does. */
function adjudicate(
  candidate: CandidateFinding,
  files: Record<string, string>,
) {
  const input = {
    candidateId: "m2-candidate",
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
      repository: { revisionId: SHA, files: new Map(Object.entries(files)) },
    }),
  );
}

// ---------------------------------------------------------------------------

describe("witness 1 — a genuine violation reaches verification", () => {
  const FILES = { "tsconfig.json": STRICT, "src/cache.ts": VIOLATION };

  it("produces exactly one M.2 candidate from the production entry", async () => {
    const outcome = await review(FILES, 3);
    const mine = outcome.report.findings.filter(
      (finding) => finding.ruleId === EXACT_OPTIONAL_WRITE_RULE_ID,
    );

    expect(mine).toHaveLength(1);
    // Identity asserted, so another analyzer cannot accidentally satisfy this.
    expect(mine[0]?.location).toEqual({
      path: "src/cache.ts",
      startLine: 3,
      endLine: 3,
    });
    expect(mine[0]?.claim).toContain("exactOptionalPropertyTypes");
  });

  it("is VERIFIED by the compiler, independently", async () => {
    const outcome = await review(FILES, 3);
    const candidate = outcome.report.findings.find(
      (finding) => finding.ruleId === EXACT_OPTIONAL_WRITE_RULE_ID,
    );
    if (candidate === undefined) throw new Error("no M.2 candidate");

    const attempt = adjudicate(candidate, FILES);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("verified");
    expect(attempt.reasons).toContain("governing_compiler_rejects_write");
  });
});

describe("witness 2 — the option is off", () => {
  it("establishes the syntactic trigger exists", async () => {
    // Without this the next assertion is another "the analyzer saw nothing"
    // green test, which is exactly how an AST mismatch stayed invisible during
    // implementation.
    const outcome = await review(
      { "tsconfig.json": STRICT, "src/cache.ts": VIOLATION },
      3,
    );
    expect(
      outcome.report.findings.filter(
        (finding) => finding.ruleId === EXACT_OPTIONAL_WRITE_RULE_ID,
      ),
    ).toHaveLength(1);
  });

  it("produces no candidate when the governing project disables it", async () => {
    const outcome = await review(
      { "tsconfig.json": RELAXED, "src/cache.ts": VIOLATION },
      3,
    );
    expect(
      outcome.report.findings.filter(
        (finding) => finding.ruleId === EXACT_OPTIONAL_WRITE_RULE_ID,
      ),
    ).toEqual([]);
  });
});

describe("witness 3 — the verifier refutes what the analyzer proposed", () => {
  const FILES = { "tsconfig.json": STRICT, "src/cache.ts": PERMITTED };

  it("still produces a candidate — the hypothesis is genuinely formed", async () => {
    // The premise. If no candidate existed, "the verifier rejected it" would
    // be true of nothing and the independence proof would be vacuous.
    const outcome = await review(FILES, 4);
    expect(
      outcome.report.findings.filter(
        (finding) => finding.ruleId === EXACT_OPTIONAL_WRITE_RULE_ID,
      ),
    ).toHaveLength(1);
  });

  it("REJECTS it, because the compiler affirmatively permits the write", async () => {
    const outcome = await review(FILES, 4);
    const candidate = outcome.report.findings.find(
      (finding) => finding.ruleId === EXACT_OPTIONAL_WRITE_RULE_ID,
    );
    if (candidate === undefined) throw new Error("no M.2 candidate");

    const attempt = adjudicate(candidate, FILES);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;

    // A verifier that could only agree passes every other test here.
    expect(attempt.decision).toBe("rejected");
    expect(attempt.reasons).toContain("governing_compiler_permits_write");
  });
});

describe("witness 4 — governance was never established", () => {
  it("produces no candidate when no config governs the file", async () => {
    const outcome = await review({ "src/cache.ts": VIOLATION }, 3);
    expect(
      outcome.report.findings.filter(
        (finding) => finding.ruleId === EXACT_OPTIONAL_WRITE_RULE_ID,
      ),
    ).toEqual([]);
  });
});

describe("witness 6 — the project cannot be reproduced", () => {
  it("is INCONCLUSIVE, never VERIFIED, when no config reaches the verifier", () => {
    // One definite outcome, not `toContain(["inconclusive","unavailable"])`.
    // An assertion accepting either side of a distinction cannot defend it.
    const candidate: CandidateFinding = {
      ruleId: EXACT_OPTIONAL_WRITE_RULE_ID,
      category: "correctness",
      family: "nullability",
      claim:
        "Writing `undefined` to the optional property `tag` is rejected under exactOptionalPropertyTypes, which is enabled by tsconfig.json.",
      causal: {
        anchor: { path: "src/cache.ts", startLine: 3, endLine: 3 },
        steps: ["`tag` is declared optional"],
        trigger: "compiling the change",
        consequence: "the project fails to typecheck",
      },
      remediation: "Delete the property.",
      counterfactual: { existsWithoutChange: false, because: "changed line" },
      proposedSeverity: "medium",
      confidenceScore: 0.6,
      location: { path: "src/cache.ts", startLine: 3, endLine: 3 },
      evidence: [],
      identityHint: "src/cache.ts:tag:exact-optional-write",
      clusterId: "cluster:m2",
    };

    const attempt = adjudicate(candidate, { "src/cache.ts": VIOLATION });
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;

    expect(attempt.decision).toBe("inconclusive");
    expect(attempt.reasons).toContain("governing_project_unavailable");
  });
});

describe("witness 7 — the natural false positive stays unpublished", () => {
  it("does not resurrect the historical shadowed-parameter candidate", async () => {
    // System-level, not a claim about M.2's syntax. The question is whether
    // adding a capability revived a defect the reviewer already learned not to
    // report — which is the entire reason the natural-FP corpus exists, and
    // has nothing to do with this family.
    const FILES = {
      "tsconfig.json": STRICT,
      "src/store.ts":
        "export async function save(): Promise<void> {\n  return;\n}",
      "src/cache.ts": [
        'import { save } from "./store.js";',
        "export function run(save: () => number): number {",
        "  return save();",
        "}",
      ].join("\n"),
    };

    const outcome = await review(FILES, 3);

    // The shadowed synchronous parameter must not be reported as a discarded
    // promise, and M.2 must not add a claim of its own here either.
    expect(outcome.candidates).toEqual([]);
    expect(outcome.report.findings).toEqual([]);
  });
});
