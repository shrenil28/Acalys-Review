import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PublicationStore,
  ReviewIngestionStore,
  VerificationScheduler,
  ReviewStageStore,
  canTransitionPublication,
  findLifecycleViolations,
  legalPublicationTransitions,
  PUBLICATION_STATES,
  PublicationContentConflict,
  type PublicationState,
  type TenantScope,
} from "@acalys/database";
import {
  assertSuiteIsActuallyRunning,
  dockerAvailable,
  startPostgres,
  type TestDatabase,
} from "../../../packages/database/tests/postgres.js";

import {
  PublicationInvariantViolation,
  contentDigest,
  publishOne,
  strippedBody,
} from "../src/index.js";
import { FakeGithub } from "./fake-github.js";

const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER
  ? describe
  : describe.skip.bind(describe);

if (!HAS_DOCKER) {
  console.warn(
    "\n  ⚠ Docker unavailable — publication crash matrix SKIPPED.\n",
  );
}

/**
 * The E.3 crash matrix.
 *
 * The property under test, stated so it cannot be satisfied by a weaker one:
 *
 * > For every point at which a publisher can die, replaying converges on
 * > **one** external effect — never zero when the obligation was durable, and
 * > never two.
 *
 * The provider double is `FakeGithub`, whose rules are transcribed from the
 * live experiment rather than invented. The one that matters most: a create is
 * refused while a review is pending, and permitted once one is submitted. A
 * double that refused in both cases would make case 4 pass for a reason GitHub
 * does not provide.
 */
