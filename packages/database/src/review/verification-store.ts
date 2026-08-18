/**
 * Persisting verification, and promoting what it established.
 *
 * Two operations, deliberately in that order and deliberately not in one
 * transaction:
 *
 * ```
 * 1  record the attempt          idempotent on invocation id
 * 2  if verified: promote + plan  one transaction
 * ```
 *
 * The split is the point. A verification that executed successfully must not
 * disappear because promotion or policy evaluation failed after it — the
 * verifier may be the expensive part of the pipeline, and re-running it because
 * an INSERT downstream failed is how a retry storm becomes a bill. On retry the
 * worker reads the attempt it already wrote and resumes from promotion.
 *
 * # Redelivery is not a retry
 *
 * An at-least-once worker delivering the same work twice, and an operator
 * deliberately re-verifying after fixing the verifier, are different events
 * that must produce different data:
 *
 * ```
 * candidate
 *   ├── attempt 1  [invocation A]
 *   │     ├── first delivery   → INSERT
 *   │     └── redelivery       → same A, converges on the existing row
 *   └── attempt 2  [invocation B]
 *         └── the verifier genuinely ran again
 * ```
 *
 * So the invocation id is minted by the caller *before* the verifier runs, and
 * the attempt ordinal is supplied rather than computed. `MAX(attempt) + 1` is a
 * race even behind a unique index, and losing that race would masquerade as a
 * redelivery — which is the one thing this distinction exists to prevent.
 */

import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";

type PgClient = Pool | PoolClient;

export interface AttemptRecord {
  readonly invocationId: string;
  readonly attempt: number;
  readonly candidateFindingId: string;
  readonly reviewRunId: string;
  readonly organizationId: string;
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly contextDigest: string;
  readonly cacheKey: string;
  readonly outcome:
    | {
        readonly status: "completed";
        readonly decision: "verified" | "rejected" | "inconclusive";
        readonly reasons: readonly string[];
        readonly confidence: number;
        readonly severity: string;
      }
    | { readonly status: "unavailable"; readonly failure: string };
}

export interface StoredAttempt {
  readonly id: string;
  readonly invocationId: string;
  readonly attempt: number;
  readonly status: string;
  readonly decision: string | null;
  readonly reasons: readonly string[];
  readonly failure: string | null;
  /** True when this call wrote the row, false when it converged on an existing one. */
  readonly inserted: boolean;
}

export interface PromotionRecord {
  readonly reviewRunId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly verificationAttemptId: string;
  readonly revisionId: string;
  readonly fingerprintValue: string;
  readonly severity: string;
  readonly category: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly claim: string;
  readonly explanation: string;
}

export class VerificationStore {
  readonly #pool: Pool;
  readonly #now: () => Date;

  public constructor(pool: Pool, now: () => Date = () => new Date()) {
    this.#pool = pool;
    this.#now = now;
  }

  /**
   * Records an attempt, converging on the existing row for a redelivery.
   *
   * `ON CONFLICT (invocation_id) DO UPDATE` rather than `DO NOTHING`, so the
   * row comes back either way and the caller can proceed without a second
   * round trip — and so `xmax = 0` can distinguish the insert from the
   * convergence, which is what makes "did I already do this?" answerable.
   */
  public async recordAttempt(record: AttemptRecord): Promise<StoredAttempt> {
    const outcome = record.outcome;
    const result = await this.#pool.query<{
      id: string;
      invocation_id: string;
      attempt: number;
      status: string;
      decision: string | null;
      reasons: string[];
      failure: string | null;
      inserted: boolean;
    }>(
      `INSERT INTO verification_attempts (
         id, organization_id, review_run_id, candidate_finding_id,
         status, decision, reasons, confidence, severity, failure,
         verifier_id, verifier_version, context_digest, cache_key,
         invocation_id, attempt, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (invocation_id)
         DO UPDATE SET invocation_id = verification_attempts.invocation_id
       RETURNING id, invocation_id, attempt, status, decision, reasons, failure,
                 (xmax = 0) AS inserted`,
      [
        randomUUID(),
        record.organizationId,
        record.reviewRunId,
        record.candidateFindingId,
        outcome.status,
        outcome.status === "completed" ? outcome.decision : null,
        outcome.status === "completed" ? [...outcome.reasons] : [],
        outcome.status === "completed" ? outcome.confidence : null,
        outcome.status === "completed" ? outcome.severity : null,
        outcome.status === "unavailable" ? outcome.failure : null,
        record.verifierId,
        record.verifierVersion,
        record.contextDigest,
        record.cacheKey,
        record.invocationId,
        record.attempt,
        this.#now(),
      ],
    );

