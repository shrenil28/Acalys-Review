/**
 * The route manifest — one description of the HTTP surface.
 *
 * There are normally three places a route is defined: the server that
 * implements it, the client that calls it, and the docs that describe it. They
 * drift, and the drift surfaces as a 404 in production. Here there is one
 * definition, and both sides are generated from it:
 *
 *     routes.ts  ──►  apps/api        implements each entry
 *                └─►  @acalys/api-client  calls each entry
 *
 * Every route carries its own request and response **schemas**, so validation
 * is not something either side remembers to do — it is part of the route.
 *
 * # Async by construction
 *
 * `POST /reviews` is declared `202`, not `200`. That is the shape of the whole
 * product: a review takes minutes, runs on a worker that may not exist yet, and
 * scales horizontally. A synchronous `200` would make the API hold a connection
 * open for the duration and would couple response time to worker throughput —
 * the coupling the invariant "workers scale without changing frontend APIs"
 * exists to prevent.
 *
 * # No route exposes an internal concept
 *
 * There is no `/queues`, no `/workers`, no `/attempts`, no `/sandboxes`. A
 * caller asks about reviews, findings, and repositories — product nouns. This
 * is asserted by a test, not left to review.
 */

import { z } from "zod";
import { TEXT_LIMITS } from "../../domain/primitives/limits.js";
import { REVIEW_DEPTHS } from "../../domain/configuration/review-config.js";
import {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
} from "../../domain/finding/taxonomy.js";
import { FINDING_LIFECYCLE_STATES } from "../../domain/finding/finding-lifecycle.js";
import {
  apiErrorDtoSchema,
  apiIdSchema,
  pageDtoSchema,
  pageQuerySchema,
} from "./common.js";
import {
  conversationDtoSchema,
  findingDtoSchema,
  knowledgeItemDtoSchema,
  preMergeCheckDtoSchema,
  pullRequestSummaryDtoSchema,
  repositoryDtoSchema,
  reviewRunDtoSchema,
  reviewSummaryDtoSchema,
} from "./resources.js";

export const HTTP_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * One endpoint.
 *
 * `path` uses `:param` placeholders, matching Express and every router-shaped
 * library, and `params` names them with schemas so a client cannot substitute
 * the wrong value into the wrong slot.
 *
 * `successStatus` is part of the contract rather than assumed to be 200: the
 * difference between 200 and 202 is the difference between "here is your
 * review" and "your review is queued", and a client rendering the first for
 * the second would show an empty result as a finished one.
 */
export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  /** What this endpoint is for, one line. Feeds generated documentation. */
  readonly summary: string;
  readonly params?: z.ZodType | undefined;
  readonly query?: z.ZodType | undefined;
  readonly body?: z.ZodType | undefined;
  readonly response: z.ZodType;
  readonly successStatus: 200 | 201 | 202 | 204;
  /** Non-success statuses this endpoint can return, beyond the universal set. */
  readonly errorStatuses: readonly number[];
}

/**
 * Statuses every endpoint can return.
 *
 * Listed once because they come from cross-cutting middleware — authentication,
 * tenant resolution, rate limiting — not from any endpoint's own logic.
 * Repeating them per route would invite one to be forgotten and read as "this
 * endpoint cannot 401", which is never true.
 */
export const UNIVERSAL_ERROR_STATUSES = [400, 401, 403, 429, 500] as const;

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * The body of `POST /reviews`.
 *
 * `z.object`, not `z.strictObject`: inbound payloads strip unknown keys (§56)
 * so a client built against a newer build is not rejected by an older server.
 *
 * The overrides are the same three fields {@link RequestOverrides} allows, and
 * for the same reason — this is the least trusted input in the system, and the
 * allow-list is the security boundary. Note what a caller *cannot* ask for
 * here: external knowledge sources, tool policy, or merge policy.
 */
export const createReviewBodySchema = z.object({
  repositoryId: apiIdSchema,
  pullRequestId: apiIdSchema.optional(),
  depth: z.enum(REVIEW_DEPTHS).optional(),
  categories: z
    .array(z.enum(FINDING_CATEGORIES))
    .max(FINDING_CATEGORIES.length)
    .optional(),
  reviewDrafts: z.boolean().optional(),
});

export const cancelReviewBodySchema = z.object({
  reason: z.string().min(1).max(TEXT_LIMITS.summary).optional(),
});

export const dismissFindingBodySchema = z.object({
  reason: z.string().min(1).max(TEXT_LIMITS.summary),
});

export const findingQuerySchema = pageQuerySchema.extend({
  severity: z.enum(FINDING_SEVERITIES).optional(),
  category: z.enum(FINDING_CATEGORIES).optional(),
  state: z.enum(FINDING_LIFECYCLE_STATES).optional(),
});

const idParam = z.object({ id: apiIdSchema });
const repositoryParam = z.object({ repositoryId: apiIdSchema });

/**
 * The accepted-review body.
 *
 * Returns the run *as it exists now* — queued — rather than a bare id. A
 * client that gets the full {@link ReviewRunDto} can render the pending state
 * immediately without a follow-up request, which is the difference between the
 * UI showing "queued" and showing nothing until the first poll.
 */
export const reviewAcceptedSchema = reviewRunDtoSchema;

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

