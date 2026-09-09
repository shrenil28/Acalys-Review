/**
 * The Postgres inbox — the production implementation.
 *
 * Everything of consequence happens inside one transaction, and the
 * exactly-once guarantee is delegated to a unique constraint rather than
 * decided in application code.
 *
 * # Why the constraint, and not a check-then-insert
 *
 *     SELECT … WHERE delivery_id = $1     ← nothing
 *     -- another replica does the same here
 *     INSERT …                            ← both succeed
 *
 * The window between the two statements is small and entirely sufficient: two
 * gateway replicas handling one redelivery hit it routinely, and the result is
 * two review runs on one push. `ON CONFLICT` closes it because the check and
 * the write are the same atomic operation.
 *
 * # Why not `ON CONFLICT DO NOTHING`
 *
 * It cannot distinguish the two cases that matter. `DO UPDATE` with a no-op
 * assignment makes the existing row visible in `RETURNING`, so the digest can
 * be compared — which is what separates a legitimate redelivery from a body
 * that changed under a reused id.
 */

import { randomUUID } from "node:crypto";

import type {
  AuthenticatedDelivery,
  DeliveryState,
  IngestOutcome,
  JobRequest,
  ScheduledJob,
  WebhookDelivery,
  WebhookInbox,
} from "./inbox.js";

/**
 * The slice of `pg` this adapter uses.
 *
 * Declared structurally rather than importing `pg`'s types, so the package
 * compiles without the driver present and a test can supply a fake pool. It is
 * also the honest description of the dependency: four methods, not an ORM.
 */
export interface PgQueryResult<TRow> {
  readonly rows: TRow[];
  readonly rowCount: number | null;
}

export interface PgClient {
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<TRow>>;
  release(): void;
}

export interface PgPool {
  connect(): Promise<PgClient>;
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<TRow>>;
}

interface DeliveryRow {
  id: string;
  provider: string;
  source_endpoint_id: string;
  delivery_id: string;
  event: string;
  action: string | null;
  body_digest: string;
  payload: Buffer;
  received_at: Date;
  authenticated_at: Date;
  state: string;
  outcome_reason: string | null;
  attempts: number;
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    provider: row.provider,
    sourceEndpointId: row.source_endpoint_id,
    deliveryId: row.delivery_id,
    event: row.event,
    action: row.action,
    bodyDigest: row.body_digest,
    payload: row.payload,
    receivedAt: row.received_at,
    authenticatedAt: row.authenticated_at,
    state: row.state as DeliveryState,
    outcomeReason: row.outcome_reason,
    attempts: row.attempts,
  };
}

/**
 * Hook points for testing crash windows.
 *
 * Injecting a failure between two statements is the only way to prove the
 * transaction boundary is where it is claimed to be. Without this, "crash after
 * the delivery insert but before the job insert" is untestable, and that is
 * precisely the window that would leave an owned delivery with no work — a
 * state redelivery cannot repair, because the row makes the retry look like a
 * duplicate.
 */
export interface InboxFaultInjector {
  readonly afterDeliveryInsert?: (() => Promise<void>) | undefined;
  readonly afterJobInsert?: (() => Promise<void>) | undefined;
  readonly beforeCommit?: (() => Promise<void>) | undefined;
}

export interface PostgresWebhookInboxOptions {
  readonly pool: PgPool;
  readonly now?: (() => Date) | undefined;
  readonly faults?: InboxFaultInjector | undefined;
}

export class WebhookJobClaimLost extends Error {
  public constructor(jobId: string, claimGeneration: number) {
    super(
      `Webhook job ${jobId} is no longer owned by claim generation ${String(claimGeneration)}`,
    );
    this.name = "WebhookJobClaimLost";
  }
}

export class PostgresWebhookInbox implements WebhookInbox {
  readonly #pool: PgPool;
  readonly #now: () => Date;
  readonly #faults: InboxFaultInjector;

  public constructor(options: PostgresWebhookInboxOptions) {
    this.#pool = options.pool;
    this.#now = options.now ?? (() => new Date());
    this.#faults = options.faults ?? {};
  }

  public async ingest(
    delivery: AuthenticatedDelivery,
    jobs: readonly JobRequest[],
  ): Promise<IngestOutcome> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");

