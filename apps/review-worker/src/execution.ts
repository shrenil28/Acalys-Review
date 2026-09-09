import type { OrchestratorOptions, RunContext } from "./orchestrator.js";
import { advanceToSettled } from "./orchestrator.js";
import type { ReviewExecutionPort } from "./worker.js";

export interface ReviewRunContextResolver {
  resolve(input: {
    readonly runId: string;
    readonly revisionId: string;
    readonly pullRequestId: string;
    readonly deliveryRowId: string;
  }): Promise<RunContext | undefined>;
}

/**
 * Binds durable webhook work to the resumable review state machine.
 *
 * The analyzer and verifier inside `orchestrator` are required ports, so this
 * adapter cannot silently fall back to the deterministic test implementation.
 */
export function createReviewExecutionPort(options: {
  readonly contexts: ReviewRunContextResolver;
  readonly orchestrator: OrchestratorOptions;
}): ReviewExecutionPort {
  return {
    async execute(input) {
      const context = await options.contexts.resolve(input);
      if (context === undefined) {
        return {
          kind: "permanent_failure",
          errorCode: "acalys.error.review-context-missing",
        };
      }

      try {
        const outcome = await advanceToSettled(context, options.orchestrator);
        switch (outcome.kind) {
          case "settled":
            switch (outcome.state) {
              case "publishing":
                // Entering `publishing` atomically persists the publication
                // intents. The webhook job may hand ownership to that durable
                // obligation here; waiting for the remote provider effect would
                // couple ingestion retry semantics to publication recovery.
                return { kind: "settled", state: outcome.state };
              case "completed":
              case "failed":
              case "cancelled":
              case "superseded":
                return { kind: "settled", state: outcome.state };
              default:
                return { kind: "deferred", state: outcome.state };
            }

          case "refused":
            return {
              kind: "deferred",
              state: outcome.actualState ?? "run-not-visible",
            };

          case "stale":
            return { kind: "deferred", state: "revision-stale" };

          case "invariant_violation":
            return {
              kind: "permanent_failure",
              errorCode: `acalys.error.review-invariant.${outcome.missing}`,
            };

          case "advanced":
            // `advanceToSettled` never returns an intermediate advanced result.
            throw new Error("advanceToSettled returned an intermediate state");
        }
      } catch {
        // The worker owns a durable job, so an unclassified execution error must
        // preserve that obligation for retry rather than acknowledge it away.
        return {
          kind: "retryable_failure",
          errorCode: "acalys.error.review-execution",
        };
      }
    },
  };
}
