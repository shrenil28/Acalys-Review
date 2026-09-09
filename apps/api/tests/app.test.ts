import { describe, expect, it } from "vitest";
import request from "supertest";

import type { AuthService } from "@acalys/auth";
import { API_ROUTES, errorResponseSchema } from "@acalys/contracts/api/v1";
import {
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ProviderError,
  RepositoryError,
  ReviewError,
  SandboxError,
  ToolExecutionError,
  UnauthorizedError,
  ValidationError,
} from "@acalys/contracts/domain";
import type { ApiMutationStore, ApiStore } from "@acalys/database";
import {
  createApiApp,
  type ApiRequestLogFields,
  type ApiRequestLogger,
} from "../src/app.js";

const ALL_SCOPES = [
  "repositories:read",
  "reviews:read",
  "reviews:write",
  "findings:read",
  "findings:write",
  "conversations:read",
  "conversations:write",
  "knowledge:read",
] as const;

interface AppFixtureOptions {
  readonly scopes?: readonly string[];
  readonly rateAllowed?: boolean;
  readonly api?: Partial<Record<keyof ApiStore, (...args: never[]) => unknown>>;
  readonly mutations?: Partial<
    Record<keyof ApiMutationStore, (...args: never[]) => unknown>
  >;
  readonly logger?: ApiRequestLogger;
  readonly heartbeatMillis?: number;
  readonly pollMillis?: number;
}

function appWith(input: AppFixtureOptions = {}) {
  const auth = {
    async authenticateBearer() {
      return {
        kind: "api_key",
        id: "key-1",
        organizationId: "org-1",
        role: "admin",
        scopes: new Set(input.scopes ?? ALL_SCOPES),
      };
    },
  } as unknown as AuthService;

  const api = new Proxy(
    {},
    {
      get(_target, property) {
        const override = input.api?.[property as keyof ApiStore];
        if (override !== undefined) return override;
        return async () => ({ malformed: true });
      },
    },
  ) as unknown as ApiStore;

  const mutations = new Proxy(
    {},
    {
      get(_target, property) {
        const override = input.mutations?.[property as keyof ApiMutationStore];
        if (override !== undefined) return override;
        return async () => ({
          kind: "result",
          status: property === "createReview" ? 202 : 200,
          body: { malformed: true },
        });
      },
    },
  ) as unknown as ApiMutationStore;

  return createApiApp({
    auth,
    api,
    mutations,
    consumeRate: async () => input.rateAllowed ?? true,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.heartbeatMillis === undefined
      ? {}
      : { heartbeatMillis: input.heartbeatMillis }),
    ...(input.pollMillis === undefined ? {} : { pollMillis: input.pollMillis }),
  });
}

const TOO_LONG_ID = "x".repeat(257);

const malformedRequests = [
  ["listRepositories", "get", "/api/v1/repositories?limit=0"],
  ["getRepository", "get", `/api/v1/repositories/${TOO_LONG_ID}`],
  [
    "listPullRequests",
    "get",
    `/api/v1/repositories/${TOO_LONG_ID}/pull-requests`,
  ],
  ["createReview", "post", "/api/v1/reviews", { repositoryId: "" }],
  ["getReview", "get", `/api/v1/reviews/${TOO_LONG_ID}`],
  ["cancelReview", "post", "/api/v1/reviews/review-1/cancel", { reason: "" }],
  ["getReviewSummary", "get", `/api/v1/reviews/${TOO_LONG_ID}/summary`],
  ["listReviewFindings", "get", "/api/v1/reviews/review-1/findings?limit=0"],
  ["listReviewChecks", "get", `/api/v1/reviews/${TOO_LONG_ID}/pre-merge-checks`],
  ["getFinding", "get", `/api/v1/findings/${TOO_LONG_ID}`],
  ["dismissFinding", "post", "/api/v1/findings/finding-1/dismiss", { reason: "" }],
  [
    "listConversations",
    "get",
    `/api/v1/repositories/${TOO_LONG_ID}/conversations`,
  ],
  ["resolveConversation", "post", `/api/v1/conversations/${TOO_LONG_ID}/resolve`],
  ["listKnowledge", "get", "/api/v1/knowledge?limit=0"],
] as const;

