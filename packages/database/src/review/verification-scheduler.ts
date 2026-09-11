/**
 * Who is allowed to say "this is attempt 2".
 *
 * 0006 made the attempt ordinal *supplied* rather than computed, and gave the
 * right reason: `MAX(attempt) + 1` in a worker is a race, and losing that race
 * masquerades as a redelivery — which is the one distinction the invocation id
 * exists to protect. But "supplied by the caller" is not an authority. It moves
 * the decision somewhere with no durable record of having made it, so two
 * schedulers can still originate the same ordinal and the database learns about
 * it as a unique violation.
 *
 * A unique violation is contention. Retry-versus-redelivery is domain meaning.
 * Reading the second off the first is the bug this module exists to remove:
 *
 * ```
 * INSERT … ON CONFLICT DO NOTHING → 0 rows
 *     "someone else got there first"        ← contention, all we actually know
 *     "therefore this is a redelivery"      ← a guess, and wrong half the time
 * ```
 *
 * # How allocation is made safe
 *
 * The transaction takes a row lock on the **candidate** before it reads
 * anything. Every scheduler for that candidate is then serial, so:
 *
 * ```
 * lock candidate C
 * look up request_key            → present?  redelivery. Return what exists.
 *                                → absent?   a genuinely new request.
 * MAX(attempt) + 1               → safe, because nobody else can be here
 * INSERT the invocation
 * ```
 *
 * `MAX(attempt) + 1` is correct *here* and nowhere else. The difference is not
 * the arithmetic, it is that the read and the write happen under a lock held to
 * commit. Contention blocks; it never decides.
 *
 * The unique indexes on `(candidate_finding_id, attempt)` and `(request_key)`
 * stay, and should never fire. They are the assertion that this reasoning
 * holds, not the mechanism that makes it hold.
 *
 * # Why the command is durable at all
 *
 * A verification that is merely "about to happen" in a worker's memory is lost
 * when the worker dies, and the candidate is then owed a verification nobody
 * knows about. A scheduled row is recoverable by any worker, which is the same
 * property `publishing` has in the run lifecycle and for the same reason: the
 * obligation must outlive the process that created it.
 *
 * `scheduled` therefore does **not** mean a worker is alive.
 */

import { randomUUID } from "node:crypto";

import type { PgClient, PgPool } from "../webhook/postgres-inbox.js";

/** Why a verification attempt was asked for. */
export const INVOCATION_REASONS = [
  /** The candidate's first verification. */
  "initial",
  /** A previous attempt could not run. Never used after a *decision*. */
  "retry_unavailable",
  /** A human deliberately re-verifying, typically after fixing the verifier. */
  "operator_reverify",
] as const;

export type InvocationReason = (typeof INVOCATION_REASONS)[number];

export interface ScheduleRequest {
  readonly organizationId: string;
  readonly reviewRunId: string;
  readonly candidateFindingId: string;
  /**
   * What is being asked for, in domain terms.
   *
   * The redelivery discriminator. "The first verification pass of candidate C
   * in run R" is one request however many times a queue delivers it, so the key
   * must be derivable from the domain and must **not** contain a delivery id, a
   * job id, a worker id or a timestamp — anything that changes per delivery
   * makes every redelivery look like a new attempt.
   */
  readonly requestKey: string;
  readonly reason: InvocationReason;
}

export interface ScheduledInvocation {
  /** The invocation id the attempt will carry. Minted before the verifier runs. */
  readonly invocationId: string;
  readonly candidateFindingId: string;
  readonly reviewRunId: string;
  readonly attempt: number;
  readonly reason: InvocationReason;
  readonly state: "scheduled" | "claimed" | "settled";
  /**
   * True when this call allocated the ordinal.
   *
   * False means the request already existed — a redelivery. Reported as a fact
   * the scheduler knows, not inferred from a failed insert.
   */
  readonly allocated: boolean;
}

export interface VerificationClaim {
  readonly invocationId: string;
  readonly candidateFindingId: string;
  readonly reviewRunId: string;
  readonly attempt: number;
  readonly reason: InvocationReason;
  readonly claimToken: string;
  readonly claimGeneration: number;
  readonly claimExpiresAt: string;
}

export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly claim: VerificationClaim }
  | { readonly kind: "busy"; readonly claimExpiresAt: string }
  | { readonly kind: "settled" };

/**
 * A worker presented ownership that is no longer current.
 *
 * This is fencing, not a retry hint. Once generation N+1 owns an invocation,
 * generation N can no longer persist or settle it even if its external model
 * call eventually returns.
 */
export class StaleVerificationClaim extends Error {
  public constructor(public readonly invocationId: string) {
    super(`Verification invocation ${invocationId} is no longer owned by this claim.`);
    this.name = "StaleVerificationClaim";
  }
}

/**
 * A request key was reused for a different candidate.
 *
 * Not contention and not a redelivery: a key that means two different things
 * has stopped being an identity, and the convergence it is supposed to provide
 * would silently attach one candidate's verification to another's.
 */
