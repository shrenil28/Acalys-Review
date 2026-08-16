import { describe, expect, it } from "vitest";
import {
  API_ROUTES,
  ROUTE_NAMES,
  type RouteName,
} from "@acalys/contracts/api/v1";
import {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
  createAcalysClient,
  type Transport,
  type TransportRequest,
} from "../src/index.js";

/**
 * A transport that answers from a table instead of a network.
 *
 * This is what makes the client real code in Phase 0 rather than a placeholder
 * (§87): every route is exercised end to end — path building, query encoding,
 * request validation, status handling, response validation — with no server.
 */
function mockTransport(
  respond: (request: TransportRequest) => { status: number; body: unknown },
): { transport: Transport; requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: (request) => {
      requests.push(request);
      return Promise.resolve(respond(request));
    },
  };
}

const at = "2026-08-16T10:00:00.000Z";

const runDto = {
  id: "run-1",
  repositoryId: "repo-1",
  state: "queued",
  settled: false,
  createdAt: at,
};

const repositoryDto = {
  id: "repo-1",
  name: "acalys/acalys",
  provider: "github",
  visibility: "private",
  reviewsEnabled: true,
  updatedAt: at,
};

const findingDto = {
  id: "f-1",
  repositoryId: "repo-1",
  reviewRunId: "run-1",
  severity: "high",
  category: "security",
  confidence: "high",
  lifecycle: "published",
  title: "SQL injection",
  explanation: "…",
  path: "src/auth.ts",
  startLine: 82,
  endLine: 84,
  evidenceCount: 2,
  hasSuggestedFix: true,
  createdAt: at,
};

/**
 * A plausible success body for each route.
 *
 * Written by hand rather than generated, so the round-trip below is a real
 * check: a generated body would be produced *from* the schema it is then
 * validated against, and would pass for any schema.
 */
const RESPONSES: Readonly<Record<RouteName, unknown>> = {
  listRepositories: { items: [repositoryDto] },
  getRepository: repositoryDto,
  listPullRequests: { items: [] },
  createReview: runDto,
  getReview: runDto,
  cancelReview: { ...runDto, state: "cancelled", settled: true },
  getReviewSummary: {
    reviewRunId: "run-1",
    overview: "Adds session revocation.",
    changedAreas: [],
    riskAreas: [],
    findingCounts: {
      total: 1,
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    },
    generatedAt: at,
  },
  listReviewFindings: { items: [findingDto] },
  listReviewChecks: { items: [] },
  getFinding: findingDto,
  dismissFinding: { ...findingDto, lifecycle: "dismissed" },
  listConversations: { items: [] },
  resolveConversation: {
    id: "c-1",
    repositoryId: "repo-1",
    state: "resolved",
    messageCount: 3,
    createdAt: at,
    updatedAt: at,
  },
  listKnowledge: { items: [] },
};

/** Arguments each route needs to be callable. */
const CALLS: Readonly<Record<RouteName, Record<string, unknown>>> = {
  listRepositories: {},
  getRepository: { params: { id: "repo-1" } },
  listPullRequests: { params: { repositoryId: "repo-1" } },
  createReview: { body: { repositoryId: "repo-1" } },
  getReview: { params: { id: "run-1" } },
  cancelReview: { params: { id: "run-1" }, body: {} },
  getReviewSummary: { params: { id: "run-1" } },
  listReviewFindings: { params: { id: "run-1" } },
  listReviewChecks: { params: { id: "run-1" } },
  getFinding: { params: { id: "f-1" } },
  dismissFinding: { params: { id: "f-1" }, body: { reason: "Intentional." } },
  listConversations: { params: { repositoryId: "repo-1" } },
  resolveConversation: { params: { id: "c-1" } },
  listKnowledge: {},
};

describe("api-client round-trips every route", () => {
  it.each(ROUTE_NAMES)("%s", async (name) => {
    const route = API_ROUTES[name];
    const { transport, requests } = mockTransport(() => ({
      status: route.successStatus,
      body: RESPONSES[name],
    }));
    const client = createAcalysClient({ transport });

    await expect(client[name](CALLS[name])).resolves.toBeDefined();

    const sent = requests[0];
    expect(sent?.method).toBe(route.method);
    // Path parameters are substituted, so no `:` placeholder survives.
    expect(sent?.url.split("?")[0]).not.toContain(":");
    expect(sent?.url.startsWith("/api/v1/")).toBe(true);
  });

  it("exposes exactly the manifest's routes", () => {
    // Removing a route from the manifest removes the method here, which turns
    // a deleted endpoint into a compile error at every call site rather than a
    // 404 at runtime.
    const client = createAcalysClient({
      transport: mockTransport(() => ({ status: 200, body: {} })).transport,
    });
    for (const name of ROUTE_NAMES) {
      expect(typeof client[name]).toBe("function");
    }
  });
});

