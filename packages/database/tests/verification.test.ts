import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AttemptIdentityConflict,
  AttemptResultConflict,
  VerificationScheduler,
  VerificationStore,
  type AttemptRecord,
  type ScheduledInvocation,
  type VerificationClaim,
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
    "\n  ⚠ Docker unavailable — verification store tests SKIPPED.\n",
  );
}

/**
 * Verification persistence under the failure modes production introduces.
 *
 * The property, stated so a weaker one cannot satisfy it:
 *
 * > Under retries, concurrency and crash injection, durable state converges on
 * > one auditable outcome — without reclassifying verifier availability, losing
 * > rejected or inconclusive evidence, or duplicating a promoted finding.
 */
describeWithPostgres("Verification persistence converges", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startPostgres("verification");
    await assertSuiteIsActuallyRunning(database, [
      "verification_invocations",
      "verification_attempts",
      "review_findings",
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
  const now = new Date("2026-08-18T00:00:00.000Z");

  async function seed(): Promise<{
    runId: string;
    candidateId: string;
    revisionId: string;
  }> {
    await database.pool.query(
      "INSERT INTO organizations (id, slug, name) VALUES ($1,'acme','Acme') ON CONFLICT DO NOTHING",
      [ORG],
    );
    await database.pool.query(
      `INSERT INTO repositories (id, organization_id, provider, provider_external_id,
         owner, name, default_branch, visibility)
       VALUES ($1,$2,'github','1','acalys','acalys','main','private')
       ON CONFLICT DO NOTHING`,
      [REPO, ORG],
    );
    const pr = randomUUID();
    await database.pool.query(
      `INSERT INTO pull_requests (id, organization_id, repository_id, provider,
         provider_external_id, number, title, author, state, draft, created_at, updated_at)
       VALUES ($1,$2,$3,'github',$4,1,'t','{"kind":"human"}'::jsonb,'open',false,$5,$5)`,
      [pr, ORG, REPO, randomUUID(), now],
    );
    const revision = randomUUID();
    await database.pool.query(
      `INSERT INTO pull_request_revisions (id, organization_id, repository_id,
         pull_request_id, sequence, head_sha, head_ref, base_sha, base_ref, trigger,
         created_at)
       VALUES ($1,$2,$3,$4,1,$5,'feature',$6,'main','push',$7)`,
      [revision, ORG, REPO, pr, "a".repeat(40), "b".repeat(40), now],
    );
    const request = randomUUID();
    await database.pool.query(
      `INSERT INTO review_requests (id, organization_id, repository_id, pull_request_id,
         revision_id, target, trigger, requested_by, execution_mode, execution_strategy,
         idempotency_scope, idempotency_key, requested_at)
       VALUES ($1,$2,$3,$4,$5,'{"kind":"pull_request"}'::jsonb,'pull_request_updated',
         '{"kind":"system"}'::jsonb,'review','single',$6,$7,$8)`,
      [request, ORG, REPO, pr, revision, ORG, randomUUID(), now],
    );
    const run = randomUUID();
    await database.pool.query(
      `INSERT INTO review_runs (id, organization_id, repository_id, request_id, revision_id,
         attempt, state, execution_mode, execution_strategy, created_at)
       VALUES ($1,$2,$3,$4,$5,1,'verifying','review','single',$6)`,
      [run, ORG, REPO, request, revision, now],
    );
    const candidate = randomUUID();
    await database.pool.query(
      `INSERT INTO candidate_findings (id, organization_id, repository_id, review_run_id,
         producer_id, producer_version, input_digest, title, claim, explanation,
         category, proposed_severity, path, start_line, end_line, fingerprint_value, created_at)
       VALUES ($1,$2,$3,$4,'a','1',$5,'t','c','e','correctness','medium','src/a.ts',1,1,$6,$7)`,
      [candidate, ORG, REPO, run, "d".repeat(64), "f".repeat(64), now],
    );

    return { runId: run, candidateId: candidate, revisionId: revision };
  }

  const store = () => new VerificationStore(database.pool, () => now);
  const scheduler = () => new VerificationScheduler(database.pool, () => now);

  /**
   * Allocates a command, the way the worker does.
   *
   * The tests used to mint `invocationId: randomUUID()` and pass an ordinal
   * literal, which is what "the ordinal is supplied by the caller" permitted.
   * Migration 0007's composite foreign key refuses that: an attempt may only
   * claim an identity a scheduler durably allocated. So the helper schedules,
   * and the attempt inherits both the id and the ordinal from the command —
   * which is also how the production path now works.
   */
  const schedule = async (
    ids: { runId: string; candidateId: string },
    pass: number,
    reason: "initial" | "retry_unavailable" | "operator_reverify" = "initial",
  ): Promise<ScheduledInvocation> =>
    scheduler().schedule({
      organizationId: ORG,
      reviewRunId: ids.runId,
      candidateFindingId: ids.candidateId,
      requestKey: `test:run:${ids.runId}:candidate:${ids.candidateId}:pass:${String(pass)}`,
      reason,
    });

  /**
   * Ownership for an invocation, taken once and reused.
   *
   * An attempt may only be written under the lease that owns the invocation,
   * so the helper claims on first use and remembers the token: re-claiming an
   * invocation this worker already holds would come back `busy`, not a second
   * generation.
   */
  const claims = new Map<string, VerificationClaim>();
  const claimFor = async (invocationId: string): Promise<VerificationClaim> => {
    const held = claims.get(invocationId);
    if (held !== undefined) return held;
    const ownership = await scheduler().claim(
      invocationId,
      "test-worker",
      60_000,
    );
    if (ownership.kind !== "claimed") {
      throw new Error(`expected a verification claim, got ${ownership.kind}`);
    }
    claims.set(invocationId, ownership.claim);
    return ownership.claim;
  };

  const attempt = async (
    ids: { runId: string; candidateId: string },
    invocation: ScheduledInvocation,
    overrides: Partial<AttemptRecord> = {},
  ): Promise<AttemptRecord> => ({
    invocationId: invocation.invocationId,
    claimToken: (await claimFor(invocation.invocationId)).claimToken,
    claimGeneration: (await claimFor(invocation.invocationId)).claimGeneration,
    attempt: invocation.attempt,
    candidateFindingId: ids.candidateId,
    reviewRunId: ids.runId,
    organizationId: ORG,
    verifierId: "acalys.verifier.re-derivation",
    verifierVersion: "1.0.0",
    contextDigest: "c".repeat(64),
    cacheKey: "k".repeat(64),
    outcome: {
      status: "completed",
      decision: "verified",
      reasons: ["independent_context_confirms"],
      confidence: 0.9,
      severity: "medium",
    },
    ...overrides,
  });

  // ── 1 ────────────────────────────────────────────────────────────────────
  it("two workers persisting the same invocation produce one logical attempt", async () => {
    // Redelivery, not retry. An at-least-once worker delivering its own work
    // twice must converge rather than accumulate.
    const ids = await seed();
    const record = await attempt(ids, await schedule(ids, 1));

    const [first, second] = await Promise.all([
      store().recordAttempt(record),
      store().recordAttempt(record),
    ]);

    expect(second.id).toBe(first.id);
    // Exactly one of the two wrote it, and both learned which.
    expect([first.inserted, second.inserted].filter(Boolean)).toHaveLength(1);
    expect(await store().attemptsFor(ids.candidateId)).toHaveLength(1);
  }, 60_000);

  // ── 2 ────────────────────────────────────────────────────────────────────
  it("two genuine attempts keep distinct ordinals and neither overwrites the other", async () => {
    const ids = await seed();

    const first = await schedule(ids, 1);
    expect(first.attempt).toBe(1);

    const rejected = await store().recordAttempt(
      await attempt(ids, first, {
        outcome: {
          status: "completed",
          decision: "rejected",
          reasons: ["claim_contradicted_by_context"],
          confidence: 0.85,
          severity: "medium",
        },
      }),
    );

    // The verifier was fixed and the claim re-examined. A different request
    // key, so the scheduler allocates rather than converges — and the ordinal
    // it hands back is the authority, not a number this test chose.
    const second = await schedule(ids, 2, "operator_reverify");
    expect(second.attempt).toBe(2);
    expect(second.allocated).toBe(true);

    const verified = await store().recordAttempt(await attempt(ids, second));

    expect(verified.id).not.toBe(rejected.id);

    const history = await store().attemptsFor(ids.candidateId);
    expect(history.map((row) => row.attempt)).toEqual([1, 2]);
    // The earlier rejection survives: it is the calibration evidence that says
    // whether the verifier changed its mind, and about what.
    expect(history[0]?.decision).toBe("rejected");
    expect(history[1]?.decision).toBe("verified");
  }, 60_000);

  it("refuses an attempt claiming an ordinal no scheduler allocated", async () => {
    // The stronger form of "refuses a second attempt reusing an ordinal".
    //
    // The ordinal is no longer a number the caller picks, so reusing one means
    // presenting an identity the scheduler did not issue: a real invocation
    // paired with someone else's ordinal.
    const ids = await seed();
    const first = await schedule(ids, 1);
    const second = await schedule(ids, 2, "operator_reverify");

    // Invocation 2, carrying invocation 1's ordinal, with NO attempt rows yet.
    // Nothing else can fire: `verification_attempts_sequence_uq` needs an
    // existing row, and the ON CONFLICT path needs this invocation to have been
    // recorded already. Only the composite foreign key can refuse this, which
    // is the point of keying on all three columns — a single-column key on
    // `invocation_id` would have let it through while looking correct.
    await expect(
      store().recordAttempt(
        await attempt(ids, { ...second, attempt: first.attempt }),
      ),
    ).rejects.toThrow(/verification_attempts_from_invocation/);
    expect(await store().attemptsFor(ids.candidateId)).toHaveLength(0);

    // The other half, which no constraint can reach: once an invocation HAS an
    // attempt, `ON CONFLICT (invocation_id)` converges without inserting, so
    // the database checks nothing and the caller is handed a row it did not
    // describe. The store refuses it explicitly.
    await store().recordAttempt(await attempt(ids, first));
    await expect(
      store().recordAttempt(
        await attempt(ids, { ...first, attempt: second.attempt }),
      ),
    ).rejects.toThrow(AttemptIdentityConflict);

    expect(await store().attemptsFor(ids.candidateId)).toHaveLength(1);
  }, 60_000);

  it("refuses one invocation that executed twice with different results", async () => {
    // ── The verification analogue of the publication digest invariant ──────
    //
    // A redelivery re-presents a result that already exists. This is a second
    // *execution* of a logical verification that was supposed to happen once,
    // and `ON CONFLICT (invocation_id)` would silently let arrival order decide
    // which conclusion the product stands behind.
    //
    // It cannot happen with a deterministic verifier, which is precisely why
    // the check is worth having before the verifier is model-backed: by then
    // the symptom is a published finding whose recorded reasons are not the
    // ones that produced it, and nothing would have complained.
    const ids = await seed();
    const invocation = await schedule(ids, 1);

    await store().recordAttempt(await attempt(ids, invocation));

    // Same invocation. Different conclusion.
    await expect(
      store().recordAttempt(
        await attempt(ids, invocation, {
          outcome: {
            status: "completed",
            decision: "rejected",
            reasons: ["claimed_mechanism_not_present"],
            confidence: 0.2,
            severity: "medium",
          },
        }),
      ),
    ).rejects.toThrow(AttemptResultConflict);

    // Same decision, different reasons — still two executions, still refused.
    await expect(
      store().recordAttempt(
        await attempt(ids, invocation, {
          outcome: {
            status: "completed",
            decision: "verified",
            reasons: ["evidence_supports_claim"],
            confidence: 0.9,
            severity: "medium",
          },
        }),
      ),
    ).rejects.toThrow(AttemptResultConflict);

    // A genuine redelivery — byte-identical result — still converges. Without
    // this the check would have made at-least-once delivery unusable, which is
    // the failure mode a stricter invariant usually introduces.
    const replayed = await store().recordAttempt(
      await attempt(ids, invocation),
    );
    expect(replayed.inserted).toBe(false);
    expect(await store().attemptsFor(ids.candidateId)).toHaveLength(1);
  }, 60_000);

  it("stores an unavailable attempt without it resembling a decision", async () => {
    const ids = await seed();
    const stored = await store().recordAttempt(
      await attempt(ids, await schedule(ids, 1), {
        outcome: { status: "unavailable", failure: "model_timeout" },
      }),
    );

    expect(stored.status).toBe("unavailable");
    // No decision at all, so nothing downstream can read it as `inconclusive`.
    expect(stored.decision).toBeNull();
    expect(stored.failure).toBe("model_timeout");
  }, 60_000);

  // ── 3 ────────────────────────────────────────────────────────────────────
  it("concurrent promotion of one fingerprint yields exactly one finding", async () => {
    // A lookup-then-insert is a race two workers lose together, and the symptom
    // is two comments about one defect.
    const ids = await seed();
    const stored = await store().recordAttempt(
      await attempt(ids, await schedule(ids, 1)),
    );

    const promotion = {
      reviewRunId: ids.runId,
      organizationId: ORG,
      repositoryId: REPO,
      verificationAttemptId: stored.id,
      revisionId: ids.revisionId,
      fingerprintValue: "f".repeat(64),
      severity: "medium",
      category: "correctness",
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      title: "t",
      claim: "c",
      explanation: "e",
    };

    const results = await Promise.all([
      store().promote(promotion),
      store().promote(promotion),
      store().promote(promotion),
    ]);

    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    const findings = await database.pool.query(
      "SELECT id FROM review_findings WHERE review_run_id = $1",
      [ids.runId],
    );
    expect(findings.rowCount).toBe(1);
  }, 60_000);

  // ── 4 ────────────────────────────────────────────────────────────────────
  it("converges on the same finding after a crash between attempt and promotion", async () => {
    // The property that matters most: not merely idempotent function by
    // function, but convergent across a crash boundary.
    const ids = await seed();
    const record = await attempt(ids, await schedule(ids, 1));

    const first = await store().recordAttempt(record);
    // The worker dies here. A replacement redelivers the same invocation.
    const replayed = await store().recordAttempt(record);
    expect(replayed.id).toBe(first.id);
    expect(replayed.inserted).toBe(false);

    const promotion = {
      reviewRunId: ids.runId,
      organizationId: ORG,
      repositoryId: REPO,
      verificationAttemptId: replayed.id,
      revisionId: ids.revisionId,
      fingerprintValue: "f".repeat(64),
      severity: "medium",
      category: "correctness",
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      title: "t",
      claim: "c",
      explanation: "e",
    };

    const promoted = await store().promote(promotion);
    expect((await store().promote(promotion)).id).toBe(promoted.id);
    expect(await store().attemptsFor(ids.candidateId)).toHaveLength(1);
  }, 60_000);

  it("refuses to promote a candidate its verification did not verify", async () => {
    // The last place the guarantee can be enforced, and the one an ad-hoc
    // script would go through.
    const ids = await seed();
    for (const decision of ["rejected", "inconclusive"] as const) {
      const stored = await store().recordAttempt(
        await attempt(
          ids,
          await schedule(ids, decision === "rejected" ? 1 : 2),
          {
            outcome: {
              status: "completed",
              decision,
              reasons: ["insufficient_evidence"],
              confidence: 0.3,
              severity: "medium",
            },
          },
        ),
      );

      await expect(
        store().promote({
          reviewRunId: ids.runId,
          organizationId: ORG,
          repositoryId: REPO,
          verificationAttemptId: stored.id,
          revisionId: ids.revisionId,
          fingerprintValue: "f".repeat(64),
          severity: "medium",
          category: "correctness",
          path: "src/a.ts",
          startLine: 1,
          endLine: 1,
          title: "t",
          claim: "c",
          explanation: "e",
        }),
      ).rejects.toThrow(/did not verify/i);
    }

    const findings = await database.pool.query(
      "SELECT id FROM review_findings WHERE review_run_id = $1",
      [ids.runId],
    );
    expect(findings.rowCount).toBe(0);
  }, 60_000);
});
