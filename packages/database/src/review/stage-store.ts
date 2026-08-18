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

export interface VerificationRow {
  readonly candidateFindingId: string;
  readonly decision: "verified" | "rejected" | "inconclusive";
  readonly reasonCodes: readonly string[];
  readonly confidenceScore: number;
  readonly confidenceLevel: string;
  readonly verifierId: string;
  readonly verifierVersion: string;
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
  | { readonly kind: "refused"; readonly actualState: string | undefined }
  | { readonly kind: "illegal"; readonly from: string; readonly to: string }
  | {
      readonly kind: "prerequisite_missing";
      readonly state: string;
      readonly missing: string;
    };

/** What a stage produces. Called inside the transaction. */
export interface StageWork {
  readonly candidates?: readonly CandidateFindingRow[] | undefined;
  readonly verifications?: readonly VerificationRow[] | undefined;
  readonly findings?:
    | readonly (CandidateFindingRow & {
        readonly confidenceScore: number;
        readonly confidenceLevel: string;
        readonly severity: string;
      })[]
    | undefined;
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
   * `produce` is called *inside* the transaction and may run several times
   * across retries — it must be deterministic and its writes must converge,
   * which is what every unique key in `0003` is for.
   */
  public runStage(
    scope: TenantScope,
    runId: string,
    from: string,
    to: string,
    produce: () => StageWork,
    prerequisites: readonly (
      "candidates" | "verifications" | "findings"
    )[] = [],
  ): Promise<StageOutcome> {
    if (!canTransition(from as ReviewRunState, to as ReviewRunState)) {
      return Promise.resolve({ kind: "illegal", from, to });
    }

    return this.#inTransaction(async (client) => {
      // The run is locked for the duration, so a concurrent worker blocks here
      // rather than producing a second copy of this stage's output.
      const current = await client.query<{ state: string }>(
        "SELECT state FROM review_runs WHERE id = $1 FOR UPDATE",
        [runId],
      );
      const state = current.rows[0]?.state;
      if (state !== from) {
        return { kind: "refused", actualState: state };
      }

      // Defence in depth. Under the atomic design this cannot fail; it exists
      // for the day the design is broken by someone else.
      for (const prerequisite of prerequisites) {
        const table =
          prerequisite === "candidates"
            ? "candidate_findings"
            : prerequisite === "verifications"
              ? "verifications"
              : "review_findings";
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE review_run_id = $1`,
          [runId],
        );
        if (Number(count.rows[0]?.count ?? 0) === 0) {
          return { kind: "prerequisite_missing", state, missing: prerequisite };
        }
      }

      await this.#faults.beforeWork?.();

      const work = produce();
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

      for (const verification of work.verifications ?? []) {
        await client.query(
          `INSERT INTO verifications (
             id, organization_id, review_run_id, candidate_finding_id,
             decision, reason_codes, confidence_score, confidence_level,
             verifier_id, verifier_version, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (candidate_finding_id) DO NOTHING`,
          [
            randomUUID(),
            scope.organizationId,
            runId,
            verification.candidateFindingId,
            verification.decision,
            JSON.stringify(verification.reasonCodes),
            verification.confidenceScore,
            verification.confidenceLevel,
            verification.verifierId,
            verification.verifierVersion,
            now,
          ],
        );
      }

      for (const finding of work.findings ?? []) {
        await client.query(
          `INSERT INTO review_findings (
             id, organization_id, repository_id, review_run_id,
             fingerprint_value, severity, category, confidence_score,
             confidence_level, title, explanation, path, start_line, end_line,
             state, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'verified',$15,$15)
           ON CONFLICT (review_run_id, fingerprint_value) DO NOTHING`,
          [
            randomUUID(),
            scope.organizationId,
            scope.repositoryId,
            runId,
            finding.fingerprintValue,
            finding.severity,
            finding.category,
            finding.confidenceScore,
            finding.confidenceLevel,
            finding.title,
            finding.explanation,
            finding.path,
            finding.startLine,
            finding.endLine,
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
             created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned',$10,$10)
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
      decision: string;
    }[];
    readonly findings: readonly {
      fingerprintValue: string;
      severity: string;
    }[];
    readonly publications: readonly {
      logicalKey: string;
      state: string;
      contentDigest: string;
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
      const verifications = await client.query<{
        candidate_finding_id: string;
        decision: string;
      }>(
        "SELECT candidate_finding_id, decision FROM verifications WHERE review_run_id = $1 ORDER BY candidate_finding_id",
        [runId],
      );
      const findings = await client.query<{
        fingerprint_value: string;
        severity: string;
      }>(
        "SELECT fingerprint_value, severity FROM review_findings WHERE review_run_id = $1 ORDER BY fingerprint_value",
        [runId],
      );
      const publications = await client.query<{
        logical_key: string;
        state: string;
        content_digest: string;
      }>(
        "SELECT logical_key, state, content_digest FROM publication_intents WHERE review_run_id = $1 ORDER BY logical_key",
        [runId],
      );

      return {
        candidates: candidates.rows.map((row) => ({
          id: row.id,
          fingerprintValue: row.fingerprint_value,
        })),
        verifications: verifications.rows.map((row) => ({
          candidateFindingId: row.candidate_finding_id,
          decision: row.decision,
        })),
        findings: findings.rows.map((row) => ({
          fingerprintValue: row.fingerprint_value,
          severity: row.severity,
        })),
        publications: publications.rows.map((row) => ({
          logicalKey: row.logical_key,
          state: row.state,
          contentDigest: row.content_digest,
        })),
      };
    } finally {
      client.release();
    }
  }
}
