import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  API_ROUTES,
  REVIEW_EVENTS_STREAM,
  ROUTE_NAMES,
  buildPath,
  conversationDtoSchema,
  findingDtoSchema,
  knowledgeItemDtoSchema,
  preMergeCheckDtoSchema,
  pullRequestSummaryDtoSchema,
  repositoryDtoSchema,
  reviewProgressEventSchema,
  reviewRunDtoSchema,
  reviewSummaryDtoSchema,
  routeUrl,
} from "../../src/api/v1/index.js";

/**
 * Every schema in the public layer, walked field by field.
 *
 * The list is explicit rather than derived from the module's exports: a
 * derived list would silently shrink if an export were renamed, and the test
 * would keep passing while checking less.
 */
const PUBLIC_SCHEMAS: readonly (readonly [string, z.ZodType])[] = [
  ["RepositoryDto", repositoryDtoSchema],
  ["PullRequestSummaryDto", pullRequestSummaryDtoSchema],
  ["ReviewRunDto", reviewRunDtoSchema],
  ["ReviewSummaryDto", reviewSummaryDtoSchema],
  ["FindingDto", findingDtoSchema],
  ["ConversationDto", conversationDtoSchema],
  ["PreMergeCheckDto", preMergeCheckDtoSchema],
  ["KnowledgeItemDto", knowledgeItemDtoSchema],
  ["ReviewProgressEvent", reviewProgressEventSchema],
];

/**
 * Collects every key name reachable in a schema, at any depth.
 *
 * Reads Zod's internal `def` rather than inferring from a sample value,
 * because a sample only exercises the branches it happens to populate — an
 * optional field carrying an internal name would never appear in one.
 */
function collectKeys(schema: unknown, seen = new Set<unknown>()): Set<string> {
  const keys = new Set<string>();
  if (schema === null || typeof schema !== "object") return keys;
  if (seen.has(schema)) return keys;
  seen.add(schema);

  const def = (schema as { readonly _zod?: { readonly def?: unknown } })._zod
    ?.def;
  if (def === undefined || def === null || typeof def !== "object") return keys;

  const record = def as Record<string, unknown>;

  const shape = record["shape"];
  if (shape !== undefined && shape !== null && typeof shape === "object") {
    for (const [key, child] of Object.entries(shape)) {
      keys.add(key);
      for (const nested of collectKeys(child, seen)) keys.add(nested);
    }
  }

  // Wrappers and containers: optional, array, union, record, pipe.
  for (const field of [
    "innerType",
    "element",
    "valueType",
    "keyType",
    "in",
    "out",
  ]) {
    const child = record[field];
    if (child !== undefined) {
      for (const nested of collectKeys(child, seen)) keys.add(nested);
    }
  }
  const options = record["options"];
  if (Array.isArray(options)) {
    for (const option of options) {
      for (const nested of collectKeys(option, seen)) keys.add(nested);
    }
  }

  return keys;
}

/**
 * Field names that describe *how the platform ran the work*, not what it
 * found.
 *
 * Each is a real field on a real domain type — `attempt` on `ReviewRun`,
 * `idempotencyKey` on `Command`, `fingerprint` on `ReviewFinding` — so this is
 * a list of things that could genuinely leak through a careless projection,
 * not a list of imagined names.
 */
const FORBIDDEN_KEYS = [
  "attempt",
  "lease",
  "leaseId",
  "workerId",
  "queue",
  "queueName",
  "queueDepth",
  "rawModelResponse",
  "modelResponse",
  "prompt",
  "sandbox",
  "sandboxId",
  "idempotencyKey",
  "configSnapshotId",
  "execution",
  "history",
  "fingerprint",
  "correlationId",
  "causationId",
  "traceId",
  "organizationId",
  "candidateIds",
  "schemaVersion",
] as const;

