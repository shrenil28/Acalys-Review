import { randomUUID } from "node:crypto";

import type { PgClient, PgPool } from "../webhook/postgres-inbox.js";

export interface ModelInteractionRecord {
  readonly scope: {
    readonly organizationId: string;
    readonly reviewRunId: string;
  };
  readonly identity: {
    readonly provider: "openai" | "anthropic";
    readonly modelId: string;
    readonly tier: "cheap" | "strong";
    readonly taskClass: "triage" | "correctness" | "verification" | "summary";
    readonly routingPolicyVersion: string;
    readonly promptTemplateVersion: string;
    readonly requestDigest: string;
  };
  readonly outcome: "ok" | "failed" | "unknown" | "invalid_response";
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheHit: boolean;
    readonly costMicroUsd: number;
  };
  readonly accountedCostMicroUsd: number;
  readonly replayed: boolean;
  readonly providerDispatched: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export interface ModelUsageSnapshot {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costMicroUsd: number;
}

const ZERO_USAGE: ModelUsageSnapshot = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costMicroUsd: 0,
};

function integer(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`model usage value ${String(value)} is outside the safe integer range`);
  }
  return parsed;
}

/** Durable model-call ledger and the authoritative budget read surface. */
export class ModelUsageStore {
  readonly #pool: PgPool;

  public constructor(pool: PgPool) {
    this.#pool = pool;
  }

  public async record(record: ModelInteractionRecord): Promise<void> {
    const usage = record.usage;
    await this.#withClient(async (client) => {
      await client.query(
        `INSERT INTO model_interactions (
           id, organization_id, review_run_id, request_digest,
           provider, model_id, task_class, tier, routing_policy_version,
           prompt_template_version, outcome, input_tokens, output_tokens,
           cached_input_tokens, cache_creation_input_tokens, cost_microusd, cache_hit, replayed,
           provider_dispatched, started_at, finished_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          randomUUID(),
          record.scope.organizationId,
          record.scope.reviewRunId,
          record.identity.requestDigest,
          record.identity.provider,
          record.identity.modelId,
          record.identity.taskClass,
          record.identity.tier,
          record.identity.routingPolicyVersion,
          record.identity.promptTemplateVersion,
          record.outcome,
          usage?.inputTokens ?? 0,
          usage?.outputTokens ?? 0,
          usage?.cachedInputTokens ?? 0,
          usage?.cacheCreationInputTokens ?? 0,
          record.accountedCostMicroUsd,
          usage?.cacheHit ?? false,
          record.replayed,
          record.providerDispatched,
          record.startedAt,
          record.finishedAt,
        ],
      );
    });
  }

  public usageForRun(reviewRunId: string): Promise<ModelUsageSnapshot> {
    return this.#usage("review_run_id", reviewRunId);
  }

  public usageForOrganization(
    organizationId: string,
    since: Date,
  ): Promise<ModelUsageSnapshot> {
    return this.#usage("organization_id", organizationId, since);
  }

  async #usage(
    column: "review_run_id" | "organization_id",
    id: string,
    since?: Date,
  ): Promise<ModelUsageSnapshot> {
    return this.#withClient(async (client) => {
      const result = await client.query<{
        calls: string | number;
        input_tokens: string | number;
        output_tokens: string | number;
        cached_input_tokens: string | number;
        cost_microusd: string | number;
      }>(
        `SELECT COUNT(*) FILTER (WHERE provider_dispatched) AS calls,
                COALESCE(SUM(input_tokens) FILTER (WHERE provider_dispatched), 0) AS input_tokens,
                COALESCE(SUM(output_tokens) FILTER (WHERE provider_dispatched), 0) AS output_tokens,
                COALESCE(SUM(cached_input_tokens) FILTER (WHERE provider_dispatched), 0) AS cached_input_tokens,
                COALESCE(SUM(cost_microusd) FILTER (WHERE provider_dispatched), 0) AS cost_microusd
           FROM model_interactions
          WHERE ${column} = $1
            AND ($2::timestamptz IS NULL OR started_at >= $2)`,
        [id, since ?? null],
      );
      const row = result.rows[0];
      if (row === undefined) return ZERO_USAGE;
      return {
        calls: integer(row.calls),
        inputTokens: integer(row.input_tokens),
        outputTokens: integer(row.output_tokens),
        cachedInputTokens: integer(row.cached_input_tokens),
        costMicroUsd: integer(row.cost_microusd),
      };
    });
  }

  async #withClient<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await run(client);
    } finally {
      client.release();
    }
  }
}
