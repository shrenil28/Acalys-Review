import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiStore } from "../src/index.js";
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
    "\n  ⚠ Docker unavailable — Phase 3 pre-merge-check bound tests SKIPPED.\n",
  );
}

const ORG = "0192f8a1-1400-7000-8000-000000000101";
const REPO = "0192f8a1-1400-7000-8000-000000000201";
const PR = "0192f8a1-1400-7000-8000-000000000301";
const REVISION = "0192f8a1-1400-7000-8000-000000000401";
const REQUEST = "0192f8a1-1400-7000-8000-000000000501";
const RUN = "0192f8a1-1400-7000-8000-000000000601";
const NOW = new Date("2026-09-09T06:45:00.000Z");

async function seedRun(database: TestDatabase): Promise<void> {
  await database.pool.query(
    `INSERT INTO organizations(id,slug,name) VALUES($1,'phase3-check-bound','Phase 3 Check Bound')`,
    [ORG],
  );
  await database.pool.query(
    `INSERT INTO repositories
       (id,organization_id,provider,provider_external_id,owner,name,default_branch,visibility,created_at,updated_at)
     VALUES ($1,$2,'github','phase3-check-bound-repo','acalys','repo','main','private',$3,$3)`,
    [REPO, ORG, NOW],
  );
  await database.pool.query(
    `INSERT INTO pull_requests
       (id,organization_id,repository_id,provider,provider_external_id,number,title,author,state,draft,created_at,updated_at)
     VALUES ($1,$2,$3,'github','phase3-check-bound-pr',1,'PR','{"kind":"human"}'::jsonb,'open',false,$4,$4)`,
    [PR, ORG, REPO, NOW],
  );
  await database.pool.query(
    `INSERT INTO pull_request_revisions
       (id,organization_id,repository_id,pull_request_id,sequence,head_sha,head_ref,base_sha,base_ref,merge_base_sha,trigger,created_at)
     VALUES ($1,$2,$3,$4,1,$5,'feature',$6,'main',NULL,'push',$7)`,
    [REVISION, ORG, REPO, PR, "a".repeat(40), "b".repeat(40), NOW],
  );
  await database.pool.query(
    `INSERT INTO review_requests
       (id,organization_id,repository_id,pull_request_id,revision_id,target,trigger,requested_by,execution_mode,execution_strategy,idempotency_scope,idempotency_key,requested_at,correlation_id)
     VALUES($1,$2::uuid,$3,$4,$5,'{}'::jsonb,'api','{"kind":"api_key"}'::jsonb,'full','standard',$2::text,'phase3-check-bound',$6,'phase3-check-bound')`,
    [REQUEST, ORG, REPO, PR, REVISION, NOW],
  );
  await database.pool.query(
    `INSERT INTO review_runs
       (id,organization_id,repository_id,request_id,revision_id,attempt,state,execution_mode,execution_strategy,created_at)
     VALUES ($1,$2,$3,$4,$5,1,'completed','full','standard',$6)`,
    [RUN, ORG, REPO, REQUEST, REVISION, NOW],
  );
}

async function insertCheck(
  database: TestDatabase,
  checkId: string,
  rowId = randomUUID(),
): Promise<void> {
  await database.pool.query(
    `INSERT INTO premerge_check_results
       (id,organization_id,repository_id,review_run_id,check_id,name,status,blocking,evaluated_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',true,NULL,$7)`,
    [rowId, ORG, REPO, RUN, checkId, `Check ${checkId}`, NOW],
  );
}

describeWithPostgres("Phase 3 non-pageable pre-merge-check bound", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startPostgres("phase3_premerge_check_bound");
    await assertSuiteIsActuallyRunning(database, [
      "premerge_check_results",
      "review_runs",
    ]);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await seedRun(database);
  });

  it("rejects the 101st distinct check but still permits an upsert of an existing check at the cap", async () => {
    for (let index = 0; index < 100; index += 1) {
      await insertCheck(database, `check-${String(index).padStart(3, "0")}`);
    }

    await expect(insertCheck(database, "check-100")).rejects.toMatchObject({
      constraint: "premerge_check_results_run_limit",
    });

    const updated = await database.pool.query(
      `INSERT INTO premerge_check_results
         (id,organization_id,repository_id,review_run_id,check_id,name,status,blocking,evaluated_at,created_at)
       VALUES ($1,$2,$3,$4,'check-000','Updated','running',false,NULL,$5)
       ON CONFLICT (review_run_id,check_id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,blocking=EXCLUDED.blocking`,
      [randomUUID(), ORG, REPO, RUN, NOW],
    );
    expect(updated.rowCount).toBe(1);

    const page = await new ApiStore(database.pool).listReviewChecks(
      { organizationId: ORG },
      RUN,
    );
    expect(page?.items).toHaveLength(100);
    expect(page?.nextCursor).toBeUndefined();
  });

  it("serializes concurrent boundary inserts so exactly one 100th row can commit", async () => {
    for (let index = 0; index < 99; index += 1) {
      await insertCheck(database, `check-${String(index).padStart(3, "0")}`);
    }

    const attempts = await Promise.allSettled([
      insertCheck(database, "check-concurrent-a"),
      insertCheck(database, "check-concurrent-b"),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      constraint: "premerge_check_results_run_limit",
    });

    const count = await database.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM premerge_check_results WHERE review_run_id=$1`,
      [RUN],
    );
    expect(count.rows[0]?.count).toBe(100);
  });
});
