import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import request from "supertest";

import { signWebhookBody } from "@acalys/provider-github";
import {
  digestBody,
  type AuthenticatedDelivery,
  type IngestOutcome,
  type JobRequest,
  type WebhookDelivery,
  type WebhookInbox,
} from "@acalys/database";

import { createGatewayApp, MAX_BODY_BYTES } from "../src/index.js";

const SECRET = "it's a secret to everybody";
const ENDPOINT = "acalys-app-test";

/**
 * An in-memory inbox that models the Postgres one's contract.
 *
 * Not a substitute for the real store — the exactly-once guarantee is verified
 * against actual Postgres in `packages/database`. This exists so the *gateway's*
 * HTTP behaviour can be exercised without a container: which status maps to
 * which outcome, what reaches the response body, and whether the raw bytes
 * survive the middleware chain.
 */
class MemoryInbox implements WebhookInbox {
  public readonly deliveries = new Map<string, WebhookDelivery>();
  public readonly jobs: JobRequest[] = [];
  public ingestCalls = 0;
  public failNext = false;

  public ingest(
    delivery: AuthenticatedDelivery,
    jobs: readonly JobRequest[],
  ): Promise<IngestOutcome> {
    this.ingestCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("persistence unavailable"));
    }

    const key = `${delivery.sourceEndpointId}|${delivery.deliveryId}`;
    const existing = this.deliveries.get(key);

    if (existing !== undefined) {
      return Promise.resolve(
        existing.bodyDigest === delivery.bodyDigest
          ? { kind: "duplicate", delivery: existing }
          : {
              kind: "conflict",
              existing,
              attemptedDigest: delivery.bodyDigest,
            },
      );
    }

    const stored: WebhookDelivery = {
      id: randomUUID(),
      ...delivery,
      authenticatedAt: delivery.receivedAt,
      state: "received",
      outcomeReason: null,
      attempts: 0,
    };
    this.deliveries.set(key, stored);
    this.jobs.push(...jobs);
    return Promise.resolve({ kind: "accepted", delivery: stored });
  }

  public findDelivery(
    sourceEndpointId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery | undefined> {
    return Promise.resolve(
      this.deliveries.get(`${sourceEndpointId}|${deliveryId}`),
    );
  }

  public claimJobs(): Promise<readonly never[]> {
    return Promise.resolve([]);
  }

  public markDeliveryState(
    deliveryRowId: string,
    state: WebhookDelivery["state"],
    reason?: string,
  ): Promise<void> {
    for (const [key, value] of this.deliveries) {
      if (value.id === deliveryRowId) {
        this.deliveries.set(key, {
          ...value,
          state,
          outcomeReason: reason ?? null,
        });
      }
    }
    return Promise.resolve();
  }
}

interface Harness {
  readonly app: ReturnType<typeof createGatewayApp>;
  readonly inbox: MemoryInbox;
  readonly outcomes: string[];
}

function harness(): Harness {
  const inbox = new MemoryInbox();
  const outcomes: string[] = [];
  const app = createGatewayApp({
    github: {
      secret: SECRET,
      sourceEndpointId: ENDPOINT,
      inbox,
      allowWeakSecretForTesting: true,
      observer: {
        onOutcome: (event) => outcomes.push(event.outcome),
      },
    },
  });
  return { app, inbox, outcomes };
}

const BODY = JSON.stringify({
  action: "opened",
  number: 412,
  pull_request: { id: 1 },
});

function post(
  app: Harness["app"],
  options: {
    body?: string;
    signature?: string | undefined;
    deliveryId?: string;
    event?: string;
    omit?: readonly string[];
  } = {},
) {
  const body = options.body ?? BODY;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-delivery":
      options.deliveryId ?? "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    "x-github-event": options.event ?? "pull_request",
    "x-hub-signature-256": options.signature ?? signWebhookBody(SECRET, body),
  };
  for (const name of options.omit ?? []) delete headers[name];

  const pending = request(app).post("/webhooks/github").set(headers);
  return pending.send(body);
}

