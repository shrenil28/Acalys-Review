import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiMutationStore, type IdempotencyIdentity } from "../src/index.js";
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
  console.warn(
    "\n  ⚠ Docker unavailable — Phase 3 mutation-clock tests SKIPPED.\n",
  );
}

describeWithPostgres("Phase 3 mutation database-clock authority", () => {
  let database: TestDatabase;
  const ORG = "0192f8a1-0000-7000-8000-000000000711";
  const REPO = "0192f8a1-0000-7000-8000-000000000712";
  const PR = "0192f8a1-0000-7000-8000-000000000713";
  const REV = "0192f8a1-0000-7000-8000-000000000714";
  const seedTime = new Date("2026-09-09T00:00:00.000Z");

  beforeAll(async () => {
    database = await startPostgres("phase3_mutation_clock");
    await assertSuiteIsActuallyRunning(database, [
      "api_idempotency",
      "review_requests",
      "review_runs",
      "review_dispatch_jobs",
    ]);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(
      `INSERT INTO organizations(id,slug,name) VALUES($1,'mutation-clock','Mutation Clock')`,
      [ORG],
    );
    await database.pool.query(
      `INSERT INTO repositories
        (id,organization_id,provider,provider_external_id,owner,name,default_branch,visibility)
       VALUES($1,$2,'github','mutation-clock-repo','acalys','repo','main','private')`,
      [REPO, ORG],
    );
    await database.pool.query(
      `INSERT INTO pull_requests
        (id,organization_id,repository_id,provider,provider_external_id,number,title,author,state,draft,created_at,updated_at)
       VALUES($1,$2,$3,'github','mutation-clock-pr',7,'Clock PR','{"kind":"human"}'::jsonb,'open',false,$4,$4)`,
      [PR, ORG, REPO, seedTime],
    );
    await database.pool.query(
      `INSERT INTO pull_request_revisions
        (id,organization_id,repository_id,pull_request_id,sequence,head_sha,head_ref,base_sha,base_ref,merge_base_sha,trigger,created_at)
       VALUES($1,$2,$3,$4,1,$5,'feature',$6,'main',NULL,'push',$7)`,
      [REV, ORG, REPO, PR, "a".repeat(40), "b".repeat(40), seedTime],
    );
  });

  function identity(
    key: string,
    routeName = "createReview",
    requestDigest = "a".repeat(64),
  ): IdempotencyIdentity {
    return {
      organizationId: ORG,
      principalId: "key-mutation-clock",
      routeName,
      key,
      requestDigest,
    };
  }

  async function createReview(key: string) {
    const store = new ApiMutationStore(database.pool);
    return store.createReview({
      identity: identity(key),
      repositoryId: REPO,
      pullRequestId: PR,
      requestedBy: { kind: "api_key", id: "key-mutation-clock" },
      correlationId: `corr-${key}`,
    });
  }

  it("uses one Postgres timestamp for idempotency, request, run, dispatch, and the create response", async () => {
    const before = await database.pool.query<{ at: Date }>(
      "SELECT clock_timestamp() AS at",
    );
    const outcome = await createReview("mutation-clock-create");
    const after = await database.pool.query<{ at: Date }>(
      "SELECT clock_timestamp() AS at",
    );
    expect(outcome.kind).toBe("result");

    const timestamps = await database.pool.query<{
      idem_created: Date;
      idem_completed: Date;
      requested_at: Date;
      run_created: Date;
      available_at: Date;
      job_created: Date;
      job_updated: Date;
    }>(
      `SELECT i.created_at AS idem_created, i.completed_at AS idem_completed,
              q.requested_at, r.created_at AS run_created,
              j.available_at, j.created_at AS job_created, j.updated_at AS job_updated
         FROM api_idempotency i
         JOIN review_requests q ON q.organization_id=i.organization_id
         JOIN review_runs r ON r.organization_id=q.organization_id AND r.request_id=q.id
         JOIN review_dispatch_jobs j ON j.organization_id=r.organization_id AND j.review_run_id=r.id
        WHERE i.organization_id=$1 AND i.idempotency_key=$2`,
      [ORG, "mutation-clock-create"],
    );
    const row = timestamps.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const millis = [
      row.idem_created,
      row.idem_completed,
      row.requested_at,
      row.run_created,
      row.available_at,
      row.job_created,
      row.job_updated,
    ].map((value) => value.getTime());
    expect(new Set(millis).size).toBe(1);
    expect(millis[0]).toBeGreaterThanOrEqual(before.rows[0]?.at.getTime() ?? 0);
    expect(millis[0]).toBeLessThanOrEqual(
      after.rows[0]?.at.getTime() ?? Number.MAX_SAFE_INTEGER,
    );

    const body =
      outcome.kind === "result"
        ? (outcome.body as { createdAt: string })
        : undefined;
    expect(Date.parse(body?.createdAt ?? "")).toBe(millis[0]);
  });

  it("never moves review completion or transition history backward when durable state is already ahead", async () => {
    const created = await createReview("mutation-clock-cancel-seed");
    expect(created.kind).toBe("result");
    if (created.kind !== "result") return;
    const runId = (created.body as { id: string }).id;

    const future = await database.pool.query<{ started_at: Date }>(
      `UPDATE review_runs
          SET state='analyzing', started_at=clock_timestamp() + INTERVAL '1 day'
        WHERE organization_id=$1 AND id=$2
        RETURNING started_at`,
      [ORG, runId],
    );
    const futureStartedAt = future.rows[0]?.started_at;
    expect(futureStartedAt).toBeDefined();

    const store = new ApiMutationStore(database.pool);
    const cancelled = await store.cancelReview({
      identity: identity(
        "mutation-clock-cancel",
        "cancelReview",
        "b".repeat(64),
      ),
      reviewRunId: runId,
      reason: "clock monotonicity witness",
    });
    expect(cancelled.kind).toBe("result");

    const persisted = await database.pool.query<{
      completed_at: Date;
      transition_at: Date;
    }>(
      `SELECT r.completed_at, t.at AS transition_at
         FROM review_runs r
         JOIN review_run_transitions t ON t.run_id=r.id AND t.to_state='cancelled'
        WHERE r.organization_id=$1 AND r.id=$2`,
      [ORG, runId],
    );
    const row = persisted.rows[0];
    expect(row).toBeDefined();
    if (row === undefined || futureStartedAt === undefined) return;
    expect(row.completed_at.getTime()).toBeGreaterThanOrEqual(
      futureStartedAt.getTime(),
    );
    expect(row.transition_at.getTime()).toBe(row.completed_at.getTime());
    const body =
      cancelled.kind === "result"
        ? (cancelled.body as { completedAt: string })
        : undefined;
    expect(Date.parse(body?.completedAt ?? "")).toBe(
      row.completed_at.getTime(),
    );
  });

  it("converges concurrent same-key replicas on one database-timestamped response", async () => {
    const firstStore = new ApiMutationStore(database.pool);
    const secondStore = new ApiMutationStore(database.pool);
    const request = {
      identity: identity(
        "mutation-clock-concurrent",
        "createReview",
        "c".repeat(64),
      ),
      repositoryId: REPO,
      pullRequestId: PR,
      requestedBy: { kind: "api_key", id: "key-mutation-clock" },
      correlationId: "corr-concurrent",
    } as const;

    const results = await Promise.all([
      firstStore.createReview(request),
      secondStore.createReview(request),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "replay",
      "result",
    ]);
    const bodies = results.map((result) =>
      result.kind === "result" || result.kind === "replay"
        ? (result.body as { id: string; createdAt: string })
        : undefined,
    );
    expect(bodies[0]).toEqual(bodies[1]);

    const rows = await database.pool.query<{
      created_at: Date;
      completed_at: Date;
    }>(
      `SELECT created_at,completed_at FROM api_idempotency
        WHERE organization_id=$1 AND idempotency_key=$2`,
      [ORG, "mutation-clock-concurrent"],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.completed_at.getTime()).toBe(
      rows.rows[0]?.created_at.getTime(),
    );
  });

  it("never completes an idempotency record before its own database-created timestamp", async () => {
    const store = new ApiMutationStore(database.pool);
    const outcome = await store.cancelReview({
      identity: identity(
        "mutation-clock-not-found",
        "cancelReview",
        "d".repeat(64),
      ),
      reviewRunId: "0192f8a1-0000-7000-8000-000000000799",
    });
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") expect(outcome.status).toBe(404);

    const row = await database.pool.query<{
      created_at: Date;
      completed_at: Date;
    }>(
      `SELECT created_at,completed_at FROM api_idempotency
        WHERE organization_id=$1 AND idempotency_key=$2`,
      [ORG, "mutation-clock-not-found"],
    );
    expect(row.rows[0]?.completed_at.getTime()).toBe(
      row.rows[0]?.created_at.getTime(),
    );
  });
});
