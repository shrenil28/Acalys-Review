/**
 * Supplying a comparison revision must not be a treatment.
 *
 * The evaluation harness now hands every case its base revision, so the M.3
 * capabilities are eligible on all of them. That is a change to the harness,
 * and a change to the harness is exactly the thing that quietly invalidates a
 * comparison: if merely *having* a base altered what the older analyzers
 * produced, every number measured before and after would describe different
 * reviewers, and the frozen baselines would stop meaning what they said.
 *
 * This is the same hazard L.5 exists to prevent, one layer down. The defence
 * is mechanical rather than argued: run the real production entry twice over
 * the same case, once with the base and once without, and require that
 * everything not belonging to a comparison capability is byte-identical.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import { M1_DEVELOPMENT_CASES } from "../src/eval/m1-corpus.js";
import { M1_TRACKED_CAPABILITIES } from "../src/eval/m2-evaluate.js";

const REPO = "0192f8a1-0000-7000-8000-0000000000f0";
const SHA = "7".repeat(40);
const BASE_SHA = "6".repeat(40);

type Case = (typeof M1_DEVELOPMENT_CASES)[number];

function sourceFor(entry: Case, withBase: boolean): AnalysisSource {
  return {
    read: () =>
      Promise.resolve({
        changed: entry.changed.map((change) => {
          const content = entry.baseFiles[change.path];
          return {
            path: change.path,
            content: entry.headFiles[change.path] ?? "",
            changedLines: change.changedLines,
            ...(withBase
              ? {
                  base:
                    content === undefined
                      ? ({ kind: "absent" } as const)
                      : ({ kind: "present", content } as const),
                }
              : {}),
          };
        }),
        repository: new Map(Object.entries(entry.headFiles)),
        ...(withBase ? { baseSha: BASE_SHA } : {}),
      }),
  };
}

const analyse = (entry: Case, withBase: boolean) =>
  runRealAnalysis({
    repositoryId: REPO,
    headSha: SHA,
    tenantId: "m1-eval",
    source: sourceFor(entry, withBase),
  });

/** Findings that do not belong to a comparison capability, canonically. */
const others = (
  findings: readonly { ruleId: string; claim: string; location: unknown }[],
) =>
  findings
    .filter((finding) => M1_TRACKED_CAPABILITIES[finding.ruleId] === undefined)
    .map(
      (finding) =>
        `${finding.ruleId}|${JSON.stringify(finding.location)}|${finding.claim}`,
    )
    .sort();

describe("supplying a comparison revision changes nothing else", () => {
  it.each(M1_DEVELOPMENT_CASES.map((entry) => [entry.id, entry] as const))(
    "%s produces identical non-comparison findings either way",
    async (_id, entry) => {
      const [withBase, withoutBase] = await Promise.all([
        analyse(entry, true),
        analyse(entry, false),
      ]);

      expect(others(withBase.report.findings)).toEqual(
        others(withoutBase.report.findings),
      );
    },
  );

  it("changes the cache key, because the input genuinely differs", async () => {
    // The converse, and it is not in tension with the assertion above. The
    // analyzers see the same thing; the review does not have the same inputs.
    // A key that ignored the difference would serve one review's findings for
    // the other, which is invariant 13.
    const entry = M1_DEVELOPMENT_CASES[0];
    if (entry === undefined) throw new Error("no development cases");

    const [withBase, withoutBase] = await Promise.all([
      analyse(entry, true),
      analyse(entry, false),
    ]);

    expect(withBase.cacheKey).not.toBe(withoutBase.cacheKey);
  });
});
