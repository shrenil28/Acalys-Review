/**
 * The publication ledger's operations.
 *
 * Every method here exists because P1-E.3 measured a specific provider
 * behaviour. The evidence is in `docs/review/phase-1/e3-experiment.md`; the
 * short version is the only thing that matters at this layer:
 *
 * > GitHub refuses a second PENDING review (422). It places no constraint at
 * > all once a review has been submitted.
 *
 * So the provider protects one window and not the other, and the ledger is what
 * protects the second. Two rules follow, and both are enforced here rather than
 * left to a caller to remember:
 *
 * 1. **Reconcile before creating.** An attempt on a row that has ever been
 *    ambiguous must be preceded by a provider lookup. `beginAttempt` refuses to
 *    move `unknown → attempting` without one.
 * 2. **`published` requires evidence.** Not a 2xx — an *observation* of the
 *    effect in provider state. The column and the CHECK constraint say so; this
 *    module cannot write the state without the reference and the timestamp.
 *
 * Every state change is a compare-and-swap validated against the frozen table
 * in `publication-state.ts`. A bare CAS is not enough on its own: a caller
 * holding a correct expected state can still ask for a move that is not legal,
 * which is the defect an earlier review caught in the ReviewRun store.
 */

import type { Pool } from "pg";

import {
  canTransitionPublication,
  type PublicationState,
} from "./publication-state.js";

/** A ledger row, as the publisher needs to see it. */
export interface PublicationIntent {
  readonly id: string;
  readonly organizationId: string;
  readonly reviewRunId: string;
  readonly provider: string;
  readonly kind: string;
  readonly logicalKey: string;
  readonly contentDigest: string;
  readonly state: PublicationState;
  readonly providerReference: string | null;
  readonly providerNodeId: string | null;
  readonly providerCommitId: string | null;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorClass: string | null;
  readonly confirmedAt: Date | null;
  readonly reconciledAt: Date | null;
  readonly nextAttemptAt: Date | null;
}

/**
 * What was observed in provider state.
 *
 * Three fields rather than one, because GitHub returns three distinct facts and
 * they answer different questions: the numeric id is the handle for submitting,
 * the node id is the stable global identity, and the commit id is the revision
 * the effect is anchored to — which is what content verification has to be
 * relative to.
 */
export interface ProviderObservation {
  readonly reference: string;
  readonly nodeId?: string | undefined;
  readonly commitId?: string | undefined;
}

/** Why an attempt did not succeed, and whether trying again can help. */
export type AttemptFailure =
  | {
      readonly kind: "retryable";
      readonly code: string;
      readonly retryAt: Date;
    }
  | { readonly kind: "permanent"; readonly code: string }
  /**
   * The dangerous one. A timeout or a dropped connection means the provider may
   * well have committed the effect; recording it as `failed` is how duplicate
   * reviews happen.
   */
  | { readonly kind: "ambiguous"; readonly code: string };

export type LedgerOutcome =
  | { readonly kind: "moved"; readonly state: PublicationState }
  /** Someone else moved the row first. The caller must re-read, not retry. */
  | {
      readonly kind: "refused";
      readonly actualState: PublicationState | undefined;
    }
  | {
      readonly kind: "illegal";
      readonly from: PublicationState;
      readonly to: PublicationState;
    }
  /**
   * `unknown → attempting` without a preceding provider lookup. Not a race and
   * not a programming slip in the usual sense: it is the exact shortcut that
   * publishes a duplicate, so it is refused with its own name.
   */
  | { readonly kind: "reconciliation_required" };

/**
 * The same logical publication was asked to carry different content.
 *
 * Thrown rather than returned. A caller that can handle this by branching has
 * already decided which content wins, and neither answer is safe: the effect
 * may already exist externally carrying the other one.
 */
export class PublicationContentConflict extends Error {
  public readonly logicalKey: string;
  public readonly storedDigest: string;
  public readonly intendedDigest: string;

  public constructor(
    logicalKey: string,
    storedDigest: string,
    intendedDigest: string,
  ) {
    super(
      `Publication ${logicalKey} already exists with a different content digest. ` +
        "A stable logical key with changed content is an invariant violation, " +
        "not a retry: the effect may already be visible externally carrying the " +
        "other content.",
    );
    this.name = "PublicationContentConflict";
    this.logicalKey = logicalKey;
    this.storedDigest = storedDigest;
    this.intendedDigest = intendedDigest;
  }
}

