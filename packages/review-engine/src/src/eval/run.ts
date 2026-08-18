/**
 * The full pipeline, run over the corpus.
 *
 * Deliberately end-to-end from the planner rather than handing analyzers
 * pre-built context: the seam between planning and analysis is where the most
 * expensive mistakes live, and a harness that skips it measures a system that
 * does not ship.
 */

import { extractFile, planContext } from "@acalys/code-intelligence";

import { allocateBudget } from "../budget.js";
import { buildClusters } from "../cluster.js";
import { runAnalysis, type AnalysisCache } from "../execution.js";
import type { AnalysisResult, CorrectnessFamily } from "../finding.js";
import { analyzeAsyncCompletion } from "../correctness/async-completion.js";
import { analyzeSignatureCompatibility } from "../correctness/signature-compatibility.js";
import { analyzeSwallowedErrors } from "../correctness/swallowed-error.js";
import type { AnalyzerCase } from "./corpus.js";
import {
  summarizeCases,
  type AnalyzerReport,
  type CaseOutcome,
} from "./metrics.js";

/** Every analyzer, run over every cluster. */
export const ALL_ANALYZERS = [
  analyzeAsyncCompletion,
  analyzeSwallowedErrors,
  analyzeSignatureCompatibility,
] as const;

export const EVAL_BUDGET_TOKENS = 60_000;

export async function runCase(
  testCase: AnalyzerCase,
  cache?: AnalysisCache,
): Promise<CaseOutcome> {
  const context = planContext(
    {
      changed: testCase.changed.map((entry) => ({
        path: entry.path,
        content: testCase.files[entry.path] ?? "",
        changedLines: entry.changedLines,
      })),
      repository: Object.entries(testCase.files).map(([path, source]) =>
        extractFile(path, source),
      ),
      sources: new Map(Object.entries(testCase.files)),
    },
    EVAL_BUDGET_TOKENS,
  );

  const clusters = buildClusters([...testCase.changed], context.items);
  const allocations = clusters.map((cluster) => allocateBudget(cluster));

  const report = await runAnalysis(clusters, allocations, {
    ...(cache === undefined ? {} : { cache }),
    analyzer: ({ cluster }) => {
      const subject = cluster.subject.map((entry) => ({
        path: entry.path,
        changedLines: entry.changedLines,
      }));
      const input = {
        context: { ...context, items: cluster.context },
        subject,
        clusterId: cluster.id,
      };

      // Every analyzer sees the same cluster. Composition happens here rather
      // than inside an analyzer, so adding one cannot change another's input.
      const results: AnalysisResult[] = ALL_ANALYZERS.map((analyze) =>
        analyze(input),
      );
      return {
        findings: results.flatMap((result) => result.findings),
        suppressions: results.flatMap((result) => result.suppressions),
        degradations: [],
      };
    },
  });

  const actual = [...new Set(report.findings.map((finding) => finding.family))];
  const missed = testCase.expect.filter((family) => !actual.includes(family));

  return {
    id: testCase.id,
    bucket: testCase.bucket,
    expected: testCase.expect,
    actual,
    missed,
    spurious: report.findings.filter(
      (finding) => !testCase.expect.includes(finding.family),
    ).length,
    findings: report.findings,
    suppressions: report.suppressions,
    contextTokens: context.budget.consumed,
    because: testCase.because,
  };
}

export async function evaluateCorpus(
  cases: readonly AnalyzerCase[],
): Promise<AnalyzerReport> {
  const outcomes: CaseOutcome[] = [];
  for (const testCase of cases) {
    outcomes.push(await runCase(testCase));
  }
  return summarizeCases(outcomes);
}

export type { CorrectnessFamily };
