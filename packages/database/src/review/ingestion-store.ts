import { createHash } from "node:crypto";
import { canonicalJson } from "@acalys/contracts/domain";
import {
  dashboardEffectiveReviewPolicySchema,
  type DashboardEffectiveReviewPolicy,
} from "@acalys/contracts/dashboard/v1";
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
  pullRequestReviewTargetSchema,
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
  readonly correlationId?: string | undefined;
  readonly policySnapshot?: DashboardEffectiveReviewPolicy | undefined;
  readonly policyFingerprint?: string | undefined;
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

export interface ReviewRunExecutionContext {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly headSha: string;
  readonly provider: "github" | "gitlab";
  readonly pullRequestId: string;
  /** Immutable provider subject captured on ReviewRequest at admission time. */
  readonly reviewPolicy?:
    | {
        readonly policy: DashboardEffectiveReviewPolicy;
        readonly fingerprint: string;
      }
    | undefined;
  readonly reviewSubject?:
    | {
        readonly number?: number | undefined;
        readonly title: string;
        readonly description?: string | undefined;
        readonly headRef: string;
        readonly repositoryOwner: string;
        readonly repositoryName: string;
      }
    | undefined;
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
   * # Converging, rather than one worker losing
   *
   * Two workers handling one delivery must produce one revision. The ordering
   * below is what makes that true, and an earlier version had it wrong in a
   * way that only showed under real contention:
   *
   * ```
   * WRONG                              RIGHT
   * SELECT existing   (both: none)     LOCK the pull request row
   * LOCK the row      (B waits)        SELECT existing  (B now sees A's row)
   * INSERT            (B: violation)   INSERT ... ON CONFLICT DO NOTHING
   * ```
   *
   * Checking for existence *before* taking the lock means both workers decide
   * "not there" against the same stale snapshot; serializing afterwards only
   * decides which one gets to fail. Taking the lock first means the second
   * worker's `SELECT` runs after the first has committed, and under READ
   * COMMITTED it sees the row.
   *
   * `ON CONFLICT DO NOTHING` is kept as well, because the lock is per pull
   * request and a caller could still race on a path that does not hold it. If
   * the insert yields nothing, the row exists and is read back — converging on
   * it, which is the whole contract of this method.
   *
   * **Measured, not assumed:** each of the two changes fixes the tested
   * interleaving on its own. Reordering the lock alone passes; adding
   * `ON CONFLICT` alone passes. So no test here distinguishes them, and
   * neither is individually defended by a mutation — removing either one
   * survives. They are kept together as defence in depth against *different*
   * interleavings.
   *
   * The consequence is worth stating rather than hiding: **this fix carries no
   * mutation coverage.** Two independently sufficient defences admit no
   * killable single-edit mutant, and the harness takes one `find`/`replace`
   * per definition. Planting one anyway would put an unkillable entry in the
   * manifest and shrink the denominator with something that can never die.
   *
   * What guards it instead is a test: "converges when many workers race one
   * head SHA at once" fails on the pre-fix code in every run and passes on
   * this one. That is weaker than a mutation and it is what exists.
   *
   * The comment this replaces claimed the loser "retries into the conflict
   * branch". Nothing retried. The behaviour was documented and absent, which
   * is worse than undocumented: the test that would have caught it read as
   * flaky rather than as failing.
   *
   * `sequence` is assigned as `max + 1` **within the transaction**, under the
   * same row lock, so two concurrent inserts cannot compute the same number.
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
      // Locks the pull request row FIRST, serializing both the existence check
      // and sequence assignment for this PR without serializing the table.
      // Checking existence before this line is the defect described above.
      await client.query(
        "SELECT id FROM pull_requests WHERE id = $1 FOR UPDATE",
        [input.pullRequestId],
      );

      const readBack = async (): Promise<StoredRevision | undefined> => {
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
        return found === undefined
          ? undefined
          : {
              id: found.id,
              pullRequestId: input.pullRequestId,
              sequence: found.sequence,
              headSha: input.headSha,
              createdAt: found.created_at,
              existed: true,
            };
      };

      const already = await readBack();
      if (already !== undefined) return already;

