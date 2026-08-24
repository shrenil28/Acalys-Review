/**
 * P1-M.3.5 production witnesses — proposing at the consumer boundary.
 *
 * The first witness is the one this capability exists for, and its premises
 * are asserted rather than assumed: the source bytes are identical between the
 * two revisions, so a module export-set delta is empty by construction. The
 * predecessor cannot be rescued by an incidental file change, because there
 * isn't one.
 *
 * The second is the competition failure Epoch 3 found: one edit losing a name
 * at both the boundary and the declaring module produced two candidates
 * racing, and only one of them described what a consumer experiences.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import {
  BOUNDARY_REACHABILITY_RULE_ID,
  planVerificationContext,
  verifyDeterministically,
  type CandidateFinding,
} from "@acalys/review-engine";

const REPO = "0192f8a1-0000-7000-8000-0000000000b5";
const SHA = "c".repeat(40);
const BASE_SHA = "d".repeat(40);

const DECODE =
  "export function decode(raw: string): string {\n  return raw;\n}";

const manifest = (exports: Record<string, string>) =>
  JSON.stringify({ name: "pkg", exports }, null, 2);

interface Revision {
  readonly files: Record<string, string>;
}

/** Drives the production entry over an explicit base/head pair. */
function sourceFor(
  base: Revision,
  head: Revision,
  changed: readonly string[],
): AnalysisSource {
  return {
    read: () =>
      Promise.resolve({
        changed: changed.map((path) => ({
          path,
          content: head.files[path] ?? "",
          changedLines: [1, 2, 3, 4, 5, 6, 7, 8],
          base:
            base.files[path] === undefined
              ? ({ kind: "absent" } as const)
              : ({ kind: "present", content: base.files[path] } as const),
        })),
        repository: new Map(Object.entries(head.files)),
        baseSha: BASE_SHA,
      }),
  };
}

const review = (base: Revision, head: Revision, changed: readonly string[]) =>
  runRealAnalysis({
    repositoryId: REPO,
    headSha: SHA,
    tenantId: "tenant-1",
    source: sourceFor(base, head, changed),
  });

const mine = (findings: readonly CandidateFinding[]) =>
  findings.filter(
    (finding) => finding.ruleId === BOUNDARY_REACHABILITY_RULE_ID,
  );

function adjudicate(
  candidate: CandidateFinding,
  head: Revision,
  base: Revision,
) {
  const input = {
    candidateId: "m35-candidate",
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
      repository: {
        revisionId: SHA,
        files: new Map(Object.entries(head.files)),
      },
      comparison: {
        revisionId: BASE_SHA,
        files: new Map(Object.entries(base.files)),
      },
    }),
  );
}

// ---------------------------------------------------------------------------

describe("witness A — a boundary-only edit", () => {
  const SOURCE = {
    "src/index.ts": "export const version = 1;",
    "src/codec.ts": DECODE,
  };
  const BASE: Revision = {
    files: {
      ...SOURCE,
      "package.json": manifest({
        ".": "./src/index.ts",
        "./codec": "./src/codec.ts",
      }),
    },
  };
  const HEAD: Revision = {
    files: { ...SOURCE, "package.json": manifest({ ".": "./src/index.ts" }) },
  };

  it("establishes that NO source file differs between the revisions", () => {
    // The premise that makes this witness non-vacuous. A module export-set
    // delta is empty here by construction, so the predecessor could not have
    // recovered this case by any route.
    for (const path of Object.keys(SOURCE)) {
      expect(HEAD.files[path]).toBe(BASE.files[path]);
    }
    expect(HEAD.files["package.json"]).not.toBe(BASE.files["package.json"]);
  });

  it("proposes the loss anyway, because the boundary changed", async () => {
    const outcome = await review(BASE, HEAD, ["package.json"]);
    const candidates = mine(outcome.report.findings);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.claim).toContain("`decode`");
    expect(candidates[0]?.claim).toContain("`pkg/codec`");
    // Anchored on the side the name was reachable from.
    expect(candidates[0]?.location.side).toBe("base");
  });

  it("names the boundary, not the declaring module, in its identity", async () => {
    const outcome = await review(BASE, HEAD, ["package.json"]);

    expect(mine(outcome.report.findings)[0]?.identityHint).toBe(
      "pkg/codec:decode:value:boundary-reachability-loss",
    );
  });

  it("is INCONCLUSIVE, because this verifier cannot probe a withdrawn boundary", async () => {
    // The honest outcome, and the boundary of this checkpoint. The proposal is
    // correct — M.3.4 could not make it at all — but the existing verifier
    // probes through a relative file specifier, so package-exports resolution
    // plays no part in it. `src/codec.ts` is byte-identical at head and still
    // exports `decode`, so the probe compiles.
    //
    // A `rejected` here would be a false refutation teaching the funnel that
    // boundary withdrawals are safe. Proving one needs consumer-style
    // resolution, which is separate work with its own contract, and widening
    // verification to make this witness green is exactly what the M.3.5
    // contract forbids.
    const outcome = await review(BASE, HEAD, ["package.json"]);
    const candidate = mine(outcome.report.findings)[0];
    if (candidate === undefined) throw new Error("no M.3.5 candidate");

    const attempt = adjudicate(candidate, HEAD, BASE);
    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    expect(attempt.decision).toBe("inconclusive");
  });
});

