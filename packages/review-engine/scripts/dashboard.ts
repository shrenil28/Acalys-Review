/**
 * Prints the P1-G dashboard.
 *
 *     npm run eval:dashboard -w @acalys/review-engine
 *
 * A script rather than only a test, because these numbers are for reading and
 * arguing with. A metric that can only be seen by making a test fail is a
 * metric nobody looks at until something is already wrong.
 */

import { ANALYZER_CORPUS, evaluateCorpus } from "../src/eval/index.js";

async function main(): Promise<void> {
  const report = await evaluateCorpus(ANALYZER_CORPUS);
  const line = (label: string, value: string | number): void => {
    process.stdout.write(`  ${label.padEnd(32)} ${String(value)}\n`);
  };

  process.stdout.write("\nP1-G analyzer dashboard\n");
  // The honest label. With a corpus this small, a perfect score is evidence
  // that the harness works — not evidence that the reviewer is good. Reporting
  // it as the latter would be misleading the moment the corpus grows, and the
  // person most likely to be misled is whoever reads this next.
  process.stdout.write(
    `  status: eval framework green / baseline corpus green (${String(report.cases.length)} cases)\n` +
      "  NOT a claim about reviewer precision or recall in the wild\n\n",
  );
  line("cases", report.cases.length);
  line("recall", report.recall);
  line("precision", report.precision);
  line("false positives on clean cases", report.falsePositivesOnCleanCases);
  line("findings per case", report.findingsPerCase);
  line("suppression rate", report.suppressionRate);
  line("tokens per case", report.tokensPerCase);
  line("tokens per finding", report.tokensPerFinding);

  process.stdout.write("\n  recall by family\n");
  for (const [family, recall] of Object.entries(report.recallByFamily)) {
    line(`    ${family}`, String(recall));
  }
  process.stdout.write("\n");
}

await main();
