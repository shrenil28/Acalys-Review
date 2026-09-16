import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ApiMutationStore,
  ReviewDispatchStore,
  StaleReviewDispatchClaim,
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
  console.warn(
    "\n  ⚠ Docker unavailable — Phase 3 dispatch coordination tests SKIPPED.\n",
  );
}

describeWithPostgres("Phase 3 API dispatch coordination", () => {
  let database: TestDatabase;
  const ORG = "0192f8a1-0000-7000-8000-000000000101";
  const REPO = "0192f8a1-0000-7000-8000-000000000201";
  const PR = "0192f8a1-0000-7000-8000-000000000301";
  const REV = "0192f8a1-0000-7000-8000-000000000401";
  const seedAt = new Date("2026-09-09T00:00:00.000Z");

  beforeAll(async () => {
    database = await startPostgres("phase3_dispatch_coordination");
    await assertSuiteIsActuallyRunning(database, [
      "api_idempotency",
      "review_dispatch_jobs",
      "review_runs",
    ]);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(
      `INSERT INTO organizations(id,slug,name) VALUES($1,'a','A')`,
      [ORG],
    );
    await database.pool.query(
      `INSERT INTO repositories
        (id,organization_id,provider,provider_external_id,owner,name,default_branch,visibility)
       VALUES($1,$2,'github','r1','a','repo','main','private')`,
      [REPO, ORG],
    );
    await database.pool.query(
      `INSERT INTO pull_requests
        (id,organization_id,repository_id,provider,provider_external_id,number,title,
         author,state,draft,created_at,updated_at)
       VALUES($1,$2,$3,'github','p1',1,'PR','{"kind":"human"}'::jsonb,
              'open',false,$4,$4)`,
      [PR, ORG, REPO, seedAt],
    );
    await database.pool.query(
      `INSERT INTO pull_request_revisions
        (id,organization_id,repository_id,pull_request_id,sequence,head_sha,head_ref,
         base_sha,base_ref,merge_base_sha,trigger,created_at)
       VALUES($1,$2,$3,$4,1,$5,'feature',$6,'main',NULL,'push',$7)`,
      [REV, ORG, REPO, PR, "a".repeat(40), "b".repeat(40), seedAt],
    );
  });

  function identity(key: string, routeName = "createReview") {
    return {
      organizationId: ORG,
      principalId: "key-1",
      routeName,
      key,
      requestDigest: key.padEnd(64, "a").slice(0, 64),
    };
  }

  async function createRun(key: string): Promise<string> {
    const result = await new ApiMutationStore(database.pool).createReview({
      identity: identity(key),
      repositoryId: REPO,
      pullRequestId: PR,
      requestedBy: { kind: "api_key", id: "key-1" },
      correlationId: `corr-${key}`,
    });
    expect(result.kind).toBe("result");
    if (result.kind !== "result")
      throw new Error("review creation did not return a result");
    const body = result.body as { id?: unknown };
    if (typeof body.id !== "string")
      throw new Error("review creation returned no run id");
    return body.id;
  }

  it("lets concurrent worker replicas claim one run only once", async () => {
    await createRun("claim-race");
    const first = new ReviewDispatchStore(database.pool);
    const second = new ReviewDispatchStore(database.pool);

    const [left, right] = await Promise.all([
      first.claim(1, 60_000),
      second.claim(1, 60_000),
    ]);
    const claims = [...left, ...right];
    expect(claims).toHaveLength(1);
    expect(claims[0]?.claimGeneration).toBe(1);
    expect(claims[0]?.attempts).toBe(1);
    expect(claims[0]?.leaseExpiresAt.getTime()).toBeGreaterThan(
      claims[0]?.claimedAt.getTime() ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("serializes cancellation with claiming and removes the dispatch obligation", async () => {
    const runId = await createRun("cancel-race");
    const dispatch = new ReviewDispatchStore(database.pool);
    const mutations = new ApiMutationStore(database.pool);

    const [claims, cancellation] = await Promise.all([
      dispatch.claim(1, 60_000),
      mutations.cancelReview({
        identity: identity("cancel-race-idem", "cancelReview"),
        reviewRunId: runId,
        reason: "operator requested cancellation",
      }),
    ]);

    expect(cancellation.kind).toBe("result");
    if (cancellation.kind === "result") expect(cancellation.status).toBe(200);
    const state = await database.pool.query<{ state: string }>(
      `SELECT state FROM review_runs WHERE id=$1`,
      [runId],
    );
    expect(state.rows[0]?.state).toBe("cancelled");
    const jobs = await database.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM review_dispatch_jobs WHERE review_run_id=$1`,
      [runId],
    );
    expect(jobs.rows[0]?.count).toBe(0);

    const claim = claims[0];
    if (claim !== undefined) {
      await expect(
        dispatch.complete(claim.reviewRunId, claim.claimGeneration),
      ).rejects.toBeInstanceOf(StaleReviewDispatchClaim);
    }
    expect(await dispatch.claim(1, 60_000)).toHaveLength(0);
  });

  it("waits for a live execution guard before cancellation can commit", async () => {
    const runId = await createRun("cancel-live-executor");
    const dispatch = new ReviewDispatchStore(database.pool);
    const mutations = new ApiMutationStore(database.pool);
    const claim = (await dispatch.claim(1, 60_000))[0];
    expect(claim).toBeDefined();
    if (claim === undefined) return;

    const acquisition = await dispatch.acquireExecutionGuard(
      runId,
      claim.claimGeneration,
    );
    expect(acquisition.kind).toBe("owned");
    if (acquisition.kind !== "owned") return;

    let cancellationSettled = false;
    const cancellation = mutations
      .cancelReview({
        identity: identity("cancel-live-executor-idem", "cancelReview"),
        reviewRunId: runId,
        reason: "operator requested cancellation",
      })
      .finally(() => {
        cancellationSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cancellationSettled).toBe(false);
    expect(await acquisition.guard.renew(60_000)).toBe(true);

    await acquisition.guard.release();
    const result = await cancellation;
    expect(result.kind).toBe("result");
    if (result.kind === "result") expect(result.status).toBe(200);
    expect(await dispatch.claim(1, 60_000)).toHaveLength(0);
  });

  it("reclaims an abandoned claim after lease expiry with a higher generation", async () => {
    const runId = await createRun("crash-recovery");
    const first = new ReviewDispatchStore(database.pool);
    const second = new ReviewDispatchStore(database.pool);
    const abandoned = (await first.claim(1, 60_000))[0];
    expect(abandoned).toBeDefined();
    if (abandoned === undefined) return;

    // Simulate a process crash: no execution guard survives, and only the
    // durable lease remains. Once it has expired, another replica may reclaim.
    await database.pool.query(
      `UPDATE review_dispatch_jobs
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE review_run_id=$1`,
      [runId],
    );

    const recovered = (await second.claim(1, 60_000))[0];
    expect(recovered).toBeDefined();
    expect(recovered?.claimGeneration).toBe(abandoned.claimGeneration + 1);
    expect(recovered?.attempts).toBe(abandoned.attempts + 1);
    await expect(
      first.complete(abandoned.reviewRunId, abandoned.claimGeneration),
    ).rejects.toBeInstanceOf(StaleReviewDispatchClaim);
  });

  it("does not steal an expired timestamp lease while the live executor guard is held", async () => {
    const runId = await createRun("executor-fence");
    const first = new ReviewDispatchStore(database.pool);
    const second = new ReviewDispatchStore(database.pool);
    const claim = (await first.claim(1, 60_000))[0];
    expect(claim).toBeDefined();
    if (claim === undefined) return;

    const acquisition = await first.acquireExecutionGuard(
      runId,
      claim.claimGeneration,
    );
    expect(acquisition.kind).toBe("owned");
    if (acquisition.kind !== "owned") return;

    try {
      await database.pool.query(
        `UPDATE review_dispatch_jobs
            SET lease_expires_at=clock_timestamp()-interval '1 second'
          WHERE review_run_id=$1`,
        [runId],
      );
      expect(await second.claim(1, 60_000)).toHaveLength(0);
      expect(await acquisition.guard.renew(60_000)).toBe(true);
    } finally {
      await acquisition.guard.release();
    }

    await database.pool.query(
      `UPDATE review_dispatch_jobs
          SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE review_run_id=$1`,
      [runId],
    );
    const reclaimed = (await second.claim(1, 60_000))[0];
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.claimGeneration).toBeGreaterThan(claim.claimGeneration);
  });

  it("replays a dead letter as one new run attempt and keeps the old generation fenced", async () => {
    const runId = await createRun("dead-letter-replay");
    const first = new ReviewDispatchStore(database.pool);
    const second = new ReviewDispatchStore(database.pool);
    const claim = (await first.claim(1, 60_000))[0];
    expect(claim).toBeDefined();
    if (claim === undefined) return;

    await first.deadLetter(
      runId,
      claim.claimGeneration,
      "acalys.error.dispatch-test",
    );
    await expect(
      first.complete(runId, claim.claimGeneration),
    ).rejects.toBeInstanceOf(StaleReviewDispatchClaim);
    const dead = await database.pool.query<{
      claim_generation: string | number;
      dead_lettered_at: Date | null;
    }>(
      `SELECT claim_generation,dead_lettered_at
         FROM review_dispatch_jobs
        WHERE review_run_id=$1`,
      [runId],
    );
    // A raw read of a BIGINT column: pg hands it back as a string, the way the
    // store's own reads receive it before they coerce.
    const rawGeneration = dead.rows[0]?.claim_generation;
    const deadGeneration =
      rawGeneration === undefined ? undefined : Number(rawGeneration);
    expect(dead.rows[0]?.dead_lettered_at).toBeInstanceOf(Date);
    expect(deadGeneration).toBe(claim.claimGeneration + 1);
    if (deadGeneration === undefined) return;

    const [left, right] = await Promise.all([
      first.replayDeadLetter(runId, deadGeneration),
      second.replayDeadLetter(runId, deadGeneration),
    ]);
    expect(new Set([left.reviewRunId, right.reviewRunId]).size).toBe(1);
    expect([left.kind, right.kind].sort()).toEqual(["existing", "replayed"]);
    expect(left.attempt).toBe(2);
    expect(right.attempt).toBe(2);
    expect(left.reviewRunId).not.toBe(runId);

    const runs = await database.pool.query<{
      id: string;
      attempt: number;
      state: string;
    }>(
      `SELECT id,attempt,state FROM review_runs WHERE request_id=(SELECT request_id FROM review_runs WHERE id=$1) ORDER BY attempt`,
      [runId],
    );
    expect(runs.rows.map((row) => [row.attempt, row.state])).toEqual([
      [1, "failed"],
      [2, "queued"],
    ]);
    const jobs = await database.pool.query<{
      review_run_id: string;
      dead_lettered_at: Date | null;
    }>(
      `SELECT review_run_id,dead_lettered_at
         FROM review_dispatch_jobs
        WHERE review_run_id=ANY($1::uuid[])
        ORDER BY review_run_id`,
      [[runId, left.reviewRunId]],
    );
    expect(jobs.rows).toHaveLength(2);
    expect(
      jobs.rows.find((row) => row.review_run_id === runId)?.dead_lettered_at,
    ).toBeInstanceOf(Date);
    expect(
      jobs.rows.find((row) => row.review_run_id === left.reviewRunId)
        ?.dead_lettered_at,
    ).toBeNull();
  });
});