    const row = result.rows[0];
    if (row === undefined)
      throw new Error("verification attempt was not persisted");

    return {
      id: row.id,
      invocationId: row.invocation_id,
      attempt: row.attempt,
      status: row.status,
      decision: row.decision,
      reasons: row.reasons,
      failure: row.failure,
      inserted: row.inserted,
    };
  }

  /** Every attempt for a candidate, oldest first. The audit trail. */
  public async attemptsFor(
    candidateFindingId: string,
  ): Promise<readonly StoredAttempt[]> {
    const result = await this.#pool.query<{
      id: string;
      invocation_id: string;
      attempt: number;
      status: string;
      decision: string | null;
      reasons: string[];
      failure: string | null;
    }>(
      `SELECT id, invocation_id, attempt, status, decision, reasons, failure
         FROM verification_attempts
        WHERE candidate_finding_id = $1
        ORDER BY attempt`,
      [candidateFindingId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      invocationId: row.invocation_id,
      attempt: row.attempt,
      status: row.status,
      decision: row.decision,
      reasons: row.reasons,
      failure: row.failure,
      inserted: false,
    }));
  }

  /**
   * Promotes a verified candidate, converging on the existing finding.
   *
   * The collapse is enforced by `UNIQUE (review_run_id, fingerprint_value)`
   * and `ON CONFLICT`, not by reading first and inserting after — a
   * lookup-then-insert is a race that two concurrent workers lose together,
   * and the symptom is two comments about one defect.
   *
   * Refuses to promote anything the attempt did not verify. Belt and braces
   * with the kernel's promotion gate: this is the last place the guarantee can
   * be enforced, and it is the one an ad-hoc script would go through.
   */
  public async promote(record: PromotionRecord): Promise<{ id: string }> {
    return this.#inTransaction(async (client) => {
      const attempt = await client.query<{ decision: string | null }>(
        "SELECT decision FROM verification_attempts WHERE id = $1",
        [record.verificationAttemptId],
      );

      if (attempt.rows[0]?.decision !== "verified") {
        throw new Error(
          "Refusing to promote: the referenced verification did not verify the claim. " +
            "Promotion is the only path from a candidate to a product finding, and " +
            "`verified` is necessary for it.",
        );
      }

      const now = this.#now();
      const result = await client.query<{ id: string }>(
        `INSERT INTO review_findings (
           id, organization_id, repository_id, review_run_id, revision_id,
           title, explanation, category, severity,
           confidence_score, confidence_level,
           path, start_line, end_line, fingerprint_value, state,
           verification_attempt_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'published',$16,$17,$17)
         ON CONFLICT (review_run_id, fingerprint_value)
           DO UPDATE SET updated_at = review_findings.updated_at
         RETURNING id`,
        [
          randomUUID(),
          record.organizationId,
          record.repositoryId,
          record.reviewRunId,
          record.revisionId,
          record.title,
          // The claim and the causal chain travel together in `explanation`:
          // the schema has one prose column, and splitting the reader's
          // narrative across two would mean neither is complete on its own.
          `${record.claim}\n\n${record.explanation}`,
          record.category,
          record.severity,
          0.9,
          "high",
          record.path,
          record.startLine,
          record.endLine,
          record.fingerprintValue,
          record.verificationAttemptId,
          now,
        ],
      );

      const id = result.rows[0]?.id;
      if (id === undefined)
        throw new Error("promotion did not return a finding");
      return { id };
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