const successRequests = [
  ["listRepositories", "get", "/api/v1/repositories"],
  ["getRepository", "get", "/api/v1/repositories/repository-1"],
  ["listPullRequests", "get", "/api/v1/repositories/repository-1/pull-requests"],
  [
    "createReview",
    "post",
    "/api/v1/reviews",
    { repositoryId: "repository-1", pullRequestId: "pull-request-1" },
  ],
  ["getReview", "get", "/api/v1/reviews/review-1"],
  ["cancelReview", "post", "/api/v1/reviews/review-1/cancel", {}],
  ["getReviewSummary", "get", "/api/v1/reviews/review-1/summary"],
  ["listReviewFindings", "get", "/api/v1/reviews/review-1/findings"],
  ["listReviewChecks", "get", "/api/v1/reviews/review-1/pre-merge-checks"],
  ["getFinding", "get", "/api/v1/findings/finding-1"],
  [
    "dismissFinding",
    "post",
    "/api/v1/findings/finding-1/dismiss",
    { reason: "not actionable" },
  ],
  ["listConversations", "get", "/api/v1/repositories/repository-1/conversations"],
  ["resolveConversation", "post", "/api/v1/conversations/conversation-1/resolve"],
  ["listKnowledge", "get", "/api/v1/knowledge"],
] as const;

async function send(
  app: ReturnType<typeof appWith>,
  method: string,
  path: string,
  body?: unknown,
) {
  const agent = request(app);
  let call = method === "post" ? agent.post(path) : agent.get(path);
  call = call.set("authorization", "Bearer test");
  if (method === "post") call = call.set("idempotency-key", "phase3-test-key");
  if (body !== undefined) call = call.send(body);
  return call;
}

