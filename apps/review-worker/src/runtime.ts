import {
  ModelBudgetReservationStore,
  ModelCredentialAdmissionStore,
  ModelUsageStore,
  ReviewDispatchStore,
  PolicyDecisionStore,
  PostgresWebhookInbox,
  PreMergeStore,
  ReviewIngestionStore,
  ReviewStageStore,
  VerificationScheduler,
  VerificationStore,
  type PgPool,
} from "@acalys/database";
import {
  ModelGateway,
  type CassetteStore,
  type CredentialPolicy,
  type GatewayLogger,
  type ModelBudgetConfig,
  type ModelProvider,
  type ModelProviderAdapter,
  type ModelRoutingPolicy,
  type ReplayMode,
  type RetryPolicy,
} from "@acalys/model-gateway";
import type { GithubRepositoryReader } from "@acalys/provider-github";

import { runRealAnalysis } from "./analysis.js";
import { createReviewExecutionPort } from "./execution.js";
import {
  createApiDispatchWorker,
  type RunningApiDispatchWorker,
} from "./api-dispatch-worker.js";
import {
  createGithubAnalysisSource,
  createGithubIndependentSource,
} from "./github-source.js";
import { createModelCandidateVerifier } from "./model-verifier.js";
import type { OrchestratorOptions } from "./orchestrator.js";
import {
  createWorker,
  type RunningWorker,
  type WorkerObserver,
} from "./worker.js";

export interface ProductionModelRuntimeConfig {
  readonly router: ModelRoutingPolicy;
  readonly adapters: ReadonlyMap<ModelProvider, ModelProviderAdapter>;
  readonly budget: ModelBudgetConfig;
  readonly credentials: Readonly<Record<ModelProvider, CredentialPolicy>>;
  readonly retries: RetryPolicy;
  readonly cassette?: CassetteStore | undefined;
  readonly replayMode?: ReplayMode | undefined;
  readonly logger?: GatewayLogger | undefined;
}

export interface ProductionWorkerConfig {
  readonly batchSize?: number | undefined;
  readonly leaseMillis?: number | undefined;
  readonly pollIntervalMillis?: number | undefined;
  readonly retryBackoffMillis?: number | undefined;
  readonly observer?: WorkerObserver | undefined;
}

export interface ProductionReviewRuntimeOptions {
  readonly pool: PgPool;
  readonly githubReader: GithubRepositoryReader;
  readonly model: ProductionModelRuntimeConfig;
  readonly worker?: ProductionWorkerConfig | undefined;
}

export interface ProductionReviewRuntime {
  readonly worker: RunningWorker;
  readonly apiDispatchWorker: RunningApiDispatchWorker;
  readonly modelGateway: ModelGateway;
}

/**
 * The production composition root for Phase 2.
 *
 * This function is intentionally the only place that assembles the complete
 * webhook → review lifecycle → model analyzer → independent verifier path.
 * Tests may construct the lower-level ports directly, but the executable
 * process uses this root so a production caller cannot accidentally omit the
 * real analyzer, verifier, budget, admission or source-reader boundary.
 */
