import { ANALYZER_CORPUS, evaluateFunnel } from "../src/eval/index.js";

const report = await evaluateFunnel(ANALYZER_CORPUS);
const line = (label: string, value: unknown) =>
  console.log(`  ${label.padEnd(34)} ${String(value)}`);

console.log("\nP1-J end-to-end funnel baseline\n");
line("cases", report.cases);
line("candidates", report.candidates);
console.log();
line("verified", report.verified);
line("rejected", report.rejected);
line("inconclusive", report.inconclusive);
line("unavailable", report.unavailable);
console.log();
line("promoted", report.promoted);
line("published", report.published);
line("withheld by policy", report.withheld);
console.log();
line("FP refuted by verifier", report.falsePositivesRefuted);
line("FP abstained by verifier", report.falsePositivesAbstained);
line("FP filtered (refuted+abstained)", report.falsePositivesFiltered);
line("true positives LOST to verifier", report.truePositivesLost);
line("false positives published", report.falsePositivesPublished);
line("true positives published", report.truePositivesPublished);
console.log();
line("candidate precision", report.candidatePrecision);
line("published precision", report.publishedPrecision);
line("published recall", report.publishedRecall);
console.log();
line("analysis tokens", report.analysisTokens);
line("verification tokens", report.verificationTokens);
line("tokens per published finding", report.tokensPerPublishedFinding);

console.log("\n  per-candidate journeys");
for (const j of report.journeys) {
  const decision =
    j.attempt.status === "completed" ? j.attempt.decision : "UNAVAILABLE";
  console.log(
    `    ${j.caseId.padEnd(34)} ${j.bucket.padEnd(12)} ${j.family.padEnd(16)} ` +
      `${j.wanted ? "wanted " : "SPURIOUS"} ${decision.padEnd(13)} ${j.published ? "published" : "-"}`,
  );
}