const COLUMNS = `
  id, organization_id, review_run_id, provider, kind, logical_key,
  content_digest, state, provider_reference, provider_node_id,
  provider_commit_id, attempts, last_error_code, last_error_class,
  confirmed_at, reconciled_at, next_attempt_at`;

interface Row {
  id: string;
  organization_id: string;
  review_run_id: string;
  provider: string;
  kind: string;
  logical_key: string;
  content_digest: string;
  state: PublicationState;
  provider_reference: string | null;
  provider_node_id: string | null;
  provider_commit_id: string | null;
  attempts: number;
  last_error_code: string | null;
  last_error_class: string | null;
  confirmed_at: Date | null;
  reconciled_at: Date | null;
  next_attempt_at: Date | null;
}

function toIntent(row: Row): PublicationIntent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    reviewRunId: row.review_run_id,
    provider: row.provider,
    kind: row.kind,
    logicalKey: row.logical_key,
    contentDigest: row.content_digest,
    state: row.state,
    providerReference: row.provider_reference,
    providerNodeId: row.provider_node_id,
    providerCommitId: row.provider_commit_id,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    lastErrorClass: row.last_error_class,
    confirmedAt: row.confirmed_at,
    reconciledAt: row.reconciled_at,
    nextAttemptAt: row.next_attempt_at,
  };
}

export class PublicationStore {
  readonly #pool: Pool;
  readonly #now: () => Date;

  public constructor(pool: Pool, now: () => Date = () => new Date()) {
    this.#pool = pool;
    this.#now = now;
  }

