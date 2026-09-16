import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PolicyDecisionStore,
  PreMergeStore,
  ReviewIngestionStore,
  ReviewStageStore,
  VerificationScheduler,
  VerificationStore,
  findLifecycleViolations,
  type TenantScope,
} from "@acalys/database";
import type { VerificationAttempt } from "@acalys/review-engine";
import {
  assertSuiteIsActuallyRunning,
  dockerAvailable,
  startPostgres,
  type TestDatabase,
} from "../../../packages/database/tests/postgres.js";

import {
  advance,
  advanceToSettled,
  analyze,
  type CandidateVerifier,
  type FunnelConfig,
  type RunContext,
} from "../src/index.js";

const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER
  ? describe
  : describe.skip.bind(describe);

if (!HAS_DOCKER) {
  console.warn("\n  ⚠ Docker unavailable — trust funnel suite SKIPPED.\n");
}

/**
 * The funnel, end to end, in durable rows.
 *
 * ```
 * A  verified     → promoted → policy: publish     → one comment obligation
 * B  rejected     → not promoted, and still queryable
 * C  inconclusive → not promoted, and still queryable
 * D  verified     → promoted → policy: withhold    → no obligation at all
 * ```
 *
 * Written because the checkpoint before it could not have failed. Every module
 * in this chain existed and was tested in isolation; none was called by the
 * worker, and the suite was green. So the assertions here are deliberately
 * about **rows the pipeline wrote**, never about functions this file called
 * itself — a funnel test that drives the stores directly proves the stores
 * work, which was never in doubt.
 *
 * D is the one that matters most. It is a real, independently verified defect
 * that policy decided not to interrupt anyone about, and the two facts have to
 * be separately visible: a `ReviewFinding` exists, and no external obligation
 * does. A pipeline that quietly published it would look identical in every
 * count except this one.
 */
