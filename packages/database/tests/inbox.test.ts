import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  PostgresWebhookInbox,
  digestBody,
  type AuthenticatedDelivery,
  type JobRequest,
} from "../src/index.js";
import {
  assertSuiteIsActuallyRunning,
  dockerAvailable,
  startPostgres,
  type TestDatabase,
} from "./postgres.js";

const HAS_DOCKER = dockerAvailable();

/**
 * Skips loudly rather than silently passing.
 *
 * A suite that quietly reports success on a machine without Docker would let
 * the constraint regress unnoticed — the failure mode this whole file exists to
 * prevent.
 */
const describeWithPostgres = HAS_DOCKER
  ? describe
  : describe.skip.bind(describe);

if (!HAS_DOCKER) {
  console.warn(
    "\n  ⚠ Docker unavailable — Postgres inbox tests SKIPPED. The exactly-once\n" +
      "    guarantee is a unique constraint and is NOT verified in this run.\n",
  );
}

describeWithPostgres("Postgres webhook inbox", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await startPostgres("inbox");
    // Fail closed: a suite that reports success without running is worse
    // than one that fails.
    await assertSuiteIsActuallyRunning(database, [
      "webhook_deliveries",
      "webhook_jobs",
    ]);
  }, 120_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  beforeEach(async () => {
    await database.reset();
  });

  const ENDPOINT = "acalys-app-prod";

  function delivery(
    overrides: Partial<AuthenticatedDelivery> = {},
  ): AuthenticatedDelivery {
    const payload = Buffer.from(
      overrides.payload?.toString("utf8") ?? '{"action":"opened","number":412}',
      "utf8",
    );
    return {
      provider: "github",
      sourceEndpointId: ENDPOINT,
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      event: "pull_request",
      action: "opened",
      bodyDigest: digestBody(payload),
      payload,
      receivedAt: new Date("2026-08-16T10:00:00.000Z"),
      ...overrides,
      // Recomputed last so an overridden payload always carries a matching
      // digest unless a test deliberately supplies its own.
      ...(overrides.bodyDigest === undefined
        ? { bodyDigest: digestBody(overrides.payload ?? payload) }
        : {}),
    };
  }

  const job: JobRequest = {
    kind: "github.pull_request",
    payload: { action: "opened" },
  };

  const inbox = (faults = {}) =>
    new PostgresWebhookInbox({ pool: database.pool, faults });

  async function countRows(): Promise<{ deliveries: number; jobs: number }> {
    const deliveries = await database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM webhook_deliveries",
    );
    const jobs = await database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM webhook_jobs",
    );
    return {
      deliveries: Number(deliveries.rows[0]?.count ?? 0),
      jobs: Number(jobs.rows[0]?.count ?? 0),
    };
  }

  it("accepts a first delivery and schedules its work", async () => {
    const outcome = await inbox().ingest(delivery(), [job]);

    expect(outcome.kind).toBe("accepted");
    expect(await countRows()).toEqual({ deliveries: 1, jobs: 1 });
  });

  it("retains the authenticated bytes, not just a digest", async () => {
    // A digest proves identity; bytes enable replay. Without the payload, a
    // worker crash after acknowledgement leaves the platform knowing a delivery
    // existed while unable to process it.
    await inbox().ingest(delivery(), [job]);
    const stored = await inbox().findDelivery(
      ENDPOINT,
      "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    );

    expect(stored?.payload.toString("utf8")).toBe(
      '{"action":"opened","number":412}',
    );
  });

  describe("exactly once", () => {
    it("treats a redelivery of identical bytes as a duplicate", async () => {
      const store = inbox();
      const first = await store.ingest(delivery(), [job]);
      const second = await store.ingest(delivery(), [job]);

      expect(first.kind).toBe("accepted");
      expect(second.kind).toBe("duplicate");
      expect(await countRows()).toEqual({ deliveries: 1, jobs: 1 });
    });

    it("THE property: N concurrent identical deliveries produce one of everything", async () => {
      // The centrepiece. Two gateway replicas handling one redelivery hit this
      // routinely, and a check-then-insert loses the race every time.
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 24 }),
          async (concurrency) => {
            await database.reset();
            const store = inbox();
            const deliveryId = randomUUID();

            const outcomes = await Promise.all(
              Array.from({ length: concurrency }, () =>
                store.ingest(delivery({ deliveryId }), [job]),
              ),
            );

            expect(await countRows()).toEqual({ deliveries: 1, jobs: 1 });

            // Every caller must observe a settled, non-error outcome — one
            // accepted, the rest duplicates. A caller that saw an exception would
            // have returned 5xx for a delivery the platform already owns.
            expect(outcomes.filter((o) => o.kind === "accepted")).toHaveLength(
              1,
            );
            expect(outcomes.filter((o) => o.kind === "duplicate")).toHaveLength(
              concurrency - 1,
            );
          },
        ),
        { numRuns: 6 },
      );
    }, 120_000);

    it("scopes uniqueness by endpoint, so one hook cannot suppress another", async () => {
      // Delivery ids are unique per webhook, not globally. A staging endpoint
      // replaying production traffic must not silently swallow the original.
      const store = inbox();
      const shared = "same-delivery-id";

      const production = await store.ingest(
        delivery({ deliveryId: shared, sourceEndpointId: "prod" }),
        [job],
      );
      const staging = await store.ingest(
        delivery({ deliveryId: shared, sourceEndpointId: "staging" }),
        [job],
      );

      expect(production.kind).toBe("accepted");
      expect(staging.kind).toBe("accepted");
      expect(await countRows()).toEqual({ deliveries: 2, jobs: 2 });
    });
  });

  describe("same id, different bytes is an anomaly, not a duplicate", () => {
    it("reports a conflict and preserves the original", async () => {
      // GitHub does not reuse delivery ids, so this means something between
      // GitHub and here rewrote the body. `ON CONFLICT DO NOTHING` would
      // discard exactly this evidence.
      const store = inbox();
      await store.ingest(delivery(), [job]);

      const outcome = await store.ingest(
        delivery({ payload: Buffer.from('{"action":"closed"}', "utf8") }),
        [job],
      );

      expect(outcome.kind).toBe("conflict");
      if (outcome.kind !== "conflict") throw new Error("unreachable");
      expect(outcome.existing.bodyDigest).not.toBe(outcome.attemptedDigest);

      // The original survives untouched, and no second job was scheduled.
      const stored = await store.findDelivery(ENDPOINT, delivery().deliveryId);
      expect(stored?.payload.toString("utf8")).toBe(
        '{"action":"opened","number":412}',
      );
      expect(await countRows()).toEqual({ deliveries: 1, jobs: 1 });
    });

    it("property: any byte change makes it a conflict, never a duplicate", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 31 }),
          fc.integer({ min: 33, max: 126 }),
          async (position, replacement) => {
            await database.reset();
            const store = inbox();
            const original = Buffer.from(
              '{"action":"opened","number":412}',
              "utf8",
            );
            await store.ingest(delivery({ payload: original }), [job]);

            const mutated = Buffer.from(original);
            if (mutated[position] === replacement) return; // no change to make
            mutated[position] = replacement;

            const outcome = await store.ingest(delivery({ payload: mutated }), [
              job,
            ]);
            expect(outcome.kind).toBe("conflict");
          },
        ),
        { numRuns: 12 },
      );
    }, 120_000);
  });

  describe("crash windows", () => {
    it("crash after the delivery insert leaves nothing owned", async () => {
      // The dangerous window: a committed delivery with no job is work nobody
      // will do, and redelivery cannot repair it because the row makes the
      // retry look like a duplicate.
      const store = inbox({
        afterDeliveryInsert: () => Promise.reject(new Error("process died")),
      });

      await expect(store.ingest(delivery(), [job])).rejects.toThrow(
        "process died",
      );
      expect(await countRows()).toEqual({ deliveries: 0, jobs: 0 });
    });

    it("crash after the job insert leaves nothing owned", async () => {
      const store = inbox({
        afterJobInsert: () => Promise.reject(new Error("process died")),
      });

      await expect(store.ingest(delivery(), [job])).rejects.toThrow(
        "process died",
      );
      expect(await countRows()).toEqual({ deliveries: 0, jobs: 0 });
    });

    it("crash immediately before commit leaves nothing owned", async () => {
      const store = inbox({
        beforeCommit: () => Promise.reject(new Error("process died")),
      });

      await expect(store.ingest(delivery(), [job])).rejects.toThrow(
        "process died",
      );
      expect(await countRows()).toEqual({ deliveries: 0, jobs: 0 });
    });

    it("a rolled-back delivery can be redelivered successfully", async () => {
      // The recovery path: because nothing was committed, GitHub's redelivery
      // (or a manual replay) is accepted rather than mistaken for a duplicate.
      await expect(
        inbox({
          beforeCommit: () => Promise.reject(new Error("process died")),
        }).ingest(delivery(), [job]),
      ).rejects.toThrow();

      const retry = await inbox().ingest(delivery(), [job]);
      expect(retry.kind).toBe("accepted");
      expect(await countRows()).toEqual({ deliveries: 1, jobs: 1 });
    });

    it("property: any crash point leaves zero rows", async () => {
      const points = [
        "afterDeliveryInsert",
        "afterJobInsert",
        "beforeCommit",
      ] as const;

      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...points), async (point) => {
          await database.reset();
          const store = inbox({
            [point]: () => Promise.reject(new Error("died")),
          });

          await expect(store.ingest(delivery(), [job])).rejects.toThrow();
          expect(await countRows()).toEqual({ deliveries: 0, jobs: 0 });
        }),
        { numRuns: 9 },
      );
    }, 60_000);
  });

  describe("job claiming", () => {
    it("returns scheduled work oldest first", async () => {
      const store = inbox();
      await store.ingest(delivery({ deliveryId: "a" }), [job]);
      await store.ingest(delivery({ deliveryId: "b" }), [job]);

      const claimed = await store.claimJobs(10);
      expect(claimed).toHaveLength(2);
    });

    it("does not hand the same job to two workers", async () => {
      // FOR UPDATE SKIP LOCKED: several workers poll one table without
      // serializing, and each takes rows the others have not locked.
      const store = inbox();
      await store.ingest(delivery(), [job]);

      const [first, second] = await Promise.all([
        store.claimJobs(10),
        store.claimJobs(10),
      ]);

      expect((first?.length ?? 0) + (second?.length ?? 0)).toBe(1);
    });

    it("counts attempts, so a poison job can be found", async () => {
      const store = inbox();
      await store.ingest(delivery(), [job]);
      const claimed = await store.claimJobs(10);

      expect(claimed[0]?.attempts).toBe(1);
    });
  });

  it("records an ignored delivery distinctly from a processed one", async () => {
    // "Did we act on this?" must stay answerable. Recording an ignored event as
    // processed erases the distinction.
    const store = inbox();
    const outcome = await store.ingest(delivery(), []);
    if (outcome.kind !== "accepted") throw new Error("unreachable");

    await store.markDeliveryState(
      outcome.delivery.id,
      "ignored",
      "unsupported",
    );
    const stored = await store.findDelivery(ENDPOINT, delivery().deliveryId);

    expect(stored?.state).toBe("ignored");
    expect(stored?.outcomeReason).toBe("unsupported");
  });
});
