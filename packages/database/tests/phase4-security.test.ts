import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DashboardSecurityStore } from "../src/index.js";
import { assertSuiteIsActuallyRunning, dockerAvailable, startPostgres, type TestDatabase } from "./postgres.js";
import { seedVerifiedAttempt } from "./finding-provenance.js";

const describeWithPostgres = dockerAvailable() ? describe : describe.skip.bind(describe);
const ORG_A = "0192f8a1-4100-7000-8000-000000000101";
const ORG_B = "0192f8a1-4100-7000-8000-000000000102";
const REPO_A = "0192f8a1-4100-7000-8000-000000000201";
const REPO_B = "0192f8a1-4100-7000-8000-000000000202";
const PR_A = "0192f8a1-4100-7000-8000-000000000301";
const PR_B = "0192f8a1-4100-7000-8000-000000000302";
const REV_A = "0192f8a1-4100-7000-8000-000000000401";
const REV_B = "0192f8a1-4100-7000-8000-000000000402";
const REQ_A = "0192f8a1-4100-7000-8000-000000000501";
const REQ_B = "0192f8a1-4100-7000-8000-000000000502";
const RUN_A = "0192f8a1-4100-7000-8000-000000000601";
const RUN_B = "0192f8a1-4100-7000-8000-000000000602";
const SECURITY_HIGH = "0192f8a1-4100-7000-8000-000000000701";
const SECURITY_RESOLVED = "0192f8a1-4100-7000-8000-000000000702";
const NON_SECURITY = "0192f8a1-4100-7000-8000-000000000703";
const FOREIGN_SECURITY = "0192f8a1-4100-7000-8000-000000000704";
const NOW = new Date("2026-09-11T03:00:00.000Z");

async function seedReviewGraph(database: TestDatabase, input: { org: string; repo: string; pr: string; rev: string; req: string; run: string; suffix: string }) {
  await database.pool.query(`INSERT INTO repositories(id,organization_id,provider,provider_external_id,owner,name,default_branch,visibility,created_at,updated_at) VALUES ($1,$2,'github',$3,'acalys',$4,'main','private',$5,$5)`, [input.repo, input.org, `security-repo-${input.suffix}`, `repo-${input.suffix}`, NOW]);
  await database.pool.query(`INSERT INTO pull_requests(id,organization_id,repository_id,provider,provider_external_id,number,title,author,state,draft,created_at,updated_at) VALUES ($1,$2,$3,'github',$4,$5,$6,$7::jsonb,'open',false,$8,$8)`, [input.pr, input.org, input.repo, `security-pr-${input.suffix}`, input.suffix === "a" ? 17 : 18, `PR ${input.suffix}`, JSON.stringify({ kind: "human", provider: { provider: "github", externalId: `user-${input.suffix}`, handle: `alice-${input.suffix}` } }), NOW]);
  await database.pool.query(`INSERT INTO pull_request_revisions(id,organization_id,repository_id,pull_request_id,sequence,head_sha,head_ref,base_sha,base_ref,merge_base_sha,trigger,created_at) VALUES ($1,$2,$3,$4,1,$5,'feature',$6,'main',NULL,'push',$7)`, [input.rev, input.org, input.repo, input.pr, input.suffix.repeat(40), input.suffix === "a" ? "c".repeat(40) : "d".repeat(40), NOW]);
  await database.pool.query(`INSERT INTO review_requests(id,organization_id,repository_id,pull_request_id,revision_id,target,trigger,requested_by,execution_mode,execution_strategy,idempotency_scope,idempotency_key,requested_at,correlation_id) VALUES ($1,$2::uuid,$3,$4,$5,'{}'::jsonb,'api','{"kind":"api_key"}'::jsonb,'full','standard',$2::text,$6,$7,$8)`, [input.req, input.org, input.repo, input.pr, input.rev, `security-${input.suffix}`, NOW, `security-corr-${input.suffix}`]);
  await database.pool.query(`INSERT INTO review_runs(id,organization_id,repository_id,request_id,revision_id,attempt,state,execution_mode,execution_strategy,created_at) VALUES ($1,$2,$3,$4,$5,1,'completed','full','standard',$6)`, [input.run, input.org, input.repo, input.req, input.rev, NOW]);
}

