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

export interface ApiClient {
  get<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    init?: { readonly signal?: AbortSignal | undefined },
  ): Promise<ApiResult<z.infer<TSchema>>>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    async get(path, schema, init) {
      const token = options.authorization?.();
      let response: Response;

      try {
        response = await doFetch(`${options.baseUrl}${path}`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(token === undefined ? {} : { Authorization: token }),
          },
          ...(init?.signal === undefined ? {} : { signal: init.signal }),
        });
      } catch (error) {
        // Offline, DNS, CORS, abort. No response exists, so nothing can be
        // said about the resource — which is not the same as saying it is
        // empty.
        return {
          kind: "transport",
          detail: error instanceof Error ? error.message : "request failed",
        };
      }

      if (!response.ok) {
        return {
          kind: "rejected",
          status: response.status,
          category: categorize(response.status),
          // The status, not the body. A body can contain anything a
          // misconfigured server decided to include.
          detail: `the server responded ${String(response.status)}`,
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: "contract", detail: "the response was not valid JSON" };
      }

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        // The path that failed, never the value at it — a validation failure
        // on a credential field would otherwise print the credential.
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
    },
  };
}