      // `DO UPDATE` with a self-assignment rather than `DO NOTHING`: the latter
      // returns no row on conflict, so the existing digest would be invisible
      // and a rewritten body would be indistinguishable from a redelivery.
      // `xmax = 0` is Postgres's own signal for "this row was inserted by this
      // statement" — the only reliable way to tell an insert from a conflict
      // when both return a row.
      const inserted = await client.query<DeliveryRow & { inserted: boolean }>(
        `INSERT INTO webhook_deliveries (
           id, provider, source_endpoint_id, delivery_id, event, action,
           body_digest, payload, received_at, authenticated_at, state, attempts
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'received',0)
         ON CONFLICT ON CONSTRAINT webhook_deliveries_endpoint_delivery_key
           DO UPDATE SET updated_at = webhook_deliveries.updated_at
         RETURNING *, (xmax = 0) AS inserted`,
        [
          randomUUID(),
          delivery.provider,
          delivery.sourceEndpointId,
          delivery.deliveryId,
          delivery.event,
          delivery.action,
          delivery.bodyDigest,
          delivery.payload,
          delivery.receivedAt,
          this.#now(),
        ],
      );

      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("webhook_deliveries upsert returned no row");
      }

      await this.#faults.afterDeliveryInsert?.();

      if (!row.inserted) {
        // Already owned. The digest decides which kind.
        await client.query("ROLLBACK");
        const existing = toDelivery(row);
        return existing.bodyDigest === delivery.bodyDigest
          ? { kind: "duplicate", delivery: existing }
          : {
              kind: "conflict",
              existing,
              attemptedDigest: delivery.bodyDigest,
            };
      }

      for (const job of jobs) {
        await client.query(
          `INSERT INTO webhook_jobs (id, delivery_row_id, kind, payload, available_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            randomUUID(),
            row.id,
            job.kind,
            JSON.stringify(job.payload),
            this.#now(),
          ],
        );
        await this.#faults.afterJobInsert?.();
      }

      await this.#faults.beforeCommit?.();
      await client.query("COMMIT");

      return { kind: "accepted", delivery: toDelivery(row) };
    } catch (error) {
      // Rollback failures are swallowed: the original error is the useful one,
      // and a connection already broken will fail this too.
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async findDelivery(
    sourceEndpointId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery | undefined> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query<DeliveryRow>(
        `SELECT * FROM webhook_deliveries
          WHERE source_endpoint_id = $1 AND delivery_id = $2`,
        [sourceEndpointId, deliveryId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toDelivery(row);
    } finally {
      client.release();
    }
  }

  /**
   * Claims ready jobs on a **lease**.
   *
   * `FOR UPDATE SKIP LOCKED` lets several workers poll one table without
   * serializing: each takes rows the others have not locked rather than
   * blocking behind them. That handles contention. It does not handle death.
   *
   * A worker that claims a job and then dies would, with a plain
   * `locked_at IS NULL` predicate, hold it forever — the delivery sits in
   * `processing` with nothing able to reclaim it, and GitHub will not
   * redeliver. So the claim carries an expiry, and a job whose lease has
   * lapsed is claimable again:
   *
   *     never claimed          available_at <= now
   *     claimed, worker alive  lease_expires_at > now    → skipped
   *     claimed, worker dead   lease_expires_at <= now   → reclaimed
   *
   * The lease must outlast the work. Too short and a healthy worker has its
   * job stolen mid-execution, which is worse than a delay: two workers then
   * run the same delivery concurrently, and only the idempotent writes
   * downstream keep that from duplicating review history.
   *
   * `attempts` increments on every claim, including reclaims, so a job that
   * repeatedly kills its worker is visible as a poison record rather than
   * cycling silently.
   */
  public async claimJobs(
    limit: number,
    leaseMillis = 300_000,
  ): Promise<readonly ScheduledJob[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const now = this.#now();
      const leaseExpiry = new Date(now.getTime() + leaseMillis);

      const result = await client.query<{
        id: string;
        delivery_row_id: string;
        kind: string;
        payload: unknown;
        available_at: Date;
        attempts: number;
        claim_generation: string | number;
      }>(
        `UPDATE webhook_jobs
            SET locked_at = $1, lease_expires_at = $3, attempts = attempts + 1,
                claim_generation = claim_generation + 1
          WHERE id IN (
            SELECT id FROM webhook_jobs
             WHERE available_at <= $1
               AND dead_lettered_at IS NULL
               AND attempts < max_attempts
               AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
             ORDER BY available_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, delivery_row_id, kind, payload, available_at, attempts, claim_generation`,
        [now, limit, leaseExpiry],
      );
      await client.query("COMMIT");

      return result.rows.map((row) => {
        const claimGeneration = Number(row.claim_generation);
        if (!Number.isSafeInteger(claimGeneration) || claimGeneration <= 0) {
          throw new Error(`Invalid webhook claim generation for job ${row.id}`);
        }
        return {
          id: row.id,
          deliveryRowId: row.delivery_row_id,
          kind: row.kind,
          payload: row.payload,
          availableAt: row.available_at,
          attempts: row.attempts,
          claimGeneration,
        };
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Releases a finished job.
   *
   * Deleting rather than flagging: a completed job has no further use, and the
   * partial index that makes the claim query fast stays proportional to the
   * backlog rather than to history.
   */
  public async completeJob(jobId: string, claimGeneration: number): Promise<void> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        "DELETE FROM webhook_jobs WHERE id = $1 AND claim_generation = $2",
        [jobId, claimGeneration],
      );
      if (result.rowCount !== 1) {
        throw new WebhookJobClaimLost(jobId, claimGeneration);
      }
    } finally {
      client.release();
    }
  }

  public async deferJob(
    jobId: string,
    claimGeneration: number,
    retryAfterMillis = 1_000,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      const now = this.#now();
      const result = await client.query(
        `UPDATE webhook_jobs
            SET locked_at = NULL,
                lease_expires_at = NULL,
                available_at = $3,
                attempts = GREATEST(attempts - 1, 0)
          WHERE id = $1 AND claim_generation = $2`,
        [jobId, claimGeneration, new Date(now.getTime() + retryAfterMillis)],
      );
      if (result.rowCount !== 1) {
        throw new WebhookJobClaimLost(jobId, claimGeneration);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Returns a job for a later attempt, or dead-letters it.
   *
   * The bounded failure path. A delivery can be perfectly authenticated,
   * perfectly persisted, and still semantically unusable — an unsupported
   * action, a repository the installation can no longer read, a payload that
   * fails normalization. Without a ceiling, that row consumes a worker slot
   * forever.
   *
   * `retryable` is the caller's classification, and the distinction matters:
   * a provider timeout deserves another attempt, a payload that cannot be
   * normalized will fail identically every time and should stop immediately
   * rather than burning the full budget.
   */
  public async releaseJob(
    jobId: string,
    claimGeneration: number,
    options: {
      readonly retryable: boolean;
      readonly errorCode: string;
      readonly retryAfterMillis?: number | undefined;
    },
  ): Promise<{ readonly deadLettered: boolean }> {
    const client = await this.#pool.connect();
    try {
      const now = this.#now();
      const result = await client.query<{ dead_lettered_at: Date | null }>(
        `UPDATE webhook_jobs
            SET locked_at = NULL,
                lease_expires_at = NULL,
                last_error_code = $2,
                available_at = $3,
                dead_lettered_at = CASE
                  WHEN $4 = false OR attempts >= max_attempts THEN $5
                  ELSE dead_lettered_at END
          WHERE id = $1 AND claim_generation = $6
          RETURNING dead_lettered_at`,
        [
          jobId,
          options.errorCode,
          new Date(now.getTime() + (options.retryAfterMillis ?? 0)),
          options.retryable,
          now,
          claimGeneration,
        ],
      );
      if (result.rowCount !== 1) {
        throw new WebhookJobClaimLost(jobId, claimGeneration);
      }
      return { deadLettered: result.rows[0]?.dead_lettered_at != null };
    } finally {
      client.release();
    }
  }

  public async markDeliveryState(
    deliveryRowId: string,
    state: DeliveryState,
    reason?: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query(
        `UPDATE webhook_deliveries
            SET state = $2, outcome_reason = $3, updated_at = $4
          WHERE id = $1`,
        [deliveryRowId, state, reason ?? null, this.#now()],
      );
    } finally {
      client.release();
    }
  }
}
