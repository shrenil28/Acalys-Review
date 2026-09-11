import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiMutationStore, ApiStore } from "../src/index.js";
import {
  assertSuiteIsActuallyRunning,
  dockerAvailable,
  startPostgres,
  type TestDatabase,
} from "./postgres.js";

const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER ? describe : describe.skip.bind(describe);
if (!HAS_DOCKER) {
  console.warn("\n  ⚠ Docker unavailable — Phase 3 tenant-integrity tests SKIPPED.\n");
}

const ORG_A = "0192f8a1-0000-7000-8000-000000001001";
const ORG_B = "0192f8a1-0000-7000-8000-000000001002";
const REPO_A = "0192f8a1-0000-7000-8000-000000001101";
const REPO_B = "0192f8a1-0000-7000-8000-000000001102";
const PR_A = "0192f8a1-0000-7000-8000-000000001201";
const PR_B = "0192f8a1-0000-7000-8000-000000001202";
const REV_A = "0192f8a1-0000-7000-8000-000000001301";
const REV_B = "0192f8a1-0000-7000-8000-000000001302";
const REQUEST_A = "0192f8a1-0000-7000-8000-000000001401";
const REQUEST_B = "0192f8a1-0000-7000-8000-000000001402";
const RUN_A = "0192f8a1-0000-7000-8000-000000001501";
const RUN_B = "0192f8a1-0000-7000-8000-000000001502";
const FINDING_A = "0192f8a1-0000-7000-8000-000000001601";
const FINDING_B = "0192f8a1-0000-7000-8000-000000001602";
const CONVERSATION_A = "0192f8a1-0000-7000-8000-000000001701";
const CONVERSATION_B = "0192f8a1-0000-7000-8000-000000001702";
const MESSAGE_A = "0192f8a1-0000-7000-8000-000000001801";
const MESSAGE_B = "0192f8a1-0000-7000-8000-000000001802";
const KNOWLEDGE_A = "0192f8a1-0000-7000-8000-000000001901";
const KNOWLEDGE_B = "0192f8a1-0000-7000-8000-000000001902";
const CHECK_A = "0192f8a1-0000-7000-8000-000000002001";
const CHECK_B = "0192f8a1-0000-7000-8000-000000002002";
const now = new Date("2026-09-09T00:00:00.000Z");

const TENANT_GRAPH_CONSTRAINTS = [
  "conversation_messages_conversation_tenant_fk",
  "knowledge_items_repository_tenant_fk",
  "premerge_check_results_repository_tenant_fk",
  "premerge_check_results_run_tenant_fk",
  "pull_request_revisions_pull_request_tenant_fk",
  "pull_request_revisions_repository_tenant_fk",
  "pull_requests_repository_tenant_fk",
  "review_conversations_finding_tenant_fk",
  "review_conversations_pull_request_tenant_fk",
  "review_conversations_repository_tenant_fk",
  "review_dispatch_jobs_pull_request_tenant_fk",
  "review_dispatch_jobs_revision_tenant_fk",
  "review_dispatch_jobs_run_tenant_fk",
  "review_findings_repository_tenant_fk",
  "review_findings_revision_tenant_fk",
  "review_findings_run_tenant_fk",
  "review_requests_pull_request_tenant_fk",
  "review_requests_repository_tenant_fk",
  "review_requests_revision_tenant_fk",
  "review_runs_repository_tenant_fk",
  "review_runs_request_tenant_fk",
  "review_runs_revision_tenant_fk",
  "review_summaries_run_tenant_fk",
] as const;

function graph(organizationId: string) {
  return organizationId === ORG_A
    ? {
        organizationId: ORG_A,
        repositoryId: REPO_A,
        pullRequestId: PR_A,
        revisionId: REV_A,
        requestId: REQUEST_A,
        runId: RUN_A,
        findingId: FINDING_A,
        conversationId: CONVERSATION_A,
        messageId: MESSAGE_A,
        knowledgeId: KNOWLEDGE_A,
        checkId: CHECK_A,
        suffix: "a",
      }
    : {
        organizationId: ORG_B,
        repositoryId: REPO_B,
        pullRequestId: PR_B,
        revisionId: REV_B,
        requestId: REQUEST_B,
        runId: RUN_B,
        findingId: FINDING_B,
        conversationId: CONVERSATION_B,
        messageId: MESSAGE_B,
        knowledgeId: KNOWLEDGE_B,
        checkId: CHECK_B,
        suffix: "b",
      };
}

