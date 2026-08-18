import { VERIFIER_CHALLENGES, evaluateChallenges } from "../src/eval/index.js";

const report = evaluateChallenges(VERIFIER_CHALLENGES);

console.log("\nP1-J.2 verifier capability — INJECTED challenges only");
console.log("  never averaged with the analyzer corpus: these measure a");
console.log("  capability, not the product.\n");

const head = ["verified", "rejected", "inconclusive", "unavailable"];
console.log(
  `  ${"gold \\ actual".padEnd(16)}${head.map((h) => h.padStart(14)).join("")}`,
);
for (const gold of [
  "should_verify",
  "should_reject",
  "should_abstain",
] as const) {
  const row = head.map((actual) =>
    String(report.matrix[gold][actual as never]).padStart(14),
  );
  console.log(`  ${gold.padEnd(16)}${row.join("")}`);
}

console.log();
const line = (label: string, value: unknown) =>
  console.log(`  ${label.padEnd(34)} ${String(value)}`);
line("CATASTROPHIC (defect refuted)", report.catastrophic);
line("false confirmations", report.falseConfirmations);
line("recall loss (abstained on defect)", report.recallLoss);
line("missed filtering", report.missedFiltering);
line("overclaims on undecidable", report.overclaims);
line(
  "pairs discriminated",
  `${String(report.pairsDiscriminated)} / ${String(report.pairsTotal)}`,
);

console.log("\n  per challenge");
for (const outcome of report.outcomes) {
  console.log(
    `    ${outcome.id.padEnd(34)} ${outcome.gold.padEnd(15)} → ${outcome.actual.padEnd(13)} ${outcome.correct ? "✓" : "✗"}`,
  );
}