      const next = await client.query<{ sequence: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM pull_request_revisions WHERE pull_request_id = $1`,
        [input.pullRequestId],
      );
      const sequence = next.rows[0]?.sequence ?? 1;
      const id = randomUUID();

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO pull_request_revisions (
           id, organization_id, repository_id, pull_request_id, sequence,
           head_sha, head_ref, base_sha, base_ref, merge_base_sha, trigger, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (pull_request_id, head_sha) DO NOTHING
         RETURNING id`,
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

      if (inserted.rows.length === 0) {
        // Someone else won on a path that did not hold our lock. Converge on
        // their row rather than failing: "one revision per head SHA" is the
        // contract, and which worker wrote it is not part of it.
        const theirs = await readBack();
        if (theirs !== undefined) return theirs;
        throw new Error(
          `pull_request_revisions insert for ${input.headSha} conflicted, ` +
            "but the conflicting row could not be read back",
        );
      }

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
           idempotency_scope, idempotency_key, requested_at, correlation_id, policy_snapshot, policy_fingerprint
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
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
          input.correlationId ?? null,
          input.policySnapshot === undefined
            ? null
            : JSON.stringify(input.policySnapshot),
          input.policyFingerprint ?? null,
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

  /** Immutable inputs required to resume one run in any worker process. */
  public getRunExecutionContext(
    runId: string,
  ): Promise<ReviewRunExecutionContext | undefined> {
    return this.#withClient(async (client) => {
      const result = await client.query<{
        organization_id: string;
        repository_id: string;
        revision_id: string | null;
        head_sha: string | null;
        head_ref: string | null;
        provider: string;
        pull_request_id: string | null;
        target: unknown;
        repository_owner: string;
        repository_name: string;
        policy_snapshot: unknown;
        policy_fingerprint: string | null;
      }>(
        `SELECT r.organization_id, r.repository_id, r.revision_id,
                rev.head_sha, rev.head_ref, repo.provider, rev.pull_request_id,
                req.target, repo.owner AS repository_owner, repo.name AS repository_name,
                req.policy_snapshot, req.policy_fingerprint
           FROM review_runs r
           JOIN repositories repo ON repo.id = r.repository_id
           JOIN review_requests req ON req.id = r.request_id
           LEFT JOIN pull_request_revisions rev ON rev.id = r.revision_id
          WHERE r.id = $1`,
        [runId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      if (
        row.revision_id === null ||
        row.head_sha === null ||
        row.pull_request_id === null ||
        (row.provider !== "github" && row.provider !== "gitlab")
      ) {
        return undefined;
      }
      const target = pullRequestReviewTargetSchema.safeParse(row.target);
      const reviewSubject =
        target.success && row.head_ref !== null
          ? {
              ...(target.data.changeRequest.number === undefined
                ? {}
                : { number: target.data.changeRequest.number }),
              title: target.data.title,
              ...(target.data.description === undefined
                ? {}
                : { description: target.data.description }),
              headRef: row.head_ref,
              repositoryOwner: row.repository_owner,
              repositoryName: row.repository_name,
            }
          : undefined;
      const policy =
        row.policy_snapshot === null || row.policy_snapshot === undefined
          ? undefined
          : dashboardEffectiveReviewPolicySchema.safeParse(row.policy_snapshot);
      const reviewPolicy =
        policy?.success === true && row.policy_fingerprint !== null
          ? (() => {
              const expected = createHash("sha256")
                .update(canonicalJson(policy.data), "utf8")
                .digest("hex");
              return expected === row.policy_fingerprint
                ? { policy: policy.data, fingerprint: row.policy_fingerprint }
                : undefined;
            })()
          : undefined;
      if (
        row.policy_snapshot !== null &&
        row.policy_snapshot !== undefined &&
        reviewPolicy === undefined
      ) {
        // A snapshotted request whose payload/fingerprint no longer agree is
        // corrupt. Fail closed instead of executing against mutable settings.
        return undefined;
      }
      return {
        organizationId: row.organization_id,
        repositoryId: row.repository_id,
        runId,
        revisionId: row.revision_id,
        headSha: row.head_sha,
        provider: row.provider,
        pullRequestId: row.pull_request_id,
        ...(reviewPolicy === undefined ? {} : { reviewPolicy }),
        ...(reviewSubject === undefined ? {} : { reviewSubject }),
      };
    });
  }

  /**
   * Cancels work for a closed pull request only before publication begins.
   * `publishing` is the external side-effect commit point: once a run reaches
   * it, cancellation may not pretend remote publication can be rolled back.
   */
  public cancelPrePublicationRuns(
    pullRequestId: string,
  ): Promise<readonly string[]> {
    return this.#withClient(async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE review_runs r
            SET state = 'cancelled', completed_at = clock_timestamp(),
                failure_code = COALESCE(failure_code, 'acalys.review.pull-request-closed'),
                failure_retryability = COALESCE(failure_retryability, 'non_retryable')
           FROM review_requests req
          WHERE r.request_id = req.id
            AND req.pull_request_id = $1
            AND r.state IN ('queued','preparing','analyzing','reviewing','verifying','reconciling')
         RETURNING r.id`,
        [pullRequestId],
      );
      return result.rows.map((row) => row.id);
    });
  }

  public getRun(runId: string): Promise<
    | {
        readonly id: string;
        readonly state: string;
        readonly attempt: number;
        readonly modelUsage: {
          readonly calls: number;
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly cachedInputTokens: number;
          readonly costMicroUsd: number;
        };
      }
    | undefined
  > {
    return this.#withClient(async (client) => {
      const result = await client.query<{
        id: string;
        state: string;
        attempt: number;
        model_calls: string | number;
        input_tokens: string | number;
        output_tokens: string | number;
        cached_input_tokens: string | number;
        cost_microusd: string | number;
      }>(
        `SELECT r.id, r.state, r.attempt,
                COUNT(m.id) FILTER (WHERE m.provider_dispatched) AS model_calls,
                COALESCE(SUM(m.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(m.cached_input_tokens), 0) AS cached_input_tokens,
                COALESCE(SUM(m.cost_microusd), 0) AS cost_microusd
           FROM review_runs r
           LEFT JOIN model_interactions m ON m.review_run_id = r.id
          WHERE r.id = $1
          GROUP BY r.id, r.state, r.attempt`,
        [runId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      const safe = (value: string | number): number => {
        const parsed = typeof value === "number" ? value : Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          throw new Error("model usage exceeds JavaScript safe integer range");
        }
        return parsed;
      };
      return {
        id: row.id,
        state: row.state,
        attempt: row.attempt,
        modelUsage: {
          calls: safe(row.model_calls),
          inputTokens: safe(row.input_tokens),
          outputTokens: safe(row.output_tokens),
          cachedInputTokens: safe(row.cached_input_tokens),
          costMicroUsd: safe(row.cost_microusd),
        },
      };
    });
  }

  /**
   * Resolves the immutable provider coordinates for one exact review revision.
   *
   * The lookup is deliberately keyed by revision id *and* checks repository/head
   * identity. A head SHA alone is ambiguous: the same commit can be reviewed
   * against two different bases after a retarget/rebase. Returning the wrong
   * base would poison both analyzer identity and the independent verifier.
   */
  public findAnalysisRevision(input: {
    readonly revisionId: string;
    readonly repositoryId: string;
    readonly headSha?: string | undefined;
  }): Promise<
    | {
        readonly organizationId: string;
        readonly provider: string;
        readonly providerRepositoryId: string;
        readonly owner: string;
        readonly name: string;
        readonly installationId: string | null;
        readonly headSha: string;
        readonly baseSha: string;
        readonly mergeBaseSha: string | null;
      }
    | undefined
  > {
    return this.#withClient(async (client) => {
      const result = await client.query<{
        organization_id: string;
        provider: string;
        provider_external_id: string;
        owner: string;
        name: string;
        installation_id: string | null;
        head_sha: string;
        base_sha: string;
        merge_base_sha: string | null;
      }>(
        `SELECT r.organization_id, repo.provider, repo.provider_external_id,
                repo.owner, repo.name, repo.installation_id,
                r.head_sha, r.base_sha, r.merge_base_sha
           FROM pull_request_revisions r
           JOIN repositories repo ON repo.id = r.repository_id
          WHERE r.id = $1
            AND r.repository_id = $2
            AND ($3::text IS NULL OR r.head_sha = $3)`,
        [input.revisionId, input.repositoryId, input.headSha ?? null],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            organizationId: row.organization_id,
            provider: row.provider,
            providerRepositoryId: row.provider_external_id,
            owner: row.owner,
            name: row.name,
            installationId: row.installation_id,
            headSha: row.head_sha,
            baseSha: row.base_sha,
            mergeBaseSha: row.merge_base_sha,
          };
    });
  }

  /** Whether a state admits no further transitions. Delegates to the contract. */
  public static isTerminal(state: string): boolean {
    return isTerminalReviewRunState(state as ReviewRunState);
  }
}
