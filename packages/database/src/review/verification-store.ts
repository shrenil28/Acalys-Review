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
 * So the invocation id is minted *before* the verifier runs, and the attempt
 * ordinal comes with it. Neither is chosen here: both are allocated by
 * `VerificationScheduler` against a durable `verification_invocations` row, and
 * migration 0007 makes that structural — the composite foreign key
 * `(invocation_id, candidate_finding_id, attempt)` means this store physically
 * cannot write an attempt whose identity no scheduler allocated.
 *
 * The earlier design had the ordinal "supplied by the caller", which fixed the
 * `MAX(attempt) + 1` race by moving it somewhere with no durable record of the
 * decision. Two schedulers could still originate the same ordinal, and the
 * database would report it as a unique violation — contention arriving where a
 * domain answer was needed.
 *
 * # What promotion writes, and what it deliberately does not
 *
 * A promoted finding is `verified`, never `published`. Promotion establishes
 * that the defect is **real**; publication policy separately decides whether a
 * developer should be interrupted about it, and the publisher separately
 * confirms the provider actually holds the comment. Writing `published` here
 * would collapse all three, and `verified → published` would become automatic
 * in the one place the product promises it is not.
 */

import { randomUUID } from "node:crypto";

import type { PgClient, PgPool } from "../webhook/postgres-inbox.js";

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

/** A candidate and its latest attempt, as reconciliation needs them. */
export interface ReconciliationRow {
  readonly candidateId: string;
  readonly fingerprintValue: string;
  readonly proposedSeverity: string;
  readonly category: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly claim: string;
  readonly explanation: string;
  /** Null when nothing has examined this candidate. */
  readonly attemptId: string | null;
  readonly status: string | null;
  readonly decision: string | null;
  readonly reasons: readonly string[];
  readonly confidence: number | null;
  readonly severity: string | null;
  readonly failure: string | null;
}

/**
 * One invocation was presented as two different attempts.
 *
 * Not contention and not a redelivery. The invocation id and the ordinal are
 * allocated together by the scheduler, so a pair that disagrees means a caller
 * assembled an identity rather than carrying one — and the convergence it would
 * silently receive is an attempt it did not describe.
 */
export class AttemptIdentityConflict extends Error {
  public constructor(
    public readonly invocationId: string,
    public readonly stored: number,
    public readonly requested: number,
  ) {
    super(
      `Invocation ${invocationId} is attempt ${String(stored)}, but was presented as ` +
        `attempt ${String(requested)}. The ordinal is allocated with the invocation; ` +
        "a pair that disagrees was assembled rather than carried.",
    );
    this.name = "AttemptIdentityConflict";
  }
}

export class VerificationStore {
  readonly #pool: PgPool;
  readonly #now: () => Date;

  public constructor(pool: PgPool, now: () => Date = () => new Date()) {
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
  public async recordAttempt(
    record: AttemptRecord,
    client?: PgClient,
  ): Promise<StoredAttempt> {
    return client === undefined
      ? this.#inTransaction((owned) => this.#recordAttempt(record, owned))
      : this.#recordAttempt(record, client);
  }

  async #recordAttempt(
    record: AttemptRecord,
    client: PgClient,
  ): Promise<StoredAttempt> {
    const outcome = record.outcome;
    const result = await client.query<{
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

    // The convergence path returns the STORED row, so what comes back may
    // disagree with what was asked for. `ON CONFLICT (invocation_id)` matches
    // on the invocation alone, which means a redelivery carrying a different
    // ordinal is silently accepted and the caller is handed a row that is not
    // the one it described.
    //
    // The composite foreign key cannot catch this: on the conflict path no
    // insert happens, so nothing is checked. This is the same shape as the
    // publication ledger's digest check that a previous checkpoint found was
    // described in a comment and performed by no code.
    if (row.attempt !== record.attempt) {
      throw new AttemptIdentityConflict(
        record.invocationId,
        row.attempt,
        record.attempt,
      );
    }

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
    return this.#inTransaction(async (client) => {
      const result = await client.query<{
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
    });
  }

  /**
   * Every candidate of a run, paired with its most recent attempt.
   *
   * The *most recent*, not the first. "Verifier v4 rejected it, v5 verified it
   * after a bug fix" is the history the attempts table exists to keep, and a
   * reconciliation that read the earliest attempt would act on the answer that
   * was already known to be wrong.
   *
   * `LEFT JOIN`, so a candidate with no attempt at all comes back with a null
   * attempt rather than vanishing from the result. A candidate that silently
   * disappeared here would be promoted by nobody and blocked by nobody — it
   * would simply cease to be part of the review, which is the failure mode
   * hardest to notice from the outside.
   */
  public async readForReconciliation(
    reviewRunId: string,
  ): Promise<readonly ReconciliationRow[]> {
    return this.#inTransaction(async (client) => {
      const result = await client.query<{
        candidate_id: string;
        fingerprint_value: string;
        proposed_severity: string;
        category: string;
        path: string;
        start_line: number;
        end_line: number;
        title: string;
        claim: string;
        explanation: string;
        attempt_id: string | null;
        status: string | null;
        decision: string | null;
        reasons: string[] | null;
        confidence: string | null;
        severity: string | null;
        failure: string | null;
      }>(
        `SELECT c.id AS candidate_id, c.fingerprint_value, c.proposed_severity,
                c.category, c.path, c.start_line, c.end_line,
                c.title, c.claim, c.explanation,
                v.id AS attempt_id, v.status, v.decision, v.reasons,
                v.confidence, v.severity, v.failure
           FROM candidate_findings c
           LEFT JOIN LATERAL (
             SELECT a.id, a.status, a.decision, a.reasons, a.confidence,
                    a.severity, a.failure
               FROM verification_attempts a
              WHERE a.candidate_finding_id = c.id
              ORDER BY a.attempt DESC
              LIMIT 1
           ) v ON TRUE
          WHERE c.review_run_id = $1
          ORDER BY c.fingerprint_value`,
        [reviewRunId],
      );

      return result.rows.map((row) => ({
        candidateId: row.candidate_id,
        fingerprintValue: row.fingerprint_value,
        proposedSeverity: row.proposed_severity,
        category: row.category,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        title: row.title,
        claim: row.claim,
        explanation: row.explanation,
        attemptId: row.attempt_id,
        status: row.status,
        decision: row.decision,
        reasons: row.reasons ?? [],
        confidence: row.confidence === null ? null : Number(row.confidence),
        severity: row.severity,
        failure: row.failure,
      }));
    });
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
   *
   * The finding is written `verified`, not `published`. See the module header:
   * being real and being worth interrupting someone about are different
   * decisions, and only the first has been made here.
   */
  public async promote(
    record: PromotionRecord,
    client?: PgClient,
  ): Promise<{ id: string }> {
    return client === undefined
      ? this.#inTransaction((owned) => this.#promote(record, owned))
      : this.#promote(record, client);
  }

  async #promote(
    record: PromotionRecord,
    client: PgClient,
  ): Promise<{ id: string }> {
    {
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
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'verified',$16,$17,$17)
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
    }
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