  public async get(id: string): Promise<PublicationIntent | undefined> {
    const result = await this.#pool.query<Row>(
      `SELECT ${COLUMNS} FROM publication_intents WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toIntent(row);
  }

  public async listForRun(
    runId: string,
  ): Promise<readonly PublicationIntent[]> {
    const result = await this.#pool.query<Row>(
      `SELECT ${COLUMNS} FROM publication_intents
        WHERE review_run_id = $1 ORDER BY logical_key`,
      [runId],
    );
    return result.rows.map(toIntent);
  }

  /**
   * Leases unsettled rows whose backoff has elapsed.
   *
   * `FOR UPDATE SKIP LOCKED` so two publisher workers take disjoint sets rather
   * than one blocking on the other. The lease is what makes a local race safe
   * locally — asking the provider to arbitrate would mean two workers racing to
   * create the same review, and the provider only refuses that while the review
   * is still pending.
   */
  public async claimDue(
    workerId: string,
    leaseSeconds: number,
    limit: number,
  ): Promise<readonly PublicationIntent[]> {
    const now = this.#now();
    const until = new Date(now.getTime() + leaseSeconds * 1_000);

    const result = await this.#pool.query<Row>(
      `UPDATE publication_intents SET claimed_by = $1, claimed_until = $2, updated_at = $3
        WHERE id IN (
          SELECT id FROM publication_intents
           WHERE state IN ('planned', 'attempting', 'unknown')
             AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
             AND (claimed_until IS NULL OR claimed_until <= $3)
           ORDER BY created_at
           LIMIT $4
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${COLUMNS}`,
      [workerId, until, now, limit],
    );
    return result.rows.map(toIntent);
  }

  /**
   * Records that provider state was enumerated for this row.
   *
   * Deliberately separate from acting on what was found. The timestamp is the
   * evidence that a lookup happened at all, which is what `beginAttempt` checks
   * before letting an ambiguous row be retried — "we retried after looking" and
   * "we retried blindly" have to be distinguishable in the data, not inferred
   * from an incident review.
   */
  public async recordReconciliation(id: string): Promise<void> {
    const now = this.#now();
    await this.#pool.query(
      "UPDATE publication_intents SET reconciled_at = $2, updated_at = $2 WHERE id = $1",
      [id, now],
    );
  }

  /**
   * Moves a row into `attempting`, taking the attempt counter with it.
   *
   * Refuses `unknown → attempting` unless reconciliation ran *after* the
   * ambiguity arose. This is the single most important guard in the file: it is
   * the code path that stands between a crashed worker and a duplicate review
   * on someone's pull request.
   */
  public async beginAttempt(
    id: string,
    from: PublicationState,
  ): Promise<LedgerOutcome> {
    if (!canTransitionPublication(from, "attempting")) {
      return { kind: "illegal", from, to: "attempting" };
    }

    const now = this.#now();
    const result = await this.#pool.query<Row>(
      `UPDATE publication_intents
          SET state = 'attempting', attempts = attempts + 1, updated_at = $3
        WHERE id = $1
          AND state = $2
          AND (
            state = 'planned'
            OR (reconciled_at IS NOT NULL AND reconciled_at >= updated_at)
          )
        RETURNING ${COLUMNS}`,
      [id, from, now],
    );

    if ((result.rowCount ?? 0) === 0) {
      const actual = await this.get(id);
      // Distinguished from a lost race: the row is exactly where the caller
      // expected it, and the only thing missing is the lookup. Reporting that
      // as `refused` would invite the caller to "just retry", which is the
      // shortcut this guard exists to refuse.
      if (
        actual !== undefined &&
        actual.state === from &&
        (from === "unknown" || from === "attempting")
      ) {
        return { kind: "reconciliation_required" };
      }
      return { kind: "refused", actualState: actual?.state };
    }

    return { kind: "moved", state: "attempting" };
  }

  /**
   * Records an observation of the effect in provider state.
   *
   * The only path to `published`. A 2xx is not enough and never was: the
   * response can be lost, and a row that says `published` because a worker
   * believed a request succeeded makes the `completed` entailment satisfiable
   * by belief rather than by evidence.
   */
  public async recordConfirmed(
    id: string,
    from: PublicationState,
    observation: ProviderObservation,
  ): Promise<LedgerOutcome> {
    return this.#transition(id, from, "published", {
      provider_reference: observation.reference,
      provider_node_id: observation.nodeId ?? null,
      provider_commit_id: observation.commitId ?? null,
      confirmed_at: this.#now(),
      last_error_code: null,
      last_error_class: null,
      next_attempt_at: null,
    });
  }

  /** Records what an attempt produced, keeping ambiguity ambiguous. */
  public async recordFailure(
    id: string,
    from: PublicationState,
    failure: AttemptFailure,
  ): Promise<LedgerOutcome> {
    if (failure.kind === "ambiguous") {
      // Not `failed`. We do not know, and the recovery for not-knowing is a
      // provider lookup, not a retry.
      return this.#transition(id, from, "unknown", {
        last_error_code: failure.code,
        last_error_class: "ambiguous",
        next_attempt_at: this.#now(),
      });
    }

    if (failure.kind === "retryable") {
      // Back to `planned` with a backoff: "we will try again" and "we gave up"
      // stay different rows rather than one row plus a counter to interpret.
      return this.#transition(id, from, "planned", {
        last_error_code: failure.code,
        last_error_class: "retryable",
        next_attempt_at: failure.retryAt,
      });
    }

    return this.#transition(id, from, "failed", {
      last_error_code: failure.code,
      last_error_class: "permanent",
      next_attempt_at: null,
    });
  }

  /**
   * Compare-and-swap, validated against the frozen transition table.
   *
   * Both halves are load-bearing. The CAS proves nobody else moved the row; the
   * table proves the move itself is legal. A caller with a correct expected
   * state can still ask for an illegal move, which is exactly the defect an
   * earlier review found in the ReviewRun store.
   */
  async #transition(
    id: string,
    from: PublicationState,
    to: PublicationState,
    columns: Readonly<Record<string, unknown>>,
  ): Promise<LedgerOutcome> {
    if (!canTransitionPublication(from, to)) {
      return { kind: "illegal", from, to };
    }

    const entries = Object.entries(columns);
    const assignments = entries
      .map(([column], index) => `${column} = $${String(index + 4)}`)
      .join(", ");

    const result = await this.#pool.query(
      `UPDATE publication_intents
          SET state = $2, updated_at = $3${assignments === "" ? "" : `, ${assignments}`}
        WHERE id = $1 AND state = $${String(entries.length + 4)}`,
      [id, to, this.#now(), ...entries.map(([, value]) => value), from],
    );

    if ((result.rowCount ?? 0) === 0) {
      const actual = await this.get(id);
      return { kind: "refused", actualState: actual?.state };
    }

    return { kind: "moved", state: to };
  }
}

/**
 * Asserts that a run's ledger is consistent with its state, database-wide.
 *
 * Used by the entailment suite rather than by production code. Written as a
 * query over every row rather than a check of one run, because the invariant it
 * defends is about the whole table: a single run that violates it is a bug, and
 * a query that only ever looks at the run under test cannot find the one that
 * does.
 */
export async function findLifecycleViolations(
  pool: Pool,
): Promise<readonly string[]> {
  const violations: string[] = [];

  // `publishing` is a durable obligation. A run in it with no ledger means the
  // obligation was announced and never recorded — nothing would resume it.
  const empty = await pool.query<{ id: string }>(
    `SELECT r.id FROM review_runs r
      WHERE r.state = 'publishing'
        AND NOT EXISTS (
          SELECT 1 FROM publication_intents p WHERE p.review_run_id = r.id
        )`,
  );
  for (const row of empty.rows) {
    violations.push(`run ${row.id} is publishing with an empty ledger`);
  }

  // The entailment E.2 had to defer: `completed` now has a defined meaning,
  // because E.3 defined what provider-confirmed means.
  const unconfirmed = await pool.query<{ id: string; logical_key: string }>(
    `SELECT r.id, p.logical_key FROM review_runs r
       JOIN publication_intents p ON p.review_run_id = r.id
      WHERE r.state = 'completed' AND p.state <> 'published'`,
  );
  for (const row of unconfirmed.rows) {
    violations.push(
      `run ${row.id} is completed while ${row.logical_key} is not provider-confirmed`,
    );
  }

  // `published` without evidence. The CHECK constraint makes this unreachable
  // through SQL, which is the point: the query proves the constraint is present
  // and would catch a migration that dropped it.
  const beliefOnly = await pool.query<{ logical_key: string }>(
    `SELECT logical_key FROM publication_intents
      WHERE state = 'published'
        AND (provider_reference IS NULL OR confirmed_at IS NULL)`,
  );
  for (const row of beliefOnly.rows) {
    violations.push(
      `publication ${row.logical_key} is published without provider evidence`,
    );
  }

  // A publication authored by anything other than the policy path. The CHECK
  // makes it unreachable through SQL, which is the point: this query proves the
  // constraint is present and would catch a migration that dropped it.
  const unauthorized = await pool.query<{ logical_key: string }>(
    "SELECT logical_key FROM publication_intents WHERE authored_by <> 'policy'",
  );
  for (const row of unauthorized.rows) {
    violations.push(
      `publication ${row.logical_key} was authored outside the policy path`,
    );
  }

  // A run past verification with a candidate nothing ever examined.
  //
  // `inconclusive` counts as examined; `unavailable` does not. A run that
  // reached reconciling with an unavailable attempt would be publishing the
  // subset that happened to verify, which makes an outage look like a clean
  // review.
  const unexamined = await pool.query<{ id: string; candidate: string }>(
    `SELECT r.id, c.id AS candidate
       FROM review_runs r
       JOIN candidate_findings c ON c.review_run_id = r.id
      WHERE r.state IN ('reconciling', 'publishing', 'completed')
        AND NOT EXISTS (
          SELECT 1 FROM verification_attempts v
           WHERE v.candidate_finding_id = c.id AND v.status = 'completed'
        )`,
  );
  for (const row of unexamined.rows) {
    violations.push(
      `run ${row.id} passed verification with candidate ${row.candidate} unexamined`,
    );
  }

  // A promoted finding with no verification behind it.
  const unverified = await pool.query<{ id: string }>(
    `SELECT f.id FROM review_findings f
       LEFT JOIN verification_attempts v ON v.id = f.verification_attempt_id
      WHERE f.verification_attempt_id IS NULL
         OR v.decision IS DISTINCT FROM 'verified'`,
  );
  for (const row of unverified.rows) {
    violations.push(
      `review finding ${row.id} was promoted without a verification`,
    );
  }

  return violations;
}