describe("API v1 boundary", () => {
  it("implements the frozen fourteen-route manifest", () => {
    expect(Object.keys(API_ROUTES)).toHaveLength(14);
  });

  it.each(malformedRequests)(
    "rejects malformed input before the %s handler",
    async (_name, method, path, body) => {
      let calls = 0;
      const counting = async () => {
        calls += 1;
        return { malformed: true };
      };
      const api = Object.fromEntries(
        [
          "listRepositories",
          "getRepository",
          "listPullRequests",
          "getReview",
          "getReviewSummary",
          "listReviewFindings",
          "listReviewChecks",
          "getFinding",
          "listConversations",
          "listKnowledge",
        ].map((name) => [name, counting]),
      ) as AppFixtureOptions["api"];
      const mutations = Object.fromEntries(
        ["createReview", "cancelReview", "dismissFinding", "resolveConversation"].map(
          (name) => [name, counting],
        ),
      ) as AppFixtureOptions["mutations"];
      const response = await send(appWith({ api, mutations }), method, path, body);
      expect(response.status).toBe(400);
      expect(calls).toBe(0);
    },
  );

  it.each(successRequests)(
    "refuses a malformed successful response from %s",
    async (_name, method, path, body) => {
      const response = await send(appWith(), method, path, body);
      expect(response.status).toBe(500);
      expect(response.body.code).toBe("INTERNAL_ERROR");
    },
  );

  it("enforces route scope before the tenant query", async () => {
    let called = false;
    const response = await request(
      appWith({
        scopes: [],
        api: {
          getRepository: async () => {
            called = true;
            return undefined;
          },
        },
      }),
    )
      .get("/api/v1/repositories/repository-1")
      .set("authorization", "Bearer test");
    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  it("records structured correlation-linked request metadata without payloads", async () => {
    const logs: ApiRequestLogFields[] = [];
    const response = await request(
      appWith({
        api: { listRepositories: async () => ({ items: [] }) },
        logger: { info(_event, fields) { logs.push(fields); } },
      }),
    )
      .get("/api/v1/repositories")
      .set("authorization", "Bearer test")
      .set("x-correlation-id", "trace-123");

    expect(response.status).toBe(200);
    expect(response.header["x-correlation-id"]).toBe("trace-123");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      correlationId: "trace-123",
      method: "GET",
      routeName: "listRepositories",
      status: 200,
      outcome: "completed",
      organizationId: "org-1",
      principalId: "key-1",
      principalKind: "api_key",
    });
    expect(JSON.stringify(logs[0])).not.toContain("authorization");
  });

  it("schema-validates handler error bodies before serialization", async () => {
    const response = await request(
      appWith({
        mutations: {
          cancelReview: async () => ({
            kind: "result",
            status: 409,
            body: { code: "CONFLICT", message: "missing retryability" },
          }),
        },
      }),
    )
      .post("/api/v1/reviews/review-1/cancel")
      .set("authorization", "Bearer test")
      .set("idempotency-key", "phase3-error-schema");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: "INTERNAL_ERROR",
      message: "The request could not be completed",
      retryability: "non_retryable",
    });
    expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
  });

  it("returns schema-valid JSON for malformed JSON, oversized bodies, and unknown v1 routes", async () => {
    const app = appWith();

    const malformed = await request(app)
      .post("/api/v1/reviews")
      .set("authorization", "Bearer test")
      .set("content-type", "application/json")
      .send('{"secret":"do-not-reflect"');
    const oversized = await request(app)
      .post("/api/v1/reviews")
      .set("authorization", "Bearer test")
      .set("content-type", "application/json")
      .send(JSON.stringify({ secret: `do-not-reflect-${"x".repeat(1_100_000)}` }));
    const unknown = await request(app)
      .get("/api/v1/not-a-route")
      .set("authorization", "Bearer test");

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(unknown.status).toBe(404);
    for (const response of [malformed, oversized, unknown]) {
      expect(response.header["content-type"]).toContain("application/json");
      expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
      expect(response.text).not.toContain("do-not-reflect");
      expect(response.text).not.toContain("SyntaxError");
      expect(response.text).not.toContain("<html");
    }
  });

  it.each([
    [new ValidationError("secret-validation-payload"), 400, "VALIDATION_ERROR", "non_retryable"],
    [new NotFoundError("secret-row-id"), 404, "NOT_FOUND", "non_retryable"],
    [new ConflictError("secret-conflict-state"), 409, "CONFLICT", "non_retryable"],
    [new UnauthorizedError("secret-auth-detail"), 401, "UNAUTHORIZED", "non_retryable"],
    [new ForbiddenError("secret-scope-detail"), 403, "FORBIDDEN", "non_retryable"],
    [new ProviderError("secret-upstream-body", { retryable: true }), 500, "PROVIDER_ERROR", "conditional"],
    [new RepositoryError("secret-repository-path", { retryable: true }), 500, "REPOSITORY_ERROR", "conditional"],
    [new SandboxError("secret-sandbox-output", { retryable: false }), 500, "SANDBOX_ERROR", "conditional"],
    [new ToolExecutionError("secret-tool-output", { retryable: true }), 500, "TOOL_EXECUTION_ERROR", "conditional"],
    [new ReviewError("secret-model-output", { retryable: false }), 500, "REVIEW_ERROR", "conditional"],
    [new ConfigurationError("secret-config-value"), 500, "CONFIGURATION_ERROR", "non_retryable"],
    [new InternalError("secret-stack-context"), 500, "INTERNAL_ERROR", "non_retryable"],
  ])(
    "projects %s through the leak-free public taxonomy",
    async (error, status, code, retryability) => {
      const response = await request(
        appWith({ api: { getRepository: async () => { throw error; } } }),
      )
        .get("/api/v1/repositories/repository-1")
        .set("authorization", "Bearer test");

      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
      expect(response.body.retryability).toBe(retryability);
      expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
      expect(response.text).not.toContain("secret-");
    },
  );

  it("does not let native or hostile thrown values disclose their contents", async () => {
    const native = await request(
      appWith({
        api: {
          getRepository: async () => {
            throw new Error("postgres://user:secret-native@db/private");
          },
        },
      }),
    )
      .get("/api/v1/repositories/repository-1")
      .set("authorization", "Bearer test");

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("secret-hostile-getter");
        },
      },
    );
    const hostileResponse = await request(
      appWith({ api: { getRepository: async () => { throw hostile; } } }),
    )
      .get("/api/v1/repositories/repository-1")
      .set("authorization", "Bearer test");

    for (const response of [native, hostileResponse]) {
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        retryability: "non_retryable",
      });
      expect(response.text).not.toContain("secret-");
      expect(response.text).not.toContain("postgres://");
    }
  });

  it("logs malformed JSON and unknown API routes without reflecting request bodies", async () => {
    const logs: ApiRequestLogFields[] = [];
    const app = appWith({ logger: { info(_event, fields) { logs.push(fields); } } });

    const malformed = await request(app)
      .post("/api/v1/reviews")
      .set("authorization", "Bearer test")
      .set("content-type", "application/json")
      .send('{"secret":"do-not-log"');
    const unknown = await request(app)
      .get("/api/v1/not-a-route")
      .set("authorization", "Bearer test");

    expect(malformed.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(logs).toHaveLength(2);
    expect(logs.every((entry) => entry.routeName === "unknown")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("do-not-log");
  });

  it("replaces an oversized caller correlation id instead of reflecting it", async () => {
    const supplied = "c".repeat(257);
    const response = await request(
      appWith({ api: { listRepositories: async () => ({ items: [] }) } }),
    )
      .get("/api/v1/repositories")
      .set("authorization", "Bearer test")
      .set("x-correlation-id", supplied);

    expect(response.status).toBe(200);
    expect(response.header["x-correlation-id"]).not.toBe(supplied);
    expect(response.header["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe("review progress SSE", () => {
  it("applies the normal rate-limit mapping before opening the stream", async () => {
    let called = false;
    const response = await request(
      appWith({
        rateAllowed: false,
        api: { reviewEvents: async () => { called = true; return []; } },
      }),
    )
      .get("/api/v1/reviews/review-1/events")
      .set("authorization", "Bearer test");

    expect(response.status).toBe(429);
    expect(response.body.code).toBe("RATE_LIMITED");
    expect(called).toBe(false);
  });

  it("validates stream params and Last-Event-ID before the tenant event query", async () => {
    let called = false;
    const app = appWith({
      api: { reviewEvents: async () => { called = true; return []; } },
    });

    const invalidId = await request(app)
      .get(`/api/v1/reviews/${TOO_LONG_ID}/events`)
      .set("authorization", "Bearer test");
    const invalidResume = await request(app)
      .get("/api/v1/reviews/review-1/events")
      .set("authorization", "Bearer test")
      .set("last-event-id", "not-an-integer");

    expect(invalidId.status).toBe(400);
    expect(invalidResume.status).toBe(400);
    expect(called).toBe(false);
  });

  it("resumes strictly after Last-Event-ID and closes on a terminal durable transition", async () => {
    const after: number[] = [];
    const response = await request(
      appWith({
        api: {
          reviewEvents: async (_scope, _id, afterSeq) => {
            after.push(afterSeq as number);
            return [
              {
                id: 6,
                event: "review.state_changed",
                data: {
                  to: "completed",
                  at: "2026-09-09T02:00:00.000Z",
                },
              },
            ];
          },
        },
      }),
    )
      .get("/api/v1/reviews/review-1/events")
      .set("authorization", "Bearer test")
      .set("last-event-id", "5");

    expect(response.status).toBe(200);
    expect(response.header["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain("id: 6\n");
    expect(response.text).toContain("event: review.done\n");
    expect(response.text).not.toContain("id: 5\n");
    expect(after).toEqual([5]);
  });

  it("writes heartbeats without product state and then resumes polling", async () => {
    let calls = 0;
    const response = await request(
      appWith({
        heartbeatMillis: 0,
        pollMillis: 1,
        api: {
          reviewEvents: async () => {
            calls += 1;
            if (calls === 1) return [];
            return [
              {
                id: 1,
                event: "review.state_changed",
                data: { to: "completed", at: "2026-09-09T02:00:00.000Z" },
              },
            ];
          },
        },
      }),
    )
      .get("/api/v1/reviews/review-1/events")
      .set("authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.text).toContain(": heartbeat\n\n");
    expect(response.text.indexOf(": heartbeat\n\n")).toBeLessThan(
      response.text.indexOf("event: review.done\n"),
    );
    expect(response.text.split(": heartbeat\n\n")[0]).not.toContain("state");
    expect(calls).toBe(2);
  });
});
