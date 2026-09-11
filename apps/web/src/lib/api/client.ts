/**
 * The one place the frontend talks to the network.
 *
 * # Validated, not asserted
 *
 * ```ts
 * const data = (await response.json()) as FindingDto[];   // a hope
 * ```
 *
 * TypeScript does not reach the network, so that cast asserts nothing. Every
 * response here is parsed with the schema the contract publishes, and a body
 * that does not match becomes a **contract failure** rather than `undefined`
 * surfacing three components later as a blank row.
 *
 * That matters more than usual because the presentation layer downstream is
 * exhaustive over lifecycle states. An unvalidated response could carry a state
 * the union does not contain, and the exhaustiveness guarantee would be
 * enforcing a promise the data never made.
 *
 * # Credentials live at this boundary
 *
 * A component never builds an `Authorization` header. The client is given a way
 * to obtain one, and nothing else in the app needs to know how. Tokens are
 * never logged, never put in an error message, and never included in a result —
 * `detail` strings here carry status codes and validation paths, not bodies.
 */

import type { z } from "zod";

import { categorize } from "./result.js";
import type { ApiResult } from "./result.js";

export interface ApiClientOptions {
  readonly baseUrl: string;
  /**
   * Supplies credentials, if the deployment needs them.
   *
   * A function rather than a value so a token can be refreshed without
   * rebuilding the client, and so that nothing holds a credential longer than
   * the request that uses it.
   */
  readonly authorization?: (() => string | undefined) | undefined;
  /** Injected in tests. Defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface ApiRequestInit {
  readonly signal?: AbortSignal | undefined;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface ApiClient {
  request<TSchema extends z.ZodType>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    schema: TSchema,
    init?: ApiRequestInit,
  ): Promise<ApiResult<z.infer<TSchema>>>;
  get<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    init?: { readonly signal?: AbortSignal | undefined },
  ): Promise<ApiResult<z.infer<TSchema>>>;
  post<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    init?: ApiRequestInit,
  ): Promise<ApiResult<z.infer<TSchema>>>;
  put<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    init?: ApiRequestInit,
  ): Promise<ApiResult<z.infer<TSchema>>>;
  /** Opens a validated authenticated SSE response without exposing fetch to pages. */
  eventStream(
    path: string,
    init?: {
      readonly signal?: AbortSignal | undefined;
      readonly lastEventId?: string | undefined;
    },
  ): Promise<ApiResult<ReadableStream<Uint8Array>>>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const headersFor = (extra: Readonly<Record<string, string>> = {}) => {
    const token = options.authorization?.();
    return {
      Accept: "application/json",
      ...(token === undefined ? {} : { Authorization: token }),
      ...extra,
    };
  };

  const rejected = (status: number): ApiResult<never> => ({
    kind: "rejected",
    status,
    category: categorize(status),
    detail: `the server responded ${String(status)}`,
  });

  const request: ApiClient["request"] = async (method, path, schema, init) => {
    let response: Response;
    try {
      const hasBody = init?.body !== undefined;
      response = await doFetch(`${options.baseUrl}${path}`, {
        method,
        credentials: "include",
        headers: headersFor({
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        }),
        ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
      });
    } catch (error) {
      return {
        kind: "transport",
        detail: error instanceof Error ? error.message : "request failed",
      };
    }

    if (!response.ok) return rejected(response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "contract", detail: "the response was not valid JSON" };
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return {
        kind: "contract",
        detail:
          first === undefined
            ? "the response did not match the API contract"
            : `the response did not match the API contract at ${first.path.join(".") || "(root)"}`,
      };
    }
    return { kind: "ok", value: parsed.data };
  };

  return {
    request,
    get(path, schema, init) {
      return request("GET", path, schema, init);
    },
    post(path, schema, init) {
      return request("POST", path, schema, init);
    },
    put(path, schema, init) {
      return request("PUT", path, schema, init);
    },
    async eventStream(path, init) {
      let response: Response;
      try {
        response = await doFetch(`${options.baseUrl}${path}`, {
          method: "GET",
          credentials: "include",
          headers: headersFor({
            Accept: "text/event-stream",
            ...(init?.lastEventId === undefined
              ? {}
              : { "Last-Event-ID": init.lastEventId }),
          }),
          ...(init?.signal === undefined ? {} : { signal: init.signal }),
        });
      } catch (error) {
        return {
          kind: "transport",
          detail: error instanceof Error ? error.message : "request failed",
        };
      }

      if (!response.ok) return rejected(response.status);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("text/event-stream")) {
        return { kind: "contract", detail: "the response was not an event stream" };
      }
      if (response.body === null) {
        return { kind: "contract", detail: "the event stream had no response body" };
      }
      return { kind: "ok", value: response.body };
    },
  };
}
