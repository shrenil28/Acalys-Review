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
  /** An error status the endpoint declares, such as 404. */
  | { readonly kind: "rejected"; readonly status: number; readonly detail: string };

/** Whether a result carries an answer. Never use truthiness for this. */
export function isOk<T>(
  result: ApiResult<T>,
): result is { kind: "ok"; value: T } {
  return result.kind === "ok";
}
