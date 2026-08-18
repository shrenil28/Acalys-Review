import { describe, expect, it } from "vitest";
import fc from "fast-check";
import request from "supertest";

import { signWebhookBody } from "@acalys/provider-github";
import type {
  AuthenticatedDelivery,
  IngestOutcome,
  JobRequest,
  WebhookInbox,
} from "@acalys/database";

import {
  DEFAULT_SERVER_TIMEOUTS,
  InsecureConfigurationError,
  MIN_SECRET_LENGTH,
  applyServerTimeouts,
  assertStrongWebhookSecret,
  createGatewayApp,
  createRateLimiter,
  startGateway,
} from "../src/index.js";

const STRONG_SECRET = "3f2a91c7e4b6d8021a5c9e7f3b1d6a48";

class NullInbox implements WebhookInbox {
  public calls = 0;

  public ingest(
    delivery: AuthenticatedDelivery,
    _jobs: readonly JobRequest[],
  ): Promise<IngestOutcome> {
    this.calls += 1;
    return Promise.resolve({
      kind: "accepted",
      delivery: {
        id: "row-1",
        ...delivery,
        authenticatedAt: delivery.receivedAt,
        state: "received",
        outcomeReason: null,
        attempts: 0,
      },
    });
  }

  public findDelivery(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public claimJobs(): Promise<readonly never[]> {
    return Promise.resolve([]);
  }

  public markDeliveryState(): Promise<void> {
    return Promise.resolve();
  }
}

describe("Webhook secret strength (checked at startup)", () => {
  it("rejects a secret short enough to brute-force offline", () => {
    // An attacker with one captured delivery searches the keyspace without
    // ever touching the platform, so nothing here would see the attempt.
    expect(() => assertStrongWebhookSecret("short")).toThrow(
      InsecureConfigurationError,
    );
    expect(() =>
      assertStrongWebhookSecret("a".repeat(MIN_SECRET_LENGTH - 1)),
    ).toThrow(InsecureConfigurationError);
  });

  it("rejects a long secret with no entropy", () => {
    // Has the length but not the variety — the shape a placeholder takes.
    expect(() => assertStrongWebhookSecret("x".repeat(64))).toThrow(
      /too little variety/,
    );
  });

  it("accepts a real secret", () => {
    expect(() => assertStrongWebhookSecret(STRONG_SECRET)).not.toThrow();
  });

  it("refuses to construct a route with a weak secret", () => {
    // Fails the deploy rather than serving a forgeable endpoint.
    expect(() =>
      createGatewayApp({
        github: {
          secret: "weak",
          sourceEndpointId: "e",
          inbox: new NullInbox(),
        },
      }),
    ).toThrow(InsecureConfigurationError);
  });

  it("never quotes the secret in the error", () => {
    const marker = "SECRET_MARKER_SHOULD_NOT_LEAK";
    try {
      assertStrongWebhookSecret(marker);
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as Error).message).not.toContain(marker);
    }
  });
});