describe("Raw bytes are the authentication boundary", () => {
  it("verifies against exact bytes even with a global express.json() mounted", async () => {
    // The failure this catches: a perfect signature module behind a wrong
    // middleware order. `express.json()` consumes and discards the bytes, and a
    // route that can only re-serialize fails every delivery — after which the
    // tempting fix is to disable verification.
    const { app, inbox } = harness();

    // Whitespace and key order that JSON.stringify would not reproduce.
    const spaced = '{ "action" : "opened" ,  "number" : 412 }';
    const response = await post(app, {
      body: spaced,
      signature: signWebhookBody(SECRET, spaced),
    });

    expect(response.status).toBe(202);
    expect(inbox.deliveries.size).toBe(1);

    // The stored payload is byte-identical to what was sent.
    const [stored] = [...inbox.deliveries.values()];
    expect(stored?.payload.toString("utf8")).toBe(spaced);
  });

  it("the global JSON parser still works for other routes", async () => {
    // Proves the raw route did not break the rest of the application.
    const { app } = harness();
    const response = await request(app).get("/healthz");
    expect(response.status).toBe(200);
  });

  it("property: changing any byte after signing fails authentication", async () => {
    // Proves the middleware chain has not quietly turned "raw body" into
    // "equivalent JSON". Covers whitespace, unicode, key order, newlines and
    // arbitrary substitutions.
    const bodies = [
      '{"action":"opened"}',
      '{ "action": "opened" }',
      '{"action":"opened","emoji":"🚀"}',
      '{"action":"opened"}\n',
      '{"number":412,"action":"opened"}',
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...bodies),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 32, max: 126 }),
        async (body, position, replacement) => {
          const signature = signWebhookBody(SECRET, body);
          const index = position % body.length;
          const original = body.charCodeAt(index);
          if (original === replacement) return;

          const mutated =
            body.slice(0, index) +
            String.fromCharCode(replacement) +
            body.slice(index + 1);

          const { app } = harness();
          const response = await post(app, { body: mutated, signature });
          expect(response.status).toBe(401);
        },
      ),
      { numRuns: 60 },
    );
  }, 60_000);

  it("bounds the body before authenticating it", async () => {
    // Cheap to send, expensive to reject is what makes a public endpoint a DoS
    // target. The ceiling applies before the handler runs.
    // 25 MiB — at or just above GitHub's 25 MB cap whichever way they mean it,
    // so no legitimate delivery is refused.
    expect(MAX_BODY_BYTES).toBe(25 * 1024 * 1024);

    const { app, inbox } = harness();
    const huge = `{"x":"${"a".repeat(MAX_BODY_BYTES)}"}`;
    const response = await post(app, {
      body: huge,
      signature: signWebhookBody(SECRET, huge),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(inbox.ingestCalls).toBe(0);
  }, 60_000);
});

describe("Authenticate before any semantic processing", () => {
  it("never touches persistence for an unsigned request", async () => {
    const { app, inbox } = harness();
    const response = await post(app, { signature: "sha256=" + "0".repeat(64) });

    expect(response.status).toBe(401);
    expect(inbox.ingestCalls).toBe(0);
  });

  it("rejects a missing signature without persisting", async () => {
    const { app, inbox } = harness();
    const response = await post(app, { omit: ["x-hub-signature-256"] });

    expect(response.status).toBe(400);
    expect(inbox.ingestCalls).toBe(0);
  });

  it("rejects malformed transport headers before verification", async () => {
    const { app, inbox } = harness();
    for (const omit of ["x-github-delivery", "x-github-event"]) {
      const response = await post(app, { omit: [omit] });
      expect(response.status, omit).toBe(400);
    }
    expect(inbox.ingestCalls).toBe(0);
  });

  it("does not disclose why authentication failed", async () => {
    // Telling a caller "malformed signature" versus "mismatch" says how far
    // they got — free reconnaissance on the one endpoint anyone can reach.
    const { app, outcomes } = harness();

    const malformed = await post(app, { signature: "garbage" });
    const mismatch = await post(app, { signature: `sha256=${"0".repeat(64)}` });

    expect(malformed.body).toEqual({ error: "unauthorized" });
    expect(mismatch.body).toEqual({ error: "unauthorized" });
    expect(JSON.stringify(malformed.body)).not.toContain("malformed");
    expect(JSON.stringify(mismatch.body)).not.toContain("mismatch");

    // …while the observer, which feeds logs and metrics, gets the distinction.
    expect(outcomes).toEqual(["signature_rejected", "signature_rejected"]);
  });
});