describeWithPostgres(
  "Publication converges to exactly one external effect",
  () => {
    let database: TestDatabase;

    beforeAll(async () => {
      database = await startPostgres("publication");
      await assertSuiteIsActuallyRunning(database, [
        "publication_intents",
        "review_runs",
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
    const PR = "0192f8a1-0000-7000-8000-0000000000c1";
    const scope: TenantScope = { organizationId: ORG, repositoryId: REPO };

    const SUMMARY = "Acalys reviewed this change and reported 1 finding(s).";
    const CONTENT = {
      summary: SUMMARY,
      comments: [
        {
          path: "src/a.ts",
          line: 1,
          fingerprint: "f".repeat(64),
          body: "Possible defect.",
        },
      ],
    };

    let now = new Date("2026-08-18T00:00:00.000Z");
    const clock = () => now;

    function stores() {
      return {
        ingestion: new ReviewIngestionStore(database.pool, clock),
        stages: new ReviewStageStore(database.pool, clock),
        publications: new PublicationStore(database.pool, clock),
      };
    }

    /** A run parked in `publishing` with one intent, as the orchestrator leaves it. */
    async function seed(): Promise<{
      runId: string;
      intentId: string;
      logicalKey: string;
    }> {
      const { ingestion, stages, publications } = stores();
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

      const revision = await ingestion.upsertRevision(scope, {
        pullRequestId: PR,
        headSha: "a".repeat(40),
        headRef: "feature",
        baseSha: "b".repeat(40),
        baseRef: "main",
        mergeBaseSha: null,
        trigger: "push",
        createdAt: now,
      });
      const request = await ingestion.upsertReviewRequest(scope, {
        pullRequestId: PR,
        revisionId: revision.id,
        target: { kind: "pull_request" },
        trigger: "pull_request_updated",
        requestedBy: { kind: "system", component: "test" },
        executionMode: "review",
        executionStrategy: "single",
        idempotencyKey: randomUUID(),
        requestedAt: now,
      });
      const run = await ingestion.upsertReviewRun(scope, {
        requestId: request.id,
        revisionId: revision.id,
        attempt: 1,
        executionMode: "review",
        executionStrategy: "single",
        createdAt: now,
      });

      const logicalKey = `acalys:github:${ORG}:${REPO}:${PR}:${revision.id}:${run.id}:review:run`;

      for (const [from, to] of [
        ["queued", "preparing"],
        ["preparing", "analyzing"],
        ["analyzing", "reviewing"],
        ["reviewing", "verifying"],
        ["verifying", "reconciling"],
      ] as const) {
        await ingestion.transition(run.id, from, to);
      }

      // The intent is written in the transition into `publishing`, so the
      // obligation is durable before the run becomes uninterruptible.
      await stages.runStage(scope, run.id, "reconciling", "publishing", () => ({
        publications: [
          {
            kind: "review",
            logicalKey,
            contentDigest: contentDigest(SUMMARY),
            provider: "github",
            pullRequestId: PR,
            revisionId: revision.id,
          },
        ],
      }));

      const [intent] = await publications.listForRun(run.id);
      expect(intent).toBeDefined();
      return { runId: run.id, intentId: intent?.id ?? "", logicalKey };
    }

    const publish = (
      intentId: string,
      github: FakeGithub,
      faults?: Parameters<typeof publishOne>[1]["faults"],
    ) =>
      stores()
        .publications.get(intentId)
        .then((intent) => {
          expect(intent).toBeDefined();
          if (intent === undefined) throw new Error("missing intent");
          return publishOne(intent, {
            store: stores().publications,
            port: github,
            content: CONTENT,
            now: clock,
            ...(faults === undefined ? {} : { faults }),
          });
        });

    const externalEffects = (github: FakeGithub, logicalKey: string) =>
      github
        .reviews()
        .filter((review) =>
          review.body.includes(`<!-- acalys:publication:${logicalKey} -->`),
        );

    // ── 1 ────────────────────────────────────────────────────────────────────
    it("crash before the provider request: same intent, safe retry, no duplicate", async () => {
      const { intentId, logicalKey } = await seed();
      const github = new FakeGithub();

      // Dies during reconciliation, before anything could have been created.
      github.failNextWith = { class: "retryable", code: "server_error" };
      const first = await publish(intentId, github);
      expect(first).toEqual({
        kind: "deferred",
        failureClass: "retryable",
        code: "server_error",
      });
      expect(externalEffects(github, logicalKey)).toHaveLength(0);

      const after = await stores().publications.get(intentId);
      expect(after?.state).toBe("planned");
      expect(after?.id).toBe(intentId);

      now = new Date(now.getTime() + 60_000);
      expect((await publish(intentId, github)).kind).toBe("confirmed");
      expect(externalEffects(github, logicalKey)).toHaveLength(1);
    }, 60_000);

    // ── 2 ────────────────────────────────────────────────────────────────────
    it("crash after marking attempting, before the network write, converges", async () => {
      const { intentId, logicalKey } = await seed();
      const store = stores().publications;

      // A worker that moved the row and then died. Nothing external happened.
      expect((await store.beginAttempt(intentId, "planned")).kind).toBe(
        "moved",
      );
      expect((await store.get(intentId))?.state).toBe("attempting");

      const github = new FakeGithub();
      const resumed = await publish(intentId, github);

      expect(resumed.kind).toBe("confirmed");
      expect(externalEffects(github, logicalKey)).toHaveLength(1);
    }, 60_000);

    // ── 3 ────────────────────────────────────────────────────────────────────
    it("provider succeeded and the DB update was lost: recovery finds it, no duplicate", async () => {
      const { intentId, logicalKey } = await seed();
      const github = new FakeGithub();

      // The provider committed everything; the process died before recording it.
      await publish(intentId, github, {
        afterSubmit: () => Promise.reject(new Error("worker died")),
      }).catch(() => undefined);

      expect(externalEffects(github, logicalKey)).toHaveLength(1);
      const stranded = await stores().publications.get(intentId);
      expect(stranded?.state).not.toBe("published");

      const resumed = await publish(intentId, github);
      expect(resumed.kind).toBe("confirmed");
      // The recovery reused the existing review rather than creating another.
      expect(externalEffects(github, logicalKey)).toHaveLength(1);
      expect(
        github.calls.filter((call) => call.startsWith("create:")),
      ).toHaveLength(1);
    }, 60_000);

    // ── 4 ────────────────────────────────────────────────────────────────────
    it("THE lost-response case: effect committed, client never knew, no duplicate", async () => {
      const { intentId, logicalKey } = await seed();
      const github = new FakeGithub();

      // Provider commits, then the response vanishes. This is the ordering that
      // cannot be simulated by throwing before the call.
      github.loseNextResponse = true;
      const lost = await publish(intentId, github);

      expect(lost).toEqual({
        kind: "deferred",
        failureClass: "ambiguous",
        code: "transport_failure_on_write",
      });

      // Not `failed`. We do not know — and in fact it exists.
      const ambiguous = await stores().publications.get(intentId);
      expect(ambiguous?.state).toBe("unknown");
      expect(ambiguous?.lastErrorClass).toBe("ambiguous");
      expect(externalEffects(github, logicalKey)).toHaveLength(1);

      // A completely fresh recovery process, with no memory of the create.
      const resumed = await publish(intentId, github);
      expect(resumed.kind).toBe("confirmed");
      expect(externalEffects(github, logicalKey)).toHaveLength(1);
      expect(
        github.calls.filter((call) => call.startsWith("create:")),
      ).toHaveLength(1);

      const settled = await stores().publications.get(intentId);
      expect(settled?.state).toBe("published");
      expect(settled?.confirmedAt).not.toBeNull();
      expect(settled?.providerReference).not.toBeNull();
    }, 60_000);

    // ── 5 ────────────────────────────────────────────────────────────────────
    it("a definite permanent rejection fails without ambiguity", async () => {
      const { intentId, logicalKey } = await seed();
      const github = new FakeGithub();

      github.failNextWith = { class: "permanent", code: "forbidden" };
      expect(await publish(intentId, github)).toEqual({
        kind: "deferred",
        failureClass: "permanent",
        code: "forbidden",
      });

      const failed = await stores().publications.get(intentId);
      expect(failed?.state).toBe("failed");
      expect(failed?.lastErrorClass).toBe("permanent");
      expect(failed?.nextAttemptAt).toBeNull();
      expect(externalEffects(github, logicalKey)).toHaveLength(0);

      // Terminal: a replay does not resurrect it or contact the provider.
      const before = github.calls.length;
      expect((await publish(intentId, github)).kind).toBe("deferred");
      expect(github.calls).toHaveLength(before);
    }, 60_000);

    // ── 6 ────────────────────────────────────────────────────────────────────
    it("a throttle is retryable, keeps its identity, and backs off", async () => {
      const { intentId } = await seed();
      const github = new FakeGithub();

      github.failNextWith = { class: "retryable", code: "rate_limited" };
      await publish(intentId, github);

      const backed = await stores().publications.get(intentId);
      expect(backed?.state).toBe("planned");
      expect(backed?.lastErrorClass).toBe("retryable");
      expect(backed?.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());

      // Not due yet: the claimer must not hand it back.
      expect(
        await stores().publications.claimDue("worker-a", 30, 10),
      ).toHaveLength(0);

      now = new Date(now.getTime() + 120_000);
      const due = await stores().publications.claimDue("worker-a", 30, 10);
      expect(due.map((intent) => intent.id)).toEqual([intentId]);
    }, 60_000);

    // ── 7 ────────────────────────────────────────────────────────────────────
    it("a multi-finding review is one publication unit, recovered as one", async () => {
      const { intentId, logicalKey } = await seed();
      const github = new FakeGithub();

      const many = {
        summary: SUMMARY,
        comments: Array.from({ length: 5 }, (_unused, index) => ({
          path: `src/f${String(index)}.ts`,
          line: index + 1,
          fingerprint: String(index).repeat(64).slice(0, 64),
          body: "Possible defect.",
        })),
      };

      const intent = await stores().publications.get(intentId);
      if (intent === undefined) throw new Error("missing intent");

      github.loseNextResponse = true;
      await publishOne(intent, {
        store: stores().publications,
        port: github,
        content: many,
        now: clock,
      });

      const recovered = await stores().publications.get(intentId);
      if (recovered === undefined) throw new Error("missing intent");
      const outcome = await publishOne(recovered, {
        store: stores().publications,
        port: github,
        content: many,
        now: clock,
      });

      expect(outcome.kind).toBe("confirmed");
      // One review, not one per finding.
      expect(externalEffects(github, logicalKey)).toHaveLength(1);
    }, 60_000);

    // ── 8 ────────────────────────────────────────────────────────────────────
    it("two publisher workers racing produce one external effect", async () => {
      const { intentId, logicalKey } = await seed();
      const github = new FakeGithub();

      const results = await Promise.all([
        publish(intentId, github),
        publish(intentId, github),
      ]);

      // Exactly one wins; the loser is refused rather than retried.
      expect(results.filter((r) => r.kind === "confirmed")).toHaveLength(1);
      expect(externalEffects(github, logicalKey)).toHaveLength(1);
      expect(
        github.calls.filter((call) => call.startsWith("create:")).length,
      ).toBeLessThanOrEqual(1);
    }, 60_000);

    it("the lease keeps two claimers from taking the same row", async () => {
      await seed();
      const store = stores().publications;

      const first = await store.claimDue("worker-a", 60, 10);
      const second = await store.claimDue("worker-b", 60, 10);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    }, 60_000);

    // ── 9 ────────────────────────────────────────────────────────────────────
    it("a run superseded before the publishing commit publishes nothing", async () => {
      const { ingestion } = stores();
      const { runId } = await seed();

      // The ledger exists only because the run reached `publishing`. A run
      // superseded earlier has no intents at all, so there is nothing to publish.
      const other = await database.pool.query<{ id: string }>(
        "SELECT id FROM review_runs WHERE id <> $1",
        [runId],
      );
      expect(other.rowCount).toBe(0);

      const superseded = await ingestion.transition(
        runId,
        "publishing",
        "superseded",
      );
      // `publishing` is a durable obligation, so this move does not exist.
      expect(superseded.kind).toBe("illegal");
    }, 60_000);

    // ── 10 ───────────────────────────────────────────────────────────────────
    it("a worker dying after publishing began leaves the obligation resumable", async () => {
      const { runId, intentId, logicalKey } = await seed();

      // The worker is gone. Nothing about the obligation depended on it.
      const run = await stores().ingestion.getRun(runId);
      expect(run?.state).toBe("publishing");

      const ledger = await stores().publications.listForRun(runId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.state).toBe("planned");

      const github = new FakeGithub();
      expect((await publish(intentId, github)).kind).toBe("confirmed");
      expect(externalEffects(github, logicalKey)).toHaveLength(1);
    }, 60_000);

    // ── 11 ───────────────────────────────────────────────────────────────────
    it("replaying a completed publication contacts nobody and moves nothing", async () => {
      const { intentId, logicalKey } = await seed();
      const github = new FakeGithub();

      expect((await publish(intentId, github)).kind).toBe("confirmed");
      const settled = await stores().publications.get(intentId);
      const callsAfterFirst = github.calls.length;

      for (let replay = 0; replay < 3; replay += 1) {
        expect(await publish(intentId, github)).toEqual({
          kind: "already_confirmed",
        });
      }

      expect(github.calls).toHaveLength(callsAfterFirst);
      expect(externalEffects(github, logicalKey)).toHaveLength(1);
      const unchanged = await stores().publications.get(intentId);
      expect(unchanged?.confirmedAt?.toISOString()).toBe(
        settled?.confirmedAt?.toISOString(),
      );
    }, 60_000);

    // ── content verification ─────────────────────────────────────────────────
    it("a marker match with different content is an invariant violation, not a retry", async () => {
      const { intentId, logicalKey } = await seed();
      const github = new FakeGithub();

      // Someone — or some earlier version of us — published this identity with
      // different content.
      github.plant(
        `<!-- acalys:publication:${logicalKey} -->\nSomething else entirely.`,
      );

      await expect(publish(intentId, github)).rejects.toBeInstanceOf(
        PublicationInvariantViolation,
      );

      // Neither resolution was taken: provider state is untouched and the ledger
      // does not claim publication.
      expect(github.reviews()).toHaveLength(1);
      expect(github.calls.some((call) => call.startsWith("create:"))).toBe(
        false,
      );
      const intent = await stores().publications.get(intentId);
      expect(intent?.state).not.toBe("published");
    }, 60_000);

    it("the same logical key with the same digest is idempotent reuse", async () => {
      // The other half of the invariant, and the half that has to keep working:
      // a replayed stage must converge on the existing row rather than insert a
      // second one or raise. Without this test the digest check could be
      // "tightened" into rejecting every replay and nothing would notice.
      const { runId } = await seed();
      const { stages, publications } = stores();
      const [existing] = await publications.listForRun(runId);
      if (existing === undefined) throw new Error("missing intent");

      for (let replay = 0; replay < 3; replay += 1) {
        // Rewound so the stage genuinely re-executes, and the outcome is
        // asserted: `publishing → publishing` is not a legal move, so looping
        // over it would be refused early and this test would pass without ever
        // reaching the insert it exists to exercise.
        await database.pool.query(
          "UPDATE review_runs SET state = 'reconciling' WHERE id = $1",
          [runId],
        );

        const outcome = await stages.runStage(
          scope,
          runId,
          "reconciling",
          "publishing",
          () => ({
            publications: [
              {
                kind: "review",
                logicalKey: existing.logicalKey,
                contentDigest: existing.contentDigest,
                provider: "github",
              },
            ],
          }),
        );
        expect(outcome.kind).toBe("advanced");
      }

      const after = await publications.listForRun(runId);
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(existing.id);
      expect(after[0]?.contentDigest).toBe(existing.contentDigest);
    }, 60_000);

    it("the same logical key with a changed digest is refused at write time", async () => {
      const { runId } = await seed();
      const { stages, publications } = stores();
      const [existing] = await publications.listForRun(runId);
      if (existing === undefined) throw new Error("missing intent");

      await expect(
        stages.runStage(scope, runId, "publishing", "completed", () => ({
          publications: [
            {
              kind: "review",
              logicalKey: existing.logicalKey,
              contentDigest: contentDigest("different content"),
              provider: "github",
            },
          ],
        })),
      ).rejects.toBeInstanceOf(PublicationContentConflict);
    }, 60_000);

    // ── lifecycle entailments ────────────────────────────────────────────────
    it("no run in the database is completed with an unconfirmed publication", async () => {
      const { runId, intentId } = await seed();
      const github = new FakeGithub();

      // Completing before confirmation must be visible as a violation.
      await stores().ingestion.transition(runId, "publishing", "completed");
      expect(await findLifecycleViolations(database.pool)).not.toEqual([]);

      await database.pool.query(
        "UPDATE review_runs SET state = 'publishing' WHERE id = $1",
        [runId],
      );
      expect((await publish(intentId, github)).kind).toBe("confirmed");
      await stores().ingestion.transition(runId, "publishing", "completed");

      expect(await findLifecycleViolations(database.pool)).toEqual([]);
    }, 60_000);

    // ── the trust boundary, enforced by the database ─────────────────────────
    it("refuses a publication authored by anything but the policy path", async () => {
      // The shortest path from "an analyzer had an opinion" to "a developer was
      // interrupted" must not be one INSERT.
      const { runId } = await seed();
      const [intent] = await stores().publications.listForRun(runId);
      if (intent === undefined) throw new Error("missing intent");

      for (const author of ["analyzer", "verifier"]) {
        await expect(
          database.pool.query(
            "UPDATE publication_intents SET authored_by = $2 WHERE id = $1",
            [intent.id, author],
          ),
        ).rejects.toThrow(/authored_by/);
      }
    }, 60_000);

    it("refuses a completed verification that does not say why", async () => {
      const { runId } = await seed();
      const candidate = await database.pool.query<{ id: string }>(
        `INSERT INTO candidate_findings (id, organization_id, repository_id, review_run_id,
         producer_id, producer_version, input_digest, title, claim, explanation,
         category, proposed_severity, path, start_line, end_line, fingerprint_value,
         created_at)
       VALUES (gen_random_uuid(),$1,$2,$3,'a','1',$4,'t','c','e','correctness','medium',
         'src/a.ts',1,1,$5,$6)
       RETURNING id`,
        [ORG, REPO, runId, "d".repeat(64), "f".repeat(64), now],
      );

      // Each shape needs its own durably scheduled invocation: an attempt may
      // only claim an identity a scheduler allocated (0007), so a test that
      // minted `gen_random_uuid()` for `invocation_id` is now refused by the
      // composite foreign key before it ever reaches the CHECK it is about.
      // That refusal is correct, and it means the fixture has to go through the
      // same door production does.
      const scheduler = new VerificationScheduler(database.pool, clock);
      let pass = 0;
      const insert = async (columns: string, values: unknown[]) => {
        pass += 1;
        const invocation = await scheduler.schedule({
          organizationId: ORG,
          reviewRunId: runId,
          candidateFindingId: candidate.rows[0]?.id ?? "",
          requestKey: `test:constraint:${runId}:${String(pass)}`,
          reason: "initial",
        });
        // And the lease the attempt is written under (0009): the composite key
        // refuses an attempt that presents ownership no invocation granted.
        const ownership = await scheduler.claim(
          invocation.invocationId,
          "test-worker",
          60_000,
        );
        if (ownership.kind !== "claimed") {
          throw new Error(
            `expected a verification claim, got ${ownership.kind}`,
          );
        }
        return database.pool.query(
          `INSERT INTO verification_attempts (id, organization_id, review_run_id,
           candidate_finding_id, verifier_id, verifier_version, context_digest,
           cache_key, invocation_id, attempt, claim_token, claim_generation,
           created_at, ${columns})
         VALUES (gen_random_uuid(),$1,$2,$3,'v','1',$4,$5,$6,$7,$8,$9,$10,${values
           .map((_unused, index) => `$${String(index + 11)}`)
           .join(",")})`,
          [
            ORG,
            runId,
            candidate.rows[0]?.id,
            "c".repeat(64),
            "k".repeat(64),
            invocation.invocationId,
            invocation.attempt,
            ownership.claim.claimToken,
            ownership.claim.claimGeneration,
            now,
            ...values,
          ],
        );
      };

      // "Verified, reason unknown" is a row nobody can audit.
      await expect(
        insert("status, decision, severity", [
          "completed",
          "verified",
          "medium",
        ]),
      ).rejects.toThrow(/verification_completed_is_reasoned/);

      // An unavailable attempt has examined nothing, so it must not carry a
      // decision a reader could mistake for a judgement.
      await expect(
        insert("status, failure, decision", [
          "unavailable",
          "model_timeout",
          "rejected",
        ]),
      ).rejects.toThrow(/verification_unavailable_has_no_decision/);

      // The legitimate shapes are accepted, so the constraints are not simply
      // refusing everything.
      await insert("status, decision, severity, reasons", [
        "completed",
        "verified",
        "medium",
        ["independent_context_confirms"],
      ]);
    }, 60_000);

    it("published without provider evidence is rejected by the database itself", async () => {
      const { intentId } = await seed();

      // The application cannot write this state; neither can anything else.
      await expect(
        database.pool.query(
          "UPDATE publication_intents SET state = 'published' WHERE id = $1",
          [intentId],
        ),
      ).rejects.toThrow(/publication_intents_published_is_confirmed/);
    }, 60_000);

    it("unknown is unreachable without an attempt", async () => {
      const { intentId } = await seed();
      await expect(
        database.pool.query(
          "UPDATE publication_intents SET state = 'unknown' WHERE id = $1",
          [intentId],
        ),
      ).rejects.toThrow(/publication_intents_unknown_was_attempted/);
    }, 60_000);

    it("an ambiguous row cannot be re-attempted without a provider lookup", async () => {
      const { intentId } = await seed();
      const store = stores().publications;

      await store.beginAttempt(intentId, "planned");
      await store.recordFailure(intentId, "attempting", {
        kind: "ambiguous",
        code: "transport_failure_on_write",
      });

      // The shortcut that publishes duplicates, refused by name.
      expect(await store.beginAttempt(intentId, "unknown")).toEqual({
        kind: "reconciliation_required",
      });

      await store.recordReconciliation(intentId);
      expect((await store.beginAttempt(intentId, "unknown")).kind).toBe(
        "moved",
      );
    }, 60_000);
  },
);

/**
 * The transition table, tested exhaustively rather than sampled.
 *
 * No database needed: the table is the contract, and a 5×5 matrix is small
 * enough that sampling it would be a choice to know less.
 */
describe("The publication transition table", () => {
  const LEGAL = new Set(
    legalPublicationTransitions().map(([from, to]) => `${from}->${to}`),
  );

  it("permits exactly the moves the table declares", () => {
    for (const from of PUBLICATION_STATES) {
      for (const to of PUBLICATION_STATES) {
        expect(
          `${from}->${to}:${String(canTransitionPublication(from, to))}`,
        ).toBe(`${from}->${to}:${String(LEGAL.has(`${from}->${to}`))}`);
      }
    }
  });

  it("keeps published and failed terminal", () => {
    for (const terminal of ["published", "failed"] as PublicationState[]) {
      for (const to of PUBLICATION_STATES) {
        expect(canTransitionPublication(terminal, to)).toBe(false);
      }
    }
  });

  it("routes every exit from unknown through provider evidence", () => {
    // `unknown → planned` would be a blind retry with a backoff attached.
    expect(canTransitionPublication("unknown", "planned")).toBe(false);
    expect(canTransitionPublication("unknown", "published")).toBe(true);
    expect(canTransitionPublication("unknown", "attempting")).toBe(true);
    expect(canTransitionPublication("unknown", "failed")).toBe(true);
  });
});

describe("Content comparison", () => {
  it("ignores the identity marker and compares what the reader sees", () => {
    const body = "<!-- acalys:publication:k -->\nAcalys reviewed this change.";
    expect(strippedBody(body)).toBe("Acalys reviewed this change.");
    expect(contentDigest(strippedBody(body))).toBe(
      contentDigest("Acalys reviewed this change."),
    );
  });

  it("does not strip anything from a body that carries no marker", () => {
    expect(strippedBody("Just a comment.")).toBe("Just a comment.");
  });
});
