/**
 * Running a stage: produce the output and announce it, atomically.
 *
 * The design decision this file exists to enforce, and why it went this way:
 *
 * > A stage's durable output and the transition that announces it are **one
 * > transaction.**
 *
 * The alternative — write the output, then transition — lets the state machine
 * lie. A crash between the two commits leaves `state = 'verifying'` on a run
 * with no analysis output, and the next worker reads the enum, believes it, and
 * proceeds on nothing that exists. The enum would mean "a worker got here", not
 * "the work happened".
 *
 * That is the compare-and-swap bug from P1-D one layer up: **state is not
 * evidence.** Making the pair atomic turns the entailment
 *
 *     state = 'verifying'  ⟹  analysis output exists
 *
 * into a structural fact rather than a rule someone remembers.
 *
 * `assertPrerequisites` is therefore **defence in depth, not the guarantee**.
 * It exists because schemas get corrupted by hand, migrations get written
 * wrongly, and a future refactor can split what is currently atomic — and when
 * that happens, the system should refuse to continue rather than review nothing
 * and report success.
 *
 * # Idempotent by identity
 *
 * A stage means *"ensure the output for this identity exists"*, never *"insert
 * output"*. Every table is keyed accordingly, so a retried stage converges. A
 * deterministic analyzer makes that trivially checkable: duplicate rows would
 * be immediately visible.
 */

import { randomUUID } from "node:crypto";

import { canTransition, type ReviewRunState } from "@acalys/contracts/domain";

import type { PgClient, PgPool } from "../webhook/postgres-inbox.js";
import type { TenantScope } from "./ingestion-store.js";
import { PublicationContentConflict } from "./publication-store.js";

export interface CandidateFindingRow {
  readonly producerId: string;
  readonly producerVersion: string;
  readonly inputDigest: string;
  readonly title: string;
  readonly claim: string;
  readonly explanation: string;
  readonly category: string;
  readonly proposedSeverity: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly fingerprintValue: string;
}

/**
 * What the analysis actually covered.
 *
 * Written in the transaction that records the analysis, so a run can never
 * claim findings without also saying how much of the change produced them.
 */
export interface AnalysisCoverage {
  readonly clustersTotal: number;
  readonly clustersAnalyzed: number;
  readonly clustersSkipped: number;
  readonly contextTokens: number;
  readonly complete: boolean;
  /** Required when `complete` is false: "bounded, reason unknown" is unusable. */
  readonly stopReason?: string | undefined;
}

export interface PublicationIntentRow {
  readonly kind: "review" | "inline_comment" | "summary" | "check";
  readonly logicalKey: string;
  readonly contentDigest: string;
  /** Which adapter reconciles this row. Denormalized: see migration 0004. */
  readonly provider: "github" | "gitlab";
  readonly pullRequestId?: string | undefined;
  /**
   * The revision published against.
   *
   * P1-E.3 found every GitHub review carries a `commit_id`. Without the
   * revision here, two runs against different pushes of one pull request are
   * indistinguishable in the ledger, and "already published?" degrades to
   * "was anything ever published here?".
   */
  readonly revisionId?: string | undefined;
  /**
   * The finding this publication renders, and the decision that authorized it.
   *
   * Both or neither. A finding-scoped publication with no decision is refused
   * by `publication_intents_finding_needs_decision`, and a decision that said
   * `withhold` has no `publishable_id` for the foreign key to reference — so
   * "a withheld finding reached the ledger" is unrepresentable rather than
   * merely forbidden.
   *
   * Run-level publications — the review container, the summary — belong to no
   * finding and carry neither.
   */
  readonly reviewFindingId?: string | undefined;
  readonly publicationDecisionId?: string | undefined;
}

/**
 * A stage refused to run, and why.
 *
 * `prerequisite_missing` is the interesting one: it means the state machine
 * claimed a stage happened while its artifact is absent. Under the atomic
 * design above that should be unreachable, so seeing it is a signal that
 * something outside this code wrote to the database.
 */
export type StageOutcome =
  | { readonly kind: "advanced"; readonly state: string }
  /**
   * The work was done against a revision the run no longer points at.
   *
   * Distinct from `refused`, and the recoveries are opposites:
   *
   * ```
   * refused  →  someone else advanced the run. Stop. Retrying is wrong: the
   *             run is no longer this worker's to move.
   * stale    →  the run is still ours and still in the expected state, but the
   *             work describes a revision it no longer points at. Recompute
   *             against the current revision. Re-committing is wrong: it would
   *             publish comments about code that is no longer there.
   * ```
   */
  | {
      readonly kind: "stale";
      readonly expectedRevisionId: string;
      readonly actualRevisionId: string | undefined;
    }
  | { readonly kind: "refused"; readonly actualState: string | undefined }
  | { readonly kind: "illegal"; readonly from: string; readonly to: string }
  | {
      readonly kind: "prerequisite_missing";
      readonly state: string;
      readonly missing: string;
    };

