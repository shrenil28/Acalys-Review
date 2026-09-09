import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  findLifecycleViolations,
  PolicyDecisionStore,
  PreMergeStore,
  ReviewIngestionStore,
  ReviewStageStore,
  VerificationScheduler,
  VerificationStore,
  type TenantScope,
} from "@acalys/database";
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
  deterministicVerifier,
  logicalKey,
  verifyCandidate,
  type RunContext,
} from "../src/index.js";

const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER
  ? describe
  : describe.skip.bind(describe);

if (!HAS_DOCKER) {
  console.warn(
    "\n  ⚠ Docker unavailable — lifecycle crash-recovery tests SKIPPED.\n",
  );
}

/**
 * The invariant this file exists to prove.
 *
 * > Given the same persisted input and deterministic stages, **every crash
 * > schedule converges to the same ReviewRequest, ReviewRun, findings,
 * > verifications and publication intents.**
 *
 * Deliberately *not* the same infrastructure-attempt count. Worker history may
 * differ; the logical result may not.
 *
 * The analyzer and verifier are deterministic stubs on purpose: mixing model
 * nondeterminism into a crash-recovery proof makes the proof worthless, because
 * a differing replay could not be attributed to broken recovery rather than a
 * differing answer.
 */
describeWithPostgres(
  "The lifecycle converges under every crash schedule",
  () => {
    let database: TestDatabase;

    beforeAll(async () => {
      database = await startPostgres("lifecycle");
      await assertSuiteIsActuallyRunning(database, [
        "candidate_findings",
        "verification_invocations",
        "verification_attempts",
        "review_findings",
        "publication_decisions",
        "premerge_check_results",
        "publication_intents",
      ]);
    }, 120_000);

    afterAll(async () => {
      await database?.stop();
    }, 60_000);

    const ORG = "0192f8a1-0000-7000-8000-00000000000a";
    const REPO = "0192f8a1-0000-7000-8000-0000000000aa";
    const PR = "0192f8a1-0000-7000-8000-0000000000c1";
    const scope: TenantScope = { organizationId: ORG, repositoryId: REPO };
    const HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";
    const at = new Date("2026-08-16T10:00:00.000Z");

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

    const ingestion = () => new ReviewIngestionStore(database.pool);
    const stages = () => new ReviewStageStore(database.pool);
    // Every store the funnel needs, supplied here rather than defaulted.
    // `OrchestratorOptions` requires them: an orchestrator that could be built
    // without a verification store is one that will be, and the pipeline that
    // resulted promoted candidates nothing had examined.
    const options = () => ({
      ingestion: ingestion(),
      stages: stages(),
      scheduler: new VerificationScheduler(database.pool),
      verifications: new VerificationStore(database.pool),
      decisions: new PolicyDecisionStore(database.pool),
      premerge: new PreMergeStore(database.pool),
      analyzer: analyze,
      verifier: deterministicVerifier,
    });

    /**
     * Deletes rows the state machine says must exist, in dependency order.
     *
     * Only reachable from a test: the prerequisite checks exist for a database
     * corrupted from outside, so corrupting it is what exercising them requires.
     */
    async function corruptByDeleting(
      runId: string,
      tables: readonly string[],
    ): Promise<void> {
      for (const table of tables) {
        await database.pool.query(
          `DELETE FROM ${table} WHERE review_run_id = $1`,
          [runId],
        );
      }
    }

    /** Creates a queued run and returns the context for driving it. */
    async function seedRun(headSha = HEAD, key = "k-1"): Promise<RunContext> {
      const store = ingestion();
      const revision = await store.upsertRevision(scope, {
        pullRequestId: PR,
        headSha,
        headRef: "feat/x",
        baseSha: "1".repeat(40),
        baseRef: "main",
        mergeBaseSha: null,
        trigger: "push",
        createdAt: at,
      });
      const request = await store.upsertReviewRequest(scope, {
        pullRequestId: PR,
        revisionId: revision.id,
        target: { kind: "pull_request" },
        trigger: "pull_request_updated",
        requestedBy: { kind: "system", component: "test" },
        executionMode: "review",
        executionStrategy: "single",
        idempotencyKey: key,
        requestedAt: at,
      });
      const run = await store.upsertReviewRun(scope, {
        requestId: request.id,
        revisionId: revision.id,
        attempt: 1,
        executionMode: "review",
        executionStrategy: "single",
        createdAt: at,
      });

      return {
        scope,
        runId: run.id,
        revisionId: revision.id,
        headSha,
        provider: "github" as const,
        pullRequestId: PR,
      };
    }

    /**
     * The full logical result, for comparing across crash schedules.
     *
     * The run id is normalized out of publication keys. Those keys are
     * deliberately run-scoped — one provider review per run — so two *different*
     * runs must produce different keys, and comparing them raw would fail for the
     * correct reason and hide the incorrect ones. The content digest is left
     * intact, because that is what must be identical.
     */
    async function logicalHistory(runId: string, revisionId = "") {
      const outputs = await stages().readOutputs(runId);
      const run = await ingestion().getRun(runId);
      return {
        state: run?.state,
        attempt: run?.attempt,
        candidates: outputs.candidates.map((c) => c.fingerprintValue),
        verifications: outputs.verifications.map((v) => v.decision).sort(),
        findings: outputs.findings.map(
          (f) => `${f.fingerprintValue}:${f.severity}`,
        ),
        publications: outputs.publications.map(
          (p) =>
            `${p.logicalKey
              .replaceAll(runId, "<run>")
              // The revision is part of the key too, and is per-seed. Masking
              // only the run id would make every comparison fail for the one
              // reason that is correct, hiding the reasons that are not.
              .replaceAll(
                revisionId === "" ? "\u0000" : revisionId,
                "<revision>",
              )}:${p.state}:${p.contentDigest}`,
        ),
      };
    }

    // ── 1 ──────────────────────────────────────────────────────────────────
    it("a clean run reaches the commit point with one of everything", async () => {
      const context = await seedRun();
      const outcome = await advanceToSettled(context, options());

      expect(outcome).toEqual({ kind: "settled", state: "publishing" });

      const history = await logicalHistory(context.runId, context.revisionId);
      expect(history.state).toBe("publishing");
      expect(history.candidates.length).toBeGreaterThan(0);
      expect(history.verifications).toHaveLength(history.candidates.length);
      // One review intent plus one comment per published finding.
      expect(history.publications).toHaveLength(history.findings.length + 1);
    }, 60_000);

    // ── 2 ──────────────────────────────────────────────────────────────────
    describe("crash at every point of every stage", () => {
      const STATES = [
        "queued",
        "preparing",
        "analyzing",
        "reviewing",
        "verifying",
        "reconciling",
      ] as const;

      it("resuming from any state converges on the same history", async () => {
        // The reference: an uninterrupted run.
        const clean = await seedRun(HEAD, "k-clean");
        await advanceToSettled(clean, options());
        const expected = await logicalHistory(clean.runId, clean.revisionId);

        for (const stopAt of STATES) {
          await database.reset();
          await seedFixtures();
          const context = await seedRun(HEAD, `k-${stopAt}`);

          // Advance until the run is sitting in `stopAt`, then abandon it —
          // simulating a worker that died having just entered that state.
          for (;;) {
            const run = await ingestion().getRun(context.runId);
            if (run?.state === stopAt) break;
            const step = await advance(context, options());
            if (step.kind !== "advanced") break;
          }

          // A different worker picks it up with no handoff and no recovery mode.
          await advanceToSettled(context, options());

          const actual = await logicalHistory(
            context.runId,
            context.revisionId,
          );
          expect(actual, `resumed from ${stopAt}`).toEqual(expected);
        }
      }, 120_000);

      it("crashing AFTER the output but BEFORE the transition rolls back both", async () => {
        // The window that decides whether the state machine can lie. If output
        // and transition were two transactions, this crash would leave
        // `state = analyzing` on a run whose candidates do not exist — and the
        // next worker would read the enum, believe it, and proceed on nothing.
        //
        // A mutation that split the transaction survived the test below, which is
        // why this one exists: throwing *before* the output passes equally well
        // against a broken implementation.
        const context = await seedRun();
        await advance(context, options()); // queued → preparing

        const failing = new ReviewStageStore(database.pool, () => new Date(), {
          afterOutput: () =>
            Promise.reject(new Error("died between the writes")),
        });

        await expect(
          failing.runStage(
            scope,
            context.runId,
            "preparing",
            "analyzing",
            () => ({
              candidates: analyze({
                repositoryId: REPO,
                revisionId: context.revisionId,
                headSha: context.headSha,
              }),
            }),
          ),
        ).rejects.toThrow("died between the writes");

        // Neither half survived.
        expect((await ingestion().getRun(context.runId))?.state).toBe(
          "preparing",
        );
        expect(
          (await stages().readOutputs(context.runId)).candidates,
        ).toHaveLength(0);
      }, 60_000);

      it("crashing AFTER the transition still rolls back, because it is one commit", async () => {
        const context = await seedRun();
        await advance(context, options());

        const failing = new ReviewStageStore(database.pool, () => new Date(), {
          afterTransition: () =>
            Promise.reject(new Error("died after the update")),
        });

        await expect(
          failing.runStage(
            scope,
            context.runId,
            "preparing",
            "analyzing",
            () => ({
              candidates: analyze({
                repositoryId: REPO,
                revisionId: context.revisionId,
                headSha: context.headSha,
              }),
            }),
          ),
        ).rejects.toThrow();

        // The transition was issued but never committed.
        expect((await ingestion().getRun(context.runId))?.state).toBe(
          "preparing",
        );
        expect(
          (await stages().readOutputs(context.runId)).candidates,
        ).toHaveLength(0);
      }, 60_000);

      it("crashing BEFORE any work leaves the run untouched", async () => {
        const context = await seedRun();
        await advance(context, options());

        const failing = new ReviewStageStore(database.pool, () => new Date(), {
          beforeWork: () => Promise.reject(new Error("died before working")),
        });

        await expect(
          failing.runStage(
            scope,
            context.runId,
            "preparing",
            "analyzing",
            () => ({}),
          ),
        ).rejects.toThrow();

        expect((await ingestion().getRun(context.runId))?.state).toBe(
          "preparing",
        );
      }, 60_000);

      it("state always entails its artifacts, at every state a run can be in", async () => {
        // The entailment stated directly, rather than inferred from the
        // transaction design:
        //     state >= analyzing    ⟹ candidates exist
        //     state >= verifying    ⟹ verifications exist
        //     state >= publishing   ⟹ publication intents exist
        const context = await seedRun();

        for (;;) {
          const run = await ingestion().getRun(context.runId);
          const outputs = await stages().readOutputs(context.runId);
          const state = run?.state ?? "";

          const reached = (target: string) =>
            [
              "queued",
              "preparing",
              "analyzing",
              "reviewing",
              "verifying",
              "reconciling",
              "publishing",
            ].indexOf(state) >=
            [
              "queued",
              "preparing",
              "analyzing",
              "reviewing",
              "verifying",
              "reconciling",
              "publishing",
            ].indexOf(target);

          if (reached("analyzing")) {
            expect(
              outputs.candidates.length,
              `candidates at ${state}`,
            ).toBeGreaterThan(0);
          }
          if (reached("reconciling")) {
            // Strengthened from "some verification exists at `verifying`".
            //
            // Verification now runs *while* the run is in `verifying` rather
            // than as the output of entering it, so the old entailment no
            // longer describes the pipeline. It was also the weaker claim:
            // `count(*) > 0` is satisfied by a run where one candidate out of
            // twenty was examined, which is the partial-review semantics the
            // promotion gate exists to refuse.
            //
            // The entailment that matters is per candidate, and it starts at
            // `reconciling` — the first state from which a finding can reach a
            // developer.
            const examined = outputs.verifications.filter(
              (verification) => verification.status === "completed",
            );
            const candidateIds = new Set(
              outputs.candidates.map((candidate) => candidate.id),
            );
            const examinedIds = new Set(
              examined.map((verification) => verification.candidateFindingId),
            );
            expect(examinedIds.size, `examined at ${state}`).toBe(
              candidateIds.size,
            );
          }
          if (reached("publishing")) {
            expect(
              outputs.publications.length,
              `publications at ${state}`,
            ).toBeGreaterThan(0);
          }

          const step = await advance(context, options());
          if (step.kind !== "advanced") break;
        }
      }, 60_000);

      it("crashing inside produce() leaves neither output nor transition", async () => {
        // The other side of the durable write. Because the stage's output and its
        // transition are one transaction, a failure part-way leaves the run
        // exactly where it was — the state can never claim a stage happened whose
        // artifact is missing.
        const context = await seedRun();
        await advance(context, options()); // queued → preparing

        const exploding = new ReviewStageStore(database.pool);
        await expect(
          exploding.runStage(
            scope,
            context.runId,
            "preparing",
            "analyzing",
            () => {
              throw new Error("worker died mid-stage");
            },
          ),
        ).rejects.toThrow("worker died mid-stage");

        const run = await ingestion().getRun(context.runId);
        expect(run?.state).toBe("preparing");
        const outputs = await stages().readOutputs(context.runId);
        expect(outputs.candidates).toHaveLength(0);
      }, 60_000);

      it("property: any crash schedule yields the same logical history", async () => {
        const clean = await seedRun(HEAD, "k-ref");
        await advanceToSettled(clean, options());
        const expected = await logicalHistory(clean.runId, clean.revisionId);

        await fc.assert(
          fc.asyncProperty(
            // How many steps to take before "dying", repeatedly.
            fc.array(fc.integer({ min: 1, max: 3 }), {
              minLength: 1,
              maxLength: 6,
            }),
            async (schedule) => {
              await database.reset();
              await seedFixtures();
              const context = await seedRun(HEAD, "k-sched");

              for (const steps of schedule) {
                for (let step = 0; step < steps; step += 1) {
                  const outcome = await advance(context, options());
                  if (outcome.kind !== "advanced") break;
                }
                // …worker dies here; a fresh one continues on the next iteration.
              }
              await advanceToSettled(context, options());

              expect(
                await logicalHistory(context.runId, context.revisionId),
              ).toEqual(expected);
            },
          ),
          { numRuns: 8 },
        );
      }, 180_000);
    });

    async function seedFixtures(): Promise<void> {
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
    }

    // ── 3 ──────────────────────────────────────────────────────────────────
    it("duplicate workers converge without duplicating stage output", async () => {
      // Two workers racing the same run. The row lock inside `runStage` means one
      // waits; the loser's compare-and-swap then finds a moved state and refuses.
      const context = await seedRun();

      for (let step = 0; step < 6; step += 1) {
        const [first, second] = await Promise.all([
          advance(context, options()),
          advance(context, options()),
        ]);

        // Both MAY advance, and that is correct rather than a violation: one can
        // commit `queued → preparing` while the other, re-reading, legitimately
        // commits `preparing → analyzing`. What must never happen is two workers
        // committing the SAME transition — which the compare-and-swap prevents
        // and the no-duplicate assertions below actually measure.
        for (const outcome of [first, second]) {
          expect(["advanced", "refused", "settled"]).toContain(outcome.kind);
        }
      }

      await advanceToSettled(context, options());
      const outputs = await stages().readOutputs(context.runId);

      // No duplicated rows: every fingerprint appears once.
      expect(
        new Set(outputs.candidates.map((c) => c.fingerprintValue)).size,
      ).toBe(outputs.candidates.length);
      expect(new Set(outputs.publications.map((p) => p.logicalKey)).size).toBe(
        outputs.publications.length,
      );
    }, 60_000);

    // ── 4 ──────────────────────────────────────────────────────────────────
    it("a terminal run is immutable under replay", async () => {
      const context = await seedRun();
      await advanceToSettled(context, options());
      await database.pool.query(
        "UPDATE review_runs SET state = 'completed' WHERE id = $1",
        [context.runId],
      );
      const before = await logicalHistory(context.runId, context.revisionId);

      // Every further attempt is a no-op.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const outcome = await advance(context, options());
        expect(outcome.kind).toBe("settled");
      }

      expect(await logicalHistory(context.runId, context.revisionId)).toEqual(
        before,
      );
    }, 60_000);

    // ── 5 ──────────────────────────────────────────────────────────────────
    it("supersession prevents entry to publishing", async () => {
      const context = await seedRun();
      // Drive to reconciling — the last state from which supersession is legal.
      for (;;) {
        const run = await ingestion().getRun(context.runId);
        if (run?.state === "reconciling") break;
        await advance(context, options());
      }

      await ingestion().supersedeOlderRuns(PR, randomUUID());
      expect((await ingestion().getRun(context.runId))?.state).toBe(
        "superseded",
      );

      // The worker, still holding its stale view, tries to commit.
      const outcome = await advance(context, options());
      expect(outcome.kind).toBe("settled");
      expect((await ingestion().getRun(context.runId))?.state).toBe(
        "superseded",
      );

      // And crucially: no publication obligation was ever created.
      const outputs = await stages().readOutputs(context.runId);
      expect(outputs.publications).toHaveLength(0);
    }, 60_000);

    // ── 6 ──────────────────────────────────────────────────────────────────
    it("the publishing obligation survives the worker that created it", async () => {
      // `publishing` is a durable obligation, not an execution status. Once the
      // intents are committed they outlive the process, and nothing may supersede
      // the run out from under them.
      const context = await seedRun();
      await advanceToSettled(context, options());

      const before = await stages().readOutputs(context.runId);
      expect(before.publications.length).toBeGreaterThan(0);
      expect(before.publications.every((p) => p.state === "planned")).toBe(
        true,
      );

      // A newer push arrives; the run is already at the commit point.
      const superseded = await ingestion().supersedeOlderRuns(PR, randomUUID());
      expect(superseded).not.toContain(context.runId);
      expect((await ingestion().getRun(context.runId))?.state).toBe(
        "publishing",
      );

      // The ledger is intact for whichever worker picks up the obligation.
      expect(await stages().readOutputs(context.runId)).toEqual(before);
    }, 60_000);

    // ── 7 ──────────────────────────────────────────────────────────────────
    describe("state is not proof that the artifact exists", () => {
      it("refuses to continue when a prerequisite is missing", async () => {
        // Unreachable under the atomic design, so this simulates the database
        // being corrupted from outside. The worker must not read the enum,
        // believe it, and proceed on nothing — reviewing nothing and reporting
        // success is worse than failing.
        const context = await seedRun();
        await advanceToSettled(context, options());

        // Wind the run back to `verifying` and delete what that state entails.
        await database.pool.query(
          "UPDATE review_runs SET state = 'verifying' WHERE id = $1",
          [context.runId],
        );
        // Deleted from the top of the trust chain down. The foreign keys run
        // publication → finding → attempt → invocation → candidate, so
        // corrupting the database now means dismantling it deliberately —
        // which is the point of the chain existing.
        await corruptByDeleting(context.runId, [
          "publication_intents",
          "publication_decisions",
          "review_findings",
          "verification_attempts",
          "verification_invocations",
          "candidate_findings",
        ]);

        const outcome = await advance(context, options());
        expect(outcome.kind).toBe("invariant_violation");
        if (outcome.kind !== "invariant_violation")
          throw new Error("unreachable");
        expect(outcome.missing).toBe("candidates");

        // The run did not move.
        expect((await ingestion().getRun(context.runId))?.state).toBe(
          "verifying",
        );
      }, 60_000);

      it("detects a missing verification at reconciling", async () => {
        const context = await seedRun();
        await advanceToSettled(context, options());

        await database.pool.query(
          "UPDATE review_runs SET state = 'reconciling' WHERE id = $1",
          [context.runId],
        );
        await corruptByDeleting(context.runId, [
          "publication_intents",
          "publication_decisions",
          "review_findings",
          "verification_attempts",
        ]);

        const outcome = await advance(context, options());
        expect(outcome.kind).toBe("invariant_violation");
      }, 60_000);
    });

    // ── 8 ──────────────────────────────────────────────────────────────────
    it("stage outputs are deterministic and idempotent by identity", async () => {
      // Running the stage functions twice must produce identical output, and
      // re-running the persisted stage must not duplicate rows.
      const context = await seedRun();
      const input = {
        repositoryId: REPO,
        revisionId: context.revisionId,
        headSha: HEAD,
      };

      expect(analyze(input)).toEqual(analyze(input));

      await advanceToSettled(context, options());
      const first = await stages().readOutputs(context.runId);

      // Force the analysis stage to run again against the same identity.
      await database.pool.query(
        "UPDATE review_runs SET state = 'preparing' WHERE id = $1",
        [context.runId],
      );
      await advanceToSettled(context, options());

      expect(await stages().readOutputs(context.runId)).toEqual(first);
    }, 60_000);

    // ── 9 ──────────────────────────────────────────────────────────────────
    it("publication intents carry both a stable key and a content digest", async () => {
      // They answer different questions. The key says "is this effect already
      // represented?"; the digest says "is it the effect we intended?". A key
      // reused with a changed digest is an invariant violation, not a retry.
      const context = await seedRun();
      await advanceToSettled(context, options());

      const outputs = await stages().readOutputs(context.runId);
      const publicationScope = {
        organizationId: context.scope.organizationId,
        repositoryId: context.scope.repositoryId,
        provider: "github" as const,
        pullRequestId: context.pullRequestId,
        revisionId: context.revisionId,
        runId: context.runId,
      };

      const review = outputs.publications.find((p) =>
        p.logicalKey.includes(":review:"),
      );

      expect(review?.contentDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(review?.state).toBe("planned");

      // Every scope that makes two effects different appears in the key, so a
      // future key that drops one is visible in the data rather than merely
      // still-unique-by-accident.
      for (const part of [
        context.scope.organizationId,
        context.scope.repositoryId,
        context.pullRequestId,
        context.revisionId,
        context.runId,
      ]) {
        expect(review?.logicalKey).toContain(part);
      }

      // Stable across recomputation — minted before any attempt, so an ambiguous
      // provider outcome stays reconcilable.
      expect(logicalKey(publicationScope, "review", "run")).toBe(
        review?.logicalKey,
      );
    }, 60_000);

    // ── 10 ─────────────────────────────────────────────────────────────────
    it("infrastructure attempts stay distinct from domain attempts", async () => {
      const context = await seedRun();

      // Many "worker restarts": each re-enters the orchestrator from scratch.
      for (let restart = 0; restart < 5; restart += 1) {
        await advanceToSettled(context, options());
      }

      const run = await ingestion().getRun(context.runId);
      expect(run?.attempt).toBe(1);

      const runs = await database.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM review_runs",
      );
      expect(Number(runs.rows[0]?.count)).toBe(1);
    }, 60_000);

    it("no run in the database is publishing with no obligation", async () => {
      // The entailment stated as a database-wide invariant rather than inferred
      // from one run's history. `state = publishing` means the system owes an
      // external effect; a run in that state with an empty ledger would be an
      // obligation nobody can discharge, and nothing would ever notice.
      for (const headSha of ["1".repeat(40), "2".repeat(40), "3".repeat(40)]) {
        const context = await seedRun(headSha, `k-inv-${headSha.slice(0, 2)}`);
        await advanceToSettled(context, options());
      }

      const orphaned = await database.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM review_runs r
        WHERE r.state = 'publishing'
          AND NOT EXISTS (
            SELECT 1 FROM publication_intents p WHERE p.review_run_id = r.id
          )`,
      );
      expect(Number(orphaned.rows[0]?.count)).toBe(0);
    }, 60_000);

    it("only verified candidates become findings", async () => {
      // The candidate/finding distinction made visible: a verifier that confirmed
      // everything would hide a pipeline that had silently collapsed the two.
      const context = await seedRun();
      await advanceToSettled(context, options());

      const outputs = await stages().readOutputs(context.runId);
      const verified = outputs.candidates.filter(
        (candidate) =>
          verifyCandidate(candidate).status === "completed" &&
          (verifyCandidate(candidate) as { decision: string }).decision ===
            "verified",
      );

      // Proves the stub actually exercises the distinction. Without this the
      // assertion below passes trivially on a run where everything verified,
      // which is the shape a collapsed pipeline also has.
      expect(outputs.candidates.length).toBeGreaterThan(0);
      expect(outputs.findings).toHaveLength(verified.length);
      expect(outputs.findings.length).toBeLessThanOrEqual(
        outputs.candidates.length,
      );

      // Every finding cites the attempt that established it, and none is
      // `published` — promotion establishes that the defect is real, and
      // nothing more.
      for (const finding of outputs.findings) {
        expect(finding.verificationAttemptId).not.toBeNull();
        expect(finding.state).toBe("verified");
      }
    }, 60_000);

    it("the database-wide entailments hold for a run the orchestrator drove", async () => {
      // ── The assertion this checkpoint exists for ──────────────────────────
      //
      // `findLifecycleViolations` already contained the queries that catch an
      // unverified promotion and an unexamined candidate. It was only ever
      // called from `publication.test.ts`, whose fixture seeds a run parked in
      // `publishing` with **no candidates and no findings** — so both queries
      // scanned zero rows and returned clean, and the suite reported the trust
      // boundary intact.
      //
      // Pointed at a run the orchestrator actually drove, the same function
      // reported four violations. That is the difference between a check and a
      // check that runs, and it is why this test lives here rather than beside
      // the fixture that cannot fail it.
      const context = await seedRun();
      const outcome = await advanceToSettled(context, options());

      // Prove the pipeline reached the states the entailments are about. An
      // entailment suite that silently ran against a refused run would be
      // vacuous in exactly the way this test was written to end.
      expect(outcome).toEqual({ kind: "settled", state: "publishing" });

      const counts = await database.pool.query<{
        candidates: string;
        attempts: string;
        findings: string;
      }>(
        `SELECT (SELECT count(*) FROM candidate_findings)    AS candidates,
                (SELECT count(*) FROM verification_attempts) AS attempts,
                (SELECT count(*) FROM review_findings)       AS findings`,
      );
      expect(Number(counts.rows[0]?.candidates)).toBeGreaterThan(0);
      expect(Number(counts.rows[0]?.attempts)).toBe(
        Number(counts.rows[0]?.candidates),
      );

      expect(await findLifecycleViolations(database.pool)).toEqual([]);
    }, 60_000);
  },
);
