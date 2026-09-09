import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ModelBudgetReservationStore,
  ReviewIngestionStore,
  type ModelBudgetLimits,
} from "../src/index.js";
import {
  assertSuiteIsActuallyRunning,
  dockerAvailable,
  startPostgres,
  type TestDatabase,
} from "./postgres.js";

const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER
  ? describe
  : describe.skip.bind(describe);

if (!HAS_DOCKER) {
  console.warn("\n  ⚠ Docker unavailable — model budget reservation tests SKIPPED.\n");
}

describeWithPostgres("Model budget reservations are atomic and conservative", () => {
  let database: TestDatabase;

  const ORG = "0192f8a1-0000-7000-8000-00000000000a";
  const REPO = "0192f8a1-0000-7000-8000-0000000000aa";
  const PR = "0192f8a1-0000-7000-8000-0000000000c1";
  const now = new Date("2026-09-08T00:00:00.000Z");

  const baseLimits: ModelBudgetLimits = {
    maxCallsPerRun: 10,
    maxCostMicroUsdPerCall: 1_000,
    maxCostMicroUsdPerRun: 10_000,
    maxCostMicroUsdPerOrganization: 10_000,
    organizationWindowMs: 60_000,
  };

  beforeAll(async () => {
    database = await startPostgres("model_budget");
    await assertSuiteIsActuallyRunning(database, [
      "model_interactions",
      "model_budget_reservations",
      "review_runs",
    ]);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(
      "INSERT INTO organizations (id, slug, name) VALUES ($1,'acme','Acme')",
      [ORG],
    );
    await database.pool.query(
      `INSERT INTO repositories (
         id, organization_id, provider, provider_external_id,
         owner, name, default_branch, visibility
       ) VALUES ($1,$2,'github','repo-1','acme','repo','main','private')`,
      [REPO, ORG],
    );
    await database.pool.query(
      `INSERT INTO pull_requests (
         id, organization_id, repository_id, provider, provider_external_id,
         number, title, author, state, draft, created_at, updated_at
       ) VALUES (
         $1,$2,$3,'github','pr-1',1,'budget test',
         '{"kind":"human"}'::jsonb,'open',false,$4,$4
       )`,
      [PR, ORG, REPO, now],
    );
  });

  async function seedRun(key: string, head: string): Promise<string> {
    const ingestion = new ReviewIngestionStore(database.pool, () => now);
    const scope = { organizationId: ORG, repositoryId: REPO };
    const revision = await ingestion.upsertRevision(scope, {
      pullRequestId: PR,
      headSha: head.repeat(40),
      headRef: `feature/${key}`,
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
      requestedBy: { kind: "system", component: "model-budget-test" },
      executionMode: "review",
      executionStrategy: "single",
      idempotencyKey: key,
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
    return run.id;
  }

  function reserve(
    reviewRunId: string,
    requestedCostMicroUsd: number,
    limits: ModelBudgetLimits,
  ) {
    return new ModelBudgetReservationStore(database.pool).reserve({
      scope: { organizationId: ORG, reviewRunId },
      limits,
      requestedCostMicroUsd,
      at: now,
    });
  }

  it("serializes concurrent reservations so one run cannot exceed its cost ceiling", async () => {
    const runId = await seedRun("run-race", "a");
    const limits = {
      ...baseLimits,
      maxCostMicroUsdPerRun: 100,
    };

    const results = await Promise.all([
      reserve(runId, 60, limits),
      reserve(runId, 60, limits),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      "budget_exceeded",
      "reserved",
    ]);
    const winner = results.find((result) => result.kind === "reserved");
    if (winner?.kind === "reserved") await winner.reservation.release();
  });

  it("serializes concurrent runs so one organization cannot exceed its rolling ceiling", async () => {
    const firstRun = await seedRun("org-race-a", "a");
    const secondRun = await seedRun("org-race-b", "c");
    const limits = {
      ...baseLimits,
      maxCostMicroUsdPerOrganization: 100,
    };

    const results = await Promise.all([
      reserve(firstRun, 60, limits),
      reserve(secondRun, 60, limits),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      "budget_exceeded",
      "reserved",
    ]);
    const winner = results.find((result) => result.kind === "reserved");
    if (winner?.kind === "reserved") await winner.reservation.release();
  });

  it("expires an abandoned reservation only when provider dispatch never started", async () => {
    const runId = await seedRun("pre-dispatch-expiry", "a");
    const limits = {
      ...baseLimits,
      maxCostMicroUsdPerRun: 100,
    };
    const first = await reserve(runId, 100, limits);
    expect(first.kind).toBe("reserved");

    await database.pool.query(
      `UPDATE model_budget_reservations
          SET reserved_at = clock_timestamp() - interval '2 minutes',
              expires_at = clock_timestamp() - interval '1 minute'
        WHERE review_run_id = $1`,
      [runId],
    );

    const replacement = await reserve(runId, 100, limits);
    expect(replacement.kind).toBe("reserved");
    if (replacement.kind === "reserved") await replacement.reservation.release();
  });

  it("keeps an unresolved post-dispatch reservation conservative after expiry", async () => {
    const runId = await seedRun("post-dispatch-expiry", "a");
    const limits = {
      ...baseLimits,
      maxCostMicroUsdPerRun: 100,
    };
    const first = await reserve(runId, 100, limits);
    expect(first.kind).toBe("reserved");
    if (first.kind !== "reserved") return;
    await first.reservation.markDispatched();

    await database.pool.query(
      `UPDATE model_budget_reservations
          SET reserved_at = clock_timestamp() - interval '2 minutes',
              expires_at = clock_timestamp() - interval '1 minute'
        WHERE review_run_id = $1`,
      [runId],
    );

    const second = await reserve(runId, 1, limits);
    expect(second.kind).toBe("budget_exceeded");
    await first.reservation.release();
  });

  it("releases known spend reservations so later calls can use the ceiling", async () => {
    const runId = await seedRun("release", "a");
    const limits = {
      ...baseLimits,
      maxCostMicroUsdPerRun: 100,
    };
    const first = await reserve(runId, 100, limits);
    expect(first.kind).toBe("reserved");
    if (first.kind !== "reserved") return;

    await first.reservation.release();
    const second = await reserve(runId, 100, limits);
    expect(second.kind).toBe("reserved");
    if (second.kind === "reserved") await second.reservation.release();
  });

  it("counts both active reservations and committed provider dispatches against maxCallsPerRun", async () => {
    const runId = await seedRun("call-ceiling", "a");
    const limits = {
      ...baseLimits,
      maxCallsPerRun: 1,
    };

    const active = await reserve(runId, 1, limits);
    expect(active.kind).toBe("reserved");
    expect((await reserve(runId, 1, limits)).kind).toBe("budget_exceeded");
    if (active.kind === "reserved") await active.reservation.release();

    await database.pool.query(
      `INSERT INTO model_interactions (
         id, organization_id, review_run_id, request_digest, provider, model_id,
         task_class, tier, routing_policy_version, prompt_template_version,
         outcome, input_tokens, output_tokens, cached_input_tokens,
         cache_creation_input_tokens, cost_microusd, cache_hit, replayed,
         provider_dispatched, started_at, finished_at
       ) VALUES (
         $1,$2,$3,$4,'openai','test-model','correctness','strong','route-v1','prompt-v1',
         'ok',1,1,0,0,1,false,false,true,clock_timestamp(),clock_timestamp()
       )`,
      [randomUUID(), ORG, runId, "d".repeat(64)],
    );

    expect((await reserve(runId, 1, limits)).kind).toBe("budget_exceeded");
  });
});