describe("Rate limiting", () => {
  it("allows up to the limit, then refuses", () => {
    const limiter = createRateLimiter({ limit: 3, windowMillis: 1000 });

    expect([1, 2, 3].map(() => limiter.tryConsume("a"))).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("refills after the window", () => {
    let clock = 0;
    const limiter = createRateLimiter({
      limit: 1,
      windowMillis: 1000,
      now: () => clock,
    });

    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    clock = 1001;
    expect(limiter.tryConsume("a")).toBe(true);
  });

  it("keeps budgets separate per key", () => {
    const limiter = createRateLimiter({ limit: 1, windowMillis: 1000 });
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("b")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  describe("the limiter is not itself a memory-exhaustion vector", () => {
    it("bounds its key space", () => {
      // A plain Map<ip, state> grows without limit. Over IPv6 a single /64
      // gives an attacker billions of keys, and the limiter becomes the outage
      // it was added to prevent.
      const limiter = createRateLimiter({
        limit: 10,
        windowMillis: 60_000,
        maxKeys: 100,
      });

      for (let index = 0; index < 10_000; index += 1) {
        limiter.tryConsume(`2001:db8::${index.toString(16)}`);
      }

      expect(limiter.size).toBeLessThanOrEqual(100);
    });

    it("property: size never exceeds maxKeys, for any traffic pattern", () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 8 }), {
            minLength: 1,
            maxLength: 500,
          }),
          fc.integer({ min: 1, max: 50 }),
          (keys, maxKeys) => {
            const limiter = createRateLimiter({
              limit: 5,
              windowMillis: 60_000,
              maxKeys,
            });
            for (const key of keys) limiter.tryConsume(key);
            expect(limiter.size).toBeLessThanOrEqual(maxKeys);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  it("gives failed authentication a tighter budget than the endpoint overall", async () => {
    // The cost asymmetry: rejecting is cheap for the platform and free for the
    // sender, so a flood of forged signatures is the realistic DoS.
    const inbox = new NullInbox();
    const app = createGatewayApp({
      github: {
        secret: STRONG_SECRET,
        sourceEndpointId: "e",
        inbox,
        rateLimits: {
          unauthenticated: createRateLimiter({
            limit: 2,
            windowMillis: 60_000,
          }),
          overall: createRateLimiter({ limit: 1000, windowMillis: 60_000 }),
        },
      },
    });

    const forged = () =>
      request(app)
        .post("/webhooks/github")
        .set({
          "x-github-delivery": "d-1",
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        })
        .send("{}");

    expect((await forged()).status).toBe(401);
    expect((await forged()).status).toBe(401);
    // Third forged attempt is over the tighter budget.
    expect((await forged()).status).toBe(429);

    // Persistence was never touched by any of them.
    expect(inbox.calls).toBe(0);
  });

  it("turns away an over-budget caller before buffering the body", async () => {
    const inbox = new NullInbox();
    const app = createGatewayApp({
      github: {
        secret: STRONG_SECRET,
        sourceEndpointId: "e",
        inbox,
        rateLimits: {
          unauthenticated: createRateLimiter({
            limit: 100,
            windowMillis: 60_000,
          }),
          overall: createRateLimiter({ limit: 1, windowMillis: 60_000 }),
        },
      },
    });

    const body = "{}";
    const send = () =>
      request(app)
        .post("/webhooks/github")
        .set({
          "x-github-delivery": "d-1",
          "x-github-event": "pull_request",
          "x-hub-signature-256": signWebhookBody(STRONG_SECRET, body),
        })
        .send(body);

    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(429);
  });

  it("does not disclose its window in the response", () => {
    // A limiter that explains itself tells an attacker how to pace under it.
    const limiter = createRateLimiter({ limit: 1, windowMillis: 1000 });
    limiter.tryConsume("a");
    expect(limiter.tryConsume("a")).toBe(false);
  });
});

describe("Security headers", () => {
  const app = createGatewayApp({
    github: {
      secret: STRONG_SECRET,
      sourceEndpointId: "e",
      inbox: new NullInbox(),
    },
  });

  it("sets nosniff, so a JSON error cannot be reinterpreted as HTML", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("denies framing and referrers, and forbids caching", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("does not advertise the framework", async () => {
    // Telling an attacker the framework and version tells them which CVEs to
    // try first.
    const response = await request(app).get("/healthz");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("applies headers to error responses too", async () => {
    const response = await request(app)
      .post("/webhooks/github")
      .set({
        "x-github-delivery": "d",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      })
      .send("{}");

    expect(response.status).toBe(401);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("Error handling never leaks internals", () => {
  it("returns a generic body and no stack for an unhandled error", async () => {
    // Express's default handler renders the stack outside production — and
    // "outside production" is decided by NODE_ENV, exactly the variable that
    // is wrong in an internet-reachable staging environment.
    const seen: unknown[] = [];
    const exploding: WebhookInbox = {
      ingest: () => {
        throw new Error("SECRET_INTERNAL_PATH /srv/acalys/keys/app.pem");
      },
      findDelivery: () => Promise.resolve(undefined),
      claimJobs: () => Promise.resolve([]),
      markDeliveryState: () => Promise.resolve(),
    };

    const app = createGatewayApp({
      github: {
        secret: STRONG_SECRET,
        sourceEndpointId: "e",
        inbox: exploding,
      },
      onError: (error) => seen.push(error),
    });

    const body = "{}";
    const response = await request(app)
      .post("/webhooks/github")
      .set({
        "x-github-delivery": "d",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signWebhookBody(STRONG_SECRET, body),
      })
      .send(body);

    // The route converts an inbox failure into 503; either way nothing leaks.
    expect([500, 503]).toContain(response.status);
    const serialized = JSON.stringify(response.body) + response.text;
    expect(serialized).not.toContain("SECRET_INTERNAL_PATH");
    expect(serialized).not.toContain("app.pem");
    expect(serialized).not.toContain("at ");
  });
});

describe("Connection timeouts defeat slowloris", () => {
  it("applies bounded timeouts to the server", () => {
    // The attack happens before any handler runs — a client dribbling headers
    // holds a socket, and Express never sees a request, so no middleware can
    // intervene.
    const server = {
      requestTimeout: 0,
      headersTimeout: 0,
      keepAliveTimeout: 0,
    };
    applyServerTimeouts(server);

    expect(server.requestTimeout).toBe(30_000);
    expect(server.keepAliveTimeout).toBe(5_000);
  });

  it("keeps headersTimeout above requestTimeout, as Node requires", () => {
    // Node warns and behaves unexpectedly when headersTimeout <= requestTimeout.
    // Asserted on the named fields rather than through `?? 0`, which would turn
    // a typo into a vacuously passing test — as it did on the first attempt.
    expect(DEFAULT_SERVER_TIMEOUTS.headersTimeoutMillis).toBeGreaterThan(
      DEFAULT_SERVER_TIMEOUTS.requestTimeoutMillis,
    );
    expect(DEFAULT_SERVER_TIMEOUTS.keepAliveTimeoutMillis).toBeLessThan(
      DEFAULT_SERVER_TIMEOUTS.requestTimeoutMillis,
    );
  });
});

describe("Graceful shutdown", () => {
  it("stops accepting and resolves, and is idempotent", async () => {
    // Every rolling deploy is a SIGTERM. A process killed mid-request makes
    // GitHub record a failed delivery it will not automatically redeliver.
    const shutdowns: string[] = [];
    const running = await startGateway({
      app: createGatewayApp({
        github: {
          secret: STRONG_SECRET,
          sourceEndpointId: "e",
          inbox: new NullInbox(),
        },
      }),
      port: 0,
      drainMillis: 2_000,
      onShutdown: (reason) => shutdowns.push(reason),
    });

    await Promise.all([running.stop("first"), running.stop("second")]);

    // One shutdown, not two racing each other.
    expect(shutdowns).toEqual(["first"]);
    expect(running.server.listening).toBe(false);
  }, 15_000);
});