/**
 * What a stage produces. Called inside the transaction.
 *
 * `verifications` and `findings` used to be here, and their removal is the
 * P1-I correction rather than a tidy-up.
 *
 * A stage that could write a `review_findings` row directly was a second way to
 * promote a candidate, alongside `VerificationStore.promote` — and it was the
 * one the orchestrator actually used, so every promotion in the live pipeline
 * bypassed the gate that checks the candidate was verified. The findings it
 * wrote carried `verification_attempt_id = NULL`, which the entailment query
 * has always called a violation.
 *
 * Now promotion has exactly one implementation, it runs inside this
 * transaction via the caller's `produce(client)`, and it refuses anything its
 * attempt did not verify.
 */
export interface StageWork {
  readonly candidates?: readonly CandidateFindingRow[] | undefined;
  readonly publications?: readonly PublicationIntentRow[] | undefined;
}

/**
 * Fault points for testing both sides of the durable write.
 *
 * Injecting a failure *between* the output insert and the transition is the
 * only way to prove they are one transaction. Without it, a test that throws
 * before the output passes equally well against a two-transaction
 * implementation — which is exactly what a mutation revealed.
 */
export interface StageFaultInjector {
  readonly beforeWork?: (() => Promise<void>) | undefined;
  readonly afterOutput?: (() => Promise<void>) | undefined;
  readonly afterTransition?: (() => Promise<void>) | undefined;
}

export class ReviewStageStore {
  readonly #pool: PgPool;
  readonly #now: () => Date;
  readonly #faults: StageFaultInjector;

