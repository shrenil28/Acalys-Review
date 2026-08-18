/**
 * Turning a stored delivery into review history, convergently.
 *
 * The invariant this file exists to hold:
 *
 * > A stored delivery may be **executed** more than once. Its externally
 * > meaningful effects must behave as if it were executed once.
 *
 * No attempt is made to manufacture exactly-once execution — that is not
 * available over a network with crashing processes. What is available is
 * convergence: every write is keyed so that re-running the same work finds what
 * the previous run created instead of duplicating it.
 *
 *     revision        UNIQUE (pull_request_id, head_sha)
 *     request         UNIQUE (idempotency_scope, idempotency_key)
 *     run             UNIQUE (request_id, attempt)
 *
 * A worker that dies after creating a `ReviewRun` and is retried therefore
 * converges onto that same run, rather than opening a second one for the same
 * push.
 *
 * # Every state change is a compare-and-swap
 *
 * Transitions are `UPDATE … WHERE id = $1 AND state = $expected`. Reading the
 * state and then writing it is a TOCTOU window, and a real one:
 *
 *     T1  worker A reads state = reconciling
 *     T2  push B lands; A is superseded
 *     T3  worker A writes state = publishing — and posts comments
 *
 * The check has to happen *at* the side effect, not before it. A conditional
 * update reports `rowCount = 0` when someone else moved the run, and the caller
 * must treat that as "stop", not as "retry".
 *
 * The same mechanism makes terminality real at runtime: a terminal state never
 * matches an expected non-terminal `from`, so nothing can resurrect a finished
 * run — the transactional counterpart of Phase 0's N×N matrix.
 */

import { randomUUID } from "node:crypto";

import {
  canTransition,
  isTerminalReviewRunState,
  type ReviewRunState,
} from "@acalys/contracts/domain";

import type { PgClient, PgPool } from "../webhook/postgres-inbox.js";

export interface TenantScope {
  readonly organizationId: string;
  readonly repositoryId: string;
}

export interface RevisionInput {
  readonly pullRequestId: string;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly mergeBaseSha: string | null;
  readonly trigger: string;
  readonly createdAt: Date;
}

export interface StoredRevision {
  readonly id: string;
  readonly pullRequestId: string;
  readonly sequence: number;
  readonly headSha: string;
  readonly createdAt: Date;
  /** True when this row already existed — the convergence signal. */
  readonly existed: boolean;
}

export interface ReviewRequestInput {
  readonly pullRequestId: string | null;
  readonly revisionId: string | null;
  readonly target: unknown;
  readonly trigger: string;
  readonly requestedBy: unknown;
  readonly executionMode: string;
  readonly executionStrategy: string;
  readonly idempotencyKey: string;
  readonly requestedAt: Date;
}

export interface StoredReviewRequest {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly existed: boolean;
}

export interface StoredReviewRun {
  readonly id: string;
  readonly requestId: string;
  readonly attempt: number;
  readonly state: string;
  readonly existed: boolean;
}

export type TransitionOutcome =
  | { readonly kind: "moved"; readonly state: string }
  /** Someone else changed the run first. Stop; do not retry. */
  | { readonly kind: "refused"; readonly actualState: string | undefined }
  /**
   * The transition is not in the state machine at all.
   *
   * Distinct from `refused`: a refusal means the caller lost a race and should
   * stop, while this means the caller asked for something that is never legal
   * and is a bug in the caller.
   */
  | { readonly kind: "illegal"; readonly from: string; readonly to: string };

export class ReviewIngestionStore {
  readonly #pool: PgPool;
  readonly #now: () => Date;

  public constructor(pool: PgPool, now: () => Date = () => new Date()) {
    this.#pool = pool;
    this.#now = now;
  }