export function createProductionReviewRuntime(
  options: ProductionReviewRuntimeOptions,
): ProductionReviewRuntime {
  const ingestion = new ReviewIngestionStore(options.pool);
  const stages = new ReviewStageStore(options.pool);
  const scheduler = new VerificationScheduler(options.pool);
  const verifications = new VerificationStore(options.pool);
  const decisions = new PolicyDecisionStore(options.pool);
  const premerge = new PreMergeStore(options.pool);
  const inbox = new PostgresWebhookInbox({ pool: options.pool });

  const usage = new ModelUsageStore(options.pool);
  const reservations = new ModelBudgetReservationStore(options.pool);
  const admission = new ModelCredentialAdmissionStore(options.pool);
  const modelGateway = new ModelGateway({
    router: options.model.router,
    adapters: options.model.adapters,
    usage,
    reservations,
    budget: options.model.budget,
    credentials: options.model.credentials,
    retries: options.model.retries,
    admission,
    ...(options.model.cassette === undefined
      ? {}
      : { cassette: options.model.cassette }),
    ...(options.model.replayMode === undefined
      ? {}
      : { replayMode: options.model.replayMode }),
    ...(options.model.logger === undefined
      ? {}
      : { logger: options.model.logger }),
  });

  const analysisSource = createGithubAnalysisSource({
    ingestion,
    reader: options.githubReader,
  });

  const verifier = createModelCandidateVerifier({
    model: modelGateway,
    sourceFor: ({ repositoryId, revisionId }) =>
      createGithubIndependentSource({
        ingestion,
        reader: options.githubReader,
        repositoryId,
        revisionId,
      }),
  });

  const orchestrator: OrchestratorOptions = {
    ingestion,
    stages,
    scheduler,
    verifications,
    decisions,
    premerge,
    analyzer: async (input, context) => {
      if (context.provider !== "github") {
        throw new Error(
          `Phase-2 production analyzer does not support provider ${context.provider}`,
        );
      }
      const outcome = await runRealAnalysis({
        repositoryId: input.repositoryId,
        headSha: input.headSha,
        revisionId: context.revisionId,
        tenantId: context.scope.organizationId,
        provider: "github",
        source: analysisSource,
        llm: {
          scope: {
            organizationId: context.scope.organizationId,
            reviewRunId: context.runId,
          },
          model: modelGateway,
        },
      });
      return outcome.candidates;
    },
    verifier,
  };

  const reviewExecution = createReviewExecutionPort({
    contexts: {
      async resolve(input) {
        const stored = await ingestion.getRunExecutionContext(input.runId);
        if (
          stored === undefined ||
          stored.revisionId !== input.revisionId ||
          stored.pullRequestId !== input.pullRequestId
        ) {
          return undefined;
        }
        return {
          scope: {
            organizationId: stored.organizationId,
            repositoryId: stored.repositoryId,
          },
          runId: stored.runId,
          revisionId: stored.revisionId,
          headSha: stored.headSha,
          provider: stored.provider,
          pullRequestId: stored.pullRequestId,
        };
      },
    },
    orchestrator,
  });

  const apiDispatchWorker = createApiDispatchWorker({
    store: new ReviewDispatchStore(options.pool),
    reviewExecution,
    ...(options.worker?.batchSize === undefined
      ? {}
      : { batchSize: options.worker.batchSize }),
    ...(options.worker?.leaseMillis === undefined
      ? {}
      : { leaseMillis: options.worker.leaseMillis }),
    ...(options.worker?.pollIntervalMillis === undefined
      ? {}
      : { pollIntervalMillis: options.worker.pollIntervalMillis }),
    ...(options.worker?.retryBackoffMillis === undefined
      ? {}
      : { retryBackoffMillis: options.worker.retryBackoffMillis }),
    ...(options.worker?.observer === undefined
      ? {}
      : { observer: { onError: options.worker.observer.onError } }),
  });

  const worker = createWorker({
    inbox,
    store: ingestion,
    reviewExecution,
    ...(options.worker?.batchSize === undefined
      ? {}
      : { batchSize: options.worker.batchSize }),
    ...(options.worker?.leaseMillis === undefined
      ? {}
      : { leaseMillis: options.worker.leaseMillis }),
    ...(options.worker?.pollIntervalMillis === undefined
      ? {}
      : { pollIntervalMillis: options.worker.pollIntervalMillis }),
    ...(options.worker?.retryBackoffMillis === undefined
      ? {}
      : { retryBackoffMillis: options.worker.retryBackoffMillis }),
    ...(options.worker?.observer === undefined
      ? {}
      : { observer: options.worker.observer }),
  });

  return { worker, apiDispatchWorker, modelGateway };
}