  public constructor(
    pool: PgPool,
    now: () => Date = () => new Date(),
    faults: StageFaultInjector = {},
  ) {
    this.#pool = pool;
    this.#now = now;
    this.#faults = faults;
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

  /**
   * Produces a stage's output and advances the run, in one transaction.
   *
   * `produce` is called *inside* the transaction, is handed the transaction's
   * own client, and may run several times across retries — it must be
   * deterministic and its writes must converge, which is what every unique key
   * in `0003` is for.
   *
   * It receives the client so that work which cannot be expressed as plain rows
   * — promotion, which must check the verification behind each candidate, and
   * policy, which must record a decision before a publication may cite it —
   * commits in the same transaction as the transition. Doing that work outside
   * and passing the rows in was the alternative, and it is how the promotion
   * gate came to be bypassable: whatever a caller can assemble as a row, it can
   * assemble without asking permission.
   *
   * It must NOT be used for anything that talks to a model, a provider, or the
   * network. Those hold the run's row lock open for the duration.
   */
  public runStage(
    scope: TenantScope,
    runId: string,
    from: string,
    to: string,
    produce: (client: PgClient) => StageWork | Promise<StageWork>,
    prerequisites: readonly (
      "candidates" | "verifications" | "every_candidate_examined" | "findings"
    )[] = [],
    options?: {
      /**
       * The revision the caller's work describes.
       *
       * Supplied by any stage whose output is revision-specific — which is all
       * of them once a real analyzer is involved.
       */
      readonly expectedRevisionId?: string | undefined;
      /** Coverage, written in the same transaction as the transition. */
      readonly coverage?: AnalysisCoverage | undefined;
    },
  ): Promise<StageOutcome> {
    if (!canTransition(from as ReviewRunState, to as ReviewRunState)) {
      return Promise.resolve({ kind: "illegal", from, to });
    }

    return this.#inTransaction(async (client) => {
      // The run is locked for the duration, so a concurrent worker blocks here
      // rather than producing a second copy of this stage's output.
      const current = await client.query<{
        state: string;
        revision_id: string;
      }>(
        "SELECT state, revision_id FROM review_runs WHERE id = $1 FOR UPDATE",
        [runId],
      );
      const state = current.rows[0]?.state;
      if (state !== from) {
        return { kind: "refused", actualState: state };
      }

      // The identity the work was done against, re-checked at commit rather
      // than before the work started.
      //
      // Analysis takes seconds to minutes. Checking that a run is current and
      // then analyzing is a classic time-of-check/time-of-use race: by the time
      // the result is written, a new push may have superseded the revision the
      // findings describe. Publishing them anyway means commenting on code that
      // is no longer there.
      //
      // Checked inside the transaction that commits the result, so it either
      // holds at commit time or the stage fails closed.
      const expected = options?.expectedRevisionId;
      if (expected !== undefined && current.rows[0]?.revision_id !== expected) {
        return {
          kind: "stale",
          expectedRevisionId: expected,
          actualRevisionId: current.rows[0]?.revision_id,
        };
      }

      // Defence in depth. Under the atomic design this cannot fail; it exists
      // for the day the design is broken by someone else.
      for (const prerequisite of prerequisites) {
        // `verifications` resolves to `verification_attempts`, and only to
        // *completed* ones. The legacy `verifications` table this used to point
        // at is gone (0007): it held one row per candidate forever, so a second
        // verification of a candidate was silently discarded — and while it
        // existed, "the run has been verified" could be satisfied by a table
        // the P1-I guarantees say nothing about.
        //
        // `status = 'completed'` matters as much as the table name. An
        // `unavailable` attempt has examined nothing, and counting it here
        // would let a verifier outage satisfy the prerequisite that exists to
        // notice one.
        // `every_candidate_examined` counts what is MISSING; the others count
        // what is present. Two shapes rather than one, because forcing this
        // entailment into "is the count non-zero?" is what a `count(*) > 0`
        // check on `verification_attempts` already is — and that check passes
        // when one candidate out of twenty was verified, which is precisely the
        // partial-review semantics this stage must not acquire by accident.
        const [query, failWhenZero] =
          prerequisite === "candidates"
            ? [
                "SELECT count(*)::text AS count FROM candidate_findings WHERE review_run_id = $1",
                true,
              ]
            : prerequisite === "verifications"
              ? [
                  `SELECT count(*)::text AS count FROM verification_attempts
                    WHERE review_run_id = $1 AND status = 'completed'`,
                  true,
                ]
              : prerequisite === "every_candidate_examined"
                ? [
                    // Candidates with no completed attempt. `unavailable` does
                    // not count as examined: it has looked at nothing, and
                    // letting it satisfy this is how a verifier outage renders
                    // as a clean review.
                    `SELECT count(*)::text AS count
                       FROM candidate_findings c
                      WHERE c.review_run_id = $1
                        AND NOT EXISTS (
                          SELECT 1 FROM verification_attempts v
                           WHERE v.candidate_finding_id = c.id
                             AND v.status = 'completed'
                        )`,
                    false,
                  ]
                : [
                    "SELECT count(*)::text AS count FROM review_findings WHERE review_run_id = $1",
                    true,
                  ];

        const count = Number(
          (await client.query<{ count: string }>(query, [runId])).rows[0]
            ?.count ?? 0,
        );
        if (failWhenZero === true ? count === 0 : count > 0) {
          return { kind: "prerequisite_missing", state, missing: prerequisite };
        }
      }

      await this.#faults.beforeWork?.();

      const work = await produce(client);
      const now = this.#now();

      for (const candidate of work.candidates ?? []) {
        await client.query(
          `INSERT INTO candidate_findings (
             id, organization_id, repository_id, review_run_id,
             producer_id, producer_version, input_digest,
             title, claim, explanation, category, proposed_severity,
             path, start_line, end_line, fingerprint_value, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (review_run_id, fingerprint_value) DO NOTHING`,
          [
            randomUUID(),
            scope.organizationId,
            scope.repositoryId,
            runId,
            candidate.producerId,
            candidate.producerVersion,
            candidate.inputDigest,
            candidate.title,
            candidate.claim,
            candidate.explanation,
            candidate.category,
            candidate.proposedSeverity,
            candidate.path,
            candidate.startLine,
            candidate.endLine,
            candidate.fingerprintValue,
            now,
          ],
        );
      }

      for (const publication of work.publications ?? []) {
        // `DO UPDATE` so the row is returned on conflict, and the digest that
        // comes back is the STORED one. Comparing it here is the enforcement of
        // the ledger's central invariant: a stable logical key carrying changed
        // content is not a retry, it is a claim that the same external effect
        // means two different things — and the effect may already be visible
        // externally carrying the other one.
        //
        // The previous version of this statement did the `DO UPDATE` and threw
        // the result away, so the comment claimed a check that no code
        // performed.
        const upserted = await client.query<{ content_digest: string }>(
          `INSERT INTO publication_intents (
             id, organization_id, review_run_id, provider, pull_request_id,
             revision_id, kind, logical_key, content_digest, state,
             review_finding_id, publication_decision_id,
             created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned',$10,$11,$12,$12)
           ON CONFLICT (review_run_id, logical_key)
             DO UPDATE SET updated_at = publication_intents.updated_at
           RETURNING content_digest`,
          [
            randomUUID(),
            scope.organizationId,
            runId,
            publication.provider,
            publication.pullRequestId ?? null,
            publication.revisionId ?? null,
            publication.kind,
            publication.logicalKey,
            publication.contentDigest,
            publication.reviewFindingId ?? null,
            publication.publicationDecisionId ?? null,
            now,
          ],
        );

        const stored = upserted.rows[0]?.content_digest;
        if (stored !== undefined && stored !== publication.contentDigest) {
          throw new PublicationContentConflict(
            publication.logicalKey,
            stored,
            publication.contentDigest,
          );
        }
      }

      // Between the output and the transition: the window that decides whether
      // `state = analyzing` entails candidates exist.
      await this.#faults.afterOutput?.();

      const coverage = options?.coverage;
      if (coverage !== undefined) {
        await client.query(
          `UPDATE review_runs
              SET analysis_clusters_total = $2,
                  analysis_clusters_analyzed = $3,
                  analysis_clusters_skipped = $4,
                  analysis_context_tokens = $5,
                  analysis_complete = $6,
                  analysis_stop_reason = $7
            WHERE id = $1`,
          [
            runId,
            coverage.clustersTotal,
            coverage.clustersAnalyzed,
            coverage.clustersSkipped,
            coverage.contextTokens,
            coverage.complete,
            coverage.stopReason ?? null,
          ],
        );
      }

      await client.query(
        `UPDATE review_runs
            SET state = $2,
                started_at = CASE WHEN $2 = 'preparing' AND started_at IS NULL
                                  THEN $3 ELSE started_at END,
                completed_at = CASE WHEN $2 IN ('completed','failed','cancelled','superseded')
                                    THEN $3 ELSE completed_at END
          WHERE id = $1`,
        [runId, to, now],
      );

      await client.query(
        `INSERT INTO review_run_transitions (run_id, seq, from_state, to_state, at)
         SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4
           FROM review_run_transitions WHERE run_id = $1`,
        [runId, from, to, now],
      );

      await this.#faults.afterTransition?.();

      return { kind: "advanced", state: to };
    });
  }

  /** Everything a run produced. For assertions and for recovery. */
  public async readOutputs(runId: string): Promise<{
    readonly candidates: readonly { id: string; fingerprintValue: string }[];
    readonly verifications: readonly {
      candidateFindingId: string;
      attempt: number;
      status: string;
      decision: string | null;
    }[];
    readonly findings: readonly {
      id: string;
      fingerprintValue: string;
      severity: string;
      state: string;
      verificationAttemptId: string | null;
    }[];
    readonly publications: readonly {
      logicalKey: string;
      state: string;
      contentDigest: string;
      reviewFindingId: string | null;
    }[];
  }> {
    const client = await this.#pool.connect();
    try {
      const candidates = await client.query<{
        id: string;
        fingerprint_value: string;
      }>(
        "SELECT id, fingerprint_value FROM candidate_findings WHERE review_run_id = $1 ORDER BY fingerprint_value",
        [runId],
      );
      // Every attempt, not one per candidate. The audit trail is the point:
      // "verifier v4 rejected it, v5 verified it after a bug fix" has to stay
      // readable, and a query that collapsed to the latest would hide exactly
      // the history that makes the verifier improvable.
      const verifications = await client.query<{
        candidate_finding_id: string;
        attempt: number;
        status: string;
        decision: string | null;
      }>(
        `SELECT candidate_finding_id, attempt, status, decision
           FROM verification_attempts
          WHERE review_run_id = $1
          ORDER BY candidate_finding_id, attempt`,
        [runId],
      );
      const findings = await client.query<{
        id: string;
        fingerprint_value: string;
        severity: string;
        state: string;
        verification_attempt_id: string | null;
      }>(
        `SELECT id, fingerprint_value, severity, state, verification_attempt_id
           FROM review_findings WHERE review_run_id = $1 ORDER BY fingerprint_value`,
        [runId],
      );
      const publications = await client.query<{
        logical_key: string;
        state: string;
        content_digest: string;
        review_finding_id: string | null;
      }>(
        `SELECT logical_key, state, content_digest, review_finding_id
           FROM publication_intents WHERE review_run_id = $1 ORDER BY logical_key`,
        [runId],
      );

      return {
        candidates: candidates.rows.map((row) => ({
          id: row.id,
          fingerprintValue: row.fingerprint_value,
        })),
        verifications: verifications.rows.map((row) => ({
          candidateFindingId: row.candidate_finding_id,
          attempt: row.attempt,
          status: row.status,
          decision: row.decision,
        })),
        findings: findings.rows.map((row) => ({
          id: row.id,
          fingerprintValue: row.fingerprint_value,
          severity: row.severity,
          state: row.state,
          verificationAttemptId: row.verification_attempt_id,
        })),
        publications: publications.rows.map((row) => ({
          logicalKey: row.logical_key,
          state: row.state,
          contentDigest: row.content_digest,
          reviewFindingId: row.review_finding_id,
        })),
      };
    } finally {
      client.release();
    }
  }
}