  async #withClient<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await run(client);
    } finally {
      client.release();
    }
  }

  async #inTransaction<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    return this.#withClient(async (client) => {
      try {
        await client.query("BEGIN");
        const result = await run(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Reads a stored delivery by row id.
   *
   * A job carries only the row id; the bytes live on the delivery. That
   * indirection is deliberate — a job is a small, frequently-updated row, and
   * copying a 25 MiB payload into it per attempt would be absurd.
   */
  public findDeliveryById(id: string): Promise<
    | {
        readonly id: string;
        readonly event: string;
        readonly action: string | null;
        readonly payload: Buffer;
        readonly bodyDigest: string;
      }
    | undefined
  > {
    return this.#withClient(async (client) => {
      const result = await client.query<{
        id: string;
        event: string;
        action: string | null;
        payload: Buffer;
        body_digest: string;
      }>(
        `SELECT id, event, action, payload, body_digest
           FROM webhook_deliveries WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            id: row.id,
            event: row.event,
            action: row.action,
            payload: row.payload,
            bodyDigest: row.body_digest,
          };
    });
  }

  /**
   * Resolves a provider repository to platform identity.
   *
   * The webhook carries GitHub's numeric id; everything downstream needs the
   * platform's `RepositoryId` and the owning organization. A miss is **not**
   * necessarily permanent — a delivery can outrun installation sync, arriving
   * before the repository row exists — so the caller classifies it as
   * retryable rather than dead-lettering immediately.
   */
  public findRepository(
    provider: string,
    providerExternalId: string,
  ): Promise<
    | {
        readonly repositoryId: string;
        readonly organizationId: string;
        readonly installationId: string | null;
      }
    | undefined
  > {
    return this.#withClient(async (client) => {
      const result = await client.query<{
        id: string;
        organization_id: string;
        installation_id: string | null;
      }>(
        `SELECT id, organization_id, installation_id FROM repositories
          WHERE provider = $1 AND provider_external_id = $2`,
        [provider, providerExternalId],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            repositoryId: row.id,
            organizationId: row.organization_id,
            installationId: row.installation_id,
          };
    });
  }

  /**
   * Records the pull request as it stands now.
   *
   * Mutable by design, and that is safe: nothing here affects the correctness
   * of a past review. Everything a review's correctness depends on — base,
   * head, merge base — lives on the immutable revision instead.
   *
   * `DO UPDATE` rather than `DO NOTHING`: a redelivery for the same PR usually
   * carries newer metadata (a retitle, a label, a state change), and dropping
   * it would leave the triage view stale forever.
   */
  public upsertPullRequest(
    scope: TenantScope,
    input: {
      readonly providerExternalId: string;
      readonly number: number;
      readonly title: string;
      readonly description: string | null;
      readonly author: unknown;
      readonly state: string;
      readonly draft: boolean;
      readonly labels: readonly string[];
      readonly createdAt: Date;
      readonly updatedAt: Date;
    },
  ): Promise<{ readonly id: string; readonly existed: boolean }> {
    return this.#withClient(async (client) => {
      const result = await client.query<{ id: string; inserted: boolean }>(
        `INSERT INTO pull_requests (
           id, organization_id, repository_id, provider, provider_external_id,
           number, title, description, author, state, draft, labels,
           created_at, updated_at
         ) VALUES ($1,$2,$3,'github',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (repository_id, provider_external_id) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           state = EXCLUDED.state,
           draft = EXCLUDED.draft,
           labels = EXCLUDED.labels,
           updated_at = EXCLUDED.updated_at
         RETURNING id, (xmax = 0) AS inserted`,
        [
          randomUUID(),
          scope.organizationId,
          scope.repositoryId,
          input.providerExternalId,
          input.number,
          input.title,
          input.description,
          JSON.stringify(input.author),
          input.state,
          input.draft,
          JSON.stringify(input.labels),
          input.createdAt,
          input.updatedAt,
        ],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error("pull_requests upsert returned no row");
      return { id: row.id, existed: !row.inserted };
    });
  }

  /**
   * Records a revision, converging on head SHA.
   *
   * `sequence` is assigned as `max + 1` **within the transaction**, so two
   * concurrent inserts cannot both compute the same number — the second either
   * blocks on the row lock or fails the unique constraint and retries into the
   * conflict branch.
   *
   * Sequence is **arrival order, not repository history.** GitHub states
   * deliveries can arrive out of order, so a delayed push can land with a
   * higher sequence than a push that happened after it. Head SHA is the
   * identity; sequence is only a local, dense, human-facing counter.
   */
  public upsertRevision(
    scope: TenantScope,
    input: RevisionInput,
  ): Promise<StoredRevision> {
    return this.#inTransaction(async (client) => {
      const existing = await client.query<{
        id: string;
        sequence: number;
        created_at: Date;
      }>(
        `SELECT id, sequence, created_at FROM pull_request_revisions
          WHERE pull_request_id = $1 AND head_sha = $2`,
        [input.pullRequestId, input.headSha],
      );

      const found = existing.rows[0];
      if (found !== undefined) {
        return {
          id: found.id,
          pullRequestId: input.pullRequestId,
          sequence: found.sequence,
          headSha: input.headSha,
          createdAt: found.created_at,
          existed: true,
        };
      }

      // Locks the pull request row, serializing sequence assignment for this PR
      // without serializing the whole table.
      await client.query(
        "SELECT id FROM pull_requests WHERE id = $1 FOR UPDATE",
        [input.pullRequestId],
      );

      const next = await client.query<{ sequence: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM pull_request_revisions WHERE pull_request_id = $1`,
        [input.pullRequestId],
      );
      const sequence = next.rows[0]?.sequence ?? 1;
      const id = randomUUID();

      await client.query(
        `INSERT INTO pull_request_revisions (
           id, organization_id, repository_id, pull_request_id, sequence,
           head_sha, head_ref, base_sha, base_ref, merge_base_sha, trigger, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          scope.organizationId,
          scope.repositoryId,
          input.pullRequestId,
          sequence,
          input.headSha,
          input.headRef,
          input.baseSha,
          input.baseRef,
          input.mergeBaseSha,
          input.trigger,
          input.createdAt,
        ],
      );

      return {
        id,
        pullRequestId: input.pullRequestId,
        sequence,
        headSha: input.headSha,
        createdAt: input.createdAt,
        existed: false,
      };
    });
  }

  /**
   * Records intent, converging on the idempotency key.
   *
   * Scoped by organization, never globally: a shared key space lets one
   * tenant's request suppress another's, which is a cross-tenant leak wearing
   * the costume of a deduplication optimization.
   */
  public upsertReviewRequest(
    scope: TenantScope,
    input: ReviewRequestInput,
  ): Promise<StoredReviewRequest> {
    return this.#withClient(async (client) => {
      const result = await client.query<{ id: string; inserted: boolean }>(
        `INSERT INTO review_requests (
           id, organization_id, repository_id, pull_request_id, revision_id,
           target, trigger, requested_by, execution_mode, execution_strategy,
           idempotency_scope, idempotency_key, requested_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (idempotency_scope, idempotency_key)
           DO UPDATE SET requested_at = review_requests.requested_at
         RETURNING id, (xmax = 0) AS inserted`,
        [
          randomUUID(),
          scope.organizationId,
          scope.repositoryId,
          input.pullRequestId,
          input.revisionId,
          JSON.stringify(input.target),
          input.trigger,
          JSON.stringify(input.requestedBy),
          input.executionMode,
          input.executionStrategy,
          scope.organizationId,
          input.idempotencyKey,
          input.requestedAt,
        ],
      );

      const row = result.rows[0];
      if (row === undefined)
        throw new Error("review_requests upsert returned no row");
      return {
        id: row.id,
        idempotencyKey: input.idempotencyKey,
        existed: !row.inserted,
      };
    });
  }

  /**
   * Creates the run for a request attempt, converging on `(request, attempt)`.
   *
   * This is where "a worker crash creates another job attempt, not another
   * ReviewRun" becomes true. The retried job passes the same attempt number and
   * finds the existing row.
   */
  public upsertReviewRun(
    scope: TenantScope,
    input: {
      readonly requestId: string;
      readonly revisionId: string | null;
      readonly attempt: number;
      readonly executionMode: string;
      readonly executionStrategy: string;
      readonly createdAt: Date;
    },
  ): Promise<StoredReviewRun> {
    return this.#withClient(async (client) => {
      const result = await client.query<{
        id: string;
        attempt: number;
        state: string;
        inserted: boolean;
      }>(
        `INSERT INTO review_runs (
           id, organization_id, repository_id, request_id, revision_id,
           attempt, state, execution_mode, execution_strategy, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9)
         ON CONFLICT (request_id, attempt)
           DO UPDATE SET created_at = review_runs.created_at
         RETURNING id, attempt, state, (xmax = 0) AS inserted`,
        [
          randomUUID(),
          scope.organizationId,
          scope.repositoryId,
          input.requestId,
          input.revisionId,
          input.attempt,
          input.executionMode,
          input.executionStrategy,
          input.createdAt,
        ],
      );

      const row = result.rows[0];
      if (row === undefined)
        throw new Error("review_runs upsert returned no row");
      return {
        id: row.id,
        requestId: input.requestId,
        attempt: row.attempt,
        state: row.state,
        existed: !row.inserted,
      };
    });
  }

  /**
   * Moves a run, only if it is still where the caller believes it is.
   *
   * The compare-and-swap. `rowCount === 0` means someone else moved it first —
   * a supersession, a cancellation, or a concurrent worker — and the caller
   * must stop rather than retry. Retrying a refused transition is how a
   * superseded run publishes anyway.
   *
   * The transition row is written in the same transaction as the state change,
   * so history can never disagree with the current state.
   */
  public transition(
    runId: string,
    from: string,
    to: string,
  ): Promise<TransitionOutcome> {
    // Validated against the SAME table Phase 0 defines, imported rather than
    // restated. An earlier version issued a bare compare-and-swap, which meant
    // a caller that correctly observed `completed` could move the run back to
    // `queued` — terminality was not enforced anywhere, only the caller's
    // honesty was. A conditional update guarantees *nobody else moved it*; it
    // says nothing about whether the move is legal.
    if (!canTransition(from as ReviewRunState, to as ReviewRunState)) {
      return Promise.resolve({ kind: "illegal", from, to });
    }

    return this.#inTransaction(async (client) => {
      const moved = await client.query(
        `UPDATE review_runs
            SET state = $3,
                started_at = CASE WHEN $3 = 'preparing' AND started_at IS NULL
                                  THEN $4 ELSE started_at END,
                completed_at = CASE WHEN $3 IN ('completed','failed','cancelled','superseded')
                                    THEN $4 ELSE completed_at END
          WHERE id = $1
            AND state = $2
            -- Defence in depth. The guard above is the authority; this makes a
            -- terminal run immovable even if a future caller reaches the SQL by
            -- another path.
            AND state NOT IN ('completed','failed','cancelled','superseded')`,
        [runId, from, to, this.#now()],
      );

      if ((moved.rowCount ?? 0) === 0) {
        const actual = await client.query<{ state: string }>(
          "SELECT state FROM review_runs WHERE id = $1",
          [runId],
        );
        return { kind: "refused", actualState: actual.rows[0]?.state };
      }

      await client.query(
        `INSERT INTO review_run_transitions (run_id, seq, from_state, to_state, at)
         SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4
           FROM review_run_transitions WHERE run_id = $1`,
        [runId, from, to, this.#now()],
      );

      return { kind: "moved", state: to };
    });
  }

  /**
   * Supersedes every live run for a pull request except the one named.
   *
   * Called when a newer revision arrives. Uses the same conditional-update
   * discipline: a run already in `publishing` is **not** superseded, because
   * `publishing` is the commit point and interrupting it leaves a partially
   * commented pull request nothing can reconcile.
   */
  public supersedeOlderRuns(
    pullRequestId: string,
    exceptRunId: string,
  ): Promise<readonly string[]> {
    return this.#inTransaction(async (client) => {
      const superseded = await client.query<{ id: string; state: string }>(
        `UPDATE review_runs r
            SET state = 'superseded', completed_at = $3
          FROM review_requests q
          WHERE r.request_id = q.id
            AND q.pull_request_id = $1
            AND r.id <> $2
            AND r.state IN ('queued','preparing','analyzing','reviewing',
                            'verifying','reconciling')
          RETURNING r.id, r.state`,
        [pullRequestId, exceptRunId, this.#now()],
      );

      for (const row of superseded.rows) {
        await client.query(
          `INSERT INTO review_run_transitions (run_id, seq, from_state, to_state, at)
           SELECT $1, COALESCE(MAX(seq), 0) + 1, 'unknown', 'superseded', $2
             FROM review_run_transitions WHERE run_id = $1`,
          [row.id, this.#now()],
        );
      }

      return superseded.rows.map((row) => row.id);
    });
  }

  /**
   * Whether a revision is the newest the platform has seen for its pull request.
   *
   * Arrival order is not repository order, so "newest" is decided by the
   * highest sequence recorded — the platform's own view of what it has been
   * told. A delivery that lands after a newer one has already been recorded is
   * answering an old question, and its run is created and immediately
   * superseded rather than skipped: the request was real, and a missing row
   * would leave no record that the platform decided not to review it.
   */
  public isLatestRevision(
    pullRequestId: string,
    revisionId: string,
  ): Promise<boolean> {
    return this.#withClient(async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM pull_request_revisions
          WHERE pull_request_id = $1
          ORDER BY sequence DESC LIMIT 1`,
        [pullRequestId],
      );
      return result.rows[0]?.id === revisionId;
    });
  }

  public getRun(
    runId: string,
  ): Promise<
    | { readonly id: string; readonly state: string; readonly attempt: number }
    | undefined
  > {
    return this.#withClient(async (client) => {
      const result = await client.query<{
        id: string;
        state: string;
        attempt: number;
      }>("SELECT id, state, attempt FROM review_runs WHERE id = $1", [runId]);
      return result.rows[0];
    });
  }

  /** Whether a state admits no further transitions. Delegates to the contract. */
  public static isTerminal(state: string): boolean {
    return isTerminalReviewRunState(state as ReviewRunState);
  }
}
