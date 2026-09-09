import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiMutationStore, ApiStore, ReviewDispatchStore, StaleReviewDispatchClaim } from "../src/index.js";
import { assertSuiteIsActuallyRunning, dockerAvailable, startPostgres, type TestDatabase } from "./postgres.js";

const HAS_DOCKER=dockerAvailable();
const describeWithPostgres=HAS_DOCKER?describe:describe.skip.bind(describe);
if(!HAS_DOCKER)console.warn("\n  ⚠ Docker unavailable — Phase 3 API persistence tests SKIPPED.\n");

describeWithPostgres("Phase 3 API persistence boundaries",()=>{
  let database:TestDatabase;
  const ORG_A="0192f8a1-0000-7000-8000-000000000101";
  const ORG_B="0192f8a1-0000-7000-8000-000000000102";
  const REPO="0192f8a1-0000-7000-8000-000000000201";
  const PR="0192f8a1-0000-7000-8000-000000000301";
  const REV="0192f8a1-0000-7000-8000-000000000401";
  const now=new Date("2026-09-09T00:00:00.000Z");
  beforeAll(async()=>{database=await startPostgres("phase3_api");await assertSuiteIsActuallyRunning(database,["api_idempotency","review_dispatch_jobs","review_runs"]);},180_000);
  afterAll(async()=>{await database?.stop();},60_000);
  beforeEach(async()=>{
    await database.reset();
    await database.pool.query(`INSERT INTO organizations(id,slug,name) VALUES($1,'a','A'),($2,'b','B')`,[ORG_A,ORG_B]);
    await database.pool.query(`INSERT INTO repositories(id,organization_id,provider,provider_external_id,owner,name,default_branch,visibility) VALUES($1,$2,'github','r1','a','repo','main','private')`,[REPO,ORG_A]);
    await database.pool.query(`INSERT INTO pull_requests(id,organization_id,repository_id,provider,provider_external_id,number,title,author,state,draft,created_at,updated_at) VALUES($1,$2,$3,'github','p1',1,'PR','{"kind":"human"}'::jsonb,'open',false,$4,$4)`,[PR,ORG_A,REPO,now]);
    await database.pool.query(`INSERT INTO pull_request_revisions(id,organization_id,repository_id,pull_request_id,sequence,head_sha,head_ref,base_sha,base_ref,merge_base_sha,trigger,created_at) VALUES($1,$2,$3,$4,1,$5,'feature',$6,'main',NULL,'push',$7)`,[REV,ORG_A,REPO,PR,"a".repeat(40),"b".repeat(40),now]);
  });
  function identity(key:string,digest="a".repeat(64)){return{organizationId:ORG_A,principalId:"key-1",routeName:"createReview",key,requestDigest:digest,now};}
  it("commits request, run, dispatch job, and replay result as one idempotent unit",async()=>{
    const store=new ApiMutationStore(database.pool); const key="idem-create-1";
    const first=await store.createReview({identity:identity(key),repositoryId:REPO,pullRequestId:PR,requestedBy:{kind:"api_key",id:"key-1"},correlationId:"corr-1"});
    const replay=await store.createReview({identity:identity(key),repositoryId:REPO,pullRequestId:PR,requestedBy:{kind:"api_key",id:"key-1"},correlationId:"corr-2"});
    expect(first.kind).toBe("result"); expect(replay.kind).toBe("replay");
    const counts=await database.pool.query<{requests:number;runs:number;jobs:number}>(`SELECT (SELECT COUNT(*)::int FROM review_requests) requests,(SELECT COUNT(*)::int FROM review_runs) runs,(SELECT COUNT(*)::int FROM review_dispatch_jobs) jobs`);
    expect(counts.rows[0]).toEqual({requests:1,runs:1,jobs:1});
  });
  it("conflicts when the same idempotency key is reused for a different canonical request",async()=>{
    const store=new ApiMutationStore(database.pool); const key="idem-digest-conflict";
    const first=await store.createReview({identity:identity(key,"e".repeat(64)),repositoryId:REPO,pullRequestId:PR,requestedBy:{kind:"api_key",id:"key-1"},correlationId:"corr-a"});
    const conflicting=await store.createReview({identity:identity(key,"f".repeat(64)),repositoryId:REPO,pullRequestId:PR,requestedBy:{kind:"api_key",id:"key-1"},correlationId:"corr-b"});
    expect(first.kind).toBe("result"); expect(conflicting).toEqual({kind:"conflict"});
    const counts=await database.pool.query<{requests:number;runs:number;jobs:number}>(`SELECT (SELECT COUNT(*)::int FROM review_requests) requests,(SELECT COUNT(*)::int FROM review_runs) runs,(SELECT COUNT(*)::int FROM review_dispatch_jobs) jobs`);
    expect(counts.rows[0]).toEqual({requests:1,runs:1,jobs:1});
  });
  it("serializes different API keys for the same revision without globally forbidding shadow runs",async()=>{
    const store=new ApiMutationStore(database.pool);
    const results=await Promise.all([
      store.createReview({identity:identity("idem-race-a","b".repeat(64)),repositoryId:REPO,pullRequestId:PR,requestedBy:{kind:"api_key"},correlationId:"a"}),
      store.createReview({identity:identity("idem-race-b","c".repeat(64)),repositoryId:REPO,pullRequestId:PR,requestedBy:{kind:"api_key"},correlationId:"b"}),
    ]);
    expect(results.map(r=>r.kind==="result"?r.status:0).sort()).toEqual([202,409]);
    const counts=await database.pool.query<{runs:number;jobs:number}>(`SELECT (SELECT COUNT(*)::int FROM review_runs) runs,(SELECT COUNT(*)::int FROM review_dispatch_jobs) jobs`);
    expect(counts.rows[0]).toEqual({runs:1,jobs:1});
  });
  it("cannot read another tenant's repository by supplying its id",async()=>{
    const api=new ApiStore(database.pool); expect(await api.getRepository({organizationId:ORG_B},REPO)).toBeUndefined();
  });
  it("fences a stale dispatch owner immediately after deferral",async()=>{
    const mutations=new ApiMutationStore(database.pool); await mutations.createReview({identity:identity("idem-fence","d".repeat(64)),repositoryId:REPO,pullRequestId:PR,requestedBy:{kind:"api_key"},correlationId:"c"});
    const dispatch=new ReviewDispatchStore(database.pool); const claim=(await dispatch.claim(1,60_000,now))[0]; expect(claim).toBeDefined(); if(claim===undefined)return;
    await dispatch.defer(claim.reviewRunId,claim.claimGeneration,new Date(now.getTime()+1_000),now);
    await expect(dispatch.complete(claim.reviewRunId,claim.claimGeneration)).rejects.toBeInstanceOf(StaleReviewDispatchClaim);
  });
});