describe("2xx means durably owned", () => {
  it("acknowledges only after the inbox has taken ownership", async () => {
    const { app, inbox } = harness();
    const response = await post(app);

    expect(response.status).toBe(202);
    expect(inbox.deliveries.size).toBe(1);
    expect(inbox.jobs).toHaveLength(1);
  });

  it("returns 503 — never 2xx — when persistence is unavailable", async () => {
    // GitHub does not automatically redeliver. Acknowledging work that was not
    // stored loses the event permanently, so the failure must be visible.
    const { app, inbox } = harness();
    inbox.failNext = true;

    const response = await post(app);

    expect(response.status).toBe(503);
    expect(inbox.deliveries.size).toBe(0);
  });

  it("treats a redelivery as owned, and answers 2xx", async () => {
    // A non-2xx would mark the hook as failing in the GitHub UI for something
    // that is the system working correctly.
    const { app, inbox } = harness();

    const first = await post(app);
    const second = await post(app);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ status: "duplicate" });
    expect(inbox.deliveries.size).toBe(1);
    expect(inbox.jobs).toHaveLength(1);
  });

  it("answers 409 when the same delivery id carries different bytes", async () => {
    // Not a duplicate. GitHub does not reuse ids, so this means something
    // rewrote the body — an anomaly worth surfacing, not discarding.
    const { app } = harness();
    await post(app);

    const altered = JSON.stringify({ action: "closed", number: 412 });
    const response = await post(app, {
      body: altered,
      signature: signWebhookBody(SECRET, altered),
    });

    expect(response.status).toBe(409);
  });

  it("property: N concurrent identical deliveries schedule one job", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 16 }), async (concurrency) => {
        const { app, inbox } = harness();
        const deliveryId = randomUUID();

        const responses = await Promise.all(
          Array.from({ length: concurrency }, () => post(app, { deliveryId })),
        );

        expect(inbox.deliveries.size).toBe(1);
        expect(inbox.jobs).toHaveLength(1);
        // Every caller observes an accepted outcome; none sees a 5xx.
        for (const response of responses) {
          expect(response.status).toBe(202);
        }
      }),
      { numRuns: 10 },
    );
  }, 60_000);
});

describe("Transport acceptance is not domain support", () => {
  it("records and acknowledges a signed but unsupported event", async () => {
    // GitHub's event vocabulary grows. A 4xx marks the hook as failing, and an
    // operator sees a broken integration where the platform is uninterested.
    const { app, inbox } = harness();
    const response = await post(app, { event: "star" });

    expect(response.status).toBe(202);
    expect(inbox.jobs).toHaveLength(0);

    const [stored] = [...inbox.deliveries.values()];
    expect(stored?.state).toBe("ignored");
    expect(stored?.outcomeReason).toContain("star");
  });

  it("records an unsupported action on a supported event", async () => {
    const { app, inbox } = harness();
    const body = JSON.stringify({ action: "labeled", number: 412 });
    const response = await post(app, {
      body,
      signature: signWebhookBody(SECRET, body),
    });

    expect(response.status).toBe(202);
    expect(inbox.jobs).toHaveLength(0);
    expect([...inbox.deliveries.values()][0]?.state).toBe("ignored");
  });

  it("schedules work for a supported action", async () => {
    const { app, inbox } = harness();
    await post(app);

    expect(inbox.jobs).toEqual([
      { kind: "github.pull_request", payload: { action: "opened" } },
    ]);
  });

  it("distinguishes ignored from processed, so 'did we act?' stays answerable", async () => {
    const { app, outcomes } = harness();
    await post(app, { event: "star" });
    await post(app, { deliveryId: randomUUID() });

    expect(outcomes).toEqual(["ignored", "accepted"]);
  });

  it("accepts a signed body that is not JSON, and ignores it", async () => {
    // Passing the HMAC and not being JSON means GitHub changed its encoding,
    // not that someone forged it. Recorded, not rejected.
    const { app, inbox } = harness();
    const body = "not json at all";
    const response = await post(app, {
      body,
      signature: signWebhookBody(SECRET, body),
    });

    expect(response.status).toBe(202);
    expect(inbox.jobs).toHaveLength(0);
  });
});

describe("The digest is over the authenticated bytes", () => {
  it("matches a digest computed from the raw body", async () => {
    // If the gateway digested a re-serialization, the conflict check would
    // compare something GitHub never sent and every redelivery would look like
    // an anomaly.
    const { app, inbox } = harness();
    const body = '{ "action": "opened",  "number": 412 }';
    await post(app, { body, signature: signWebhookBody(SECRET, body) });

    const [stored] = [...inbox.deliveries.values()];
    expect(stored?.bodyDigest).toBe(digestBody(Buffer.from(body, "utf8")));
  });
});