describe("API layer exposes no execution detail (P0.txt §76)", () => {
  it.each(PUBLIC_SCHEMAS)("%s carries no internal field", (_name, schema) => {
    const keys = collectKeys(schema);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect([...keys]).not.toContain(forbidden);
    }
  });

  it("finds keys at all, so an empty walk cannot pass vacuously", () => {
    // Without this, a `collectKeys` that returned an empty set would make
    // every assertion above trivially true — the classic way a leakage test
    // goes green while checking nothing.
    for (const [name, schema] of PUBLIC_SCHEMAS) {
      expect(
        collectKeys(schema).size,
        `${name} yielded no keys`,
      ).toBeGreaterThan(3);
    }
  });

  it("detects a planted leak", () => {
    // Proves the walk actually finds nested fields, not just top-level ones.
    const leaky = z.strictObject({
      id: z.string(),
      run: z.strictObject({ attempt: z.number() }).optional(),
    });
    expect([...collectKeys(leaky)]).toContain("attempt");
  });

  it("omits organizationId, so a client cannot supply a tenant (§9)", () => {
    // The tenant comes from the session. Echoing it in a response teaches a
    // client that it is a parameter, and the next step is a client that sends
    // one — which is how cross-tenant reads begin.
    for (const [, schema] of PUBLIC_SCHEMAS) {
      expect([...collectKeys(schema)]).not.toContain("organizationId");
    }
  });

  it("exposes a confidence level, never a raw score", () => {
    // The score's scale changes as verification improves. A UI rendering 0.82
    // would make recalibration user-visible and comparisons meaningless.
    const parsed = findingDtoSchema.safeParse({
      id: "f1",
      repositoryId: "r1",
      reviewRunId: "run1",
      severity: "high",
      category: "security",
      confidence: 0.82,
      lifecycle: "published",
      title: "t",
      explanation: "e",
      path: "src/a.ts",
      startLine: 1,
      endLine: 2,
      evidenceCount: 1,
      hasSuggestedFix: false,
      createdAt: "2026-08-16T10:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("Route manifest", () => {
  it("names no execution concept in any path", () => {
    // A URL is the most durable thing an API has. `/queues` or `/workers` in
    // one would outlive the implementation that motivated it.
    const paths = [
      ...Object.values(API_ROUTES).map((route) => route.path),
      REVIEW_EVENTS_STREAM.path,
    ];

    for (const path of paths) {
      for (const forbidden of [
        "queue",
        "worker",
        "attempt",
        "sandbox",
        "job",
        "internal",
      ]) {
        expect(path.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it("queues a review rather than performing one", () => {
    // 202, never 200. A review takes minutes and runs elsewhere; a synchronous
    // 200 would couple response time to worker throughput, which is the
    // coupling horizontal scaling exists to avoid.
    expect(API_ROUTES.createReview.successStatus).toBe(202);
    expect(API_ROUTES.createReview.method).toBe("POST");
  });

  it("gives every route a response schema and a summary", () => {
    for (const name of ROUTE_NAMES) {
      const route = API_ROUTES[name];
      expect(route.response, `${name} has no response schema`).toBeDefined();
      expect(route.summary.length, `${name} has no summary`).toBeGreaterThan(0);
    }
  });

  it("declares 409 wherever a state machine can refuse", () => {
    // A refused transition is a conflict, not bad input. A client that saw 400
    // would tell the user to fix their request, when the correct advice is to
    // reload.
    for (const name of [
      "createReview",
      "cancelReview",
      "dismissFinding",
      "resolveConversation",
    ] as const) {
      expect(API_ROUTES[name].errorStatuses, name).toContain(409);
    }
  });

  it("uses unique method+path pairs", () => {
    // Two routes on one pair means a server can only implement one of them,
    // and which one depends on registration order.
    const pairs = Object.values(API_ROUTES).map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  describe("path building", () => {
    it("substitutes parameters", () => {
      expect(buildPath("/reviews/:id/findings", { id: "abc" })).toBe(
        "/reviews/abc/findings",
      );
    });

    it("encodes values, so a slash cannot change which route matched", () => {
      expect(buildPath("/repositories/:id", { id: "a/b" })).toBe(
        "/repositories/a%2Fb",
      );
    });

    it("refuses a missing parameter rather than emitting a literal ':id'", () => {
      expect(() => buildPath("/reviews/:id", {})).toThrow(
        /Missing path parameter/,
      );
    });

    it("prefixes the version, which is where API versioning lives", () => {
      expect(routeUrl(API_ROUTES.getReview, { id: "r1" })).toBe(
        "/api/v1/reviews/r1",
      );
    });
  });
});
