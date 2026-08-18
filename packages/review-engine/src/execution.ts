/**
 * Running the analysis: bounded, capped, resumable, and honest when it stops.
 *
 * Three failure modes this file exists to prevent, all of which look fine in a
 * demo and none of which survive a real repository.
 *
 * **Fan-out.** `12 changed symbols × 8 dependencies × 4 hypotheses × a deep
 * pass` is how a repository-aware reviewer accidentally issues hundreds of
 * calls. Every dimension here is capped, and the caps are inputs rather than
 * constants so an operator can lower them without a deploy.
 *
 * **Unbounded parallelism.** `Promise.all(87)` turns a large pull request into
 * a rate-limit storm, which manifests as a slow review rather than an obvious
 * error. Clusters run through a fixed number of workers instead.
 *
 * **Silent truncation.** A review that analyzed half a pull request and
 * presented the result as complete makes every metric computed from it wrong in
 * an unknown direction — and the reader has no way to know. Reaching a cap
 * records a {@link Degradation} and the result says so.
 *
 * # Incremental is a property of the identity, not a later optimization
 *
 * Each cluster carries a fingerprint over the material that could change its
 * findings. A second revision that touches one cluster invalidates that cluster
 * and anything whose supplied context contains it — not everything, and not
 * "everything, because the head SHA moved".
 *
 * The fingerprint deliberately excludes the run, the revision and the delivery:
 * those change on every push and would make every cluster look new, which is
 * the behaviour being avoided.
 */

import { createHash } from "node:crypto";

import type { RiskCluster } from "./cluster.js";
import type { BudgetAllocation } from "./budget.js";
import type {
  AnalysisResult,
  CandidateFinding,
  Suppression,
} from "./finding.js";

/** Everything an analyzer may be given for one cluster. */
export interface ClusterAnalysisInput {
  readonly cluster: RiskCluster;
  readonly allocation: BudgetAllocation;
}

export type ClusterAnalyzer = (
  input: ClusterAnalysisInput,
) => Promise<AnalysisResult> | AnalysisResult;

export interface ExecutionLimits {
  /** Clusters analyzed at all. Beyond this, the rest are recorded and skipped. */
  readonly maxClusters: number;
  /** Concurrent analyses. Sized to provider limits, never to cluster count. */
  readonly concurrency: number;
  /** Ceiling across the whole review, not per cluster. */
  readonly maxContextTokens: number;
  /** Reasoning invocations across the whole review. */
  readonly maxReasoningCalls: number;
  /** Wall-clock ceiling. A review nobody waits for is a review nobody reads. */
  readonly deadlineMs: number;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  maxClusters: 40,
  concurrency: 4,
  maxContextTokens: 400_000,
  maxReasoningCalls: 60,
  deadlineMs: 240_000,
};

export const DEGRADATION_REASONS = [
  "cluster_cap_reached",
  "context_budget_exhausted",
  "reasoning_call_cap_reached",
  "deadline_exceeded",
  "analyzer_failed",
] as const;

export type DegradationReason = (typeof DEGRADATION_REASONS)[number];

export interface Degradation {
  readonly clusterId: string;
  readonly reason: DegradationReason;
  readonly detail: string;
}

export interface ExecutionReport {
  readonly findings: readonly CandidateFinding[];
  readonly suppressions: readonly Suppression[];
  readonly degradations: readonly Degradation[];
  /** Clusters whose prior results were reused rather than recomputed. */
  readonly reused: readonly string[];
  readonly analyzed: number;
  readonly skipped: number;
  readonly contextTokensSpent: number;
  readonly reasoningCallsSpent: number;
  readonly durationMs: number;
  /**
   * Whether this was a complete review.
   *
   * Callers must be able to ask. A quality number computed from a
   * budget-constrained review is not comparable with one that was not.
   */
  readonly complete: boolean;
}

/**
 * What a cluster's findings depend on.
 *
 * Over the supplied content, its paths and reasons — the things that, if
 * unchanged, mean the analysis would reach the same conclusion. Not the run id,
 * not the revision, not the head SHA: those move on every push and would make
 * every cluster look new, which is exactly the "incremental review that reruns
 * everything" being avoided.
 *
 * Content, not just paths, because a caller whose body changed can turn a
 * correct call into a defect without any file being added or removed.
 */
