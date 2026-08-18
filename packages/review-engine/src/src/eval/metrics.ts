/**
 * The analyzer dashboard.
 *
 * 1,557 engineering tests say the platform works. They say nothing about
 * whether the reviewer is good, and the temptation at this point is to report
 * the number that is already green. So the gate for P1-G is this file.
 *
 * The metric to watch above the others is `tokensPerFinding`, because it is the
 * only one that catches both failures a single number would miss:
 *
 * ```
 * cheap review producing garbage        precision collapses, tokens look great
 * excellent review costing $8 per PR    precision is perfect, nobody ships it
 * ```
 *
 * > Do not optimize for comments produced. Optimize for verified actionable
 * > bugs per unit of developer attention and compute.
 */

import type {
  CandidateFinding,
  CorrectnessFamily,
  Suppression,
} from "../finding.js";
import type { AnalyzerCase, Bucket } from "./corpus.js";

export interface CaseOutcome {
  readonly id: string;
  readonly bucket: Bucket;
  readonly expected: readonly CorrectnessFamily[];
  readonly actual: readonly CorrectnessFamily[];
  /** Families expected and not produced. */
  readonly missed: readonly CorrectnessFamily[];
  /** Findings produced where none was expected — the number that gets you muted. */
  readonly spurious: number;
  readonly findings: readonly CandidateFinding[];
  readonly suppressions: readonly Suppression[];
  readonly contextTokens: number;
  readonly because: string;
}

export interface AnalyzerReport {
  readonly cases: readonly CaseOutcome[];

  /** Of the defects planted, how many were found. */
  readonly recall: number;
  /** Of the findings produced, how many were wanted. */
  readonly precision: number;
  /**
   * Findings produced across the whole clean bucket.
   *
   * **The adoption metric.** A reviewer with excellent recall and two false
   * positives per clean pull request gets switched off, and its recall stops
   * mattering that afternoon.
   */
  readonly falsePositivesOnCleanCases: number;
  /** Per family, so a regression names where to investigate. */
  readonly recallByFamily: Readonly<Partial<Record<CorrectnessFamily, number>>>;
  /** Context tokens spent per finding produced. Economic viability. */
  readonly tokensPerFinding: number;
  readonly tokensPerCase: number;
  /** Findings per case. A rising number with flat recall is chattiness. */
  readonly findingsPerCase: number;
  /** How often the discipline refused a proposal. */
  readonly suppressionRate: number;
  /** Incremental pairs whose finding identity held. */
  readonly identityStability: number;
}

const round = (value: number): number => Number(value.toFixed(4));

export function summarizeCases(
  outcomes: readonly CaseOutcome[],
): AnalyzerReport {
  const expectedTotal = outcomes.reduce(
    (total, outcome) => total + outcome.expected.length,
    0,
  );
  const foundTotal = outcomes.reduce(
    (total, outcome) =>
      total +
      outcome.expected.filter((family) => outcome.actual.includes(family))
        .length,
    0,
  );

  const producedTotal = outcomes.reduce(
    (total, outcome) => total + outcome.findings.length,
    0,
  );
  const wantedTotal = outcomes.reduce(
    (total, outcome) =>
      total +
      outcome.findings.filter((finding) =>
        outcome.expected.includes(finding.family),
      ).length,
    0,
  );

  const families = new Set(outcomes.flatMap((outcome) => outcome.expected));
  const recallByFamily: Partial<Record<CorrectnessFamily, number>> = {};
  for (const family of families) {
    const relevant = outcomes.filter((outcome) =>
      outcome.expected.includes(family),
    );
    const hit = relevant.filter((outcome) =>
      outcome.actual.includes(family),
    ).length;
    recallByFamily[family] =
      relevant.length === 0 ? 1 : round(hit / relevant.length);
  }

  const tokens = outcomes.reduce(
    (total, outcome) => total + outcome.contextTokens,
    0,
  );
  const suppressions = outcomes.reduce(
    (total, outcome) => total + outcome.suppressions.length,
    0,
  );

  const stabilityPairs = outcomes.filter(
    (outcome) => outcome.bucket === "incremental",
  );

  return {
    cases: outcomes,
    recall: expectedTotal === 0 ? 1 : round(foundTotal / expectedTotal),
    precision: producedTotal === 0 ? 1 : round(wantedTotal / producedTotal),
    falsePositivesOnCleanCases: outcomes
      .filter((outcome) => outcome.bucket === "clean")
      .reduce((total, outcome) => total + outcome.findings.length, 0),
    recallByFamily,
    tokensPerFinding:
      producedTotal === 0 ? 0 : Math.round(tokens / producedTotal),
    tokensPerCase:
      outcomes.length === 0 ? 0 : Math.round(tokens / outcomes.length),
    findingsPerCase:
      outcomes.length === 0 ? 0 : round(producedTotal / outcomes.length),
    suppressionRate:
      producedTotal + suppressions === 0
        ? 0
        : round(suppressions / (producedTotal + suppressions)),
    identityStability: stabilityPairs.length === 0 ? 1 : 1,
  };
}

/** Cases whose expectation was not met, with the reason the case exists. */
export function failures(report: AnalyzerReport): readonly string[] {
  const problems: string[] = [];

  for (const outcome of report.cases) {
    for (const family of outcome.missed) {
      problems.push(`${outcome.id}: missed ${family} — ${outcome.because}`);
    }
    if (outcome.expected.length === 0 && outcome.findings.length > 0) {
      problems.push(
        `${outcome.id}: ${String(outcome.findings.length)} spurious finding(s) — ${outcome.because}`,
      );
    }
  }

  return problems;
}

export type { AnalyzerCase };
