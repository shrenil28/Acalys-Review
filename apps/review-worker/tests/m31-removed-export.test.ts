/**
 * P1-M.3.1 production witnesses — `removed_export`.
 *
 * Driven through `runRealAnalysis`, the real production entry, so what is
 * established here is that the capability works *in the pipeline* rather than
 * in a unit test beside it.
 *
 * ```
 * 1  a public export genuinely stops being reachable  -> VERIFIED
 * 2  moved behind `export *`                          -> candidate, REJECTED
 * 3  moved behind a named re-export                   -> no candidate at all
 * 4  a type-only export still reachable               -> not published
 * 5  base absent / unavailable / not_indexed          -> no candidate
 * 6  no comparison revision reaches the verifier      -> never VERIFIED
 * 7  the historical natural FP                        -> still unpublished
 * ```
 *
 * Witness 2 is the one that matters. A verifier that could only agree with its
 * analyzer passes every other case in this file.
 *
 * Witnesses 2 and 3 are deliberately different shapes. A named re-export keeps
 * the name in the export clause where syntax can see it, so the analyzer
 * declines and no verification is spent. `export *` is opaque to syntax, so
 * the analyzer proposes and the compiler settles it. Using a named re-export
 * for the refutation case would have produced no candidate and quietly proved
 * nothing about independence.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import {
  REMOVED_EXPORT_RULE_ID,
  planVerificationContext,
  verifyDeterministically,
  type CandidateFinding,
} from "@acalys/review-engine";

const REPO = "0192f8a1-0000-7000-8000-0000000000e1";
const SHA = "c".repeat(40);
const BASE_SHA = "d".repeat(40);
const BOUNDARY = "src/parser.ts";

const EXPORTED = [
  "export function parse(raw: string): number {",
  "  return Number(raw);",
  "}",
].join("\n");

/** The historical case: the declaration survives, the export name does not. */
const ALIASED = [
  "function parse(raw: string): number {",
  "  return Number(raw);",
  "}",
  "export { parse as parseInternal };",
].join("\n");

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

const removals = (findings: readonly CandidateFinding[]) =>
  findings.filter((finding) => finding.ruleId === REMOVED_EXPORT_RULE_ID);

/** Runs the real verifier over a candidate, with the comparison revision. */
function adjudicate(
  candidate: CandidateFinding,
  head: Record<string, string>,
  base: Record<string, string>,
) {
  const input = {
    candidateId: "m31-candidate",
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
      comparison: {
        revisionId: BASE_SHA,
        files: new Map(Object.entries(base)),
      },
    }),
  );
}

// ---------------------------------------------------------------------------

describe("witness 1 — a public export stops being reachable", () => {
  const HEAD = { [BOUNDARY]: ALIASED };
  const BASE = { [BOUNDARY]: EXPORTED };

  it("produces exactly one M.3.1 candidate from the production entry", async () => {
    const outcome = await review({
      head: HEAD,
      base: { kind: "present", content: EXPORTED },
      baseSha: BASE_SHA,
    });

    const mine = removals(outcome.report.findings);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.claim).toContain("`parse`");
    expect(mine[0]?.location.path).toBe(BOUNDARY);
  });

  it("is VERIFIED by compiling a base-valid consumer against head", async () => {
    const outcome = await review({
      head: HEAD,
      base: { kind: "present", content: EXPORTED },
      baseSha: BASE_SHA,
    });
    const candidate = removals(outcome.report.findings)[0];
    if (candidate === undefined) throw new Error("no M.3.1 candidate");

    const attempt = adjudicate(candidate, HEAD, BASE);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("verified");
    expect(attempt.reasons).toContain("public_export_unreachable_at_head");
  });
});