describe("witness B — competing observations of one loss", () => {
  const BASE: Revision = {
    files: {
      "package.json": manifest({ ".": "./src/index.ts" }),
      "src/index.ts": 'export { decode } from "./codec.js";',
      "src/codec.ts": DECODE,
    },
  };
  const HEAD: Revision = {
    files: {
      "package.json": manifest({ ".": "./src/index.ts" }),
      "src/index.ts": "export const version = 1;",
      "src/codec.ts":
        "function decode(raw: string): string {\n  return raw;\n}",
    },
  };

  it("produces ONE candidate though several files witness the loss", async () => {
    // The entry stopped re-exporting it and the declaring module stopped
    // exporting it. Two observations, one consumer-visible break.
    const outcome = await review(BASE, HEAD, ["src/index.ts", "src/codec.ts"]);

    expect(mine(outcome.report.findings)).toHaveLength(1);
  });

  it("identifies it by the boundary, not by whichever file was seen first", async () => {
    const outcome = await review(BASE, HEAD, ["src/index.ts", "src/codec.ts"]);

    expect(mine(outcome.report.findings)[0]?.identityHint).toBe(
      "pkg:decode:value:boundary-reachability-loss",
    );
  });

  it("produces the identical finding when the files are seen in reverse", async () => {
    // Not merely the same count. Discovery order must not change identity,
    // claim, evidence, or anchor — this project has been bitten twice by
    // order-dependent selection.
    const forward = await review(BASE, HEAD, ["src/index.ts", "src/codec.ts"]);
    const reversed = await review(BASE, HEAD, ["src/codec.ts", "src/index.ts"]);

    const canonical = (findings: readonly CandidateFinding[]) =>
      mine(findings).map((finding) => ({
        identityHint: finding.identityHint,
        claim: finding.claim,
        location: finding.location,
        steps: finding.causal.steps,
        evidence: finding.evidence.map((entry) => entry.observation),
      }));

    expect(canonical(reversed.report.findings)).toEqual(
      canonical(forward.report.findings),
    );
  });
});

describe("a surface that could not be read licenses nothing", () => {
  it("records a degradation instead of reporting every name as lost", async () => {
    // The head entry re-exports wholesale from a module that is not in the
    // revision. Every name looks missing, and none of them has been shown to
    // be missing.
    const BASE: Revision = {
      files: {
        "package.json": manifest({ ".": "./src/index.ts" }),
        "src/index.ts": DECODE,
      },
    };
    const HEAD: Revision = {
      files: {
        "package.json": manifest({ ".": "./src/index.ts" }),
        "src/index.ts": 'export * from "./missing.js";',
      },
    };

    const outcome = await review(BASE, HEAD, ["src/index.ts"]);

    expect(mine(outcome.report.findings)).toEqual([]);
    expect(
      outcome.report.degradations.some(
        (entry) =>
          entry.reason === "analyzer_abstained" &&
          entry.detail.includes("partial"),
      ),
    ).toBe(true);
  });
});
