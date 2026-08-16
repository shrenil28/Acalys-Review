/**
 * The typed client, built from the shared route manifest.
 *
 * Every method here is derived from `API_ROUTES` rather than hand-written:
 * the path, the method, the success status, and both schemas come from the
 * manifest, so a route that changes shape changes this client by definition.
 * A hand-written client is the third place a route gets defined, and the one
 * that silently goes stale.
 *
 *     API_ROUTES  ──►  apps/api        implements
 *                 └─►  this client     calls
 *
 * # Both directions are validated
 *
 * A request body is parsed before it is sent, and a response body is parsed
 * before it is returned. The second is the one usually skipped, and it is the
 * one that matters more: an unvalidated response means a server change surfaces
 * as `undefined is not an object` deep inside a React render, three frames from
 * the cause. Validating at the boundary turns that into
 * {@link ApiResponseError} naming the exact field.
 *
 * # The client is unaware of workers, queues, and attempts
 *
 * There is nothing to poll a queue with, no attempt number to pass, and no
 * worker to address — because the API has none of those. This file is what the
 * invariant "the frontend must not depend on review-worker implementation
 * details" looks like in code.
 */

import type { z } from "zod";
import {
  API_ROUTES,
  REVIEW_EVENTS_STREAM,
  errorResponseSchema,
  routeUrl,
  type RouteDefinition,
  type RouteName,
} from "@acalys/contracts/api/v1";
import {
  ApiRequestError,
  ApiResponseError,
  ApiTransportError,
} from "./errors.js";
import type { Transport } from "./transport.js";

/** How the client is configured. */
export interface AcalysClientOptions {
  readonly transport: Transport;
  /**
   * Headers added to every request — typically `Authorization`.
   *
   * A function, not a value, so a token that refreshes is read at request
   * time. A static object captures the token at construction and starts
   * failing silently the moment it expires.
   */
  readonly headers?: (() => Readonly<Record<string, string>>) | undefined;
}

/**
 * A value that can appear in a query string.
 *
 * Narrow on purpose. `unknown` here would let an object through, and
 * `String({})` yields `"[object Object]"` — a filter that silently matches
 * nothing and reads as an empty result rather than as a bug.
 */
export type QueryValue = string | number | boolean | undefined;

/** Per-call arguments. Each field is present only when its route needs it. */
export interface CallOptions {
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly query?: Readonly<Record<string, QueryValue>> | undefined;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Serializes query parameters.
 *
 * `undefined` values are dropped rather than sent as the string `"undefined"` —
 * the classic bug that turns "no severity filter" into "severity=undefined",
 * which then matches nothing and looks like an empty result set.
 */
function buildQuery(query: Readonly<Record<string, QueryValue>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    search.append(key, String(value));
  }
  const encoded = search.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function formatIssues(
  error: z.ZodError,
): readonly { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Executes one route.
 *
 * Exported so a caller can invoke a route the generated surface has not named —
 * and so the generated methods below are a thin, uniform wrapper over one
 * implementation rather than seventeen near-copies.
 */
export async function callRoute<TRoute extends RouteDefinition>(
  route: TRoute,
  options: AcalysClientOptions,
  call: CallOptions = {},
): Promise<z.output<TRoute["response"]>> {
  const path = routeUrl(route, call.params ?? {});
  const label = `${route.method} ${route.path}`;

  // Validate outbound before the wire, so a malformed request fails here with
  // a field path rather than as a 400 the caller has to decode.
  let body: string | undefined;
  if (route.body !== undefined) {
    const parsed = route.body.safeParse(call.body ?? {});
    if (!parsed.success) {
      throw new ApiResponseError(
        `request to ${label}`,
        formatIssues(parsed.error),
      );
    }
    body = JSON.stringify(parsed.data);
  }

  const query = call.query === undefined ? "" : buildQuery(call.query);

  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.headers?.() ?? {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };

  let response;
  try {
    response = await options.transport({
      method: route.method,
      url: `${path}${query}`,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
  } catch (cause) {
    // A transport that threw means no answer arrived. Distinct from a server
    // that answered with an error, and retryable where that may not be.
    throw new ApiTransportError(label, cause);
  }

  if (response.status !== route.successStatus) {
    const parsed = errorResponseSchema.safeParse(response.body);
    throw new ApiRequestError(
      response.status,
      parsed.success
        ? parsed.data
        : {
            // A non-2xx with an unparseable body is still a request failure —
            // a proxy 502 returns HTML. Synthesizing a well-formed error keeps
            // the caller's handling uniform, and `non_retryable` is the safe
            // default: an unknown failure must not be retried automatically.
            code: "UNKNOWN_ERROR",
            message: `Unexpected status ${String(response.status)} from ${label}`,
            retryability: "non_retryable",
          },
    );
  }

  const parsed = route.response.safeParse(response.body);
  if (!parsed.success) {
    throw new ApiResponseError(label, formatIssues(parsed.error));
  }
  return parsed.data as z.output<TRoute["response"]>;
}

/** The client's method surface: one method per named route. */
export type AcalysClient = {
  readonly [TName in RouteName]: (
    call?: CallOptions,
  ) => Promise<z.output<(typeof API_ROUTES)[TName]["response"]>>;
} & {
  /**
   * The URL of the progress stream for a run.
   *
   * A URL rather than a subscription: `EventSource` exists in a browser and
   * not in Node, and a client that constructed one would stop working in the
   * environment its own tests run in. The route stays in the manifest so the
   * URL cannot drift; opening it is the caller's decision.
   */
  readonly reviewEventsUrl: (reviewRunId: string) => string;
};

/**
 * Builds a client.
 *
 * Methods are generated by iterating the manifest, so adding a route to
 * `API_ROUTES` adds a method here with no edit — and, more usefully, *removing*
 * one removes the method, which turns a deleted endpoint into a compile error
 * at every call site instead of a 404 at runtime.
 */
export function createAcalysClient(options: AcalysClientOptions): AcalysClient {
  const methods = Object.fromEntries(
    Object.entries(API_ROUTES).map(([name, route]) => [
      name,
      (call: CallOptions = {}) => callRoute(route, options, call),
    ]),
  ) as { [TName in RouteName]: (call?: CallOptions) => Promise<unknown> };

  return {
    ...methods,
    reviewEventsUrl: (reviewRunId: string) =>
      routeUrl(REVIEW_EVENTS_STREAM, { id: reviewRunId }),
  } as AcalysClient;
}
