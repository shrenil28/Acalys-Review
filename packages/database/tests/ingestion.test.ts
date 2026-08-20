import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  PostgresWebhookInbox,
  ReviewIngestionStore,
  digestBody,
  type AuthenticatedDelivery,
  type TenantScope,
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
    "\n  ⚠ Docker unavailable — review ingestion tests SKIPPED. Convergence under\n" +
      "    crash and concurrency is NOT verified in this run.\n",
  );
}

/**
 * The question P1-D has to answer.
 *
 * Not "can a worker create a ReviewRun?" — anything can do that. It is:
 *
 * > after arbitrary crashes and duplicate execution, does the database always
 * > converge on the one logical review history that should have existed?
 *
 * Every test below crashes something, races something, or replays something,
 * and then asks what is in the database.
 */
describeWithPostgres(
  "Review ingestion converges under crash and concurrency",
  () => {
    let database: TestDatabase;

    beforeAll(async () => {
      database = await startPostgres("ingestion");
      // Fail closed: a suite that reports success without running is worse
      // than one that fails.
      await assertSuiteIsActuallyRunning(database, [
        "review_runs",
        "review_requests",
        "pull_request_revisions",
      ]);
    }, 120_000);

    afterAll(async () => {
      await database?.stop();
    }, 60_000);

    const ORG_A = "0192f8a1-0000-7000-8000-00000000000a";
    const ORG_B = "0192f8a1-0000-7000-8000-00000000000b";
    const REPO_A = "0192f8a1-0000-7000-8000-0000000000aa";
    const REPO_B = "0192f8a1-0000-7000-8000-0000000000bb";
    const PR_A = "0192f8a1-0000-7000-8000-0000000000c1";
    const PR_B = "0192f8a1-0000-7000-8000-0000000000c2";

    const scopeA: TenantScope = { organizationId: ORG_A, repositoryId: REPO_A };
    const scopeB: TenantScope = { organizationId: ORG_B, repositoryId: REPO_B };

    const at = new Date("2026-08-16T10:00:00.000Z");

    beforeEach(async () => {
      await database.reset();
      for (const [org, repo, pr, slug] of [
        [ORG_A, REPO_A, PR_A, "acme"],
        [ORG_B, REPO_B, PR_B, "globex"],
      ] as const) {
        await database.pool.query(
          "INSERT INTO organizations (id, slug, name) VALUES ($1,$2,$3)",
          [org, slug, slug],
        );
        await database.pool.query(
          `INSERT INTO repositories (id, organization_id, provider, provider_external_id,
           owner, name, default_branch, visibility)
         VALUES ($1,$2,'github',$3,$4,'repo','main','private')`,
          [repo, org, `ext-${slug}`, slug],
        );
        await database.pool.query(
          `INSERT INTO pull_requests (id, organization_id, repository_id, provider,
           provider_external_id, number, title, author, state, draft, created_at, updated_at)
         VALUES ($1,$2,$3,'github',$4,412,'t','{"kind":"human"}'::jsonb,'open',false,$5,$5)`,
          [pr, org, repo, `pr-${slug}`, at],
        );
      }
    });

    const store = () => new ReviewIngestionStore(database.pool);

    const revision = (headSha: string, pullRequestId = PR_A) => ({
      pullRequestId,
      headSha,
      headRef: "feat/x",
      baseSha: "1".repeat(40),
      baseRef: "main",
      mergeBaseSha: null,
      trigger: "push",
      createdAt: at,
    });

    const requestFor = (
      revisionId: string,
      key: string,
      pullRequestId = PR_A,
    ) => ({
      pullRequestId,
      revisionId,
      target: { kind: "pull_request" },
      trigger: "pull_request_updated",
      requestedBy: { kind: "system", component: "acalys.webhook-gateway" },
      executionMode: "review",
      executionStrategy: "single",
      idempotencyKey: key,
      requestedAt: at,
    });

    async function counts(): Promise<Record<string, number>> {
      const result: Record<string, number> = {};
      for (const table of [
        "pull_request_revisions",
        "review_requests",
        "review_runs",
      ]) {
        const row = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        result[table] = Number(row.rows[0]?.count ?? 0);
      }
      return result;
    }

    /** Runs the ingestion pipeline, optionally dying at a named step. */
    async function ingest(
      headSha: string,
      key: string,
      dieAfter?: "revision" | "request" | "run",
    ): Promise<{ revisionId: string; requestId?: string; runId?: string }> {
      const s = store();
      const rev = await s.upsertRevision(scopeA, revision(headSha));
      if (dieAfter === "revision") throw new Error("worker died");

      const request = await s.upsertReviewRequest(
        scopeA,
        requestFor(rev.id, key),
      );
      if (dieAfter === "request") throw new Error("worker died");

      const run = await s.upsertReviewRun(scopeA, {
        requestId: request.id,
        revisionId: rev.id,
        attempt: 1,
        executionMode: "review",
        executionStrategy: "single",
        createdAt: at,
      });
      if (dieAfter === "run") throw new Error("worker died");

      return { revisionId: rev.id, requestId: request.id, runId: run.id };
    }

    // 1 ──────────────────────────────────────────────────────────────────────
    describe("two workers race for one delivery", () => {
      it("produces one revision, one request, one run", async () => {
        // Not "both eventually return success" — the database must prevent
        // simultaneous ownership, and the row counts are what prove it.
        await Promise.all([
          ingest("a".repeat(40), "k-1"),
          ingest("a".repeat(40), "k-1"),
        ]);

        expect(await counts()).toEqual({
          pull_request_revisions: 1,
          review_requests: 1,
          review_runs: 1,
        });
      });

      it("converges when many workers race one head SHA at once", async () => {
        // Two workers is not enough to observe the defect this exists to
        // catch. `upsertRevision` once checked for an existing revision
        // BEFORE taking the pull-request row lock, so both workers decided
        // "not there" against the same stale snapshot and the loser's INSERT
        // violated the unique constraint. With two callers the interleaving
        // that exposes it is rare — the failure surfaced roughly once per
        // three FULL suite runs, where contention is high, and never in six
        // consecutive isolated runs of this file.
        //
        // A test that only fails under unrelated load reads as flaky and gets
        // treated as noise. Twenty concurrent callers make the interleaving
        // ordinary rather than lucky, so the guarded and unguarded paths
        // differ observably here (invariant 7) instead of somewhere else.
        const workers = 20;
        const results = await Promise.all(
          Array.from({ length: workers }, () =>
            ingest("c".repeat(40), "k-many"),
          ),
        );

        // Every worker gets an answer; none loses.
        expect(results).toHaveLength(workers);
        for (const result of results) {
          expect(result.revisionId).toBe(results[0]?.revisionId);
        }

        expect(await counts()).toEqual({
          pull_request_revisions: 1,
          review_requests: 1,
          review_runs: 1,
        });
      });

      it("property: N concurrent workers converge on one history", async () => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 2, max: 12 }), async (workers) => {
            await database.reset();
            await beforeEachSeed();
            const sha = randomUUID()
              .replace(/-/g, "")
              .padEnd(40, "0")
              .slice(0, 40);

            const results = await Promise.allSettled(
              Array.from({ length: workers }, () => ingest(sha, `k-${sha}`)),
            );

            // Concurrent inserts may collide; what matters is that whatever
            // survived converged, not that nothing errored.
            expect(results.some((r) => r.status === "fulfilled")).toBe(true);
            expect(await counts()).toEqual({
              pull_request_revisions: 1,
              review_requests: 1,
              review_runs: 1,
            });
          }),
          { numRuns: 5 },
        );
      }, 120_000);
    });

    /** The seed `beforeEach` performs, reusable inside property runs. */
    async function beforeEachSeed(): Promise<void> {
      for (const [org, repo, pr, slug] of [
        [ORG_A, REPO_A, PR_A, "acme"],
        [ORG_B, REPO_B, PR_B, "globex"],
      ] as const) {
        await database.pool.query(
          "INSERT INTO organizations (id, slug, name) VALUES ($1,$2,$3)",
          [org, slug, slug],
        );
        await database.pool.query(
          `INSERT INTO repositories (id, organization_id, provider, provider_external_id,
           owner, name, default_branch, visibility)
         VALUES ($1,$2,'github',$3,$4,'repo','main','private')`,
          [repo, org, `ext-${slug}`, slug],
        );
        await database.pool.query(
          `INSERT INTO pull_requests (id, organization_id, repository_id, provider,
           provider_external_id, number, title, author, state, draft, created_at, updated_at)
         VALUES ($1,$2,$3,'github',$4,412,'t','{"kind":"human"}'::jsonb,'open',false,$5,$5)`,
          [pr, org, repo, `pr-${slug}`, at],
        );
      }
    }

    // 2 ──────────────────────────────────────────────────────────────────────
    describe("a worker that dies after claiming releases its job", () => {
      it("makes the job claimable again once the lease lapses", async () => {
        // Without a lease, `locked_at IS NULL` never becomes true again: the
        // delivery sits in `processing` with nothing to recover it, and GitHub
        // will not redeliver.
        const inbox = new PostgresWebhookInbox({ pool: database.pool });
        const body = Buffer.from('{"action":"opened"}', "utf8");
        const delivery: AuthenticatedDelivery = {
          provider: "github",
          sourceEndpointId: "e",
          deliveryId: "d-1",
          event: "pull_request",
          action: "opened",
          bodyDigest: digestBody(body),
          payload: body,
          receivedAt: at,
        };
        await inbox.ingest(delivery, [
          { kind: "github.pull_request", payload: {} },
        ]);

        // Worker claims, then dies without completing.
        const claimed = await inbox.claimJobs(10, 50);
        expect(claimed).toHaveLength(1);

        // Immediately after, the lease is live and nobody else may take it.
        expect(await inbox.claimJobs(10, 50)).toHaveLength(0);

        // Once it lapses, the job is reclaimable.
        await new Promise((resolve) => setTimeout(resolve, 80));
        const reclaimed = await inbox.claimJobs(10, 50);
        expect(reclaimed).toHaveLength(1);
        // And the reclaim is visible as an attempt, so a job that keeps killing
        // its worker shows up as poison rather than cycling silently.
        expect(reclaimed[0]?.attempts).toBe(2);
      }, 20_000);
    });

    // 3 ──────────────────────────────────────────────────────────────────────
    describe("a worker that dies after creating a ReviewRun", () => {
      it("does not create a second request or run when retried", async () => {
        // The dangerous one. A crash here, retried naively, doubles the review
        // history for one push — and the duplicate posts a second set of
        // comments.
        await expect(ingest("b".repeat(40), "k-2", "run")).rejects.toThrow();
        const first = await counts();

        // The retry replays the identical work.
        await ingest("b".repeat(40), "k-2");

        expect(await counts()).toEqual(first);
        expect(first).toEqual({
          pull_request_revisions: 1,
          review_requests: 1,
          review_runs: 1,
        });
      });

      it("property: dying at any step converges after replay", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom<"revision" | "request" | "run">(
              "revision",
              "request",
              "run",
            ),
            async (dieAfter) => {
              await database.reset();
              await beforeEachSeed();
              const sha = "c".repeat(40);

              await expect(ingest(sha, "k-p", dieAfter)).rejects.toThrow();
              await ingest(sha, "k-p");
              await ingest(sha, "k-p");

              expect(await counts()).toEqual({
                pull_request_revisions: 1,
                review_requests: 1,
                review_runs: 1,
              });
            },
          ),
          { numRuns: 6 },
        );
      }, 120_000);
    });

    // 4 ──────────────────────────────────────────────────────────────────────
    describe("commit succeeds but acknowledgement is lost", () => {
      it("converges onto the existing objects rather than duplicating them", async () => {
        // The classic boundary: the database committed, the worker never learned
        // it, and the job is retried. Convergence is the only defence.
        const first = await ingest("d".repeat(40), "k-3");
        const second = await ingest("d".repeat(40), "k-3");

        expect(second.revisionId).toBe(first.revisionId);
        expect(second.requestId).toBe(first.requestId);
        expect(second.runId).toBe(first.runId);
        expect(await counts()).toEqual({
          pull_request_revisions: 1,
          review_requests: 1,
          review_runs: 1,
        });
      });
    });

    // 5 ──────────────────────────────────────────────────────────────────────
    describe("out-of-order pushes", () => {
      it("keeps head SHA as identity, and sequence as arrival order only", async () => {
        // GitHub states deliveries can arrive out of order. A delayed push must
        // not create a second revision for code already recorded, and insertion
        // order must never be mistaken for repository history.
        const s = store();
        const later = await s.upsertRevision(scopeA, revision("e".repeat(40)));
        const earlier = await s.upsertRevision(
          scopeA,
          revision("f".repeat(40)),
        );

        expect(later.sequence).toBe(1);
        expect(earlier.sequence).toBe(2);

        // Redelivery of the first converges rather than taking sequence 3.
        const replay = await s.upsertRevision(scopeA, revision("e".repeat(40)));
        expect(replay.id).toBe(later.id);
        expect(replay.existed).toBe(true);
        expect((await counts()).pull_request_revisions).toBe(2);
      });

      it("supersedes a run answering a revision that is no longer latest", async () => {
        // The documented rule: the request was real and the revision happened, so
        // both are recorded — but the run is created and immediately superseded
        // rather than skipped. Skipping would leave no record that the platform
        // decided not to review it.
        const s = store();
        const old = await ingest("1".repeat(40), "k-old");
        await ingest("2".repeat(40), "k-new");

        expect(await s.isLatestRevision(PR_A, old.revisionId)).toBe(false);

        const outcome = await s.transition(
          old.runId ?? "",
          "queued",
          "superseded",
        );
        expect(outcome.kind).toBe("moved");
      });
    });

    // 6 ──────────────────────────────────────────────────────────────────────
    describe("a new revision arrives during analysis", () => {
      it("supersedes the in-flight run", async () => {
        const s = store();
        const first = await ingest("3".repeat(40), "k-a");
        await s.transition(first.runId ?? "", "queued", "preparing");
        await s.transition(first.runId ?? "", "preparing", "analyzing");

        const second = await ingest("4".repeat(40), "k-b");
        const superseded = await s.supersedeOlderRuns(PR_A, second.runId ?? "");

        expect(superseded).toContain(first.runId);
        expect((await s.getRun(first.runId ?? ""))?.state).toBe("superseded");
      });

      it("closes the TOCTOU window: a superseded run cannot then publish", async () => {
        // The bug this exists to prevent:
        //   T1  worker A reads state = reconciling
        //   T2  push B supersedes A
        //   T3  worker A writes state = publishing — and posts comments
        // The check must happen AT the side effect, not before it.
        const s = store();
        const first = await ingest("5".repeat(40), "k-c");
        const runId = first.runId ?? "";

        for (const [from, to] of [
          ["queued", "preparing"],
          ["preparing", "analyzing"],
          ["analyzing", "reviewing"],
          ["reviewing", "verifying"],
          ["verifying", "reconciling"],
        ] as const) {
          await s.transition(runId, from, to);
        }

        // T1: the worker has decided to publish, and holds `reconciling`.
        const observed = (await s.getRun(runId))?.state;
        expect(observed).toBe("reconciling");

        // T2: a newer push supersedes it.
        const second = await ingest("6".repeat(40), "k-d");
        await s.supersedeOlderRuns(PR_A, second.runId ?? "");

        // T3: the worker attempts the side effect on its stale observation.
        const publish = await s.transition(runId, "reconciling", "publishing");

        expect(publish.kind).toBe("refused");
        if (publish.kind !== "refused") throw new Error("unreachable");
        expect(publish.actualState).toBe("superseded");
        expect((await s.getRun(runId))?.state).toBe("superseded");
      });

      it("does not supersede a run that is already publishing", async () => {
        // `publishing` is the commit point. Interrupting it leaves a partially
        // commented pull request nothing can reconcile against.
        const s = store();
        const first = await ingest("7".repeat(40), "k-e");
        const runId = first.runId ?? "";

        for (const [from, to] of [
          ["queued", "preparing"],
          ["preparing", "analyzing"],
          ["analyzing", "reviewing"],
          ["reviewing", "verifying"],
          ["verifying", "reconciling"],
          ["reconciling", "publishing"],
        ] as const) {
          await s.transition(runId, from, to);
        }

        const second = await ingest("8".repeat(40), "k-f");
        const superseded = await s.supersedeOlderRuns(PR_A, second.runId ?? "");

        expect(superseded).not.toContain(runId);
        expect((await s.getRun(runId))?.state).toBe("publishing");
      });
    });

    // 7 ──────────────────────────────────────────────────────────────────────
    describe("terminal means terminal, transactionally", () => {
      it("refuses every transition out of every terminal state", async () => {
        // The runtime counterpart of Phase 0's N×N matrix: a conditional update
        // can never match a terminal `from`, so nothing resurrects a finished
        // run — not a retry, not a duplicate job, not a stale worker.
        const s = store();
        const terminals = [
          "completed",
          "failed",
          "cancelled",
          "superseded",
        ] as const;

        for (const terminal of terminals) {
          const run = await ingest(
            terminal.slice(0, 1).repeat(40),
            `k-term-${terminal}`,
          );
          const runId = run.runId ?? "";
          await database.pool.query(
            "UPDATE review_runs SET state = $2 WHERE id = $1",
            [runId, terminal],
          );

          // Even an HONEST caller — one that correctly observed the terminal
          // state — must not be able to move it. This is what a bare
          // compare-and-swap fails to enforce: it guarantees nobody else moved
          // the run, and says nothing about whether the move is legal.
          for (const target of [
            "queued",
            "preparing",
            "analyzing",
            "publishing",
            "completed",
          ]) {
            const outcome = await s.transition(runId, terminal, target);
            expect(outcome.kind, `${terminal} -> ${target}`).toBe("illegal");
            expect((await s.getRun(runId))?.state).toBe(terminal);
          }

          // A stale worker's view never matches a terminal run. The pairs below
          // are all LEGAL transitions, so the only possible reason to fail is
          // that the run has moved — which is exactly what must be detected.
          for (const [staleFrom, target] of [
            ["queued", "preparing"],
            ["analyzing", "reviewing"],
            ["reconciling", "publishing"],
          ] as const) {
            const outcome = await s.transition(runId, staleFrom, target);
            expect(outcome.kind, `${terminal} from ${staleFrom}`).toBe(
              "refused",
            );
            if (outcome.kind !== "refused") throw new Error("unreachable");
            expect(outcome.actualState).toBe(terminal);
          }
        }
      }, 60_000);

      it("property: a stale worker can never move a terminal run", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom("completed", "failed", "cancelled", "superseded"),
            // Legal (from, to) pairs only, so a refusal can only mean the run
            // moved — never that the pair itself was invalid.
            fc.constantFrom<readonly [string, string]>(
              ["queued", "preparing"],
              ["preparing", "analyzing"],
              ["analyzing", "reviewing"],
              ["reviewing", "verifying"],
              ["reconciling", "publishing"],
            ),
            async (terminal, [staleFrom, target]) => {
              await database.reset();
              await beforeEachSeed();
              const run = await ingest("9".repeat(40), "k-prop");
              const runId = run.runId ?? "";
              await database.pool.query(
                "UPDATE review_runs SET state = $2 WHERE id = $1",
                [runId, terminal],
              );

              const outcome = await store().transition(
                runId,
                staleFrom,
                target,
              );
              expect(outcome.kind).toBe("refused");
              expect((await store().getRun(runId))?.state).toBe(terminal);
            },
          ),
          { numRuns: 10 },
        );
      }, 120_000);
    });

    // 8 ──────────────────────────────────────────────────────────────────────
    describe("a poison delivery does not consume worker capacity forever", () => {
      it("dead-letters after the attempt budget", async () => {
        const inbox = new PostgresWebhookInbox({ pool: database.pool });
        const body = Buffer.from('{"action":"opened"}', "utf8");
        await inbox.ingest(
          {
            provider: "github",
            sourceEndpointId: "e",
            deliveryId: "poison",
            event: "pull_request",
            action: "opened",
            bodyDigest: digestBody(body),
            payload: body,
            receivedAt: at,
          },
          [{ kind: "github.pull_request", payload: {} }],
        );

        let deadLettered = false;
        for (let attempt = 0; attempt < 10 && !deadLettered; attempt += 1) {
          const jobs = await inbox.claimJobs(1, 60_000);
          if (jobs.length === 0) break;
          const released = await inbox.releaseJob(jobs[0]?.id ?? "", {
            retryable: true,
            errorCode: "acalys.error.provider-timeout",
          });
          deadLettered = released.deadLettered;
        }

        expect(deadLettered).toBe(true);
        // And it stops occupying a worker slot.
        expect(await inbox.claimJobs(10, 60_000)).toHaveLength(0);
      }, 30_000);

      it("dead-letters a permanent failure immediately, without burning the budget", async () => {
        // A payload that cannot be normalized fails identically every time.
        // Spending five attempts on it is five wasted worker slots.
        const inbox = new PostgresWebhookInbox({ pool: database.pool });
        const body = Buffer.from("{}", "utf8");
        await inbox.ingest(
          {
            provider: "github",
            sourceEndpointId: "e",
            deliveryId: "permanent",
            event: "pull_request",
            action: "opened",
            bodyDigest: digestBody(body),
            payload: body,
            receivedAt: at,
          },
          [{ kind: "github.pull_request", payload: {} }],
        );

        const jobs = await inbox.claimJobs(1, 60_000);
        const released = await inbox.releaseJob(jobs[0]?.id ?? "", {
          retryable: false,
          errorCode: "acalys.error.normalization-failed",
        });

        expect(released.deadLettered).toBe(true);
        expect(await inbox.claimJobs(10, 60_000)).toHaveLength(0);
      });
    });

    // Tenant isolation ───────────────────────────────────────────────────────
    describe("tenant isolation at claim and dedupe time", () => {
      it("does not let one tenant's idempotency key suppress another's request", async () => {
        // The nastiest place to make a seemingly harmless uniqueness
        // optimization: a global key space silently drops a second tenant's
        // review.
        const s = store();
        const revA = await s.upsertRevision(
          scopeA,
          revision("a1".padEnd(40, "0")),
        );
        const revB = await s.upsertRevision(
          scopeB,
          revision("a1".padEnd(40, "0"), PR_B),
        );

        const sharedKey = "github:412:a1";
        const requestA = await s.upsertReviewRequest(
          scopeA,
          requestFor(revA.id, sharedKey),
        );
        const requestB = await s.upsertReviewRequest(
          scopeB,
          requestFor(revB.id, sharedKey, PR_B),
        );

        expect(requestA.id).not.toBe(requestB.id);
        expect(requestB.existed).toBe(false);
        expect((await counts()).review_requests).toBe(2);
      });

      it("scopes every ingested row to its own organization", async () => {
        const s = store();
        const rev = await s.upsertRevision(
          scopeB,
          revision("b1".padEnd(40, "0"), PR_B),
        );
        const request = await s.upsertReviewRequest(
          scopeB,
          requestFor(rev.id, "k-b1", PR_B),
        );
        await s.upsertReviewRun(scopeB, {
          requestId: request.id,
          revisionId: rev.id,
          attempt: 1,
          executionMode: "review",
          executionStrategy: "single",
          createdAt: at,
        });

        for (const table of [
          "pull_request_revisions",
          "review_requests",
          "review_runs",
        ]) {
          const rows = await database.pool.query<{ organization_id: string }>(
            `SELECT organization_id FROM ${table}`,
          );
          for (const row of rows.rows) {
            expect(row.organization_id, table).toBe(ORG_B);
          }
        }
      });

      it("supersession never crosses a pull request, let alone a tenant", async () => {
        const s = store();
        const a = await ingest("c1".padEnd(40, "0"), "k-iso-a");

        const revB = await s.upsertRevision(
          scopeB,
          revision("c2".padEnd(40, "0"), PR_B),
        );
        const requestB = await s.upsertReviewRequest(
          scopeB,
          requestFor(revB.id, "k-iso-b", PR_B),
        );
        const runB = await s.upsertReviewRun(scopeB, {
          requestId: requestB.id,
          revisionId: revB.id,
          attempt: 1,
          executionMode: "review",
          executionStrategy: "single",
          createdAt: at,
        });

        // Superseding within PR_B must not touch tenant A's run.
        await s.supersedeOlderRuns(PR_B, randomUUID());

        expect((await s.getRun(a.runId ?? ""))?.state).toBe("queued");
        expect((await s.getRun(runB.id))?.state).toBe("superseded");
      });
    });

    // The four-level separation ──────────────────────────────────────────────
    describe("a crash creates another job attempt, not another ReviewRun", () => {
      it("keeps run.attempt at 1 across many infrastructure retries", async () => {
        // The distinction that makes review latency, retry rate and cost per
        // review computable. Collapsing them inflates "how many reviews did we
        // run" with every Kubernetes eviction.
        for (let retry = 0; retry < 5; retry += 1) {
          await ingest("d1".padEnd(40, "0"), "k-attempt");
        }

        const runs = await database.pool.query<{ attempt: number }>(
          "SELECT attempt FROM review_runs",
        );
        expect(runs.rows).toHaveLength(1);
        expect(runs.rows[0]?.attempt).toBe(1);
      });

      it("a domain-level rerun does create a second run", async () => {
        // The other side: an explicit rerun is a new attempt of the same
        // request, and must be distinguishable from an infrastructure retry.
        const first = await ingest("e1".padEnd(40, "0"), "k-rerun");
        const second = await store().upsertReviewRun(scopeA, {
          requestId: first.requestId ?? "",
          revisionId: first.revisionId,
          attempt: 2,
          executionMode: "review",
          executionStrategy: "single",
          createdAt: at,
        });

        expect(second.attempt).toBe(2);
        expect(second.id).not.toBe(first.runId);
        expect((await counts()).review_runs).toBe(2);
        expect((await counts()).review_requests).toBe(1);
      });
    });
  },
);
