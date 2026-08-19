/**
 * Aggregating measurements into an execution report.
 *
 * Names are chosen so that the arrival of model inference **adds** rows rather
 * than redefining existing ones. `contextTokenEstimate` will still mean what it
 * means today when `providerInputTokens` finally has a value.
 */

import {
  measured,
  notApplicable,
  ratio,
  unmeasured,
  type InvocationMeasurement,
  type MeasuredStage,
  type Quantity,
} from "./measurement.js";

/** How much semantic work the router decided was necessary. */
export interface WorkProfile {
  readonly candidatesTotal: number;
  readonly competenceSupported: number;
  readonly competenceUnsupported: number;
  /** Settled without any model call. Today: all of them. */
  readonly deterministicallySettled: number;
  /**
   * Left for an expensive verifier that does not exist yet.
   *
   * The number that will say whether the deterministic layer is earning its
   * place once there is something costly to avoid — the difference between
   * "every candidate goes to a model" and "only the ones nothing cheaper could
   * settle".
   */
  readonly deepVerificationRequired: number;
}

export interface LatencyProfile {
  /** Sample count, reported beside the percentiles it qualifies. */
  readonly n: number;
  readonly p50: Quantity;
  readonly p95: Quantity;
  readonly max: Quantity;
  /**
   * Added durations of every invocation.
   *
   * Not latency. Four 100ms calls running concurrently take ~110ms of wall
   * time and 400ms of execution; reporting the second as latency would make
   * parallelism look like a regression.
   */
  readonly sumExecutionMs: number;
}

export interface ExecutionReport {
  readonly runId: string;

  readonly logicalInvocations: number;
  readonly physicalAttempts: number;
  /** Physical ÷ logical. A reliability regression must show up here. */
  readonly retryAmplification: Quantity;

  readonly contextTokenEstimate: number;
  readonly contextItems: number;
  readonly contextOmittedItems: number;

  readonly modelCalls: number;
  readonly providerInputTokens: Quantity;
  readonly providerOutputTokens: Quantity;

  /** Genuinely zero: there are no model calls to bill. */
  readonly modelInferenceCostUsd: Quantity;
  /** CPU, Docker, Postgres, storage. Real, and not accounted for. */
  readonly infrastructureCostUsd: Quantity;
  /** Unrenderable while a component of it is unmeasured. */
  readonly totalCostUsd: Quantity;

  readonly latencyByStage: Readonly<
    Partial<Record<MeasuredStage, LatencyProfile>>
  >;
  readonly work: WorkProfile;
}

function percentile(sorted: readonly number[], fraction: number): Quantity {
  if (sorted.length === 0) {
    return { kind: "undefinedRatio", because: "no samples" };
  }
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );
  return measured(sorted[Math.max(0, index)] ?? 0);
}

function latencyOf(durations: readonly number[]): LatencyProfile {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max:
      sorted.length === 0
        ? { kind: "undefinedRatio", because: "no samples" }
        : measured(sorted[sorted.length - 1] ?? 0),
    sumExecutionMs: sorted.reduce((total, value) => total + value, 0),
  };
}

export function summarize(
  runId: string,
  measurements: readonly InvocationMeasurement[],
  work: WorkProfile,
): ExecutionReport {
  // Logical work is distinct invocation ids; physical work is executions of
  // them. They match today because nothing retries, and that equality is worth
  // stating rather than assuming — it is the baseline a future retry storm
  // will be compared against.
  const logicalInvocations = new Set(
    measurements.map((entry) => entry.invocationId),
  ).size;
  const physicalAttempts = measurements.length;

  const contextTokenEstimate = measurements.reduce(
    (total, entry) => total + (entry.context?.tokenEstimate ?? 0),
    0,
  );

  const modelCalls = measurements.filter(
    (entry) => entry.implementationKind === "model",
  ).length;

  const byStage: Partial<Record<MeasuredStage, LatencyProfile>> = {};
  for (const stage of new Set(measurements.map((entry) => entry.stage))) {
    byStage[stage] = latencyOf(
      measurements
        .filter((entry) => entry.stage === stage)
        .map((entry) => entry.wallMs),
    );
  }

  const noModels =
    "no model-backed procedure ran; the pipeline is entirely deterministic";

  return {
    runId,
    logicalInvocations,
    physicalAttempts,
    retryAmplification: ratio(
      physicalAttempts,
      logicalInvocations,
      "no invocations were measured",
    ),
    contextTokenEstimate,
    contextItems: measurements.reduce(
      (total, entry) => total + (entry.context?.items ?? 0),
      0,
    ),
    contextOmittedItems: measurements.reduce(
      (total, entry) => total + (entry.context?.omittedItems ?? 0),
      0,
    ),
    modelCalls,
    // `notApplicable`, not zero. No provider reported anything, because no
    // provider was asked.
    providerInputTokens:
      modelCalls === 0
        ? notApplicable(noModels)
        : measured(
            measurements.reduce(
              (total, entry) => total + (entry.inference?.inputTokens ?? 0),
              0,
            ),
          ),
    providerOutputTokens:
      modelCalls === 0
        ? notApplicable(noModels)
        : measured(
            measurements.reduce(
              (total, entry) => total + (entry.inference?.outputTokens ?? 0),
              0,
            ),
          ),
    // A real zero: there is nothing to bill, and that is a fact rather than a
    // gap.
    modelInferenceCostUsd: measured(0),
    infrastructureCostUsd: unmeasured(
      "CPU, container, database and storage cost are not accounted for",
    ),
    // Unrenderable while a component is unmeasured. Rendering it as $0 is how
    // a future model-backed checkpoint gets compared against a number nobody
    // ever measured.
    totalCostUsd: unmeasured(
      "infrastructure cost is unmeasured, so no total exists",
    ),
    latencyByStage: byStage,
    work,
  };
}
