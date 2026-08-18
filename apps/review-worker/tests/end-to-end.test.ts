import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { signWebhookBody } from "@acalys/provider-github";
import { PostgresWebhookInbox, ReviewIngestionStore } from "@acalys/database";
import { createGatewayApp } from "@acalys/webhook-gateway";
import {
  assertSuiteIsActuallyRunning,
  dockerAvailable,
  startPostgres,
  type TestDatabase,
} from "../../../packages/database/tests/postgres.js";

import {
  createWorker,
  idempotencyKeyFor,
  ingestDelivery,
} from "../src/index.js";

const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER
  ? describe
  : describe.skip.bind(describe);

if (!HAS_DOCKER) {
  console.warn(
    "\n  ⚠ Docker unavailable — end-to-end ingestion tests SKIPPED. The full\n" +
      "    HTTP → database path is NOT verified in this run.\n",
  );
}

const SECRET = "3f2a91c7e4b6d8021a5c9e7f3b1d6a48";
const ENDPOINT = "acalys-app-e2e";

const ORG = "0192f8a1-0000-7000-8000-00000000000a";
const REPO = "0192f8a1-0000-7000-8000-0000000000aa";

/** The real GitHub fixture from P1-A, so the path is exercised end to end. */
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../packages/providers/github/tests/fixtures/pull-request-opened.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as Record<string, unknown>;

/**
 * The loop, closed.
 *
 * Every previous checkpoint proved one link: the adapter normalizes, the
 * gateway authenticates and owns, the store converges. This asserts the whole
 * chain — a signed HTTP request becomes a `ReviewRun` row — and, more usefully,
 * that it still converges when the chain is interrupted anywhere along it.
 */
