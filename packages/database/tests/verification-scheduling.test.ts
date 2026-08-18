import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  InvocationKeyConflict,
  ReviewIngestionStore,
  VerificationScheduler,
  VerificationStore,
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
  console.warn("\n  ⚠ Docker unavailable — verification scheduling SKIPPED.\n");
}

/**
 * Who is allowed to say "this is attempt 2".
 *
 * The previous design made the ordinal *supplied by the caller*, which removed
 * the `MAX(attempt) + 1` race by moving the decision somewhere with no durable
 * record of having made it. Two schedulers could still originate the same
 * ordinal; the database would report that as a unique violation, and a caller
 * would be left inferring domain meaning — retry or redelivery? — from
 * contention.
 *
 * These tests are about that inference never happening. The scheduler reports
 * whether it allocated, and it knows because it read the request key under a
 * lock, not because an insert did or did not fail.
 */
describeWithPostgres("Verification attempt allocation is durable", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startPostgres("scheduling");
    await assertSuiteIsActuallyRunning(database, [
      "candidate_findings",
      "verification_invocations",
      "verification_attempts",
    ]);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  const ORG = "0192f8a1-0000-7000-8000-00000000000a";
  const REPO = "0192f8a1-0000-7000-8000-0000000000aa";
  const PR = "0192f8a1-0000-7000-8000-0000000000c1";
  const now = new Date("2026-08-18T00:00:00.000Z");

  beforeEach(async () => {
    await database.reset();
  });

  /** A run with `count` candidates, and the ids of those candidates. */
  async function seed(count = 1): Promise<{
    runId: string;
    candidateIds: readonly string[];
  }> {
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
    // Through the ingestion store rather than raw SQL: the revision, request
    // and run rows have required columns a hand-written INSERT forgets, and a
    // fixture that drifts from the schema fails for reasons unrelated to what
    // is under test.
    const store = new ReviewIngestionStore(database.pool, () => now);
    const scope = { organizationId: ORG, repositoryId: REPO };
    const revision = await store.upsertRevision(scope, {
      pullRequestId: PR,
      headSha: "a".repeat(40),
      headRef: "f",
      baseSha: "b".repeat(40),
      baseRef: "main",
      mergeBaseSha: null,
      trigger: "push",
      createdAt: now,
    });
    const request = await store.upsertReviewRequest(scope, {
      pullRequestId: PR,
      revisionId: revision.id,
      target: { kind: "pull_request" },
      trigger: "pull_request_updated",
      requestedBy: { kind: "system", component: "test" },
      executionMode: "review",
      executionStrategy: "single",
      idempotencyKey: `k-${randomUUID()}`,
      requestedAt: now,
    });
    const run = await store.upsertReviewRun(scope, {
      requestId: request.id,
      revisionId: revision.id,
      attempt: 1,
      executionMode: "review",
      executionStrategy: "single",
      createdAt: now,
    });
    const runId = run.id;

    const candidateIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      candidateIds.push(id);
      await database.pool.query(
        `INSERT INTO candidate_findings (id, organization_id, repository_id, review_run_id,
           producer_id, producer_version, input_digest, title, claim, explanation,
           category, proposed_severity, path, start_line, end_line, fingerprint_value, created_at)
         VALUES ($1,$2,$3,$4,'a','1',$5,'t','c','e','correctness','medium','src/a.ts',1,1,$6,$7)`,
        [
          id,
          ORG,
          REPO,
          runId,
          "d".repeat(64),
          String(index).padStart(64, "f"),
          now,
        ],
      );
    }

    return { runId, candidateIds };
  }

  const scheduler = () => new VerificationScheduler(database.pool, () => now);

  // ── 1 ──────────────────────────────────────────────────────────────────
  it("the same request delivered twice allocates one attempt", async () => {
    const { runId, candidateIds } = await seed();
    const request = {
      organizationId: ORG,
      reviewRunId: runId,
      candidateFindingId: candidateIds[0] ?? "",
      requestKey: "acalys:verify:pass:1",
      reason: "initial" as const,
    };

    const first = await scheduler().schedule(request);
    const second = await scheduler().schedule(request);

    expect(first.allocated).toBe(true);
    // Reported as a redelivery because the row said so — not inferred from a
    // failed insert, which would have been equally consistent with contention.
    expect(second.allocated).toBe(false);
    expect(second.invocationId).toBe(first.invocationId);
    expect(second.attempt).toBe(first.attempt);

    const all = await scheduler().invocationsFor(candidateIds[0] ?? "");
    expect(all).toHaveLength(1);
  }, 60_000);

  // ── 2 ──────────────────────────────────────────────────────────────────
  it("two schedulers racing cannot both originate the same attempt", async () => {
    // The property the durable command exists for. Both callers present
    // DIFFERENT request keys, so both are genuine requests — and the ordinals
    // they receive must still be distinct.
    const { runId, candidateIds } = await seed();
    const candidate = candidateIds[0] ?? "";

    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        scheduler().schedule({
          organizationId: ORG,
          reviewRunId: runId,
          candidateFindingId: candidate,
          requestKey: `race:${String(index)}`,
          reason: "operator_reverify",
        }),
      ),
    );

    const ordinals = results
      .map((result) => result.attempt)
      .sort((a, b) => a - b);
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(results.map((r) => r.invocationId)).size).toBe(8);
    // Every one of them allocated: eight distinct requests, eight commands.
    expect(results.every((result) => result.allocated)).toBe(true);
  }, 60_000);

  // ── 3 ──────────────────────────────────────────────────────────────────
  it("concurrent redeliveries of one request still allocate one attempt", async () => {
    // The other half of the race: same key, arriving at the same instant. The
    // lock makes the schedulers serial, so the second reads what the first
    // wrote rather than colliding with it.
    const { runId, candidateIds } = await seed();
    const request = {
      organizationId: ORG,
      reviewRunId: runId,
      candidateFindingId: candidateIds[0] ?? "",
      requestKey: "acalys:verify:concurrent",
      reason: "initial" as const,
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => scheduler().schedule(request)),
    );

    expect(new Set(results.map((r) => r.invocationId)).size).toBe(1);
    expect(new Set(results.map((r) => r.attempt))).toEqual(new Set([1]));
    // Exactly one call did the allocating, and every caller learned which.
    expect(results.filter((result) => result.allocated)).toHaveLength(1);
  }, 60_000);

  // ── 4 ──────────────────────────────────────────────────────────────────
  it("ordinals are per candidate, not global", async () => {
    // A global counter would be a correct-looking implementation that makes
    // "this is the second time we examined THIS claim" unanswerable.
    const { runId, candidateIds } = await seed(3);

    for (const candidate of candidateIds) {
      const first = await scheduler().schedule({
        organizationId: ORG,
        reviewRunId: runId,
        candidateFindingId: candidate,
        requestKey: `pass1:${candidate}`,
        reason: "initial",
      });
      expect(first.attempt).toBe(1);
    }
  }, 60_000);

  // ── 5 ──────────────────────────────────────────────────────────────────
  it("a command survives the worker that scheduled it", async () => {
    // `scheduled` does not mean a worker is alive. A crash before execution
    // leaves the command recoverable by anyone.
    const { runId, candidateIds } = await seed(2);
    for (const candidate of candidateIds) {
      await scheduler().schedule({
        organizationId: ORG,
        reviewRunId: runId,
        candidateFindingId: candidate,
        requestKey: `orphan:${candidate}`,
        reason: "initial",
      });
    }

    const pending = await scheduler().scheduledFor(runId);
    expect(pending).toHaveLength(2);
    expect(
      pending.every((invocation) => invocation.state === "scheduled"),
    ).toBe(true);

    // A replacement worker re-presents the same key and gets the same command
    // rather than opening a second one.
    const recovered = await scheduler().schedule({
      organizationId: ORG,
      reviewRunId: runId,
      candidateFindingId: candidateIds[0] ?? "",
      requestKey: `orphan:${candidateIds[0] ?? ""}`,
      reason: "initial",
    });
    expect(recovered.allocated).toBe(false);
    expect(recovered.attempt).toBe(1);
  }, 60_000);

  // ── 6 ──────────────────────────────────────────────────────────────────
  it("settles only after the result is durable", async () => {
    const { runId, candidateIds } = await seed();
    const candidate = candidateIds[0] ?? "";
    const invocation = await scheduler().schedule({
      organizationId: ORG,
      reviewRunId: runId,
      candidateFindingId: candidate,
      requestKey: "settle:1",
      reason: "initial",
    });

    // Still owed while the attempt is unwritten. The reverse order would let a
    // crash lose the attempt while the command claims to be discharged, and
    // nothing would reschedule it.
    expect(await scheduler().scheduledFor(runId)).toHaveLength(1);

    await new VerificationStore(database.pool, () => now).recordAttempt({
      invocationId: invocation.invocationId,
      attempt: invocation.attempt,
      candidateFindingId: candidate,
      reviewRunId: runId,
      organizationId: ORG,
      verifierId: "v",
      verifierVersion: "1",
      contextDigest: "c".repeat(64),
      cacheKey: "k".repeat(64),
      outcome: {
        status: "completed",
        decision: "verified",
        reasons: ["evidence_supports_claim"],
        confidence: 0.9,
        severity: "medium",
      },
    });
    await scheduler().settle(invocation.invocationId);

    expect(await scheduler().scheduledFor(runId)).toHaveLength(0);
  }, 60_000);

  // ── 7 ──────────────────────────────────────────────────────────────────
  it("refuses a request key that already means a different candidate", async () => {
    // A key that identifies two things has stopped being an identity, and the
    // convergence it promises would attach one candidate's verification to
    // another's.
    const { runId, candidateIds } = await seed(2);
    await scheduler().schedule({
      organizationId: ORG,
      reviewRunId: runId,
      candidateFindingId: candidateIds[0] ?? "",
      requestKey: "shared-key",
      reason: "initial",
    });

    await expect(
      scheduler().schedule({
        organizationId: ORG,
        reviewRunId: runId,
        candidateFindingId: candidateIds[1] ?? "",
        requestKey: "shared-key",
        reason: "initial",
      }),
    ).rejects.toBeInstanceOf(InvocationKeyConflict);
  }, 60_000);

  // ── 8 ──────────────────────────────────────────────────────────────────
  it("refuses to schedule verification of a candidate that does not exist", async () => {
    const { runId } = await seed();
    await expect(
      scheduler().schedule({
        organizationId: ORG,
        reviewRunId: runId,
        candidateFindingId: randomUUID(),
        requestKey: "ghost",
        reason: "initial",
      }),
    ).rejects.toThrow(/no such candidate/);
  }, 60_000);

  // ── 9 ──────────────────────────────────────────────────────────────────
  it("property: any interleaving of requests yields a gapless ordinal sequence", async () => {
    // Stated over arbitrary mixes of new requests and redeliveries, because the
    // failure this guards is not "two ordinals collided" — the unique index
    // would catch that — but "a redelivery consumed an ordinal", which shows up
    // only as a gap, and only sometimes.
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 }), {
          minLength: 4,
          maxLength: 12,
        }),
        async (passes) => {
          await database.reset();
          const { runId, candidateIds } = await seed();
          const candidate = candidateIds[0] ?? "";

          const seen = new Map<number, number>();
          for (const pass of passes) {
            const invocation = await scheduler().schedule({
              organizationId: ORG,
              reviewRunId: runId,
              candidateFindingId: candidate,
              requestKey: `prop:${String(pass)}`,
              reason: "operator_reverify",
            });
            const previous = seen.get(pass);
            if (previous === undefined) {
              seen.set(pass, invocation.attempt);
              expect(invocation.allocated).toBe(true);
            } else {
              // A repeated key must return its original ordinal, never a new one.
              expect(invocation.attempt).toBe(previous);
              expect(invocation.allocated).toBe(false);
            }
          }

          const ordinals = [...seen.values()].sort((a, b) => a - b);
          // Gapless from 1: exactly one ordinal per distinct request, and no
          // redelivery consumed one.
          expect(ordinals).toEqual(
            Array.from({ length: ordinals.length }, (_u, index) => index + 1),
          );
        },
      ),
      // Each run resets a real database, so the count is a deliberate trade
      // between coverage and a suite that finishes.
      { numRuns: 8 },
    );
  }, 180_000);
});
