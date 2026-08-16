/**
 * The transport seam.
 *
 * The client takes a `fetch`-shaped function rather than calling `fetch`
 * directly, and that one decision buys three things:
 *
 * - **It is testable with no server.** `tests/` exercises every route against
 *   an in-memory transport, which is what makes this real code in Phase 0
 *   rather than a placeholder waiting for Phase 1 (§87).
 * - **It runs anywhere.** `apps/web` passes the browser's `fetch`; a Node
 *   service passes its own; a test passes a function. The client never
 *   references a global.
 * - **Auth, retries, and tracing compose.** A caller wraps the transport
 *   instead of the client growing options for each.
 *
 * The shape is deliberately narrower than `fetch`. Modelling the full Fetch API
 * would drag `Headers`, `Request`, `AbortSignal`, and streaming into a contract
 * that needs none of them, and would make a hand-written test transport a
 * chore rather than four lines.
 */

/** What the client sends. */
export interface TransportRequest {
  readonly method: string;
  /** Path including the `/api/v1` prefix and any query string. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON-encoded body, or undefined for a request without one. */
  readonly body?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** What the client expects back. */
export interface TransportResponse {
  readonly status: number;
  /** Parsed JSON, or undefined for `204 No Content`. */
  readonly body: unknown;
}

export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>;

/**
 * Adapts a real `fetch` to {@link Transport}.
 *
 * A non-JSON error body is a real case — a proxy 502 returns HTML, a gateway
 * timeout returns nothing — so parsing is attempted and failure yields
 * `undefined` rather than throwing. Throwing here would replace a useful "502
 * from the gateway" with an unrelated JSON syntax error, and the actual
 * problem would be invisible.
 */
export function fetchTransport(
  fetchImpl: typeof globalThis.fetch,
  baseUrl = "",
): Transport {
  return async (request) => {
    const response = await fetchImpl(`${baseUrl}${request.url}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    if (response.status === 204) {
      return { status: response.status, body: undefined };
    }

    const text = await response.text();
    if (text === "") {
      return { status: response.status, body: undefined };
    }

    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: undefined };
    }
  };
}
