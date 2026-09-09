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
  readonly scopes?: readonly string[] | undefined;
  readonly organizationId?: string | undefined;
  readonly cursorSecrets?: readonly string[] | undefined;
  readonly rateAllowed?: boolean | undefined;
  readonly api?:
    Partial<Record<keyof ApiStore, (...args: never[]) => unknown>> | undefined;
  readonly mutations?:
    | Partial<Record<keyof ApiMutationStore, (...args: never[]) => unknown>>
    | undefined;
  readonly logger?: ApiRequestLogger | undefined;
  readonly heartbeatMillis?: number | undefined;
  readonly pollMillis?: number | undefined;
  readonly monotonicNow?: (() => number) | undefined;
}

function appWith(input: AppFixtureOptions = {}) {
  const auth = {
    async authenticateBearer() {
      return {
        kind: "api_key",
        id: "key-1",
        organizationId: input.organizationId ?? "org-1",
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
    cursorSecrets: input.cursorSecrets ?? [
      "phase3-test-pagination-secret-000000000000000000000000",
    ],
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.heartbeatMillis === undefined
      ? {}
      : { heartbeatMillis: input.heartbeatMillis }),
    ...(input.pollMillis === undefined ? {} : { pollMillis: input.pollMillis }),
    ...(input.monotonicNow === undefined
      ? {}
      : { monotonicNow: input.monotonicNow }),
  });
}

const TOO_LONG_ID = "x".repeat(257);

const PAGINATION_CURSOR_UUID = "018f4b20-7c00-7abc-8def-1234567890ab";

/**
 * One shape for every row, so `it.each` can type a single callback.
 * `as const` over rows of mixed arity produces a union vitest cannot unify.
 */
type RouteCase = readonly [
  name: string,
  method: "get" | "post",
  path: string,
  body?: string | object,
];

const malformedRequests: readonly RouteCase[] = [
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
  [
    "listReviewChecks",
    "get",
    `/api/v1/reviews/${TOO_LONG_ID}/pre-merge-checks`,
  ],
  ["getFinding", "get", `/api/v1/findings/${TOO_LONG_ID}`],
  [
    "dismissFinding",
    "post",
    "/api/v1/findings/finding-1/dismiss",
    { reason: "" },
  ],
  [
    "listConversations",
    "get",
    `/api/v1/repositories/${TOO_LONG_ID}/conversations`,
  ],
  [
    "resolveConversation",
    "post",
    `/api/v1/conversations/${TOO_LONG_ID}/resolve`,
  ],
  ["listKnowledge", "get", "/api/v1/knowledge?limit=0"],
];

const successRequests: readonly RouteCase[] = [
  ["listRepositories", "get", "/api/v1/repositories"],
  ["getRepository", "get", "/api/v1/repositories/repository-1"],
  [
    "listPullRequests",
    "get",
    "/api/v1/repositories/repository-1/pull-requests",
  ],
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
  [
    "listConversations",
    "get",
    "/api/v1/repositories/repository-1/conversations",
  ],
  [
    "resolveConversation",
    "post",
    "/api/v1/conversations/conversation-1/resolve",
  ],
  ["listKnowledge", "get", "/api/v1/knowledge"],
];

/**
 * Accepts the widened row element types and narrows here.
 *
 * `it.each` types each callback parameter as the union of every column, so a
 * row's `path` arrives as `string | object | undefined` however the tuple is
 * declared. Narrowing once, at this boundary, keeps every call site free of
 * per-argument assertions.
 */
