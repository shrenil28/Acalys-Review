import { randomUUID } from "node:crypto";

import type { PgClient, PgPool } from "../webhook/postgres-inbox.js";

const ACTIVE_DISPATCH_STATES = [
  "queued",
  "preparing",
  "analyzing",
  "reviewing",
  "verifying",
  "reconciling",
] as const;

const ACTIVE_DISPATCH_STATE_SQL = ACTIVE_DISPATCH_STATES.map(
  (state) => `'${state}'`,
).join(",");

export function reviewDispatchExecutionLockKey(reviewRunId: string): string {
  return `acalys:api-review-dispatch:${reviewRunId}`;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export interface ReviewDispatchClaim {
  readonly reviewRunId: string;
  readonly organizationId: string;
  readonly revisionId: string;
  readonly pullRequestId: string;
  readonly attempts: number;
  readonly claimGeneration: number;
  readonly claimedAt: Date;
  readonly leaseExpiresAt: Date;
}

export interface ReviewDispatchExecutionGuard {
  /** Extends the current generation's lease using the database clock. */
  renew(leaseMillis: number): Promise<boolean>;
  /** Releases the session-level single-executor fence and its dedicated client. */
  release(): Promise<void>;
}

export type ReviewDispatchGuardAcquisition =
  | { readonly kind: "owned"; readonly guard: ReviewDispatchExecutionGuard }
  | { readonly kind: "busy" }
  | { readonly kind: "stale" }
  | { readonly kind: "settled" };

export type ReviewDispatchReplay =
  | {
      readonly kind: "replayed";
      readonly reviewRunId: string;
      readonly attempt: number;
    }
  | {
      readonly kind: "existing";
      readonly reviewRunId: string;
      readonly attempt: number;
    };

export class StaleReviewDispatchClaim extends Error {
  public constructor() {
    super("Review dispatch claim is stale");
    this.name = "StaleReviewDispatchClaim";
  }
}

export class ReviewDispatchStore {
  public constructor(private readonly pool: PgPool) {}

  private async inTransaction<T>(
    work: (client: PgClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Compatibility enqueue used by internal callers. The database, not the caller,
   * owns scheduling chronology.
   */
  public async enqueue(input: {
    readonly reviewRunId: string;
    readonly organizationId: string;
    readonly revisionId: string;
    readonly pullRequestId: string;
  }): Promise<void> {
    await this.pool.query(
      `WITH db_time AS MATERIALIZED (SELECT clock_timestamp() AS at)
       INSERT INTO review_dispatch_jobs
         (review_run_id, organization_id, revision_id, pull_request_id,
          available_at, created_at, updated_at)
       SELECT $1,$2,$3,$4,db_time.at,db_time.at,db_time.at
         FROM db_time
       ON CONFLICT (review_run_id) DO NOTHING`,
      [
        input.reviewRunId,
        input.organizationId,
        input.revisionId,
        input.pullRequestId,
      ],
    );
  }

  /**
   * Claims active API review work.
   *
   * Two fences participate in the claim:
   *  - the transaction advisory lock serializes claim/cancel with a live executor;
   *  - after that fence is held, the review_run row lock serializes lifecycle state
   *    changes and the dispatch-row update.
   *
   * Advisory-first ordering is shared with cancellation. This is important: a
   * run-row-first claimant racing an advisory-first cancellation could deadlock.
   *
   * All lease timestamps come from Postgres so horizontally scaled workers cannot
   * disagree because their process clocks differ.
   */
  public async claim(
    limit: number,
    leaseMillis: number,
  ): Promise<readonly ReviewDispatchClaim[]> {
    requirePositiveInteger("limit", limit);
    requirePositiveInteger("leaseMillis", leaseMillis);

    return this.inTransaction(async (client) => {
      // A process can die after the lifecycle reached a state for which dispatch
      // is no longer owed but before deleting its job. Remove only live/non-DLQ
      // leftovers; dead-letter rows are forensic records and replay sources.
      await client.query(
        `DELETE FROM review_dispatch_jobs j
          USING review_runs r
          WHERE r.id=j.review_run_id
            AND j.dead_lettered_at IS NULL
            AND r.state IN ('publishing','completed','failed','cancelled','superseded')`,
      );

      // Candidate discovery deliberately takes no row lock. Every mutating path
      // acquires the per-run advisory fence *before* the review_runs row lock, so
      // claim/cancel/execution cannot form an advisory-vs-row-lock deadlock.
      //
      // Scan in bounded keyset pages instead of taking only `limit * N` rows. A
      // long prefix owned by live executors must not starve later ready work.
      const pageSize = Math.min(Math.max(limit * 8, 64), 1_000);
      const claims: ReviewDispatchClaim[] = [];
      let cursorAvailableAt: Date | undefined;
      let cursorReviewRunId: string | undefined;

      while (claims.length < limit) {
        const selected = await client.query<{
          review_run_id: string;
          organization_id: string;
          revision_id: string;
          pull_request_id: string;
          available_at: Date;
        }>(
          cursorAvailableAt === undefined
            ? `SELECT j.review_run_id,j.organization_id,j.revision_id,j.pull_request_id,j.available_at
                 FROM review_runs r
                 JOIN review_dispatch_jobs j ON j.review_run_id=r.id
                WHERE r.state IN (${ACTIVE_DISPATCH_STATE_SQL})
                  AND j.available_at <= clock_timestamp()
                  AND j.dead_lettered_at IS NULL
                  AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= clock_timestamp())
                ORDER BY j.available_at,j.review_run_id
                LIMIT $1`
            : `SELECT j.review_run_id,j.organization_id,j.revision_id,j.pull_request_id,j.available_at
                 FROM review_runs r
                 JOIN review_dispatch_jobs j ON j.review_run_id=r.id
                WHERE r.state IN (${ACTIVE_DISPATCH_STATE_SQL})
                  AND j.available_at <= clock_timestamp()
                  AND j.dead_lettered_at IS NULL
                  AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= clock_timestamp())
                  AND (j.available_at,j.review_run_id) > ($2::timestamptz,$3::uuid)
                ORDER BY j.available_at,j.review_run_id
                LIMIT $1`,
          cursorAvailableAt === undefined
            ? [pageSize]
            : [pageSize, cursorAvailableAt, cursorReviewRunId],
        );
        if (selected.rows.length === 0) break;

        const last = selected.rows[selected.rows.length - 1];
        if (last === undefined) break;
        cursorAvailableAt = last.available_at;
        cursorReviewRunId = last.review_run_id;

        for (const row of selected.rows) {
          if (claims.length >= limit) break;

          const advisory = await client.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired`,
            [reviewDispatchExecutionLockKey(row.review_run_id)],
          );
          if (advisory.rows[0]?.acquired !== true) continue;

          // Re-check lifecycle eligibility while holding both the advisory fence
          // and the canonical run-row lock. Cancellation uses the same order.
          const run = await client.query<{ state: string }>(
            `SELECT state FROM review_runs WHERE id=$1 FOR UPDATE`,
            [row.review_run_id],
          );
          if (
            !ACTIVE_DISPATCH_STATES.includes(
              run.rows[0]?.state as (typeof ACTIVE_DISPATCH_STATES)[number],
            )
          ) {
            continue;
          }

          const claimed = await client.query<{
            attempts: number;
            claim_generation: string | number;
            claimed_at: Date;
            lease_expires_at: Date;
          }>(
            `WITH db_time AS MATERIALIZED (SELECT clock_timestamp() AS at)
             UPDATE review_dispatch_jobs j
                SET claim_generation=j.claim_generation+1,
                    lease_expires_at=db_time.at + ($2::double precision * interval '1 millisecond'),
                    attempts=j.attempts+1,
                    updated_at=GREATEST(j.updated_at,db_time.at)
               FROM db_time
              WHERE j.review_run_id=$1
                AND j.dead_lettered_at IS NULL
                AND j.available_at <= db_time.at
                AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= db_time.at)
             RETURNING j.attempts,j.claim_generation,db_time.at AS claimed_at,j.lease_expires_at`,
            [row.review_run_id, leaseMillis],
          );
          const current = claimed.rows[0];
          if (current === undefined) continue;

          claims.push({
            reviewRunId: row.review_run_id,
            organizationId: row.organization_id,
            revisionId: row.revision_id,
            pullRequestId: row.pull_request_id,
            attempts: current.attempts,
            claimGeneration: Number(current.claim_generation),
            claimedAt: current.claimed_at,
            leaseExpiresAt: current.lease_expires_at,
          });
        }

        if (selected.rows.length < pageSize) break;
      }
      return claims;
    });
  }

  /**
   * Acquires the process-lifetime execution fence for one claimed generation.
   * The advisory lock is session-scoped and therefore disappears automatically
   * if the worker process/database connection dies.
   */
  public async acquireExecutionGuard(
    reviewRunId: string,
    generation: number,
  ): Promise<ReviewDispatchGuardAcquisition> {
    const client = await this.pool.connect();
    const lockKey = reviewDispatchExecutionLockKey(reviewRunId);
    let ownsLock = false;

    try {
      const locked = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired`,
        [lockKey],
      );
      if (locked.rows[0]?.acquired !== true) {
        client.release();
        return { kind: "busy" };
      }
      ownsLock = true;

      const current = await client.query<{
        claim_generation: string | number;
        dead_lettered_at: Date | null;
        lease_expires_at: Date | null;
        state: string;
        database_now: Date;
      }>(
        `SELECT j.claim_generation,j.dead_lettered_at,j.lease_expires_at,
                r.state,clock_timestamp() AS database_now
           FROM review_dispatch_jobs j
           JOIN review_runs r ON r.id=j.review_run_id
          WHERE j.review_run_id=$1`,
        [reviewRunId],
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        Number(row.claim_generation) !== generation ||
        row.dead_lettered_at !== null
      ) {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1,0))`,
          [lockKey],
        );
        ownsLock = false;
        client.release();
        return { kind: "stale" };
      }
      if (
        !ACTIVE_DISPATCH_STATES.includes(
          row.state as (typeof ACTIVE_DISPATCH_STATES)[number],
        )
      ) {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1,0))`,
          [lockKey],
        );
        ownsLock = false;
        client.release();
        return { kind: "settled" };
      }
      if (
        !(row.lease_expires_at instanceof Date) ||
        row.lease_expires_at.getTime() <= row.database_now.getTime()
      ) {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1,0))`,
          [lockKey],
        );
        ownsLock = false;
        client.release();
        return { kind: "stale" };
      }

      let released = false;
      const guard: ReviewDispatchExecutionGuard = {
        renew: async (leaseMillis) => {
          if (released) return false;
          requirePositiveInteger("leaseMillis", leaseMillis);
          const renewed = await client.query(
            `WITH db_time AS MATERIALIZED (SELECT clock_timestamp() AS at)
             UPDATE review_dispatch_jobs j
                SET lease_expires_at=db_time.at + ($3::double precision * interval '1 millisecond'),
                    updated_at=GREATEST(j.updated_at,db_time.at)
               FROM db_time,review_runs r
              WHERE j.review_run_id=$1
                AND j.claim_generation=$2
                AND j.dead_lettered_at IS NULL
                AND r.id=j.review_run_id
                AND r.state IN (${ACTIVE_DISPATCH_STATE_SQL})`,
            [reviewRunId, generation, leaseMillis],
          );
          return renewed.rowCount === 1;
        },
        release: async () => {
          if (released) return;
          released = true;
          try {
            await client.query(
              `SELECT pg_advisory_unlock(hashtextextended($1,0))`,
              [lockKey],
            );
          } finally {
            ownsLock = false;
            client.release();
          }
        },
      };

      return { kind: "owned", guard };
    } catch (error) {
      if (ownsLock) {
        await client
          .query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [lockKey])
          .catch(() => undefined);
      }
      client.release();
      throw error;
    }
  }

  public async complete(
    reviewRunId: string,
    generation: number,
  ): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM review_dispatch_jobs
        WHERE review_run_id=$1 AND claim_generation=$2 AND dead_lettered_at IS NULL`,
      [reviewRunId, generation],
    );
    if (result.rowCount !== 1) throw new StaleReviewDispatchClaim();
  }

  /** Coordination deferral does not burn the execution-attempt budget. */
  public async defer(
    reviewRunId: string,
    generation: number,
    delayMillis: number,
  ): Promise<void> {
    requireNonNegativeInteger("delayMillis", delayMillis);
    const result = await this.pool.query(
      `WITH db_time AS MATERIALIZED (SELECT clock_timestamp() AS at)
       UPDATE review_dispatch_jobs j
          SET available_at=db_time.at + ($3::double precision * interval '1 millisecond'),
              lease_expires_at=NULL,
              attempts=GREATEST(j.attempts-1,0),
              claim_generation=j.claim_generation+1,
              updated_at=GREATEST(j.updated_at,db_time.at)
         FROM db_time
        WHERE j.review_run_id=$1
          AND j.claim_generation=$2
          AND j.dead_lettered_at IS NULL`,
      [reviewRunId, generation, delayMillis],
    );
    if (result.rowCount !== 1) throw new StaleReviewDispatchClaim();
  }

  public async release(
    reviewRunId: string,
    generation: number,
    delayMillis: number,
    errorCode: string,
  ): Promise<void> {
    requireNonNegativeInteger("delayMillis", delayMillis);
    await this.inTransaction(async (client) => {
      // Production callers hold the session advisory execution guard while this
      // transaction settles the claim, so cancellation cannot enter concurrently.
      // Within durable rows, keep the order run first, dispatch row second.
      await client.query(`SELECT id FROM review_runs WHERE id=$1 FOR UPDATE`, [
        reviewRunId,
      ]);
      const current = await client.query<{
        attempts: number;
        max_attempts: number;
      }>(
        `SELECT attempts,max_attempts
           FROM review_dispatch_jobs
          WHERE review_run_id=$1 AND claim_generation=$2 AND dead_lettered_at IS NULL
          FOR UPDATE`,
        [reviewRunId, generation],
      );
      const row = current.rows[0];
      if (row === undefined) throw new StaleReviewDispatchClaim();
      if (row.attempts >= row.max_attempts) {
        await this.deadLetterWithClient(
          client,
          reviewRunId,
          generation,
          errorCode,
        );
        return;
      }

      const released = await client.query(
        `WITH db_time AS MATERIALIZED (SELECT clock_timestamp() AS at)
         UPDATE review_dispatch_jobs j
            SET available_at=db_time.at + ($3::double precision * interval '1 millisecond'),
                lease_expires_at=NULL,
                claim_generation=j.claim_generation+1,
                last_error_code=$4,
                updated_at=GREATEST(j.updated_at,db_time.at)
           FROM db_time
          WHERE j.review_run_id=$1 AND j.claim_generation=$2 AND j.dead_lettered_at IS NULL`,
        [reviewRunId, generation, delayMillis, errorCode],
      );
      if (released.rowCount !== 1) throw new StaleReviewDispatchClaim();
    });
  }

  public async deadLetter(
    reviewRunId: string,
    generation: number,
    errorCode: string,
  ): Promise<void> {
    await this.inTransaction((client) =>
      this.deadLetterWithClient(client, reviewRunId, generation, errorCode),
    );
  }

  /**
   * Replays a dead-letter as a new domain attempt. A terminal run is never
   * revived in place: doing so would invalidate its transition history and let a
   * stale claimant become meaningful again. Concurrent replay requests converge
   * on the first newer attempt.
   */
  public async replayDeadLetter(
    reviewRunId: string,
    expectedGeneration: number,
  ): Promise<ReviewDispatchReplay> {
    return this.inTransaction(async (client) => {
      const source = await client.query<{
        organization_id: string;
        repository_id: string;
        request_id: string;
        revision_id: string;
        pull_request_id: string;
        attempt: number;
        execution_mode: string;
        execution_strategy: string;
      }>(
        `SELECT j.organization_id,r.repository_id,r.request_id,j.revision_id,
                j.pull_request_id,r.attempt,r.execution_mode,r.execution_strategy
           FROM review_dispatch_jobs j
           JOIN review_runs r ON r.id=j.review_run_id
          WHERE j.review_run_id=$1
            AND j.claim_generation=$2
            AND j.dead_lettered_at IS NOT NULL
          FOR UPDATE OF j,r`,
        [reviewRunId, expectedGeneration],
      );
      const row = source.rows[0];
      if (row === undefined) throw new StaleReviewDispatchClaim();

      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [`acalys:api-review-dispatch-replay:${row.request_id}`],
      );

      const latest = await client.query<{ id: string; attempt: number }>(
        `SELECT id,attempt
           FROM review_runs
          WHERE request_id=$1
          ORDER BY attempt DESC
          LIMIT 1
          FOR UPDATE`,
        [row.request_id],
      );
      const newest = latest.rows[0];
      if (newest !== undefined && newest.attempt > row.attempt) {
        return {
          kind: "existing",
          reviewRunId: newest.id,
          attempt: newest.attempt,
        };
      }

      const newRunId = randomUUID();
      const newAttempt = row.attempt + 1;
      const inserted = await client.query<{ created_at: Date }>(
        `WITH db_time AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO review_runs
           (id,organization_id,repository_id,request_id,revision_id,attempt,state,
            execution_mode,execution_strategy,created_at)
         SELECT $1,$2,$3,$4,$5,$6,'queued',$7,$8,db_time.at
           FROM db_time
         RETURNING created_at`,
        [
          newRunId,
          row.organization_id,
          row.repository_id,
          row.request_id,
          row.revision_id,
          newAttempt,
          row.execution_mode,
          row.execution_strategy,
        ],
      );
      const createdAt = inserted.rows[0]?.created_at;
      if (!(createdAt instanceof Date)) {
        throw new Error(
          "Dead-letter replay did not return a database timestamp",
        );
      }

      await client.query(
        `INSERT INTO review_dispatch_jobs
          (review_run_id,organization_id,revision_id,pull_request_id,
           available_at,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$5,$5)`,
        [
          newRunId,
          row.organization_id,
          row.revision_id,
          row.pull_request_id,
          createdAt,
        ],
      );
      return { kind: "replayed", reviewRunId: newRunId, attempt: newAttempt };
    });
  }

  private async deadLetterWithClient(
    client: PgClient,
    reviewRunId: string,
    generation: number,
    errorCode: string,
  ): Promise<void> {
    // Production callers hold the session advisory execution guard. `release()`
    // may already hold this run row; reacquiring the same row lock in one
    // transaction is harmless. Durable-row ordering remains run then job.
    const run = await client.query<{
      state: string;
      created_at: Date;
      started_at: Date | null;
    }>(
      `SELECT state,created_at,started_at FROM review_runs WHERE id=$1 FOR UPDATE`,
      [reviewRunId],
    );

    const claimed = await client.query<{ dead_lettered_at: Date }>(
      `WITH db_time AS MATERIALIZED (SELECT clock_timestamp() AS at)
       UPDATE review_dispatch_jobs j
          SET lease_expires_at=NULL,
              claim_generation=j.claim_generation+1,
              last_error_code=$3,
              dead_lettered_at=db_time.at,
              updated_at=GREATEST(j.updated_at,db_time.at)
         FROM db_time
        WHERE j.review_run_id=$1
          AND j.claim_generation=$2
          AND j.dead_lettered_at IS NULL
       RETURNING j.dead_lettered_at`,
      [reviewRunId, generation, errorCode],
    );
    const deadLetteredAt = claimed.rows[0]?.dead_lettered_at;
    if (!(deadLetteredAt instanceof Date)) throw new StaleReviewDispatchClaim();

    const state = run.rows[0]?.state;
    if (
      state !== undefined &&
      ACTIVE_DISPATCH_STATES.includes(
        state as (typeof ACTIVE_DISPATCH_STATES)[number],
      )
    ) {
      const updated = await client.query<{ completed_at: Date }>(
        `UPDATE review_runs
            SET state='failed',failure_code=$2,failure_retryability='non_retryable',
                completed_at=GREATEST($3::timestamptz,created_at,COALESCE(started_at,created_at))
          WHERE id=$1 AND state=$4
          RETURNING completed_at`,
        [reviewRunId, errorCode, deadLetteredAt, state],
      );
      const completedAt = updated.rows[0]?.completed_at;
      if (!(completedAt instanceof Date)) throw new StaleReviewDispatchClaim();

      const seq = await client.query<{ next_seq: number }>(
        `SELECT COALESCE(MAX(seq),0)+1 AS next_seq
           FROM review_run_transitions
          WHERE run_id=$1`,
        [reviewRunId],
      );
      await client.query(
        `INSERT INTO review_run_transitions(run_id,seq,from_state,to_state,at)
         VALUES($1,$2,$3,'failed',$4)`,
        [reviewRunId, seq.rows[0]?.next_seq ?? 1, state, completedAt],
      );
    }
  }
}