export function fingerprintCluster(cluster: RiskCluster): string {
  const material = [
    ...cluster.subject
      .map(
        (entry) =>
          `subject:${entry.path}:${[...entry.changedLines].sort((a, b) => a - b).join(",")}`,
      )
      .sort(),
    ...cluster.context
      .map(
        (item) =>
          `ctx:${item.path}:${item.reason}:${item.representation}:${createHash(
            "sha256",
          )
            .update(item.suppliedContent, "utf8")
            .digest("hex")}`,
      )
      .sort(),
  ].join("\n");

  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Prior results, keyed by cluster fingerprint.
 *
 * Deliberately not keyed by cluster id: an id survives a change to the code,
 * and reusing findings across a real edit is worse than not reusing at all.
 */
export interface AnalysisCache {
  get(fingerprint: string): AnalysisResult | undefined;
  set(fingerprint: string, result: AnalysisResult): void;
}

export function createMemoryCache(): AnalysisCache {
  const entries = new Map<string, AnalysisResult>();
  return {
    get: (fingerprint) => entries.get(fingerprint),
    set: (fingerprint, result) => {
      entries.set(fingerprint, result);
    },
  };
}

export interface ExecutionOptions {
  readonly analyzer: ClusterAnalyzer;
  readonly limits?: Partial<ExecutionLimits> | undefined;
  readonly cache?: AnalysisCache | undefined;
  readonly now?: (() => number) | undefined;
}

/** Rough token cost of a cluster's context, for budgeting before invocation. */
function contextTokens(cluster: RiskCluster): number {
  return cluster.context.reduce(
    (total, item) => total + Math.ceil(item.suppliedContent.length / 4),
    0,
  );
}

/**
 * Runs the clusters, in priority order, inside every cap.
 *
 * Highest tier first, so that when a cap *is* reached the work that was skipped
 * is the least risky rather than whatever happened to sort last. A cap reached
 * in id order would silently make review quality depend on file naming.
 */
export async function runAnalysis(
  clusters: readonly RiskCluster[],
  allocations: readonly BudgetAllocation[],
  options: ExecutionOptions,
): Promise<ExecutionReport> {
  const limits: ExecutionLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());
  const started = now();

  const byId = new Map(
    allocations.map((allocation) => [allocation.clusterId, allocation]),
  );
  const tierRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;

  const ordered = [...clusters].sort((left, right) => {
    const leftTier = byId.get(left.id)?.tier ?? "low";
    const rightTier = byId.get(right.id)?.tier ?? "low";
    if (leftTier !== rightTier) return tierRank[leftTier] - tierRank[rightTier];
    return left.id < right.id ? -1 : 1;
  });

  const findings: CandidateFinding[] = [];
  const suppressions: Suppression[] = [];
  const degradations: Degradation[] = [];
  const reused: string[] = [];

  let contextTokensSpent = 0;
  let reasoningCallsSpent = 0;
  let analyzed = 0;

  const admitted: RiskCluster[] = [];

  // Admission happens up front and in priority order, so a cluster that will
  // not be analyzed is recorded as skipped rather than discovered missing.
  for (const cluster of ordered) {
    const allocation = byId.get(cluster.id);
    const skip = (reason: DegradationReason, detail: string): void => {
      degradations.push({ clusterId: cluster.id, reason, detail });
    };

    if (admitted.length >= limits.maxClusters) {
      skip(
        "cluster_cap_reached",
        `only ${String(limits.maxClusters)} clusters are analyzed per review`,
      );
      continue;
    }

    const cost = contextTokens(cluster);
    if (contextTokensSpent + cost > limits.maxContextTokens) {
      skip(
        "context_budget_exhausted",
        `needs ~${String(cost)} tokens; ${String(
          limits.maxContextTokens - contextTokensSpent,
        )} remain`,
      );
      continue;
    }

    const calls = allocation?.maxReasoningCalls ?? 0;
    if (reasoningCallsSpent + calls > limits.maxReasoningCalls) {
      skip(
        "reasoning_call_cap_reached",
        `needs ${String(calls)} call(s); ${String(
          limits.maxReasoningCalls - reasoningCallsSpent,
        )} remain`,
      );
      continue;
    }

    contextTokensSpent += cost;
    reasoningCallsSpent += calls;
    admitted.push(cluster);
  }

  // Bounded fan-out: a fixed pool draining a shared queue. Not
  // `Promise.all(clusters)`, which turns a large pull request into a
  // rate-limit storm that presents as a slow review rather than an error.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const cluster = admitted[index];
      if (cluster === undefined) return;

      if (now() - started > limits.deadlineMs) {
        degradations.push({
          clusterId: cluster.id,
          reason: "deadline_exceeded",
          detail: `review exceeded ${String(limits.deadlineMs)}ms`,
        });
        continue;
      }

      const allocation = byId.get(cluster.id);
      if (allocation === undefined) continue;

      const fingerprint = fingerprintCluster(cluster);
      const cached = options.cache?.get(fingerprint);
      if (cached !== undefined) {
        // The incremental payoff: a cluster the revision did not touch keeps
        // its findings, and its budget is never spent.
        findings.push(...cached.findings);
        suppressions.push(...cached.suppressions);
        reused.push(cluster.id);
        continue;
      }

      try {
        const result = await options.analyzer({ cluster, allocation });
        findings.push(...result.findings);
        suppressions.push(...result.suppressions);
        analyzed += 1;
        options.cache?.set(fingerprint, result);
      } catch (error) {
        // A failing analyzer degrades the review; it never fabricates a
        // finding, and it never takes the rest of the review with it.
        degradations.push({
          clusterId: cluster.id,
          reason: "analyzer_failed",
          detail:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : "unknown error",
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, limits.concurrency) }, () => worker()),
  );

  return {
    findings,
    suppressions,
    degradations,
    reused,
    analyzed,
    skipped: clusters.length - admitted.length,
    contextTokensSpent,
    reasoningCallsSpent,
    durationMs: now() - started,
    complete: degradations.length === 0,
  };
}
