/**
 * P1-J.5 — Deterministic Quality & Execution Baseline.
 *
 * Three baselines, kept structurally apart because they are answers to
 * different questions and mixing them is how a report starts lying:
 *
 *   A  quality      one canonical corpus evaluation
 *   B  execution    repeated frozen inputs, for timing only
 *   C  inference    what a pre-inference system can honestly say about cost
 *
 * Repeated performance samples never enter a quality denominator. Running the
 * corpus fifty times does not give fifty times the evidence about precision.
 */
import {
  ANALYZER_CORPUS,
  createRecorder,
  evaluateFunnel,
  render,
  summarize,
  type MeasuredStage,
} from "../src/eval/index.js";

const PERFORMANCE_SAMPLES = 20;

const line = (label: string, value: unknown) =>
  console.log(`  ${label.padEnd(38)} ${String(value)}`);

// ── A. Quality ────────────────────────────────────────────────────────────
const recorder = createRecorder();
const quality = await evaluateFunnel(ANALYZER_CORPUS, recorder);

console.log("\nP1-J.5 — Deterministic Quality & Execution Baseline");
console.log("  pre-inference: no model call exists in this pipeline\n");

console.log("A. QUALITY  (one canonical evaluation)");
line("analyzer precision", quality.candidatePrecision);
line("published precision", quality.publishedPrecision);
line("published recall", quality.publishedRecall);
line("false positives published", quality.falsePositivesPublished);
line("verifier incorrect rejections", quality.losses.verifier_refuted);
line("true positives abstained", quality.losses.verifier_abstained);
line("correlated derivations", quality.correlatedDerivations);

// ── B. Execution ──────────────────────────────────────────────────────────
console.log("\nB. EXECUTION  (repeated frozen inputs)");
const perSample = [];
for (let sample = 0; sample < PERFORMANCE_SAMPLES; sample += 1) {
  const sampleRecorder = createRecorder();
  await evaluateFunnel(ANALYZER_CORPUS, sampleRecorder);
  perSample.push(
    summarize(
      `sample-${String(sample)}`,
      sampleRecorder.measurements,
      quality.work,
    ),
  );
}

const stages: MeasuredStage[] = [
  "analysis",
  "verification",
  "reconciliation",
  "policy",
];

console.log(
  `\n  ${"stage".padEnd(16)}${"logical".padStart(9)}${"physical".padStart(10)}` +
    `${"ctx tok est".padStart(13)}${"n".padStart(6)}${"p50 ms".padStart(9)}` +
    `${"p95 ms".padStart(9)}${"max ms".padStart(9)}${"losses".padStart(9)}`,
);

const losses: Partial<Record<MeasuredStage, number>> = {
  analysis: quality.losses.not_proposed,
  verification:
    quality.losses.verifier_abstained + quality.losses.verifier_refuted,
  reconciliation: 0,
  policy: quality.losses.policy_withheld,
};

for (const stage of stages) {
  const durations = perSample.flatMap((report) => {
    const profile = report.latencyByStage[stage];
    return profile === undefined ? [] : [profile];
  });
  const first = summarize("agg", recorder.measurements, quality.work)
    .latencyByStage[stage];
  const n = durations.reduce((total, profile) => total + profile.n, 0);
  const p50s = durations.map((profile) =>
    profile.p50.kind === "measured" ? profile.p50.value : 0,
  );
  const p95s = durations.map((profile) =>
    profile.p95.kind === "measured" ? profile.p95.value : 0,
  );
  const maxes = durations.map((profile) =>
    profile.max.kind === "measured" ? profile.max.value : 0,
  );
  const median = (values: number[]): string => {
    if (values.length === 0) return "—";
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[Math.floor(values.length / 2)] ?? 0).toFixed(2);
  };

  console.log(
    `  ${stage.padEnd(16)}` +
      `${String(first?.n ?? 0).padStart(9)}` +
      `${String(first?.n ?? 0).padStart(10)}` +
      `${(stage === "analysis" ? quality.analysisTokens : stage === "verification" ? quality.verificationTokens : 0).toString().padStart(13)}` +
      `${String(n).padStart(6)}` +
      `${median(p50s).padStart(9)}` +
      `${median(p95s).padStart(9)}` +
      `${(maxes.length === 0 ? "—" : Math.max(...maxes).toFixed(2)).padStart(9)}` +
      `${String(losses[stage] ?? 0).padStart(9)}`,
  );
}

const aggregate = summarize("baseline", recorder.measurements, quality.work);

console.log();
line("logical invocations / review", aggregate.logicalInvocations);
line("physical attempts / review", aggregate.physicalAttempts);
line("retry amplification", render(aggregate.retryAmplification));
line(
  "context token estimate / review",
  quality.analysisTokens + quality.verificationTokens,
);
line(
  "  … per published finding",
  quality.tokensPerPublishedFinding ?? "undefined",
);
line("  … per clean case", quality.tokensPerCleanCase ?? "undefined");
line("deterministically settled", aggregate.work.deterministicallySettled);
line("deep verification required", aggregate.work.deepVerificationRequired);

console.log(
  "\n  Timings are a local deterministic floor measured with a monotonic clock,",
);
console.log(
  "  not a production prediction: no network or model latency is present.",
);

// ── C. Inference economics ────────────────────────────────────────────────
console.log("\nC. INFERENCE ECONOMICS  (pre-inference baseline)");
line("model calls", aggregate.modelCalls);
line("provider input tokens", render(aggregate.providerInputTokens));
line("provider output tokens", render(aggregate.providerOutputTokens));
line("model inference cost", `$${render(aggregate.modelInferenceCostUsd)}`);
line("infrastructure cost", render(aggregate.infrastructureCostUsd));
line("TOTAL cost / review", render(aggregate.totalCostUsd));
