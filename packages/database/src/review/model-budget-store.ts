import { randomUUID } from "node:crypto";

import type { PgClient, PgPool } from "../webhook/postgres-inbox.js";

export interface ModelBudgetLimits {
  readonly maxCallsPerRun: number;
  readonly maxCostMicroUsdPerCall: number;
  readonly maxCostMicroUsdPerRun: number;
  readonly maxCostMicroUsdPerOrganization: number;
  readonly organizationWindowMs: number;
}

export interface ModelBudgetScope {
  readonly organizationId: string;
  readonly reviewRunId: string;
}

export type ModelBudgetReserveOutcome =
  | {
      readonly kind: "reserved";
      readonly reservation: {
        markDispatched(): Promise<void>;
        release(): Promise<void>;
      };
    }
  | { readonly kind: "budget_exceeded" };

function assertSafeNonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

/**
 * Atomic fleet-wide model budget reservations.
 *
 * The critical property is that the budget check and reservation insertion are
 * performed while both the organization and review-run advisory locks are
 * held. A read-then-call check in the gateway allows two replicas to observe
 * the same remaining budget and both spend it.
 */
export class ModelBudgetReservationStore {
  readonly #pool: PgPool;

  public constructor(pool: PgPool) {
    this.#pool = pool;
  }

  public async reserve(input: {
    readonly scope: ModelBudgetScope;
    readonly limits: ModelBudgetLimits;
    readonly requestedCostMicroUsd: number;
    readonly at: Date;
  }): Promise<ModelBudgetReserveOutcome> {
    const { scope, limits } = input;
    assertSafeNonNegative(input.requestedCostMicroUsd, "requested model cost");
    assertSafeNonNegative(
      limits.maxCostMicroUsdPerCall,
      "per-call model budget",
    );
    assertSafeNonNegative(limits.maxCostMicroUsdPerRun, "per-run model budget");
    assertSafeNonNegative(
      limits.maxCostMicroUsdPerOrganization,
      "organization model budget",
    );
    if (!Number.isInteger(limits.maxCallsPerRun) || limits.maxCallsPerRun < 1) {
      throw new Error("maxCallsPerRun must be a positive integer");
    }
    if (
      !Number.isSafeInteger(limits.organizationWindowMs) ||
      limits.organizationWindowMs < 1_000
    ) {
      throw new Error("organizationWindowMs must be at least 1000ms");
    }
    if (input.requestedCostMicroUsd > limits.maxCostMicroUsdPerCall) {
      return { kind: "budget_exceeded" };
    }

    const reservationId = randomUUID();
    const reserved = await this.#inTransaction(async (client) => {
      // Always lock organization first, then run. The fixed order prevents two
      // transactions that share one dimension from deadlocking each other.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`acalys:model-budget:org:${scope.organizationId}`],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`acalys:model-budget:run:${scope.reviewRunId}`],
      );

      await client.query(
        `DELETE FROM model_budget_reservations
          WHERE released_at IS NOT NULL
             OR (dispatch_intended_at IS NULL AND expires_at <= clock_timestamp())`,
      );

      const run = await client.query<{
        calls: string | number;
        cost_microusd: string | number;
        reserved_calls: string | number;
        reserved_cost_microusd: string | number;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE i.provider_dispatched) AS calls,
           COALESCE(SUM(i.cost_microusd) FILTER (WHERE i.provider_dispatched), 0) AS cost_microusd,
           (SELECT COUNT(*)
              FROM model_budget_reservations r
             WHERE r.review_run_id = $1
               AND r.released_at IS NULL
               AND (r.dispatch_intended_at IS NOT NULL OR r.expires_at > clock_timestamp())) AS reserved_calls,
           (SELECT COALESCE(SUM(r.reserved_cost_microusd), 0)
              FROM model_budget_reservations r
             WHERE r.review_run_id = $1
               AND r.released_at IS NULL
               AND (r.dispatch_intended_at IS NOT NULL OR r.expires_at > clock_timestamp())) AS reserved_cost_microusd
         FROM model_interactions i
        WHERE i.review_run_id = $1`,
        [scope.reviewRunId],
      );

      const org = await client.query<{
        cost_microusd: string | number;
        reserved_cost_microusd: string | number;
      }>(
        `SELECT
           COALESCE(SUM(i.cost_microusd) FILTER (WHERE i.provider_dispatched), 0) AS cost_microusd,
           (SELECT COALESCE(SUM(r.reserved_cost_microusd), 0)
              FROM model_budget_reservations r
             WHERE r.organization_id = $1
               AND r.released_at IS NULL
               AND (r.dispatch_intended_at IS NOT NULL OR r.expires_at > clock_timestamp())) AS reserved_cost_microusd
         FROM model_interactions i
        WHERE i.organization_id = $1
          AND i.started_at >= clock_timestamp() - ($2 * interval '1 millisecond')`,
        [scope.organizationId, limits.organizationWindowMs],
      );

      const runRow = run.rows[0];
      const orgRow = org.rows[0];
      const calls =
        Number(runRow?.calls ?? 0) + Number(runRow?.reserved_calls ?? 0);
      const runCost =
        Number(runRow?.cost_microusd ?? 0) +
        Number(runRow?.reserved_cost_microusd ?? 0);
      const orgCost =
        Number(orgRow?.cost_microusd ?? 0) +
        Number(orgRow?.reserved_cost_microusd ?? 0);

      if (
        calls >= limits.maxCallsPerRun ||
        runCost + input.requestedCostMicroUsd > limits.maxCostMicroUsdPerRun ||
        orgCost + input.requestedCostMicroUsd >
          limits.maxCostMicroUsdPerOrganization
      ) {
        return false;
      }

      await client.query(
        `INSERT INTO model_budget_reservations (
           id, organization_id, review_run_id, reserved_cost_microusd,
           reserved_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, clock_timestamp(),
           clock_timestamp() + ($5 * interval '1 millisecond')
         )`,
        [
          reservationId,
          scope.organizationId,
          scope.reviewRunId,
          input.requestedCostMicroUsd,
          limits.organizationWindowMs,
        ],
      );
      return true;
    });

    if (!reserved) return { kind: "budget_exceeded" };

    let released = false;
    let dispatchMarked = false;
    return {
      kind: "reserved",
      reservation: {
        markDispatched: async () => {
          if (dispatchMarked) return;
          const result = await this.#withClient((client) =>
            client.query(
              `UPDATE model_budget_reservations
                  SET dispatch_intended_at = COALESCE(dispatch_intended_at, clock_timestamp())
                WHERE id = $1 AND released_at IS NULL`,
              [reservationId],
            ),
          );
          if (result.rowCount !== 1) {
            throw new Error(
              "model budget reservation was lost before provider dispatch",
            );
          }
          dispatchMarked = true;
        },
        release: async () => {
          if (released) return;
          await this.#withClient((client) =>
            client.query(
              `UPDATE model_budget_reservations
                  SET released_at = clock_timestamp()
                WHERE id = $1 AND released_at IS NULL`,
              [reservationId],
            ),
          );
          released = true;
        },
      },
    };
  }

  async #inTransaction<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