async function insertFinding(database: TestDatabase, input: { id: string; org: string; repo: string; run: string; rev: string; fingerprint: string; severity: string; category: string; state: string; title: string }) {
  const verificationAttemptId = await seedVerifiedAttempt(database, {
    organizationId: input.org,
    repositoryId: input.repo,
    reviewRunId: input.run,
    fingerprint: input.fingerprint,
    severity: input.severity,
    category: input.category,
    at: NOW,
  });
  await database.pool.query(
    `INSERT INTO review_findings(id,organization_id,repository_id,review_run_id,revision_id,fingerprint_value,severity,category,confidence_score,confidence_level,title,explanation,path,start_line,end_line,state,verification_attempt_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0.95,'very_high',$9,'Evidence','src/auth.ts',10,12,$10,$11,$12,$12)`,
    [input.id, input.org, input.repo, input.run, input.rev, input.fingerprint, input.severity, input.category, input.title, input.state, verificationAttemptId, NOW],
  );
}

describeWithPostgres("Phase 4 security findings dashboard read model", () => {
  let database: TestDatabase;
  let store: DashboardSecurityStore;

  beforeAll(async () => {
    database = await startPostgres("phase4_security_dashboard");
    await assertSuiteIsActuallyRunning(database, ["review_findings", "review_runs", "review_requests", "pull_requests"]);
    store = new DashboardSecurityStore(database.pool);
  }, 180_000);
  afterAll(async () => { await database?.stop(); }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(`INSERT INTO organizations(id,slug,name) VALUES($1,'security-a','Security A'),($2,'security-b','Security B')`, [ORG_A, ORG_B]);
    await seedReviewGraph(database, { org: ORG_A, repo: REPO_A, pr: PR_A, rev: REV_A, req: REQ_A, run: RUN_A, suffix: "a" });
    await seedReviewGraph(database, { org: ORG_B, repo: REPO_B, pr: PR_B, rev: REV_B, req: REQ_B, run: RUN_B, suffix: "b" });
    await insertFinding(database, { id: SECURITY_HIGH, org: ORG_A, repo: REPO_A, run: RUN_A, rev: REV_A, fingerprint: "1".repeat(64), severity: "high", category: "security", state: "published", title: "Auth bypass" });
    await insertFinding(database, { id: SECURITY_RESOLVED, org: ORG_A, repo: REPO_A, run: RUN_A, rev: REV_A, fingerprint: "2".repeat(64), severity: "medium", category: "security", state: "resolved", title: "Header validation" });
    await insertFinding(database, { id: NON_SECURITY, org: ORG_A, repo: REPO_A, run: RUN_A, rev: REV_A, fingerprint: "3".repeat(64), severity: "critical", category: "correctness", state: "published", title: "Logic bug" });
    await insertFinding(database, { id: FOREIGN_SECURITY, org: ORG_B, repo: REPO_B, run: RUN_B, rev: REV_B, fingerprint: "4".repeat(64), severity: "critical", category: "security", state: "published", title: "Foreign secret" });
  });

  it("keeps category and tenant isolation while preserving PR identity", async () => {
    const result = await store.snapshot({ organizationId: ORG_A, repositoryIds: [], severities: [], lifecycle: [], limit: 100 });
    expect(result.summary).toMatchObject({ total: 2, active: 1, criticalHighActive: 1, published: 1, resolved: 1, repositoriesWithFindings: 1 });
    expect(result.items.map((item) => item.id)).toEqual([SECURITY_HIGH, SECURITY_RESOLVED]);
    expect(result.items[0]).toMatchObject({ repositoryId: REPO_A, reviewRunId: RUN_A, pullRequestId: PR_A, pullRequestNumber: 17, pullRequestTitle: "PR a", author: "alice-a" });
    expect(JSON.stringify(result)).not.toContain(NON_SECURITY);
    expect(JSON.stringify(result)).not.toContain(FOREIGN_SECURITY);
  });

  it("applies repository/severity/lifecycle filters identically to summary and detail rows", async () => {
    const published = await store.snapshot({ organizationId: ORG_A, repositoryIds: [REPO_A], severities: ["high"], lifecycle: ["published"], limit: 100 });
    expect(published.summary).toMatchObject({ total: 1, active: 1, criticalHighActive: 1, published: 1, resolved: 0 });
    expect(published.items.map((item) => item.id)).toEqual([SECURITY_HIGH]);
    const resolved = await store.snapshot({ organizationId: ORG_A, repositoryIds: [REPO_A], severities: ["medium"], lifecycle: ["resolved"], limit: 100 });
    expect(resolved.summary).toMatchObject({ total: 1, active: 0, resolved: 1, published: 0 });
    expect(resolved.items.map((item) => item.id)).toEqual([SECURITY_RESOLVED]);
  });
});