async function send(
  app: ReturnType<typeof appWith>,
  method: unknown,
  path: unknown,
  body?: unknown,
) {
  if (typeof path !== "string") {
    throw new TypeError(
      `route case path must be a string, received ${typeof path}`,
    );
  }
  const agent = request(app);
  let call = method === "post" ? agent.post(path) : agent.get(path);
  call = call.set("authorization", "Bearer test");
  if (method === "post") call = call.set("idempotency-key", "phase3-test-key");
  if (typeof body === "string" || (typeof body === "object" && body !== null)) {
    call = call.send(body);
  }
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
        [
          "createReview",
          "cancelReview",
          "dismissFinding",
          "resolveConversation",
        ].map((name) => [name, counting]),
      ) as AppFixtureOptions["mutations"];
      const response = await send(
        appWith({ api, mutations }),
        method,
        path,
        body,
      );
      expect(response.status).toBe(400);
      expect(calls).toBe(0);
    },
  );

  it.each([
    ["listRepositories", "/api/v1/repositories?limit=10&limit=20"],
    [
      "listPullRequests",
      "/api/v1/repositories/repository-1/pull-requests?limit=10&limit=20",
    ],
    [
      "listReviewFindings",
      "/api/v1/reviews/review-1/findings?limit=10&limit=20",
    ],
    [
      "listConversations",
      "/api/v1/repositories/repository-1/conversations?limit=10&limit=20",
    ],
    ["listKnowledge", "/api/v1/knowledge?limit=10&limit=20"],
  ] as const)(
    "rejects duplicate scalar query values before the %s handler",
    async (name, path) => {
      let calls = 0;
      const response = await request(
        appWith({
          api: {
            [name]: async () => {
              calls += 1;
              return { items: [] };
            },
          },
        }),
      )
        .get(path)
        .set("authorization", "Bearer test");

      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(response.body.fields).toEqual([
        {
          path: "limit",
          message:
            "Query parameter must appear exactly once as a scalar string",
        },
      ]);
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

  it("emits an opaque repository cursor and round-trips it to the persistence cursor", async () => {
    const first = await request(
      appWith({
        api: {
          listRepositories: async () => ({
            items: [],
            nextCursor: PAGINATION_CURSOR_UUID,
          }),
        },
      }),
    )
      .get("/api/v1/repositories")
      .set("authorization", "Bearer test");
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toMatch(/^c1\.[A-Za-z0-9_-]+$/u);
    expect(first.body.nextCursor).not.toContain(PAGINATION_CURSOR_UUID);

    let received: unknown;
    const second = await request(
      appWith({
        api: {
          listRepositories: async (
            _scope: unknown,
            _limit: unknown,
            cursor: unknown,
          ) => {
            received = cursor;
            return { items: [] };
          },
        } as unknown as AppFixtureOptions["api"],
      }),
    )
      .get(
        `/api/v1/repositories?cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
      )
      .set("authorization", "Bearer test");
    expect(second.status).toBe(200);
    expect(received).toBe(PAGINATION_CURSOR_UUID);
  });

  it("rejects raw or tampered cursors before the tenant query", async () => {
    let calls = 0;
    const api = {
      listRepositories: async () => {
        calls += 1;
        return { items: [] };
      },
    };
    const raw = await request(appWith({ api }))
      .get(`/api/v1/repositories?cursor=${PAGINATION_CURSOR_UUID}`)
      .set("authorization", "Bearer test");
    expect(raw.status).toBe(400);
    expect(raw.body.code).toBe("VALIDATION_ERROR");
    expect(calls).toBe(0);

    const issued = await request(
      appWith({
        api: {
          listRepositories: async () => ({
            items: [],
            nextCursor: PAGINATION_CURSOR_UUID,
          }),
        },
      }),
    )
      .get("/api/v1/repositories")
      .set("authorization", "Bearer test");
    const cursor = issued.body.nextCursor as string;
    const last = cursor.at(-1)!;
    const tampered = `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    const bad = await request(appWith({ api }))
      .get(`/api/v1/repositories?cursor=${encodeURIComponent(tampered)}`)
      .set("authorization", "Bearer test");
    expect(bad.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("rejects cursor replay across organizations, collections, and parent resources", async () => {
    const issued = await request(
      appWith({
        api: {
          listRepositories: async () => ({
            items: [],
            nextCursor: PAGINATION_CURSOR_UUID,
          }),
        },
      }),
    )
      .get("/api/v1/repositories")
      .set("authorization", "Bearer test");
    const cursor = issued.body.nextCursor as string;

    let foreignCalls = 0;
    const foreign = await request(
      appWith({
        organizationId: "org-2",
        api: {
          listRepositories: async () => {
            foreignCalls += 1;
            return { items: [] };
          },
        },
      }),
    )
      .get(`/api/v1/repositories?cursor=${encodeURIComponent(cursor)}`)
      .set("authorization", "Bearer test");
    expect(foreign.status).toBe(400);
    expect(foreignCalls).toBe(0);

    let knowledgeCalls = 0;
    const crossCollection = await request(
      appWith({
        api: {
          listKnowledge: async () => {
            knowledgeCalls += 1;
            return { items: [] };
          },
        },
      }),
    )
      .get(`/api/v1/knowledge?cursor=${encodeURIComponent(cursor)}`)
      .set("authorization", "Bearer test");
    expect(crossCollection.status).toBe(400);
    expect(knowledgeCalls).toBe(0);

    const pullRequests = await request(
      appWith({
        api: {
          listPullRequests: async () => ({
            items: [],
            nextCursor: PAGINATION_CURSOR_UUID,
          }),
        },
      }),
    )
      .get("/api/v1/repositories/repository-a/pull-requests")
      .set("authorization", "Bearer test");
    let parentCalls = 0;
    const wrongParent = await request(
      appWith({
        api: {
          listPullRequests: async () => {
            parentCalls += 1;
            return { items: [] };
          },
        },
      }),
    )
      .get(
        `/api/v1/repositories/repository-b/pull-requests?cursor=${encodeURIComponent(pullRequests.body.nextCursor as string)}`,
      )
      .set("authorization", "Bearer test");
    expect(wrongParent.status).toBe(400);
    expect(parentCalls).toBe(0);
  });

  it("rejects a findings cursor when the filter set changes", async () => {
    const issued = await request(
      appWith({
        api: {
          listReviewFindings: async () => ({
            items: [],
            nextCursor: PAGINATION_CURSOR_UUID,
          }),
        },
      }),
    )
      .get("/api/v1/reviews/review-a/findings?severity=high&state=published")
      .set("authorization", "Bearer test");
    let calls = 0;
    const response = await request(
      appWith({
        api: {
          listReviewFindings: async () => {
            calls += 1;
            return { items: [] };
          },
        },
      }),
    )
      .get(
        `/api/v1/reviews/review-a/findings?severity=low&state=published&cursor=${encodeURIComponent(issued.body.nextCursor as string)}`,
      )
      .set("authorization", "Bearer test");
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

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
        logger: {
          info(_event, fields) {
            logs.push(fields);
          },
        },
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

  it("preserves the boundary-owned idempotency-key error outside route-declared handler statuses", async () => {
    const response = await request(appWith())
      .post("/api/v1/reviews/review-1/cancel")
      .set("authorization", "Bearer test");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "A valid Idempotency-Key header is required",
      retryability: "non_retryable",
    });
  });

  it("serializes a schema-valid handler error only when its status is declared by the route", async () => {
    const response = await request(
      appWith({
        mutations: {
          cancelReview: async () => ({
            kind: "result",
            status: 409,
            body: {
              code: "CONFLICT",
              message: "Review already settled",
              retryability: "non_retryable",
            },
          }),
        },
      }),
    )
      .post("/api/v1/reviews/review-1/cancel")
      .set("authorization", "Bearer test")
      .set("idempotency-key", "phase3-declared-error-status");

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "CONFLICT" });
  });

  it.each([
    [
      "createReview",
      "/api/v1/reviews",
      { repositoryId: "repository-1", pullRequestId: "pull-request-1" },
    ],
    ["cancelReview", "/api/v1/reviews/review-1/cancel", {}],
    [
      "dismissFinding",
      "/api/v1/findings/finding-1/dismiss",
      { reason: "not actionable" },
    ],
    [
      "resolveConversation",
      "/api/v1/conversations/conversation-1/resolve",
      undefined,
    ],
  ] as const)(
    "rejects an undeclared schema-valid error status from %s",
    async (mutationName, path, body) => {
      const mutations = {
        [mutationName]: async () => ({
          kind: "result" as const,
          status: 418,
          body: {
            code: "CONFLICT",
            message: "undeclared-status-secret-marker",
            retryability: "non_retryable" as const,
          },
        }),
      } as AppFixtureOptions["mutations"];
      const agent = request(appWith({ mutations }))
        .post(path)
        .set("authorization", "Bearer test")
        .set("idempotency-key", `phase3-undeclared-${mutationName}`);
      const response =
        body === undefined ? await agent : await agent.send(body);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        retryability: "non_retryable",
      });
      expect(response.text).not.toContain("undeclared-status-secret-marker");
    },
  );

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
      .send(
        JSON.stringify({ secret: `do-not-reflect-${"x".repeat(1_100_000)}` }),
      );
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
    [
      new ValidationError("secret-validation-payload"),
      400,
      "VALIDATION_ERROR",
      "non_retryable",
    ],
    [new NotFoundError("secret-row-id"), 404, "NOT_FOUND", "non_retryable"],
    [
      new ConflictError("secret-conflict-state"),
      409,
      "CONFLICT",
      "non_retryable",
    ],
    [
      new UnauthorizedError("secret-auth-detail"),
      401,
      "UNAUTHORIZED",
      "non_retryable",
    ],
    [
      new ForbiddenError("secret-scope-detail"),
      403,
      "FORBIDDEN",
      "non_retryable",
    ],
    [
      new ProviderError("secret-upstream-body", { retryable: true }),
      500,
      "PROVIDER_ERROR",
      "conditional",
    ],
    [
      new RepositoryError("secret-repository-path", { retryable: true }),
      500,
      "REPOSITORY_ERROR",
      "conditional",
    ],
    [
      new SandboxError("secret-sandbox-output", { retryable: false }),
      500,
      "SANDBOX_ERROR",
      "conditional",
    ],
    [
      new ToolExecutionError("secret-tool-output", { retryable: true }),
      500,
      "TOOL_EXECUTION_ERROR",
      "conditional",
    ],
    [
      new ReviewError("secret-model-output", { retryable: false }),
      500,
      "REVIEW_ERROR",
      "conditional",
    ],
    [
      new ConfigurationError("secret-config-value"),
      500,
      "CONFIGURATION_ERROR",
      "non_retryable",
    ],
    [
      new InternalError("secret-stack-context"),
      500,
      "INTERNAL_ERROR",
      "non_retryable",
    ],
  ])(
    "projects %s through the leak-free public taxonomy",
    async (error, status, code, retryability) => {
      const response = await request(
        appWith({
          api: {
            getRepository: async () => {
              throw error;
            },
          },
        }),
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
      appWith({
        api: {
          getRepository: async () => {
            throw hostile;
          },
        },
      }),
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
    const app = appWith({
      logger: {
        info(_event, fields) {
          logs.push(fields);
        },
      },
    });

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

  it("refuses an unusable continuation cursor from the non-pageable pre-merge-check route", async () => {
    const rawPersistenceCursor = "018f4b20-7c00-7abc-8def-deadbeef0001";
    const response = await request(
      appWith({
        api: {
          listReviewChecks: async () => ({
            items: [],
            nextCursor: rawPersistenceCursor,
          }),
        },
      }),
    )
      .get("/api/v1/reviews/review-1/pre-merge-checks")
      .set("authorization", "Bearer test");

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("INTERNAL_ERROR");
    expect(response.text).not.toContain(rawPersistenceCursor);
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
        api: {
          reviewEvents: async () => {
            called = true;
            return [];
          },
        },
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
      api: {
        reviewEvents: async () => {
          called = true;
          return [];
        },
      },
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
            after.push(afterSeq);
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
        heartbeatMillis: 1,
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

  it("keeps sending bounded heartbeats while a database event poll is still pending", async () => {
    let calls = 0;
    const response = await request(
      appWith({
        heartbeatMillis: 5,
        pollMillis: 1,
        api: {
          reviewEvents: async () => {
            calls += 1;
            if (calls === 1) return [];
            await new Promise((resolve) => setTimeout(resolve, 30));
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
    const doneAt = response.text.indexOf("event: review.done\n");
    const heartbeatAt = response.text.indexOf(": heartbeat\n\n");
    expect(heartbeatAt).toBeGreaterThanOrEqual(0);
    expect(heartbeatAt).toBeLessThan(doneAt);
    expect(
      response.text.match(/: heartbeat\n\n/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(2);
  });

  it("uses a monotonic idle clock and bounds invalid SSE timing configuration", async () => {
    expect(() => appWith({ heartbeatMillis: 0 })).toThrow(/heartbeatMillis/u);
    expect(() => appWith({ heartbeatMillis: 60_001 })).toThrow(
      /heartbeatMillis/u,
    );
    expect(() => appWith({ pollMillis: 0 })).toThrow(/pollMillis/u);

    let monotonic = 100;
    let calls = 0;
    const response = await request(
      appWith({
        heartbeatMillis: 2,
        pollMillis: 1,
        // Simulate a source that briefly moves backwards. The scheduler clamps
        // the wait to one full interval instead of allowing an unbounded gap.
        monotonicNow: () => {
          monotonic -= 1;
          return monotonic;
        },
        api: {
          reviewEvents: async () => {
            calls += 1;
            if (calls === 1) return [];
            await new Promise((resolve) => setTimeout(resolve, 8));
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
    expect(response.text).toContain("event: review.done\n");
  });
});