describeWithPostgres("A signed delivery becomes a ReviewRun", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startPostgres("e2e");
    await assertSuiteIsActuallyRunning(database, [
      "webhook_deliveries",
      "review_runs",
    ]);
  }, 120_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(
      "INSERT INTO organizations (id, slug, name) VALUES ($1,'acme','Acme')",
      [ORG],
    );
    await database.pool.query(
      `INSERT INTO repositories (id, organization_id, provider, provider_external_id,
         owner, name, default_branch, visibility, installation_id)
       VALUES ($1,$2,'github','1296269','acalys','acalys','main','private','44556677')`,
      [REPO, ORG],
    );
  });

  const inbox = () => new PostgresWebhookInbox({ pool: database.pool });
  const store = () => new ReviewIngestionStore(database.pool);

  function app() {
    return createGatewayApp({
      github: { secret: SECRET, sourceEndpointId: ENDPOINT, inbox: inbox() },
    });
  }

  /** Posts a delivery exactly as GitHub would. */
  async function deliver(
    mutate: (payload: Record<string, unknown>) => void = () => undefined,
    deliveryId = "e2e-delivery-1",
  ) {
    const payload = structuredClone(fixture);
    mutate(payload);
    const body = JSON.stringify(payload);

    return request(app())
      .post("/webhooks/github")
      .set({
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
        "x-hub-signature-256": signWebhookBody(SECRET, body),
      })
      .send(body);
  }

  async function drain(): Promise<number> {
    const worker = createWorker({ inbox: inbox(), store: store() });
    // `tick` rather than the loop: the test drives the batch and asserts on
    // what it produced, instead of racing a background timer.
    const handled = await worker.tick();
    await worker.stop();
    return handled;
  }

  async function counts(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const table of [
      "webhook_deliveries",
      "webhook_jobs",
      "pull_requests",
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

  it("HTTP → durable delivery → ReviewRun, in one pass", async () => {
    const response = await deliver();
    expect(response.status).toBe(202);

    expect(await drain()).toBe(1);

    expect(await counts()).toEqual({
      webhook_deliveries: 1,
      // The job is deleted on success: a completed job has no further use, and
      // keeping it would grow the claim index without bound.
      webhook_jobs: 0,
      pull_requests: 1,
      pull_request_revisions: 1,
      review_requests: 1,
      review_runs: 1,
    });

    const run = await database.pool.query<{
      state: string;
      attempt: number;
      organization_id: string;
    }>("SELECT state, attempt, organization_id FROM review_runs");
    expect(run.rows[0]).toMatchObject({
      state: "queued",
      attempt: 1,
      organization_id: ORG,
    });
  }, 60_000);

  it("carries the provider's identity through without leaking its vocabulary", async () => {
    await deliver();
    await drain();

    const pr = await database.pool.query<{
      provider_external_id: string;
      number: number;
      title: string;
    }>("SELECT provider_external_id, number, title FROM pull_requests");

    // Keyed on the immutable id, with the human-facing number alongside.
    expect(pr.rows[0]?.provider_external_id).toBe("2145998877");
    expect(pr.rows[0]?.number).toBe(412);

    const revision = await database.pool.query<{
      head_sha: string;
      merge_base_sha: string | null;
    }>("SELECT head_sha, merge_base_sha FROM pull_request_revisions");
    expect(revision.rows[0]?.head_sha).toBe(
      "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c",
    );
    // GitHub's `merge_commit_sha` is a test merge commit in neither branch.
    // Using it as the diff base would attribute the base branch's commits to
    // this change's author.
    expect(revision.rows[0]?.merge_base_sha).toBeNull();
  }, 60_000);

  describe("redelivery and replay converge", () => {
    it("a GitHub redelivery of the same event changes nothing", async () => {
      await deliver();
      await drain();
      const after = await counts();

      // Same delivery id and same bytes — the inbox recognizes it.
      const second = await deliver();
      expect(second.status).toBe(202);
      expect(second.body).toEqual({ status: "duplicate" });
      expect(await drain()).toBe(0);

      expect(await counts()).toEqual(after);
    }, 60_000);

    it("a DIFFERENT delivery describing the same push converges too", async () => {
      // The case the delivery id alone cannot catch: GitHub sends `opened` and
      // then a `synchronize` for the same head, or an operator replays through
      // a second endpoint. The idempotency key is derived from head SHA, so
      // both resolve to one request and one run.
      await deliver();
      await drain();

      await deliver((payload) => {
        (payload as { action: string }).action = "synchronize";
      }, "e2e-delivery-2");
      await drain();

      const after = await counts();
      expect(after["pull_request_revisions"]).toBe(1);
      expect(after["review_requests"]).toBe(1);
      expect(after["review_runs"]).toBe(1);
      // Two distinct deliveries were still both recorded — the audit trail is
      // complete even though only one review resulted.
      expect(after["webhook_deliveries"]).toBe(2);
    }, 60_000);

    it("a worker crash mid-pipeline converges on replay", async () => {
      await deliver();

      // Claim the job, then process only part-way and die.
      const claimed = await inbox().claimJobs(1, 100);
      expect(claimed).toHaveLength(1);

      const delivery = await store().findDeliveryById(
        claimed[0]?.deliveryRowId ?? "",
      );
      await store().upsertPullRequest(
        { organizationId: ORG, repositoryId: REPO },
        {
          providerExternalId: "2145998877",
          number: 412,
          title: "partial",
          description: null,
          author: { kind: "human" },
          state: "open",
          draft: false,
          labels: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      );
      // …worker dies here, holding a lease that will lapse.

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await drain()).toBe(1);

      expect(await counts()).toMatchObject({
        pull_requests: 1,
        pull_request_revisions: 1,
        review_requests: 1,
        review_runs: 1,
      });
      // The partially-written row was updated, not duplicated.
      const pr = await database.pool.query<{ title: string }>(
        "SELECT title FROM pull_requests",
      );
      expect(pr.rows[0]?.title).toBe("Stream agent responses over SSE");
      expect(delivery).toBeDefined();
    }, 60_000);
  });

  describe("a newer push supersedes the run in flight", () => {
    it("creates a second run and supersedes the first", async () => {
      await deliver();
      await drain();

      const first = await database.pool.query<{ id: string }>(
        "SELECT id FROM review_runs",
      );
      const firstRunId = first.rows[0]?.id ?? "";

      // A push: same PR, new head.
      await deliver((payload) => {
        const pull = (payload as { pull_request: Record<string, unknown> })
          .pull_request;
        (pull["head"] as { sha: string }).sha = "a".repeat(40);
        (payload as { action: string }).action = "synchronize";
      }, "e2e-delivery-push");
      await drain();

      const runs = await database.pool.query<{ id: string; state: string }>(
        "SELECT id, state FROM review_runs ORDER BY created_at",
      );
      expect(runs.rows).toHaveLength(2);

      const superseded = runs.rows.find((row) => row.id === firstRunId);
      expect(superseded?.state).toBe("superseded");
      expect(runs.rows.find((row) => row.id !== firstRunId)?.state).toBe(
        "queued",
      );
    }, 60_000);
  });

  describe("failures are classified, not retried blindly", () => {
    it("retries an unresolved repository, then dead-letters it", async () => {
      // A delivery can outrun installation sync. Retrying gives sync time to
      // catch up; the budget bounds how long that is worth.
      await database.pool.query("DELETE FROM repositories");
      await deliver();

      let handled = 0;
      for (let pass = 0; pass < 8; pass += 1) {
        // The retry backoff is skipped by claiming with the job already
        // available; a real worker would wait.
        await database.pool.query(
          "UPDATE webhook_jobs SET available_at = now()",
        );
        handled += await drain();
      }
      expect(handled).toBeGreaterThan(1);

      const delivery = await database.pool.query<{
        state: string;
        outcome_reason: string;
      }>("SELECT state, outcome_reason FROM webhook_deliveries");
      expect(delivery.rows[0]?.state).toBe("failed");
      expect(delivery.rows[0]?.outcome_reason).toContain(
        "repository-not-resolved",
      );

      // And it stops consuming worker capacity.
      expect(await drain()).toBe(0);
    }, 60_000);

    it("dead-letters an unreadable payload immediately", async () => {
      // Fails identically on every retry, so spending the budget is waste.
      const body = '{"action":"opened","pull_request":{"id":"not-a-number"}}';
      const response = await request(app())
        .post("/webhooks/github")
        .set({
          "content-type": "application/json",
          "x-github-delivery": "e2e-bad",
          "x-github-event": "pull_request",
          "x-hub-signature-256": signWebhookBody(SECRET, body),
        })
        .send(body);
      expect(response.status).toBe(202);

      expect(await drain()).toBe(1);

      const delivery = await database.pool.query<{
        state: string;
        outcome_reason: string;
      }>("SELECT state, outcome_reason FROM webhook_deliveries");
      expect(delivery.rows[0]?.state).toBe("failed");
      expect(delivery.rows[0]?.outcome_reason).toContain("payload-unreadable");
      // One attempt, not five.
      expect(await drain()).toBe(0);
    }, 60_000);

    it("records an unhandled action as ignored, distinctly from processed", async () => {
      await deliver((payload) => {
        (payload as { action: string }).action = "labeled";
      }, "e2e-labeled");

      // The gateway already declines to schedule work for it.
      expect(await drain()).toBe(0);

      const delivery = await database.pool.query<{ state: string }>(
        "SELECT state FROM webhook_deliveries",
      );
      expect(delivery.rows[0]?.state).toBe("ignored");
    }, 60_000);
  });

  it("derives the idempotency key from head SHA, not the delivery id", () => {
    // The property that makes two different deliveries about one push converge.
    const event = {
      pull_request: { id: 2145998877, head: { sha: "b".repeat(40) } },
    } as never;
    expect(idempotencyKeyFor(event)).toBe(
      `github:2145998877:${"b".repeat(40)}`,
    );
  });

  it("ignores a non-pull_request delivery rather than failing it", async () => {
    const outcome = await ingestDelivery(
      { id: "x", event: "star", payload: Buffer.from("{}", "utf8") },
      { store: store() },
    );
    expect(outcome.kind).toBe("ignored");
  });
});
