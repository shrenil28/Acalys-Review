/**
 * What the client throws.
 *
 * Three distinct failures, because a caller responds to each differently and a
 * single `ApiError` would force it to parse a message to tell them apart:
 *
 * | Class | Means | Caller should |
 * | --- | --- | --- |
 * | {@link ApiRequestError} | the server answered with a non-2xx | show `code`; retry only if `retryability` says so |
 * | {@link ApiResponseError} | the server answered with a body the contract does not describe | not retry — the response is wrong, not late |
 * | {@link ApiTransportError} | no answer at all | retry; nothing was necessarily lost |
 *
 * The second is the one that usually gets collapsed into the first. It should
 * not be: a schema mismatch means the client and server disagree about the
 * contract, and retrying reproduces it forever while hiding a deploy skew that
 * needs a human.
 */

import type { ApiErrorDto } from "@acalys/contracts/api/v1";

/** Base class, so a caller can catch everything this client throws. */
export abstract class AcalysApiError extends Error {
  public abstract readonly kind: "request" | "response" | "transport";
}

/** The server answered, and said no. */
export class ApiRequestError extends AcalysApiError {
  public override readonly name = "ApiRequestError";
  public readonly kind = "request" as const;

  public constructor(
    public readonly status: number,
    public readonly error: ApiErrorDto,
  ) {
    super(`${String(status)} ${error.code}: ${error.message}`);
  }

  /** Whether retrying this exact request could plausibly succeed. */
  public get retryable(): boolean {
    return this.error.retryability === "retryable";
  }
}

/**
 * The server answered with something the contract does not describe.
 *
 * Carries the validation issues rather than the body: the body may contain
 * anything, including data the caller should not log (§125), while the issue
 * paths say precisely where client and server disagree.
 */
export class ApiResponseError extends AcalysApiError {
  public override readonly name = "ApiResponseError";
  public readonly kind = "response" as const;

  public constructor(
    public readonly route: string,
    public readonly issues: readonly { path: string; message: string }[],
  ) {
    super(
      `Response from ${route} did not match the contract: ${issues
        .map((issue) => `${issue.path || "<root>"} ${issue.message}`)
        .join("; ")}`,
    );
  }
}

/** No answer: the network failed, the request was aborted, or it timed out. */
export class ApiTransportError extends AcalysApiError {
  public override readonly name = "ApiTransportError";
  public readonly kind = "transport" as const;

  public constructor(
    public readonly route: string,
    override readonly cause: unknown,
  ) {
    super(`Request to ${route} did not complete`);
  }
}