describe("witness 2 — the verifier refutes what the analyzer proposed", () => {
  // `export *`, not a named re-export. With `export { parse } from "./impl"`
  // the name is right there in the export clause and the analyzer correctly
  // declines to hypothesize — there is nothing to refute. `export *` is the
  // shape syntax genuinely cannot resolve, so it is where the analyzer
  // proposes and something independent has to settle it.
  const HEAD = {
    [BOUNDARY]: 'export * from "./impl";',
    "src/impl.ts": EXPORTED,
  };
  const BASE = { [BOUNDARY]: EXPORTED };

  it("still produces a candidate — the hypothesis is genuinely formed", async () => {
    // The premise. Without a candidate, "the verifier rejected it" would be
    // true of nothing and the independence proof would be vacuous.
    const outcome = await review({
      head: HEAD,
      base: { kind: "present", content: EXPORTED },
      baseSha: BASE_SHA,
    });

    expect(removals(outcome.report.findings)).toHaveLength(1);
  });

  it("REJECTS it, because the same import still resolves", async () => {
    const outcome = await review({
      head: HEAD,
      base: { kind: "present", content: EXPORTED },
      baseSha: BASE_SHA,
    });
    const candidate = removals(outcome.report.findings)[0];
    if (candidate === undefined) throw new Error("no M.3.1 candidate");

    const attempt = adjudicate(candidate, HEAD, BASE);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;

    // The analyzer could not see through `export *`. The compiler could.
    expect(attempt.decision).toBe("rejected");
    expect(attempt.reasons).toContain("public_export_still_reachable");
  });
});

describe("witness 3 — a named re-export is not even hypothesized", () => {
  it("produces no candidate when the export clause still names it", async () => {
    // The declaration moved to another module. The public contract did not,
    // and this is visible in syntax, so no verification is spent on it.
    const outcome = await review({
      head: {
        [BOUNDARY]: 'export { parse } from "./impl";',
        "src/impl.ts": EXPORTED,
      },
      base: { kind: "present", content: EXPORTED },
      baseSha: BASE_SHA,
    });

    expect(removals(outcome.report.findings)).toEqual([]);
  });
});

describe("witness 4 — a type-only export that is still reachable", () => {
  it("is not reported as a removal through value space", async () => {
    // The trap: probing a type-only export in value position produces a
    // diagnostic about the probe, not about the change. Reporting it would be
    // a fabricated finding.
    const TYPES = "src/types.ts";
    const HEAD = { [TYPES]: "export type Config = { a: string; b?: number };" };
    const BASE = { [TYPES]: "export type Config = { a: string };" };

    const outcome = await review({
      head: HEAD,
      base: { kind: "present", content: BASE[TYPES] },
      baseSha: BASE_SHA,
      changedPath: TYPES,
    });

    for (const candidate of removals(outcome.report.findings)) {
      const attempt = adjudicate(candidate, HEAD, BASE);
      if (attempt.status !== "completed") continue;
      expect(attempt.decision).not.toBe("verified");
    }
  });
});

describe("witness 5 — the base revision was not established", () => {
  it.each([
    ["unavailable", { kind: "unavailable", because: "object store timeout" }],
    ["not_indexed", { kind: "not_indexed" }],
  ] as const)("produces no candidate when the base is %s", async (_l, base) => {
    // Never "no base, so nothing was removed". That is a negative conclusion
    // drawn from our own blindness, and it is silent when wrong.
    const outcome = await review({
      head: { [BOUNDARY]: ALIASED },
      base,
      baseSha: BASE_SHA,
    });

    expect(removals(outcome.report.findings)).toEqual([]);
  });

  it("produces no candidate when the file is new at head", async () => {
    // `absent` is positive knowledge: nothing it declares can have been
    // removed, because there was nothing to remove from.
    const outcome = await review({
      head: { [BOUNDARY]: ALIASED },
      base: { kind: "absent" },
      baseSha: BASE_SHA,
    });

    expect(removals(outcome.report.findings)).toEqual([]);
  });
});

describe("witness 6 — no comparison revision reaches the verifier", () => {
  it("is INCONCLUSIVE, never VERIFIED", async () => {
    const HEAD = { [BOUNDARY]: ALIASED };
    const outcome = await review({
      head: HEAD,
      base: { kind: "present", content: EXPORTED },
      baseSha: BASE_SHA,
    });
    const candidate = removals(outcome.report.findings)[0];
    if (candidate === undefined) throw new Error("no M.3.1 candidate");

    const input = {
      candidateId: "m31-candidate",
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
      evidence: [],
      proposedSeverity: candidate.proposedSeverity,
    };

    // The same candidate, verified without the comparison revision.
    const attempt = verifyDeterministically(
      input,
      planVerificationContext({
        verificationInput: input,
        repository: { revisionId: SHA, files: new Map(Object.entries(HEAD)) },
      }),
    );

    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("inconclusive");
    expect(attempt.reasons).toContain("comparison_revision_unavailable");
  });
});

describe("witness 7 — the natural false positive stays unpublished", () => {
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