export class InvocationKeyConflict extends Error {
  public constructor(
    public readonly requestKey: string,
    public readonly existingCandidateId: string,
    public readonly requestedCandidateId: string,
  ) {
    super(
      `Request key \`${requestKey}\` already identifies a verification of candidate ` +
        `${existingCandidateId}; it cannot also identify one of ${requestedCandidateId}.`,
    );
    this.name = "InvocationKeyConflict";
  }
}

interface InvocationRow {
  id: string;
  candidate_finding_id: string;
  review_run_id: string;
  attempt: number;
  reason: InvocationReason;
  state: "scheduled" | "claimed" | "settled";
  claim_token?: string | null;
  claim_generation?: string | number;
  claim_expires_at?: string | Date | null;
}

function toInvocation(
  row: InvocationRow,
  allocated: boolean,
): ScheduledInvocation {
  return {
    invocationId: row.id,
    candidateFindingId: row.candidate_finding_id,
    reviewRunId: row.review_run_id,
    attempt: row.attempt,
    reason: row.reason,
    state: row.state,
    allocated,
  };
}

export class VerificationScheduler {
  readonly #pool: PgPool;
  readonly #now: () => Date;

  public constructor(pool: PgPool, now: () => Date = () => new Date()) {
    this.#pool = pool;
    this.#now = now;
  }