async function seedGraph(database: TestDatabase, organizationId: string): Promise<void> {
  const value = graph(organizationId);
  await database.pool.query(
    `INSERT INTO repositories
       (id,organization_id,provider,provider_external_id,owner,name,default_branch,visibility,created_at,updated_at)
     VALUES ($1,$2,'github',$3,$4,'repo','main','private',$5,$5)`,
    [value.repositoryId, organizationId, `tenant-integrity-repo-${value.suffix}`, value.suffix, now],
  );
  await database.pool.query(
    `INSERT INTO pull_requests
       (id,organization_id,repository_id,provider,provider_external_id,number,title,author,state,draft,created_at,updated_at)
     VALUES ($1,$2,$3,'github',$4,1,$5,'{"kind":"human"}'::jsonb,'open',false,$6,$6)`,
    [value.pullRequestId, organizationId, value.repositoryId, `tenant-integrity-pr-${value.suffix}`, `PR ${value.suffix}`, now],
  );
  await database.pool.query(
    `INSERT INTO pull_request_revisions
       (id,organization_id,repository_id,pull_request_id,sequence,head_sha,head_ref,base_sha,base_ref,merge_base_sha,trigger,created_at)
     VALUES ($1,$2,$3,$4,1,$5,'feature',$6,'main',NULL,'push',$7)`,
    [value.revisionId, organizationId, value.repositoryId, value.pullRequestId, value.suffix.repeat(40), value.suffix === "a" ? "c".repeat(40) : "d".repeat(40), now],
  );
  await database.pool.query(
    `INSERT INTO review_requests
       (id,organization_id,repository_id,pull_request_id,revision_id,target,trigger,requested_by,execution_mode,execution_strategy,idempotency_scope,idempotency_key,requested_at,correlation_id)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,'api','{"kind":"api_key"}'::jsonb,'full','standard',$2,$6,$7,$8)`,
    [value.requestId, organizationId, value.repositoryId, value.pullRequestId, value.revisionId, `seed-${value.suffix}`, now, `corr-${value.suffix}`],
  );
  await database.pool.query(
    `INSERT INTO review_runs
       (id,organization_id,repository_id,request_id,revision_id,attempt,state,execution_mode,execution_strategy,created_at)
     VALUES ($1,$2,$3,$4,$5,1,'queued','full','standard',$6)`,
    [value.runId, organizationId, value.repositoryId, value.requestId, value.revisionId, now],
  );
  await database.pool.query(
    `INSERT INTO review_run_transitions(run_id,seq,from_state,to_state,at)
     VALUES ($1,1,'queued','preparing',$2)`,
    [value.runId, now],
  );
  await database.pool.query(
    `INSERT INTO review_findings
       (id,organization_id,repository_id,review_run_id,revision_id,fingerprint_value,severity,category,confidence_score,confidence_level,title,explanation,path,start_line,end_line,state,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'high','security',0.9,'very_high',$7,'evidence','src/index.ts',1,1,'published',$8,$8)`,
    [value.findingId, organizationId, value.repositoryId, value.runId, value.revisionId, value.suffix.repeat(64), `Finding ${value.suffix}`, now],
  );
  const foreignSummaryRunId = organizationId === ORG_A ? RUN_B : RUN_A;
  await database.pool.query(
    `INSERT INTO review_summaries(review_run_id,organization_id,payload,generated_at)
     VALUES ($1,$2,$3::jsonb,$4)`,
    [
      value.runId,
      organizationId,
      JSON.stringify({
        reviewRunId: foreignSummaryRunId,
        overview: `summary-${value.suffix}`,
        changedAreas: [],
        riskAreas: [],
        findingCounts: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
        generatedAt: now.toISOString(),
      }),
      now,
    ],
  );
  await database.pool.query(
    `INSERT INTO premerge_check_results
       (id,organization_id,repository_id,review_run_id,check_id,name,status,blocking,evaluated_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',true,NULL,$7)`,
    [value.checkId, organizationId, value.repositoryId, value.runId, `check-${value.suffix}`, `Check ${value.suffix}`, now],
  );
  await database.pool.query(
    `INSERT INTO review_conversations
       (id,organization_id,repository_id,pull_request_id,finding_id,state,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'open',$6,$6)`,
    [value.conversationId, organizationId, value.repositoryId, value.pullRequestId, value.findingId, now],
  );
  await database.pool.query(
    `INSERT INTO conversation_messages(id,organization_id,conversation_id,body,created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [value.messageId, organizationId, value.conversationId, `message-${value.suffix}`, now],
  );
  await database.pool.query(
    `INSERT INTO knowledge_items
       (id,organization_id,repository_id,scope,source_type,path,summary,authored,active,recorded_at,created_at,updated_at)
     VALUES ($1,$2,$3,'repository','learning','src/index.ts',$4,false,true,$5,$5,$5)`,
    [value.knowledgeId, organizationId, value.repositoryId, `knowledge-${value.suffix}`, now],
  );
}

function identity(routeName: string, key: string) {
  return {
    organizationId: ORG_A,
    principalId: "tenant-integrity-key-a",
    routeName,
    key,
    requestDigest: key.padEnd(64, "0").slice(0, 64),
    now,
  };
}

async function expectConstraint(
  database: TestDatabase,
  sql: string,
  values: readonly unknown[],
  expectedConstraint: string,
): Promise<void> {
  try {
    await database.pool.query(sql, [...values]);
    throw new Error(`expected ${expectedConstraint} to reject the write`);
  } catch (error) {
    expect((error as { readonly constraint?: string }).constraint).toBe(expectedConstraint);
  }
}

describeWithPostgres("Phase 3 tenant graph integrity", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startPostgres("phase3_tenant_integrity");
    await assertSuiteIsActuallyRunning(database, [
      "review_runs",
      "review_findings",
      "review_conversations",
      "knowledge_items",
      "review_dispatch_jobs",
    ]);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(
      `INSERT INTO organizations(id,slug,name) VALUES($1,'tenant-integrity-a','A'),($2,'tenant-integrity-b','B')`,
      [ORG_A, ORG_B],
    );
    await seedGraph(database, ORG_A);
    await seedGraph(database, ORG_B);
  });

  it("installs and validates every API-reachable tenant graph foreign key", async () => {
    const result = await database.pool.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [[...TENANT_GRAPH_CONSTRAINTS]],
    );
    expect(result.rows.map((row) => row.conname)).toEqual([...TENANT_GRAPH_CONSTRAINTS].sort());
    expect(result.rows.every((row) => row.convalidated)).toBe(true);
  });

  it("rejects cross-tenant repository, run, conversation, knowledge, and dispatch edges", async () => {
    await expectConstraint(
      database,
      `INSERT INTO pull_requests
         (id,organization_id,repository_id,provider,provider_external_id,number,title,author,state,draft,created_at,updated_at)
       VALUES ($1,$2,$3,'github','cross-tenant-pr',7,'cross','{}'::jsonb,'open',false,$4,$4)`,
      ["0192f8a1-0000-7000-8000-000000002101", ORG_A, REPO_B, now],
      "pull_requests_repository_tenant_fk",
    );

    await expectConstraint(
      database,
      `INSERT INTO review_findings
         (id,organization_id,repository_id,review_run_id,revision_id,fingerprint_value,severity,category,confidence_score,confidence_level,title,explanation,path,start_line,end_line,state,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'high','security',0.9,'very_high','cross','cross','src/x.ts',1,1,'published',$7,$7)`,
      ["0192f8a1-0000-7000-8000-000000002102", ORG_A, REPO_A, RUN_B, REV_A, "e".repeat(64), now],
      "review_findings_run_tenant_fk",
    );

    await expectConstraint(
      database,
      `INSERT INTO review_conversations
         (id,organization_id,repository_id,pull_request_id,finding_id,state,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'open',$6,$6)`,
      ["0192f8a1-0000-7000-8000-000000002103", ORG_A, REPO_A, PR_B, FINDING_A, now],
      "review_conversations_pull_request_tenant_fk",
    );

    await expectConstraint(
      database,
      `INSERT INTO knowledge_items
         (id,organization_id,repository_id,scope,source_type,summary,authored,active,created_at,updated_at)
       VALUES ($1,$2,$3,'repository','learning','cross',false,true,$4,$4)`,
      ["0192f8a1-0000-7000-8000-000000002104", ORG_A, REPO_B, now],
      "knowledge_items_repository_tenant_fk",
    );

    await expectConstraint(
      database,
      `INSERT INTO review_dispatch_jobs
         (review_run_id,organization_id,revision_id,pull_request_id,available_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$5,$5)`,
      [RUN_B, ORG_A, REV_A, PR_A, now],
      "review_dispatch_jobs_run_tenant_fk",
    );
  });

  it("keeps the complete API read surface and durable review events inside the principal tenant", async () => {
    const api = new ApiStore(database.pool);
    const scopeA = { organizationId: ORG_A };

    expect((await api.listRepositories(scopeA, 100)).items.map((item) => item.id)).toEqual([REPO_A]);
    expect(await api.getRepository(scopeA, REPO_A)).toBeDefined();
    expect(await api.getRepository(scopeA, REPO_B)).toBeUndefined();
    expect((await api.listPullRequests(scopeA, REPO_A, 100))?.items.map((item) => item.id)).toEqual([PR_A]);
    expect(await api.listPullRequests(scopeA, REPO_B, 100)).toBeUndefined();
    expect(await api.getReview(scopeA, RUN_A)).toBeDefined();
    expect(await api.getReview(scopeA, RUN_B)).toBeUndefined();
    expect((await api.getReviewSummary(scopeA, RUN_A))?.reviewRunId).toBe(RUN_A);
    expect(await api.getReviewSummary(scopeA, RUN_B)).toBeUndefined();
    expect((await api.listReviewFindings(scopeA, RUN_A, 100, undefined, {}))?.items.map((item) => item.id)).toEqual([FINDING_A]);
    expect(await api.listReviewFindings(scopeA, RUN_B, 100, undefined, {})).toBeUndefined();
    expect((await api.listReviewChecks(scopeA, RUN_A))?.items.map((item) => item.id)).toEqual([CHECK_A]);
    expect(await api.listReviewChecks(scopeA, RUN_B)).toBeUndefined();
    expect(await api.getFinding(scopeA, FINDING_A)).toBeDefined();
    expect(await api.getFinding(scopeA, FINDING_B)).toBeUndefined();
    expect((await api.listConversations(scopeA, REPO_A, 100))?.items.map((item) => item.id)).toEqual([CONVERSATION_A]);
    expect(await api.listConversations(scopeA, REPO_B, 100)).toBeUndefined();
    expect(await api.getConversation(scopeA, CONVERSATION_A)).toBeDefined();
    expect(await api.getConversation(scopeA, CONVERSATION_B)).toBeUndefined();
    expect((await api.listKnowledge(scopeA, 100)).items.map((item) => item.id)).toEqual([KNOWLEDGE_A]);

    expect((await api.reviewEvents(scopeA, RUN_A, 0))?.map((event) => event.id)).toEqual([1]);
    expect(await api.reviewEvents(scopeA, RUN_A, 99)).toEqual([]);
    expect(await api.reviewEvents(scopeA, RUN_B, 0)).toBeUndefined();
  });

  it("returns not-found for every cross-tenant mutation and leaves the foreign rows unchanged", async () => {
    const mutations = new ApiMutationStore(database.pool);

    const create = await mutations.createReview({
      identity: identity("createReview", "cross-create"),
      repositoryId: REPO_B,
      pullRequestId: PR_B,
      requestedBy: { kind: "api_key", id: "tenant-integrity-key-a" },
      correlationId: "cross-create",
    });
    const cancel = await mutations.cancelReview({
      identity: identity("cancelReview", "cross-cancel"),
      reviewRunId: RUN_B,
      reason: "must not cross tenants",
    });
    const dismiss = await mutations.dismissFinding({
      identity: identity("dismissFinding", "cross-dismiss"),
      findingId: FINDING_B,
      reason: "must not cross tenants",
    });
    const resolve = await mutations.resolveConversation({
      identity: identity("resolveConversation", "cross-resolve"),
      conversationId: CONVERSATION_B,
    });

    for (const outcome of [create, cancel, dismiss, resolve]) {
      expect(outcome.kind).toBe("result");
      if (outcome.kind === "result") expect(outcome.status).toBe(404);
    }

    const state = await database.pool.query<{
      run_state: string;
      finding_state: string;
      conversation_state: string;
    }>(
      `SELECT
         (SELECT state FROM review_runs WHERE id=$1) AS run_state,
         (SELECT state FROM review_findings WHERE id=$2) AS finding_state,
         (SELECT state FROM review_conversations WHERE id=$3) AS conversation_state`,
      [RUN_B, FINDING_B, CONVERSATION_B],
    );
    expect(state.rows[0]).toEqual({
      run_state: "queued",
      finding_state: "published",
      conversation_state: "open",
    });
  });
});
