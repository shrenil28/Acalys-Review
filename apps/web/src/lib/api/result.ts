/**
 * What happened when the frontend asked the backend a question.
 *
 * Four outcomes, kept apart deliberately, because three of them are ways of
 * knowing nothing and only one of them is an answer:
 *
 * ```
 * ok         the server answered, and the answer validated
 * transport  the request never produced a usable response
 * contract   it responded, and the body is not what the contract declares
 * rejected   it answered with an error status it is allowed to return
 * ```
 *
 * The reason this is a union rather than `T | null` is the invariant the whole
 * checkpoint turns on:
 *
 * > a transport failure must never render as "no actionable findings"
 *
 * That is the frontend restatement of a rule the backend already enforces — a
 * verifier outage must not read as a clean review — and `null` is exactly the
 * shape that collapses them. An empty list and a failed request are both
 * "nothing to show" to a component that only checks for absence.
 */

export type ApiResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  /** No usable response: offline, DNS, CORS, timeout, abort. */
  | { readonly kind: "transport"; readonly detail: string }
  /**
   * A response whose body does not match the declared contract.
   *
   * Distinct from `transport` because the remedy is different: one is a network
   * to investigate, the other is a server and a client that disagree about what
   * they are exchanging. Rendering either as an empty list hides both.
   */
  | { readonly kind: "contract"; readonly detail: string }
  /**
   * The server answered with a status it declines to serve on.
   *
   * Carries a `category` as well as the number, so a page can choose a remedy
   * without parsing a message. These want different responses and only one of
   * them is worth retrying:
   *
   * ```
   * unauthorized  sign in again
   * forbidden     ask for access
   * absent        the thing is gone; navigate away
   * conflict      state moved under you; refetch
   * throttled     wait
   * server        report it
   * ```
   *
   * They do not need six visual designs. They need enough structure that the
   * choice is available later without a string comparison.
   */
  | {
      readonly kind: "rejected";
      readonly status: number;
      readonly category: RejectionCategory;
      readonly detail: string;
    };

export type RejectionCategory =
  | "unauthorized"
  | "forbidden"
  | "absent"
  | "conflict"
  | "throttled"
  | "server"
  | "other";

export function categorize(status: number): RejectionCategory {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "absent";
    case 409:
      return "conflict";
    case 429:
      return "throttled";
    default:
      return status >= 500 ? "server" : "other";
  }
}

/** Whether a result carries an answer. Never use truthiness for this. */
export function isOk<T>(
  result: ApiResult<T>,
): result is { kind: "ok"; value: T } {
  return result.kind === "ok";
}