  /**
   * Allocates — or recovers — the command for one verification.
   *
   * Idempotent on `requestKey`, and the idempotency is decided by a read under
   * a lock rather than by a write that might fail.
   */
  public async schedule(
    request: ScheduleRequest,
  ): Promise<ScheduledInvocation> {
    return this.#inTransaction(async (client) => {
      // The allocation lock. Taken first, before anything is read, so every
      // scheduler for this candidate is serial from here to commit.
      //
      // On the candidate rather than on the invocations table: the ordinal is
      // per candidate, so that is the scope that must be serialized. Locking
      // the whole table would serialize unrelated candidates; locking nothing
      // is what made `MAX(attempt) + 1` a race in the first place.
      const candidate = await client.query<{ id: string }>(
        "SELECT id FROM candidate_findings WHERE id = $1 FOR UPDATE",
        [request.candidateFindingId],
      );
      if (candidate.rows[0] === undefined) {
        throw new Error(
          `Cannot schedule verification for candidate ${request.candidateFindingId}: no such candidate. ` +
            "A verification command must be traceable to the claim it examines.",
        );
      }

      const existing = await client.query<InvocationRow>(
        `SELECT id, candidate_finding_id, review_run_id, attempt, reason, state
           FROM verification_invocations
          WHERE request_key = $1`,
        [request.requestKey],
      );

      const found = existing.rows[0];
      if (found !== undefined) {
        if (found.candidate_finding_id !== request.candidateFindingId) {
          throw new InvocationKeyConflict(
            request.requestKey,
            found.candidate_finding_id,
            request.candidateFindingId,
          );
        }
        // A redelivery. Reported as one because the row says so.
        return toInvocation(found, false);
      }

      const next = await client.query<{ attempt: number }>(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
           FROM verification_invocations
          WHERE candidate_finding_id = $1`,
        [request.candidateFindingId],
      );
      const attempt = next.rows[0]?.attempt ?? 1;

      const inserted = await client.query<InvocationRow>(
        `INSERT INTO verification_invocations (
           id, organization_id, review_run_id, candidate_finding_id,
           attempt, request_key, reason, state, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled',$8)
         RETURNING id, candidate_finding_id, review_run_id, attempt, reason, state`,
        [
          randomUUID(),
          request.organizationId,
          request.reviewRunId,
          request.candidateFindingId,
          attempt,
          request.requestKey,
          request.reason,
          this.#now(),
        ],
      );

      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("verification invocation was not persisted");
      }
      return toInvocation(row, true);
    });
  }

  /**
   * Claims the expensive execution step.
   *
   * Lease time comes from PostgreSQL, not a worker clock. A process with a
   * skewed clock therefore cannot steal or retain ownership. Before claiming,
   * a durable attempt left by a crash-after-write is converted to `settled`;
   * recovery never re-executes work whose result already exists.
   */
  public async claim(
    invocationId: string,
    claimedBy: string,
    leaseMillis: number,
  ): Promise<ClaimOutcome> {
    if (!Number.isInteger(leaseMillis) || leaseMillis < 1_000) {
      throw new RangeError("verification lease must be at least 1000ms");
    }

    return this.#inTransaction(async (client) => {
      await client.query(
        `UPDATE verification_invocations AS i
            SET state = 'settled', settled_at = clock_timestamp()
          WHERE i.id = $1
            AND i.state <> 'settled'
            AND EXISTS (
              SELECT 1 FROM verification_attempts a
               WHERE a.invocation_id = i.id
            )`,
        [invocationId],
      );

      const token = randomUUID();
      const claimed = await client.query<InvocationRow>(
        `UPDATE verification_invocations
            SET state = 'claimed',
                claim_token = $2,
                claim_generation = claim_generation + 1,
                claimed_by = $3,
                claimed_at = clock_timestamp(),
                claim_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'),
                settled_at = NULL
          WHERE id = $1
            AND (
              state = 'scheduled'
              OR (state = 'claimed' AND claim_expires_at <= clock_timestamp())
            )
          RETURNING id, candidate_finding_id, review_run_id, attempt, reason, state,
                    claim_token, claim_generation, claim_expires_at`,
        [invocationId, token, claimedBy, leaseMillis],
      );

      const row = claimed.rows[0];
      if (row !== undefined) {
        if (row.claim_token === null || row.claim_token === undefined ||
            row.claim_expires_at === null || row.claim_expires_at === undefined) {
          throw new Error("claimed verification invocation has no lease identity");
        }
        return {
          kind: "claimed",
          claim: {
            invocationId: row.id,
            candidateFindingId: row.candidate_finding_id,
            reviewRunId: row.review_run_id,
            attempt: row.attempt,
            reason: row.reason,
            claimToken: row.claim_token,
            claimGeneration: Number(row.claim_generation),
            claimExpiresAt:
              row.claim_expires_at instanceof Date
                ? row.claim_expires_at.toISOString()
                : row.claim_expires_at,
          },
        };
      }

      const current = await client.query<InvocationRow>(
        `SELECT id, candidate_finding_id, review_run_id, attempt, reason, state,
                claim_token, claim_generation, claim_expires_at
           FROM verification_invocations
          WHERE id = $1`,
        [invocationId],
      );
      const found = current.rows[0];
      if (found === undefined) {
        throw new Error(`Verification invocation ${invocationId} does not exist.`);
      }
      if (found.state === "settled") return { kind: "settled" };
      if (found.claim_expires_at === null || found.claim_expires_at === undefined) {
        throw new Error("claimed verification invocation has no expiry");
      }
      return {
        kind: "busy",
        claimExpiresAt:
          found.claim_expires_at instanceof Date
            ? found.claim_expires_at.toISOString()
            : found.claim_expires_at,
      };
    });
  }

  /** Extend a live claim without changing its fencing identity. */
  public async renew(
    invocationId: string,
    claimToken: string,
    claimGeneration: number,
    leaseMillis: number,
  ): Promise<void> {
    const updated = await this.#inTransaction((client) =>
      client.query<{ id: string }>(
        `UPDATE verification_invocations
            SET claim_expires_at = clock_timestamp() + ($4 * interval '1 millisecond')
          WHERE id = $1 AND state = 'claimed'
            AND claim_token = $2 AND claim_generation = $3
            AND claim_expires_at > clock_timestamp()
          RETURNING id`,
        [invocationId, claimToken, claimGeneration, leaseMillis],
      ),
    );
    if (updated.rows[0] === undefined) {
      throw new StaleVerificationClaim(invocationId);
    }
  }

  /**
   * Marks a command discharged.
   *
   * Separate from writing the attempt, and deliberately *after* it: a command
   * settled before its result is durable would let a crash lose the attempt
   * while the command claims to be done, and nothing would reschedule it.
   */
  public async settle(
    invocationId: string,
    claimToken: string,
    claimGeneration: number,
  ): Promise<void> {
    await this.#inTransaction(async (client) => {
      const result = await client.query<{ state: string }>(
        `UPDATE verification_invocations
            SET state = 'settled', settled_at = $4
          WHERE id = $1
            AND claim_token = $2 AND claim_generation = $3
            AND state IN ('claimed', 'settled')
          RETURNING state`,
        [invocationId, claimToken, claimGeneration, this.#now()],
      );
      if (result.rows[0] === undefined) {
        throw new StaleVerificationClaim(invocationId);
      }
    });
  }

  /** Commands a crashed worker left behind. The recovery queue. */
  public async scheduledFor(
    reviewRunId: string,
  ): Promise<readonly ScheduledInvocation[]> {
    return this.#inTransaction(async (client) => {
      const result = await client.query<InvocationRow>(
        `SELECT id, candidate_finding_id, review_run_id, attempt, reason, state
           FROM verification_invocations
          WHERE review_run_id = $1
            AND (state = 'scheduled'
                 OR (state = 'claimed' AND claim_expires_at <= clock_timestamp()))
          ORDER BY candidate_finding_id, attempt`,
        [reviewRunId],
      );
      return result.rows.map((row) => toInvocation(row, false));
    });
  }

  /** Every command for a candidate, oldest first. The audit trail. */
  public async invocationsFor(
    candidateFindingId: string,
  ): Promise<readonly ScheduledInvocation[]> {
    return this.#inTransaction(async (client) => {
      const result = await client.query<InvocationRow>(
        `SELECT id, candidate_finding_id, review_run_id, attempt, reason, state
           FROM verification_invocations
          WHERE candidate_finding_id = $1
          ORDER BY attempt`,
        [candidateFindingId],
      );
      return result.rows.map((row) => toInvocation(row, false));
    });
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
}