describe("Request handling", () => {
  it("sends a JSON body only when the route has one", async () => {
    const { transport, requests } = mockTransport((request) => ({
      status: request.method === "POST" ? 202 : 200,
      body: runDto,
    }));
    const client = createAcalysClient({ transport });

    await client.createReview({ body: { repositoryId: "repo-1" } });
    expect(requests[0]?.headers["content-type"]).toBe("application/json");

    await client.getReview({ params: { id: "run-1" } });
    expect(requests[1]?.body).toBeUndefined();
    expect(requests[1]?.headers["content-type"]).toBeUndefined();
  });

  it("validates the request before the wire", async () => {
    // A malformed request fails here with a field path, rather than as a 400
    // the caller has to decode.
    const { transport, requests } = mockTransport(() => ({
      status: 202,
      body: runDto,
    }));
    const client = createAcalysClient({ transport });

    await expect(
      client.createReview({ body: { repositoryId: "" } }),
    ).rejects.toBeInstanceOf(ApiResponseError);
    expect(requests).toHaveLength(0);
  });

  it("strips unknown request keys instead of rejecting them (§56)", async () => {
    // Forward compatibility: a client built against a newer build must not be
    // rejected by an older server.
    const { transport, requests } = mockTransport(() => ({
      status: 202,
      body: runDto,
    }));
    const client = createAcalysClient({ transport });

    await client.createReview({
      body: { repositoryId: "repo-1", futureField: "ignored" },
    });

    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      repositoryId: "repo-1",
    });
  });

  it("drops undefined query values rather than sending the string 'undefined'", async () => {
    const { transport, requests } = mockTransport(() => ({
      status: 200,
      body: { items: [findingDto] },
    }));
    const client = createAcalysClient({ transport });

    await client.listReviewFindings({
      params: { id: "run-1" },
      query: { severity: "high", category: undefined, limit: 10 },
    });

    expect(requests[0]?.url).toContain("severity=high");
    expect(requests[0]?.url).not.toContain("undefined");
    expect(requests[0]?.url).toContain("limit=10");
  });

  it("reads auth headers at request time, not at construction", async () => {
    // A static header object captures a token that then expires, and the
    // failure looks like an auth bug rather than a stale value.
    let token = "first";
    const { transport, requests } = mockTransport(() => ({
      status: 200,
      body: repositoryDto,
    }));
    const client = createAcalysClient({
      transport,
      headers: () => ({ authorization: `Bearer ${token}` }),
    });

    await client.getRepository({ params: { id: "repo-1" } });
    token = "second";
    await client.getRepository({ params: { id: "repo-1" } });

    expect(requests[0]?.headers["authorization"]).toBe("Bearer first");
    expect(requests[1]?.headers["authorization"]).toBe("Bearer second");
  });
});

describe("Failure handling distinguishes three kinds", () => {
  it("throws ApiRequestError when the server says no", async () => {
    const { transport } = mockTransport(() => ({
      status: 404,
      body: {
        code: "NOT_FOUND",
        message: "No such review",
        retryability: "non_retryable",
      },
    }));
    const client = createAcalysClient({ transport });

    const error = await client
      .getReview({ params: { id: "missing" } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(404);
    expect((error as ApiRequestError).error.code).toBe("NOT_FOUND");
    expect((error as ApiRequestError).retryable).toBe(false);
  });

  it("reports retryability, so a caller need not guess from the status", async () => {
    const { transport } = mockTransport(() => ({
      status: 503,
      body: {
        code: "PROVIDER_UNAVAILABLE",
        message: "GitHub is unavailable",
        retryability: "retryable",
      },
    }));
    const client = createAcalysClient({ transport });

    const error = (await client
      .getReview({ params: { id: "run-1" } })
      .catch((caught: unknown) => caught)) as ApiRequestError;

    expect(error.retryable).toBe(true);
  });

  it("synthesizes a non-retryable error for an unparseable failure body", async () => {
    // A proxy 502 returns HTML. The caller's handling stays uniform, and
    // `non_retryable` is the safe default for a failure nobody understands.
    const { transport } = mockTransport(() => ({
      status: 502,
      body: undefined,
    }));
    const client = createAcalysClient({ transport });

    const error = (await client
      .getReview({ params: { id: "run-1" } })
      .catch((caught: unknown) => caught)) as ApiRequestError;

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.error.code).toBe("UNKNOWN_ERROR");
    expect(error.retryable).toBe(false);
  });

  it("throws ApiResponseError when a 2xx body does not match the contract", async () => {
    // The one usually collapsed into a request error, and the one that must
    // not be: a schema mismatch means client and server disagree, and retrying
    // reproduces it forever while hiding a deploy skew.
    const { transport } = mockTransport(() => ({
      status: 200,
      body: { id: "run-1" },
    }));
    const client = createAcalysClient({ transport });

    const error = await client
      .getReview({ params: { id: "run-1" } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).issues.length).toBeGreaterThan(0);
    expect(
      (error as ApiResponseError).issues.map((issue) => issue.path),
    ).toContain("state");
  });

  it("treats an unexpected success status as a failure", async () => {
    // A 200 where the contract says 202 means the review was not queued —
    // rendering the response as a result would show an empty review as
    // finished.
    const { transport } = mockTransport(() => ({ status: 200, body: runDto }));
    const client = createAcalysClient({ transport });

    await expect(
      client.createReview({ body: { repositoryId: "repo-1" } }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });

  it("throws ApiTransportError when no answer arrives", async () => {
    const client = createAcalysClient({
      transport: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    const error = await client
      .getReview({ params: { id: "run-1" } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiTransportError);
    expect((error as ApiTransportError).cause).toBeInstanceOf(Error);
  });
});

describe("Progress stream", () => {
  it("hands back a URL rather than opening a subscription", () => {
    // `EventSource` exists in a browser and not in Node; a client that
    // constructed one would stop working in the environment its own tests run
    // in. The route stays in the manifest so the URL cannot drift.
    const client = createAcalysClient({
      transport: mockTransport(() => ({ status: 200, body: {} })).transport,
    });

    expect(client.reviewEventsUrl("run-1")).toBe(
      "/api/v1/reviews/run-1/events",
    );
  });
});
