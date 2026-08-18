import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ReviewIngestionStore,
  ReviewStageStore,
  type TenantScope,
} from "@acalys/database";
import {
  allocateBudget,
  runAnalysis,
  type AnalysisResult,
  type RiskCluster,
} from "@acalys/review-engine";
import {
  assertSuiteIsActuallyRunning,
  dockerAvailable,
  startPostgres,
  type TestDatabase,
} from "../../../packages/database/tests/postgres.js";

const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER
  ? describe
  : describe.skip.bind(describe);

if (!HAS_DOCKER) {
  console.warn("\n  ⚠ Docker unavailable — lifecycle hardening SKIPPED.\n");
}

/**
 * The engine, proven where it actually runs.
 *
 * The analyzer being correct in isolation is not the claim that matters. These
 * are the properties that decide whether a correct analyzer produces a correct
 * *review*: what happens when the work is cancelled, when a new push arrives
 * mid-analysis, when the engine throws, when a worker retries, and when the
 * budget runs out.
 *
 * Real Postgres, because every one of them is a transaction or a race, and an
 * in-memory double cannot fail in the way that matters.
 */
describeWithPostgres("The engine inside the ReviewRun lifecycle", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startPostgres("hardening");
    await assertSuiteIsActuallyRunning(database, [
      "review_runs",
      "candidate_findings",
    ]);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  });

  beforeEach(async () => {
    await database.reset();
  });

  const ORG = "0192f8a1-0000-7000-8000-00000000000a";
  const REPO = "0192f8a1-0000-7000-8000-0000000000aa";
  const PR = "0192f8a1-0000-7000-8000-0000000000c1";
  const scope: TenantScope = { organizationId: ORG, repositoryId: REPO };
  const now = new Date("2026-08-18T00:00:00.000Z");
  const clock = () => now;

  const stores = () => ({
    ingestion: new ReviewIngestionStore(database.pool, clock),
    stages: new ReviewStageStore(database.pool, clock),
  });

  async function seed(headSha: string): Promise<{
    runId: string;
    revisionId: string;
  }> {
    const { ingestion } = stores();
    await database.pool.query(
      "INSERT INTO organizations (id, slug, name) VALUES ($1,'acme','Acme') ON CONFLICT DO NOTHING",
      [ORG],
    );
    await database.pool.query(
      `INSERT INTO repositories (id, organization_id, provider, provider_external_id,
         owner, name, default_branch, visibility)
       VALUES ($1,$2,'github','1296269','acalys','acalys','main','private')
       ON CONFLICT DO NOTHING`,
      [REPO, ORG],
    );
    await database.pool.query(
      `INSERT INTO pull_requests (id, organization_id, repository_id, provider,
         provider_external_id, number, title, author, state, draft, created_at, updated_at)
       VALUES ($1,$2,$3,'github','2145998877',412,'t','{"kind":"human"}'::jsonb,'open',false,$4,$4)
       ON CONFLICT DO NOTHING`,
      [PR, ORG, REPO, now],
    );

    const revision = await ingestion.upsertRevision(scope, {
      pullRequestId: PR,
      headSha,
      headRef: "feature",
      baseSha: "b".repeat(40),
      baseRef: "main",
      mergeBaseSha: null,
      trigger: "push",
      createdAt: now,
    });
    const request = await ingestion.upsertReviewRequest(scope, {
      pullRequestId: PR,
      revisionId: revision.id,
      target: { kind: "pull_request" },
      trigger: "pull_request_updated",
      requestedBy: { kind: "system", component: "test" },
      executionMode: "review",
      executionStrategy: "single",
      idempotencyKey: randomUUID(),
      requestedAt: now,
    });
    const run = await ingestion.upsertReviewRun(scope, {
      requestId: request.id,
      revisionId: revision.id,
      attempt: 1,
      executionMode: "review",
      executionStrategy: "single",
      createdAt: now,
    });

    await ingestion.transition(run.id, "queued", "preparing");
    await ingestion.transition(run.id, "preparing", "analyzing");
    return { runId: run.id, revisionId: revision.id };
  }

  const cluster = (id: string): RiskCluster => ({
    id,
    subject: [{ path: `src/${id}.ts`, changedLines: [1] }],
    changedSymbols: [],
    context: [],
    mandatory: [],
  });

  const nothing = (): AnalysisResult => ({
    findings: [],
    suppressions: [],
    degradations: [],
  });

  // ── 1. cancellation ──────────────────────────────────────────────────────
  it("stops starting work when cancellation arrives between clusters", async () => {
    const clusters = Array.from({ length: 8 }, (_u, i) =>
      cluster(`c${String(i)}`),
    );
    let started = 0;
    let cancelled = false;

    const report = await runAnalysis(
      clusters,
      clusters.map((c) => allocateBudget(c)),
      {
        limits: { concurrency: 1 },
        cancellation: { cancelled: () => cancelled, reason: "user cancelled" },
        analyzer: () => {
          started += 1;
          // Cancellation lands *during* cluster 2, so the race under test is
          // whether cluster 3 starts anyway.
          if (started === 2) cancelled = true;
          return nothing();
        },
      },
    );

    // The running unit finished; nothing further began.
    expect(started).toBe(2);
    expect(report.analyzed).toBe(2);
    expect(report.degradations.every((d) => d.reason === "cancelled")).toBe(
      true,
    );
    expect(report.degradations).toHaveLength(6);
    expect(report.complete).toBe(false);
  }, 60_000);

  // ── 2. supersession ──────────────────────────────────────────────────────
  it("refuses to commit findings for a run superseded before analysis finished", async () => {
    const { runId } = await seed("a".repeat(40));
    const { ingestion, stages } = stores();

    // A new push supersedes the run while the analyzer is still working.
    expect(
      (await ingestion.transition(runId, "analyzing", "superseded")).kind,
    ).toBe("moved");

    const outcome = await stages.runStage(
      scope,
      runId,
      "analyzing",
      "reviewing",
      () => ({
        candidates: [
          {
            producerId: "acalys.correctness.async-completion",
            producerVersion: "1",
            inputDigest: "d".repeat(64),
            title: "t",
            claim: "c",
            explanation: "e",
            category: "correctness",
            proposedSeverity: "medium",
            path: "src/a.ts",
            startLine: 1,
            endLine: 1,
            fingerprintValue: "f".repeat(64),
          },
        ],
      }),
    );

    expect(outcome.kind).toBe("refused");
    const rows = await stages.readOutputs(runId);
    // Nothing was written: the work and the transition are one transaction.
    expect(rows.candidates).toEqual([]);
  }, 60_000);

  it("refuses to publish findings that describe a superseded revision", async () => {
    // The dangerous boundary: the findings exist and look publishable, and the
    // only thing standing between them and someone's pull request is that the
    // run is no longer current.
    const { runId } = await seed("a".repeat(40));
    const { ingestion, stages } = stores();

    await stages.runStage(scope, runId, "analyzing", "reviewing", () => ({
      candidates: [
        {
          producerId: "acalys.correctness.async-completion",
          producerVersion: "1",
          inputDigest: "d".repeat(64),
          title: "t",
          claim: "c",
          explanation: "e",
          category: "correctness",
          proposedSeverity: "medium",
          path: "src/a.ts",
          startLine: 1,
          endLine: 1,
          fingerprintValue: "f".repeat(64),
        },
      ],
    }));

    expect((await stages.readOutputs(runId)).candidates).toHaveLength(1);
    expect(
      (await ingestion.transition(runId, "reviewing", "superseded")).kind,
    ).toBe("moved");

    // Every remaining path to publication is closed.
    expect(
      (await ingestion.transition(runId, "reviewing", "verifying")).kind,
    ).toBe("refused");
    expect(
      (await ingestion.transition(runId, "superseded", "publishing")).kind,
    ).toBe("illegal");

    const publications = await database.pool.query(
      "SELECT 1 FROM publication_intents WHERE review_run_id = $1",
      [runId],
    );
    expect(publications.rowCount).toBe(0);
  }, 60_000);

  // ── 3. stale results at commit time ──────────────────────────────────────
  it("rejects work committed against a revision the run no longer points at", async () => {
    // The TOCTOU the check exists for: analysis takes seconds to minutes, and
    // checking currency *before* the work is no protection at all.
    const { runId, revisionId } = await seed("a".repeat(40));
    const { ingestion, stages } = stores();

    const newer = await ingestion.upsertRevision(scope, {
      pullRequestId: PR,
      headSha: "c".repeat(40),
      headRef: "feature",
      baseSha: "b".repeat(40),
      baseRef: "main",
      mergeBaseSha: null,
      trigger: "push",
      createdAt: now,
    });
    await database.pool.query(
      "UPDATE review_runs SET revision_id = $2 WHERE id = $1",
      [runId, newer.id],
    );

    const outcome = await stages.runStage(
      scope,
      runId,
      "analyzing",
      "reviewing",
      () => ({}),
      [],
      { expectedRevisionId: revisionId },
    );

    expect(outcome.kind).toBe("stale");
    // The run did not advance: the analysis has to be redone, not re-committed.
    expect((await stores().ingestion.getRun(runId))?.state).toBe("analyzing");
  }, 60_000);

  it("commits when the revision still matches", async () => {
    // The other half — a guard that always refuses would pass the test above
    // and break the product.
    const { runId, revisionId } = await seed("a".repeat(40));
    const outcome = await stores().stages.runStage(
      scope,
      runId,
      "analyzing",
      "reviewing",
      () => ({}),
      [],
      { expectedRevisionId: revisionId },
    );
    expect(outcome.kind).toBe("advanced");
  }, 60_000);

  // ── 4. engine failure ────────────────────────────────────────────────────
  it("takes the existing legal failure path when the engine throws", async () => {
    const { runId } = await seed("a".repeat(40));
    const { ingestion, stages } = stores();

    await expect(
      stages.runStage(scope, runId, "analyzing", "reviewing", () => {
        throw new Error("engine exploded");
      }),
    ).rejects.toThrow("engine exploded");

    // No new lifecycle state was invented for this; the run is untouched and
    // the existing failure transition is the only exit.
    expect((await ingestion.getRun(runId))?.state).toBe("analyzing");
    expect((await stages.readOutputs(runId)).candidates).toEqual([]);
    expect(
      (await ingestion.transition(runId, "analyzing", "failed")).kind,
    ).toBe("moved");
  }, 60_000);

  // ── 5. retry idempotency ─────────────────────────────────────────────────
  it("does not duplicate findings when a worker retries the same stage", async () => {
    const { runId } = await seed("a".repeat(40));
    const { ingestion, stages } = stores();

    const candidate = {
      producerId: "acalys.correctness.async-completion",
      producerVersion: "1",
      inputDigest: "d".repeat(64),
      title: "t",
      claim: "c",
      explanation: "e",
      category: "correctness",
      proposedSeverity: "medium",
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      fingerprintValue: "f".repeat(64),
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await database.pool.query(
        "UPDATE review_runs SET state = 'analyzing' WHERE id = $1",
        [runId],
      );
      const outcome = await stages.runStage(
        scope,
        runId,
        "analyzing",
        "reviewing",
        () => ({ candidates: [candidate] }),
      );
      // Asserted, so a refusal cannot make this pass without exercising the
      // insert it is testing.
      expect(outcome.kind).toBe("advanced");
    }

    expect((await stages.readOutputs(runId)).candidates).toHaveLength(1);
    expect((await ingestion.getRun(runId))?.attempt).toBe(1);
  }, 60_000);

  // ── 6. budget exhaustion is explicit ─────────────────────────────────────
  it("records bounded coverage, so an incomplete review is not read as a clean one", async () => {
    const { runId } = await seed("a".repeat(40));
    const { stages } = stores();

    const clusters = Array.from({ length: 10 }, (_u, i) =>
      cluster(`c${String(i)}`),
    );
    const report = await runAnalysis(
      clusters,
      clusters.map((c) => allocateBudget(c)),
      { limits: { maxClusters: 3 }, analyzer: () => nothing() },
    );
    expect(report.complete).toBe(false);

    await stages.runStage(
      scope,
      runId,
      "analyzing",
      "reviewing",
      () => ({}),
      [],
      {
        coverage: {
          clustersTotal: clusters.length,
          clustersAnalyzed: report.analyzed,
          clustersSkipped: report.skipped,
          contextTokens: report.contextTokensSpent,
          complete: report.complete,
          stopReason: report.degradations[0]?.reason ?? "unknown",
        },
      },
    );

    const row = await database.pool.query<{
      analysis_complete: boolean;
      analysis_clusters_total: number;
      analysis_clusters_analyzed: number;
      analysis_clusters_skipped: number;
      analysis_stop_reason: string;
    }>(
      `SELECT analysis_complete, analysis_clusters_total, analysis_clusters_analyzed,
              analysis_clusters_skipped, analysis_stop_reason
         FROM review_runs WHERE id = $1`,
      [runId],
    );

    // "Analysis completed" and "analysis completed with bounded coverage" are
    // materially different claims, and without this they are the same row.
    expect(row.rows[0]?.analysis_complete).toBe(false);
    expect(row.rows[0]?.analysis_clusters_total).toBe(10);
    expect(row.rows[0]?.analysis_clusters_analyzed).toBe(3);
    expect(row.rows[0]?.analysis_clusters_skipped).toBe(7);
    expect(row.rows[0]?.analysis_stop_reason).toBe("cluster_cap_reached");
  }, 60_000);

  it("refuses a coverage record that is bounded but gives no reason", async () => {
    // Enforced by the database: "bounded, reason unknown" is a record nobody
    // can act on, and it would be written by exactly the code path that is in
    // a hurry.
    const { runId } = await seed("a".repeat(40));
    await expect(
      database.pool.query(
        `UPDATE review_runs
            SET analysis_complete = false, analysis_clusters_total = 1,
                analysis_clusters_analyzed = 0, analysis_clusters_skipped = 1,
                analysis_stop_reason = NULL
          WHERE id = $1`,
        [runId],
      ),
    ).rejects.toThrow(/review_runs_incomplete_has_reason/);
  }, 60_000);

  it("refuses a half-written coverage record", async () => {
    const { runId } = await seed("a".repeat(40));
    await expect(
      database.pool.query(
        "UPDATE review_runs SET analysis_complete = true WHERE id = $1",
        [runId],
      ),
    ).rejects.toThrow(/review_runs_coverage_is_whole/);
  }, 60_000);
});