export const API_ROUTES = {
  listRepositories: {
    method: "GET",
    path: "/repositories",
    summary: "Repositories the caller's organization has connected.",
    query: pageQuerySchema,
    response: pageDtoSchema(repositoryDtoSchema),
    successStatus: 200,
    errorStatuses: [],
  },

  getRepository: {
    method: "GET",
    path: "/repositories/:id",
    summary: "One repository.",
    params: idParam,
    response: repositoryDtoSchema,
    successStatus: 200,
    errorStatuses: [404],
  },

  listPullRequests: {
    method: "GET",
    path: "/repositories/:repositoryId/pull-requests",
    summary: "Open changes in a repository, for the triage table.",
    params: repositoryParam,
    query: pageQuerySchema,
    response: pageDtoSchema(pullRequestSummaryDtoSchema),
    successStatus: 200,
    errorStatuses: [404],
  },

  createReview: {
    method: "POST",
    path: "/reviews",
    summary:
      "Queue a review. Returns immediately; follow it with the events stream.",
    body: createReviewBodySchema,
    response: reviewAcceptedSchema,
    // 202, never 200: the review has not happened yet, and a client must not
    // read the response as a result.
    successStatus: 202,
    // 409: a review of this revision is already running. Not an error the user
    // caused — the client should follow the existing run rather than retry.
    errorStatuses: [404, 409],
  },

  getReview: {
    method: "GET",
    path: "/reviews/:id",
    summary: "Current state of a review run.",
    params: idParam,
    response: reviewRunDtoSchema,
    successStatus: 200,
    errorStatuses: [404],
  },

  cancelReview: {
    method: "POST",
    path: "/reviews/:id/cancel",
    summary: "Ask for a running review to stop.",
    params: idParam,
    body: cancelReviewBodySchema,
    response: reviewRunDtoSchema,
    successStatus: 200,
    // 409: the run already settled. Cancelling a completed review is not a
    // failure of the request, it is a race the client lost, and it needs to be
    // able to tell the two apart.
    errorStatuses: [404, 409],
  },

  getReviewSummary: {
    method: "GET",
    path: "/reviews/:id/summary",
    summary: "The reviewer's account of the change.",
    params: idParam,
    response: reviewSummaryDtoSchema,
    successStatus: 200,
    // 404 covers "no summary yet" as well as "no such run": a summary does not
    // exist until the run produces one.
    errorStatuses: [404],
  },

  listReviewFindings: {
    method: "GET",
    path: "/reviews/:id/findings",
    summary: "Findings a review published.",
    params: idParam,
    query: findingQuerySchema,
    response: pageDtoSchema(findingDtoSchema),
    successStatus: 200,
    errorStatuses: [404],
  },

  listReviewChecks: {
    method: "GET",
    path: "/reviews/:id/pre-merge-checks",
    summary: "Pre-merge check results for a review.",
    params: idParam,
    response: pageDtoSchema(preMergeCheckDtoSchema),
    successStatus: 200,
    errorStatuses: [404],
  },

  getFinding: {
    method: "GET",
    path: "/findings/:id",
    summary: "One published finding.",
    params: idParam,
    response: findingDtoSchema,
    successStatus: 200,
    errorStatuses: [404],
  },

  dismissFinding: {
    method: "POST",
    path: "/findings/:id/dismiss",
    summary: "Record that a human judged this finding not worth acting on.",
    params: idParam,
    body: dismissFindingBodySchema,
    response: findingDtoSchema,
    successStatus: 200,
    // 409: the finding is not in a state that can be dismissed — the lifecycle
    // machine refused the transition, and that is a conflict, not bad input.
    errorStatuses: [404, 409],
  },

  listConversations: {
    method: "GET",
    path: "/repositories/:repositoryId/conversations",
    summary: "Discussion threads in a repository.",
    params: repositoryParam,
    query: pageQuerySchema,
    response: pageDtoSchema(conversationDtoSchema),
    successStatus: 200,
    errorStatuses: [404],
  },

  resolveConversation: {
    method: "POST",
    path: "/conversations/:id/resolve",
    summary: "Mark a thread as finished.",
    params: idParam,
    response: conversationDtoSchema,
    successStatus: 200,
    errorStatuses: [404, 409],
  },

  listKnowledge: {
    method: "GET",
    path: "/knowledge",
    summary: "Learnings and instructions the reviewer draws on.",
    query: pageQuerySchema,
    response: pageDtoSchema(knowledgeItemDtoSchema),
    successStatus: 200,
    errorStatuses: [],
  },
} as const satisfies Record<string, RouteDefinition>;

export type RouteName = keyof typeof API_ROUTES;
export const ROUTE_NAMES = Object.keys(API_ROUTES) as readonly RouteName[];

/**
 * The events stream, described separately.
 *
 * SSE is not a request/response route: it has no single response body, it
 * stays open, and its payload is a sequence of named frames. Forcing it into
 * {@link RouteDefinition} would mean a `response` schema that describes one
 * frame while the endpoint returns many — a contract that reads as true and
 * is not.
 */
export const REVIEW_EVENTS_STREAM = {
  method: "GET",
  path: "/reviews/:id/events",
  summary: "Server-Sent Events following a review run to completion.",
  params: idParam,
  contentType: "text/event-stream",
  errorStatuses: [404],
} as const;

/** The error body every non-2xx response carries. */
export const errorResponseSchema = apiErrorDtoSchema;

/**
 * Substitutes `:params` into a path.
 *
 * Encodes every value: an id that reached a URL unencoded would let a `/` in a
 * value silently change which route matched.
 */
export function buildPath(
  path: string,
  params: Readonly<Record<string, string>> = {},
): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter '${name}' for '${path}'`);
    }
    return encodeURIComponent(value);
  });
}

/** The full path for a route, including the version prefix. */
export function routeUrl(
  route: { readonly path: string },
  params: Readonly<Record<string, string>> = {},
): string {
  return `/api/v1${buildPath(route.path, params)}`;
}