describeWithPostgres("The trust funnel, in durable rows", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startPostgres("funnel");
    await assertSuiteIsActuallyRunning(database, [
      "candidate_findings",
      "verification_invocations",
      "verification_attempts",
      "review_findings",
      "publication_decisions",
      "publication_intents",
      "premerge_check_results",
    ]);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  const ORG = "0192f8a1-0000-7000-8000-00000000000a";
  const REPO = "0192f8a1-0000-7000-8000-0000000000aa";
  const PR = "0192f8a1-0000-7000-8000-0000000000c1";
  const scope: TenantScope = { organizationId: ORG, repositoryId: REPO };
  const HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";
  const at = new Date("2026-08-18T10:00:00.000Z");

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(
      "INSERT INTO organizations (id, slug, name) VALUES ($1,'acme','Acme')",
      [ORG],
    );
    await database.pool.query(
      `INSERT INTO repositories (id, organization_id, provider, provider_external_id,
         owner, name, default_branch, visibility)
       VALUES ($1,$2,'github','1296269','acalys','acalys','main','private')`,
      [REPO, ORG],
    );
    await database.pool.query(
      `INSERT INTO pull_requests (id, organization_id, repository_id, provider,
         provider_external_id, number, title, author, state, draft, created_at, updated_at)
       VALUES ($1,$2,$3,'github','2145998877',412,'t','{"kind":"human"}'::jsonb,'open',false,$4,$4)`,
      [PR, ORG, REPO, at],
    );
  });

  const stores = () => ({
    ingestion: new ReviewIngestionStore(database.pool),
    stages: new ReviewStageStore(database.pool),
    scheduler: new VerificationScheduler(database.pool),
    verifications: new VerificationStore(database.pool),
    decisions: new PolicyDecisionStore(database.pool),
    premerge: new PreMergeStore(database.pool),
  });

  /** The four candidates, with fingerprints the verifier below keys on. */
  const CANDIDATES = [
    { tag: "A", fingerprint: "a".repeat(64), path: "src/a.ts" },
    { tag: "B", fingerprint: "b".repeat(64), path: "src/b.ts" },
    { tag: "C", fingerprint: "c".repeat(64), path: "src/c.ts" },
    // Excluded by path in the publication config below, so it is verified and
    // withheld — the combination the separation exists for.
    { tag: "D", fingerprint: "d".repeat(64), path: "vendor/d.ts" },
  ] as const;

  const DECISIONS: Record<string, VerificationAttempt> = {
    a: {
      status: "completed",
      decision: "verified",
      reasons: ["independent_context_confirms"],
      confidence: 0.93,
      severity: "high",
    },
    b: {
      status: "completed",
      decision: "rejected",
      reasons: ["claimed_mechanism_not_present"],
      confidence: 0.1,
      severity: "medium",
    },
    c: {
      status: "completed",
      decision: "inconclusive",
      reasons: ["insufficient_evidence"],
      confidence: 0.3,
      severity: "medium",
    },
    d: {
      status: "completed",
      decision: "verified",
      reasons: ["evidence_supports_claim"],
      confidence: 0.91,
      severity: "high",
    },
  };

  const verifier = (
    overrides: Record<string, VerificationAttempt> = {},
  ): CandidateVerifier => ({
    id: "acalys.verifier.funnel-fixture",
    version: "1",
    verify: (candidate) => {
      const key = candidate.fingerprintValue.trim()[0] ?? "";
      const attempt = { ...DECISIONS, ...overrides }[key];
      if (attempt === undefined) {
        throw new Error(`fixture has no decision for candidate ${key}`);
      }
      return attempt;
    },
  });

  const config: FunnelConfig = {
    publication: {
      minimumSeverity: "low",
      disabledCategories: [],
      // D is verified and real; policy simply does not interrupt anyone about
      // vendored code.
      excludedPaths: ["vendor/"],
      maxComments: 25,
    },
    premerge: { blockingSeverity: "high", blocking: true },
  };

  /**
   * A run driven to `analyzing` by the orchestrator, then given the four
   * fixture candidates in place of the stub's.
   *
   * The run really passes through the lifecycle; only the analyzer's output is
   * substituted, because the funnel needs one candidate of each outcome and the
   * deterministic stub produces at most three.
   */
  async function seedRun(
    candidates: readonly { fingerprint: string; path: string }[] = CANDIDATES,
  ): Promise<RunContext> {
    const { ingestion } = stores();
    const revision = await ingestion.upsertRevision(scope, {
      pullRequestId: PR,
      headSha: HEAD,
      headRef: "feat/x",
      baseSha: "1".repeat(40),
      baseRef: "main",
      mergeBaseSha: null,
      trigger: "push",
      createdAt: at,
    });
    const request = await ingestion.upsertReviewRequest(scope, {
      pullRequestId: PR,
      revisionId: revision.id,
      target: { kind: "pull_request" },
      trigger: "pull_request_updated",
      requestedBy: { kind: "system", component: "test" },
      executionMode: "review",
      executionStrategy: "single",
      idempotencyKey: "k-funnel",
      requestedAt: at,
    });
    const run = await ingestion.upsertReviewRun(scope, {
      requestId: request.id,
      revisionId: revision.id,
      attempt: 1,
      executionMode: "review",
      executionStrategy: "single",
      createdAt: at,
    });

    const context: RunContext = {
      scope,
      runId: run.id,
      revisionId: revision.id,
      headSha: HEAD,
      provider: "github",
      pullRequestId: PR,
    };

    // queued → preparing → analyzing, driven by the real orchestrator.
    const options = {
      ...stores(),
      analyzer: analyze,
      verifier: verifier(),
      config,
    };
    await advance(context, options); // queued  → preparing
    await advance(context, options); // preparing → analyzing
    await database.pool.query(
      "UPDATE review_runs SET state = 'analyzing' WHERE id = $1",
      [context.runId],
    );
    await database.pool.query(
      "DELETE FROM candidate_findings WHERE review_run_id = $1",
      [context.runId],
    );
    for (const candidate of candidates) {
      await database.pool.query(
        `INSERT INTO candidate_findings (id, organization_id, repository_id, review_run_id,
           producer_id, producer_version, input_digest, title, claim, explanation,
           category, proposed_severity, path, start_line, end_line, fingerprint_value, created_at)
         VALUES (gen_random_uuid(),$1,$2,$3,'acalys.analyzer.fixture','1',$4,
           'Fixture finding','claim','explanation','correctness','medium',$5,1,2,$6,$7)`,
        [
          ORG,
          REPO,
          context.runId,
          "e".repeat(64),
          candidate.path,
          candidate.fingerprint,
          at,
        ],
      );
    }

    return context;
  }

  async function counts(runId: string) {
    const result = await database.pool.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM candidate_findings WHERE review_run_id = $1)      AS candidates,
         (SELECT count(*) FROM verification_invocations WHERE review_run_id = $1) AS invocations,
         (SELECT count(*) FROM verification_attempts WHERE review_run_id = $1)   AS attempts,
         (SELECT count(*) FROM verification_attempts WHERE review_run_id = $1 AND decision = 'verified')     AS verified,
         (SELECT count(*) FROM verification_attempts WHERE review_run_id = $1 AND decision = 'rejected')     AS rejected,
         (SELECT count(*) FROM verification_attempts WHERE review_run_id = $1 AND decision = 'inconclusive') AS inconclusive,
         (SELECT count(*) FROM verification_attempts WHERE review_run_id = $1 AND status = 'unavailable')    AS unavailable,
         (SELECT count(*) FROM review_findings WHERE review_run_id = $1)         AS findings,
         (SELECT count(*) FROM publication_decisions WHERE review_run_id = $1 AND decision = 'publish')  AS publish,
         (SELECT count(*) FROM publication_decisions WHERE review_run_id = $1 AND decision = 'withhold') AS withhold,
         (SELECT count(*) FROM publication_intents WHERE review_run_id = $1)     AS intents,
         (SELECT count(*) FROM publication_intents WHERE review_run_id = $1 AND review_finding_id IS NOT NULL) AS obligations,
         (SELECT count(*) FROM premerge_check_results WHERE review_run_id = $1)  AS checks`,
      [runId],
    );
    return Object.fromEntries(
      Object.entries(result.rows[0] ?? {}).map(([key, value]) => [
        key,
        Number(value),
      ]),
    );
  }

  const drive = (context: RunContext, overrides = {}) =>
    advanceToSettled(context, {
      ...stores(),
      analyzer: analyze,
      verifier: verifier(),
      config,
      ...overrides,
    });

  // ── 1 ──────────────────────────────────────────────────────────────────
  it("four candidates produce exactly one external obligation", async () => {
    const context = await seedRun();
    const outcome = await drive(context);

    // The run really got there. Without this the counts below could all be
    // zero on a refused run and every expectation would still need to be
    // written — which is the shape of the vacuity this project keeps finding.
    expect(outcome).toEqual({ kind: "settled", state: "publishing" });

    expect(await counts(context.runId)).toEqual({
      candidates: 4,
      // One durable command per candidate, allocated before the verifier ran.
      invocations: 4,
      attempts: 4,
      verified: 2,
      rejected: 1,
      inconclusive: 1,
      unavailable: 0,
      // Only the two verified ones.
      findings: 2,
      publish: 1,
      withhold: 1,
      // One run-level review container, plus one comment for A.
      intents: 2,
      // The number that matters: D is real and nobody is interrupted about it.
      obligations: 1,
      checks: 1,
    });

    expect(await findLifecycleViolations(database.pool)).toEqual([]);
  }, 120_000);

  // ── 2 ──────────────────────────────────────────────────────────────────
  it("rejected and inconclusive stay durable and queryable", async () => {
    // Not deleted after reconciliation. A low-confidence candidate that
    // verifies and a high-confidence one that gets rejected are the two signals
    // that say whether analyzer confidence is calibrated, and a funnel that
    // discards them cannot answer the question it exists to answer.
    const context = await seedRun();
    await drive(context);

    const attempts = await database.pool.query<{
      fingerprint_value: string;
      decision: string;
      reasons: string[];
    }>(
      `SELECT c.fingerprint_value, v.decision, v.reasons
         FROM verification_attempts v
         JOIN candidate_findings c ON c.id = v.candidate_finding_id
        WHERE v.review_run_id = $1
        ORDER BY c.fingerprint_value`,
      [context.runId],
    );

    expect(
      attempts.rows.map((row) => [
        row.fingerprint_value.trim()[0],
        row.decision,
      ]),
    ).toEqual([
      ["a", "verified"],
      ["b", "rejected"],
      ["c", "inconclusive"],
      ["d", "verified"],
    ]);

    // The reason survives too. "Rejected, reason unknown" is a row nobody can
    // use to improve the analyzer.
    expect(attempts.rows[1]?.reasons).toEqual([
      "claimed_mechanism_not_present",
    ]);
    expect(attempts.rows[2]?.reasons).toEqual(["insufficient_evidence"]);
  }, 120_000);

  // ── 3 ──────────────────────────────────────────────────────────────────
  it("the withheld finding exists and owes nothing externally", async () => {
    const context = await seedRun();
    await drive(context);

    const withheld = await database.pool.query<{
      id: string;
      state: string;
      reason: string;
      intents: string;
    }>(
      `SELECT f.id, f.state, d.reason,
              (SELECT count(*) FROM publication_intents p
                WHERE p.review_finding_id = f.id) AS intents
         FROM review_findings f
         JOIN publication_decisions d ON d.review_finding_id = f.id
        WHERE f.review_run_id = $1 AND d.decision = 'withhold'`,
      [context.runId],
    );

    expect(withheld.rowCount).toBe(1);
    // Still a ReviewFinding: verification established it, and policy declining
    // to interrupt anyone does not make it less true.
    expect(withheld.rows[0]?.state).toBe("verified");
    expect(withheld.rows[0]?.reason).toBe("path_excluded");
    expect(Number(withheld.rows[0]?.intents)).toBe(0);
  }, 120_000);

  // ── 4 ──────────────────────────────────────────────────────────────────
  it("a withheld decision cannot be cited by a publication, at the database", async () => {
    // The structural half of the previous test. Above, policy chose not to
    // publish; here, publishing anyway is refused by the schema — the withheld
    // decision's `publishable_id` is NULL and a foreign key cannot reference
    // NULL, so there is nothing for a rogue INSERT to point at.
    const context = await seedRun();
    await drive(context);

    const withheld = await database.pool.query<{ id: string; finding: string }>(
      `SELECT id, review_finding_id AS finding FROM publication_decisions
        WHERE review_run_id = $1 AND decision = 'withhold'`,
      [context.runId],
    );
    const decisionId = withheld.rows[0]?.id;

    await expect(
      database.pool.query(
        `INSERT INTO publication_intents (id, organization_id, review_run_id, provider,
           kind, logical_key, content_digest, state, review_finding_id,
           publication_decision_id, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,$2,'github','inline_comment','rogue',$3,'planned',$4,$5,$6,$6)`,
        [
          ORG,
          context.runId,
          "f".repeat(64),
          withheld.rows[0]?.finding,
          decisionId,
          at,
        ],
      ),
    ).rejects.toThrow(/publication_decision_id_fkey/);

    // And a finding-scoped publication with no decision at all is refused too,
    // so "omit the column" is not the way around it.
    await expect(
      database.pool.query(
        `INSERT INTO publication_intents (id, organization_id, review_run_id, provider,
           kind, logical_key, content_digest, state, review_finding_id, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,$2,'github','inline_comment','rogue2',$3,'planned',$4,$5,$5)`,
        [ORG, context.runId, "f".repeat(64), withheld.rows[0]?.finding, at],
      ),
    ).rejects.toThrow(/publication_intents_finding_needs_decision/);
  }, 120_000);

  // ── 5 ──────────────────────────────────────────────────────────────────
  it("re-running the whole flow duplicates nothing", async () => {
    const context = await seedRun();
    await drive(context);
    const first = await counts(context.runId);

    // Wind the run back and drive it again, the way a redelivered job would.
    await database.pool.query(
      "UPDATE review_runs SET state = 'verifying' WHERE id = $1",
      [context.runId],
    );
    await drive(context);

    expect(await counts(context.runId)).toEqual(first);
    expect(await findLifecycleViolations(database.pool)).toEqual([]);
  }, 120_000);

  // ── 6 ──────────────────────────────────────────────────────────────────
  it("crashing after the attempts, before promotion, converges", async () => {
    const context = await seedRun();
    const options = {
      ...stores(),
      analyzer: analyze,
      verifier: verifier(),
      config,
    };

    // Drive only as far as `reconciling`: attempts are durable, nothing is
    // promoted, and the worker dies.
    for (let step = 0; step < 6; step += 1) {
      const run = await stores().ingestion.getRun(context.runId);
      if (run?.state === "reconciling") break;
      const outcome = await advance(context, options);
      if (outcome.kind !== "advanced") break;
    }

    const midway = await counts(context.runId);
    expect(midway["attempts"]).toBe(4);
    expect(midway["findings"]).toBe(0);
    expect(midway["publish"]).toBe(0);

    // A replacement worker resumes. It must not re-verify — the attempts are
    // already durable — and must reach the same publication state.
    await drive(context);

    const final = await counts(context.runId);
    expect(final["attempts"]).toBe(4);
    expect(final["findings"]).toBe(2);
    expect(final["obligations"]).toBe(1);
    expect(await findLifecycleViolations(database.pool)).toEqual([]);
  }, 120_000);

  // ── 7 ──────────────────────────────────────────────────────────────────
  it("promotion, policy and the ledger commit together or not at all", async () => {
    // The reconciling → publishing transition carries three writes and the
    // transition itself. A crash inside it must leave none of them, or
    // `state = publishing` could exist with findings nobody decided about.
    const context = await seedRun();
    const options = {
      ...stores(),
      analyzer: analyze,
      verifier: verifier(),
      config,
    };

    for (let step = 0; step < 6; step += 1) {
      const run = await stores().ingestion.getRun(context.runId);
      if (run?.state === "reconciling") break;
      const outcome = await advance(context, options);
      if (outcome.kind !== "advanced") break;
    }
    expect((await stores().ingestion.getRun(context.runId))?.state).toBe(
      "reconciling",
    );

    const exploding = new ReviewStageStore(database.pool, () => new Date(), {
      afterOutput: () => Promise.reject(new Error("worker died")),
    });
    await expect(
      advance(context, { ...options, stages: exploding }),
    ).rejects.toThrow(/worker died/);

    const after = await counts(context.runId);
    expect(after).toMatchObject({
      attempts: 4,
      findings: 0,
      publish: 0,
      withhold: 0,
      intents: 0,
      checks: 0,
    });
    expect((await stores().ingestion.getRun(context.runId))?.state).toBe(
      "reconciling",
    );

    // And the retry completes it.
    await drive(context);
    expect(await counts(context.runId)).toMatchObject({
      findings: 2,
      publish: 1,
      withhold: 1,
      obligations: 1,
    });
  }, 120_000);

  // ── 8 ──────────────────────────────────────────────────────────────────
  it("zero actionable findings is a successful review", async () => {
    const context = await seedRun([
      { fingerprint: "b".repeat(64), path: "src/b.ts" },
      { fingerprint: "c".repeat(64), path: "src/c.ts" },
    ]);
    const outcome = await drive(context);

    expect(outcome).toEqual({ kind: "settled", state: "publishing" });
    expect(await counts(context.runId)).toMatchObject({
      candidates: 2,
      attempts: 2,
      rejected: 1,
      inconclusive: 1,
      findings: 0,
      publish: 0,
      withhold: 0,
      // The run-level review container still exists: the reviewer says "nothing
      // actionable" rather than going silent.
      intents: 1,
      obligations: 0,
    });

    const summary = await database.pool.query<{ kind: string }>(
      "SELECT kind FROM publication_intents WHERE review_run_id = $1",
      [context.runId],
    );
    expect(summary.rows[0]?.kind).toBe("review");
    expect(await findLifecycleViolations(database.pool)).toEqual([]);

    // Not a failure, and the check passes rather than being skipped: a change
    // with no verified defect has satisfied the policy.
    const checks = await stores().premerge.forRun(context.runId);
    expect(checks[0]?.status).toBe("passed");
  }, 120_000);

  // ── 9 ──────────────────────────────────────────────────────────────────
  it("an unverifiable candidate fails the run rather than publishing the rest", async () => {
    // The outage case. Publishing what did verify would render a verifier
    // failure as *fewer comments on a successful review* — indistinguishable
    // from good news, and every metric would agree.
    const context = await seedRun();
    const outcome = await drive(context, {
      verifier: verifier({
        c: { status: "unavailable", failure: "model_timeout" },
      }),
    });

    expect(outcome).toEqual({ kind: "settled", state: "failed" });

    const final = await counts(context.runId);
    expect(final["attempts"]).toBe(4);
    expect(final["unavailable"]).toBe(1);
    // Nothing was promoted, decided, or published.
    expect(final["findings"]).toBe(0);
    expect(final["publish"]).toBe(0);
    expect(final["intents"]).toBe(0);

    // The unavailable attempt carries a failure and no decision, so no reader
    // can mistake an outage for a judgement about the claim.
    const unavailable = await database.pool.query<{
      decision: string | null;
      failure: string;
    }>(
      `SELECT decision, failure FROM verification_attempts
        WHERE review_run_id = $1 AND status = 'unavailable'`,
      [context.runId],
    );
    expect(unavailable.rows[0]?.decision).toBeNull();
    expect(unavailable.rows[0]?.failure).toBe("model_timeout");
  }, 120_000);

  // ── 10 ─────────────────────────────────────────────────────────────────
  it("a finding nobody is commented on can still block the merge", async () => {
    // ── The proof that enforcement is not derived from attention ──────────
    //
    // One candidate: verified, high severity, and withheld from the comment
    // surface because it is in vendored code. Nobody is interrupted about it,
    // and the merge check fails anyway.
    //
    // If the pre-merge policy read publication state — plausibly, "block on
    // what we commented on" — this run would pass, and so would a run where the
    // only reason nothing was commented was an exhausted comment budget. The
    // merge gate would then be tuned by a rendering limit.
    const context = await seedRun([
      { fingerprint: "d".repeat(64), path: "vendor/d.ts" },
    ]);
    const outcome = await drive(context);
    expect(outcome).toEqual({ kind: "settled", state: "publishing" });

    expect(await counts(context.runId)).toMatchObject({
      findings: 1,
      publish: 0,
      withhold: 1,
      // No comment. No external obligation of any kind beyond the container.
      obligations: 0,
    });

    const checks = await stores().premerge.forRun(context.runId);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("failed");
    expect(checks[0]?.blocking).toBe(true);
    expect(checks[0]?.explanation).toContain("1 verified finding(s)");
  }, 120_000);

  // ── 11 ─────────────────────────────────────────────────────────────────
  it("a finding worth commenting on need not block the merge", async () => {
    // The opposite combination, from the same finding. Only the pre-merge
    // configuration changes, and only the check changes with it — the comment
    // is published either way, which is what proves the two thresholds are
    // genuinely separate rather than one number read twice.
    const context = await seedRun([
      { fingerprint: "a".repeat(64), path: "src/a.ts" },
    ]);
    const outcome = await advanceToSettled(context, {
      ...stores(),
      analyzer: analyze,
      verifier: verifier(),
      config: {
        ...config,
        premerge: { blockingSeverity: "critical", blocking: true },
      },
    });
    expect(outcome).toEqual({ kind: "settled", state: "publishing" });

    expect(await counts(context.runId)).toMatchObject({
      findings: 1,
      publish: 1,
      obligations: 1,
    });

    const checks = await stores().premerge.forRun(context.runId);
    expect(checks[0]?.status).toBe("passed");
  }, 120_000);

  // ── 12 ─────────────────────────────────────────────────────────────────
  it("the enforcement table cannot reference publication state", async () => {
    // Structural, not behavioural. The independence above is a property of the
    // code; this is a property of the schema, and it is the one that survives a
    // refactor by someone who has not read the code.
    const columns = await database.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'premerge_check_results'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain("publication_intent_id");
    expect(names).not.toContain("publication_decision_id");
    expect(names).not.toContain("published");

    // And no foreign key from enforcement to either publication table.
    const references = await database.pool.query<{ referenced: string }>(
      `SELECT ccu.table_name AS referenced
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'premerge_check_results'
          AND tc.constraint_type = 'FOREIGN KEY'`,
    );
    const referenced = references.rows.map((row) => row.referenced);
    expect(referenced).not.toContain("publication_intents");
    expect(referenced).not.toContain("publication_decisions");
    // It does reference the run, which is how the two surfaces are correlated
    // for display without either deriving from the other.
    expect(referenced).toContain("review_runs");
  }, 120_000);

  // ── 13 ─────────────────────────────────────────────────────────────────
  it("refuses to reconcile a run with a candidate nothing examined", async () => {
    // ── Defence in depth, actually exercised ──────────────────────────────
    //
    // The orchestrator verifies every candidate before it asks for this
    // transition, so in normal operation the prerequisite never fires. That is
    // precisely why it needs its own test: two mutations that disabled it —
    // making the check unconditional, and letting an `unavailable` attempt
    // count as examined — both SURVIVED the suite before this existed.
    //
    // A guard nothing reaches is a guard nobody knows is broken, and this one
    // is the last thing standing between an externally corrupted database and a
    // review that publishes the subset it happened to verify.
    const context = await seedRun();
    await drive(context);

    const { stages } = stores();
    const candidates = await database.pool.query<{ id: string }>(
      "SELECT id FROM candidate_findings WHERE review_run_id = $1 ORDER BY fingerprint_value",
      [context.runId],
    );
    const victim = candidates.rows[0]?.id;

    // Wind back to `verifying`, dismantling what reconciliation produced.
    await database.pool.query(
      "DELETE FROM publication_intents WHERE review_run_id = $1",
      [context.runId],
    );
    await database.pool.query(
      "DELETE FROM publication_decisions WHERE review_run_id = $1",
      [context.runId],
    );
    await database.pool.query(
      "DELETE FROM review_findings WHERE review_run_id = $1",
      [context.runId],
    );
    await database.pool.query(
      "UPDATE review_runs SET state = 'verifying' WHERE id = $1",
      [context.runId],
    );
    await database.pool.query(
      "DELETE FROM verification_attempts WHERE candidate_finding_id = $1",
      [victim],
    );

    // The store is asked directly, because the orchestrator would helpfully
    // re-verify the missing candidate and the guard would never be reached.
    const missing = await stages.runStage(
      context.scope,
      context.runId,
      "verifying",
      "reconciling",
      () => ({}),
      ["candidates", "every_candidate_examined"],
    );
    expect(missing).toEqual({
      kind: "prerequisite_missing",
      state: "verifying",
      missing: "every_candidate_examined",
    });
    expect((await stores().ingestion.getRun(context.runId))?.state).toBe(
      "verifying",
    );

    // And an `unavailable` attempt does not satisfy it either. It has examined
    // nothing, so counting it here would let a verifier outage advance the run
    // and publish whatever else happened to verify.
    const invocation = await stores().scheduler.schedule({
      organizationId: ORG,
      reviewRunId: context.runId,
      candidateFindingId: victim ?? "",
      requestKey: `outage:${context.runId}:${victim ?? ""}`,
      reason: "retry_unavailable",
    });
    // An attempt is written under the lease that owns its invocation, so the
    // outage row has to be claimed first the way the worker claims one.
    const outageClaim = await stores().scheduler.claim(
      invocation.invocationId,
      "test-worker",
      60_000,
    );
    if (outageClaim.kind !== "claimed") {
      throw new Error(`expected a verification claim, got ${outageClaim.kind}`);
    }
    await database.pool.query(
      `INSERT INTO verification_attempts (id, organization_id, review_run_id,
         candidate_finding_id, status, failure, verifier_id, verifier_version,
         context_digest, cache_key, invocation_id, attempt, claim_token,
         claim_generation, created_at)
       VALUES (gen_random_uuid(),$1,$2,$3,'unavailable','model_timeout','v','1',
         $4,$5,$6,$7,$8,$9,$10)`,
      [
        ORG,
        context.runId,
        victim,
        "c".repeat(64),
        "k".repeat(64),
        invocation.invocationId,
        invocation.attempt,
        outageClaim.claim.claimToken,
        outageClaim.claim.claimGeneration,
        at,
      ],
    );

    const stillMissing = await stages.runStage(
      context.scope,
      context.runId,
      "verifying",
      "reconciling",
      () => ({}),
      ["candidates", "every_candidate_examined"],
    );
    expect(stillMissing).toEqual({
      kind: "prerequisite_missing",
      state: "verifying",
      missing: "every_candidate_examined",
    });

    // The positive case, so the guard is not simply refusing everything: a
    // completed attempt for the same candidate lets the run advance.
    const recovery = await stores().scheduler.schedule({
      organizationId: ORG,
      reviewRunId: context.runId,
      candidateFindingId: victim ?? "",
      requestKey: `recovered:${context.runId}:${victim ?? ""}`,
      reason: "retry_unavailable",
    });
    const recoveryClaim = await stores().scheduler.claim(
      recovery.invocationId,
      "funnel-test",
      60_000,
    );
    expect(recoveryClaim.kind).toBe("claimed");
    if (recoveryClaim.kind !== "claimed")
      throw new Error("expected recovery claim");
    await stores().verifications.recordAttempt({
      invocationId: recoveryClaim.claim.invocationId,
      claimToken: recoveryClaim.claim.claimToken,
      claimGeneration: recoveryClaim.claim.claimGeneration,
      attempt: recoveryClaim.claim.attempt,
      candidateFindingId: victim ?? "",
      reviewRunId: context.runId,
      organizationId: ORG,
      verifierId: "v",
      verifierVersion: "1",
      contextDigest: "c".repeat(64),
      cacheKey: "k".repeat(64),
      outcome: {
        status: "completed",
        decision: "rejected",
        reasons: ["claimed_mechanism_not_present"],
        confidence: 0.1,
        severity: "medium",
      },
    });

    const advanced = await stages.runStage(
      context.scope,
      context.runId,
      "verifying",
      "reconciling",
      () => ({}),
      ["candidates", "every_candidate_examined"],
    );
    expect(advanced).toEqual({ kind: "advanced", state: "reconciling" });
  }, 120_000);

  // ── 14 ─────────────────────────────────────────────────────────────────
  it("a finding citing an unverified attempt is refused by the database", async () => {
    // The last joint of the funnel, made structural in 0008.
    //
    // `VerificationStore.promote` already refused this, and the entailment
    // query already reported it. Neither is the guarantee: the first is code a
    // second writer can skip — which is exactly what the orchestrator did for
    // three checkpoints — and the second is a report, which arrives after the
    // row exists.
    const context = await seedRun();
    await drive(context);

    const rejected = await database.pool.query<{ id: string }>(
      `SELECT id FROM verification_attempts
        WHERE review_run_id = $1 AND decision = 'rejected'`,
      [context.runId],
    );
    const inconclusive = await database.pool.query<{ id: string }>(
      `SELECT id FROM verification_attempts
        WHERE review_run_id = $1 AND decision = 'inconclusive'`,
      [context.runId],
    );
    expect(rejected.rowCount).toBe(1);
    expect(inconclusive.rowCount).toBe(1);

    const forge = (attemptId: string | null, fingerprint: string) =>
      database.pool.query(
        `INSERT INTO review_findings (id, organization_id, repository_id, review_run_id,
           revision_id, fingerprint_value, severity, category, confidence_score,
           confidence_level, title, explanation, path, start_line, end_line, state,
           verification_attempt_id, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'high','correctness',0.9,'high',
           't','e','src/x.ts',1,2,'verified',$6,$7,$7)`,
        [
          ORG,
          REPO,
          context.runId,
          context.revisionId,
          fingerprint,
          attemptId,
          at,
        ],
      );

    // Neither a rejection nor an inconclusive result can be cited: the
    // generated `verified_id` is NULL for both, and a foreign key cannot
    // reference NULL.
    await expect(
      forge(rejected.rows[0]?.id ?? null, "1".repeat(64)),
    ).rejects.toThrow(/review_findings_promoted_by_verification/);
    await expect(
      forge(inconclusive.rows[0]?.id ?? null, "2".repeat(64)),
    ).rejects.toThrow(/review_findings_promoted_by_verification/);

    // And omitting the citation is not the way around it.
    await expect(forge(null, "3".repeat(64))).rejects.toThrow(
      /verification_attempt_id/,
    );

    // The verified attempt IS citable, so the constraint is not simply
    // refusing every insert.
    const verified = await database.pool.query<{ id: string }>(
      `SELECT id FROM verification_attempts
        WHERE review_run_id = $1 AND decision = 'verified' LIMIT 1`,
      [context.runId],
    );
    await forge(verified.rows[0]?.id ?? null, "4".repeat(64));
  }, 120_000);
});
