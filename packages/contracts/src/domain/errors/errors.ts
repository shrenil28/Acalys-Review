/**
 * Typed platform errors (P0.txt §50, §51, §63, §96).
 *
 * Two rules drive this file:
 *
 * 1. **Nothing untyped crosses a package boundary.** A string thrown from a
 *    provider adapter tells a worker nothing about whether to retry.
 * 2. **Nothing unsafe crosses a *process* boundary.** Stack traces, causes,
 *    credentials, and raw provider payloads stay in logs; the serialized form
 *    an API returns carries only fields that are safe to show a caller (§63).
 *
 * Retryability is part of the type, not a guess the caller makes from the
 * message. A provider timeout and an invalid config are both "errors", but one
 * should be re-queued and the other must never be (§51).
 */

import type { JsonValue } from "../primitives/json.js";

/**
 * How an operation that produced this error should be treated by a queue,
 * worker, or scheduler (§51).
 *
 * - `retryable` — a later attempt may plausibly succeed; the cause is
 *   transient (provider timeout, repository momentarily unavailable, 429).
 * - `non_retryable` — the input itself is wrong; retrying reproduces the
 *   failure forever (invalid `ReviewConfig`, malformed target SHA, 404).
 * - `conditional` — depends on the specific occurrence, so the throw site must
 *   decide. A provider 503 is retryable; a provider 422 is not, and both
 *   surface as `ProviderError`.
 */
export const RETRYABILITIES = [
  "retryable",
  "non_retryable",
  "conditional",
] as const;

export type Retryability = (typeof RETRYABILITIES)[number];

/**
 * The wire form of an error: what an API response or a persisted job failure
 * may contain.
 *
 * Deliberately absent: `stack`, `cause`, and any free-form object. Anything
 * placed in `details` must already be `JsonValue`, which forces a conscious
 * projection rather than dumping a caught exception in whole (§63).
 */
export interface SerializedError {
  /** Stable, machine-readable discriminator, e.g. `"VALIDATION_ERROR"`. */
  readonly code: string;
  /** Human-readable and safe to display; never contains secrets. */
  readonly message: string;
  /** Resolved answer to "should this be retried?" — never `conditional`. */
  readonly retryable: boolean;
  /** The unresolved classification, useful for metrics and triage. */
  readonly retryability: Retryability;
  /** Structured, already-safe context. Typically a validation path. */
  readonly details?: Record<string, JsonValue> | undefined;
}

export interface AcalysErrorOptions {
  /**
   * Structured context. Must be JSON-safe and must not carry credentials,
   * tokens, source code, or raw provider payloads.
   */
  readonly details?: Record<string, JsonValue> | undefined;
  /**
   * The underlying failure. Retained in-process for logging and never
   * serialized (§63).
   */
  // `unknown` already admits undefined, so no `| undefined` here.
  readonly cause?: unknown;
  /**
   * Required when the class is `conditional`; ignored otherwise. Forces the
   * throw site to answer the question it is uniquely able to answer.
   */
  readonly retryable?: boolean | undefined;
}

/**
 * Root of the platform error hierarchy.
 *
 * Subclasses declare a stable `code` and a default {@link Retryability}. They
 * never override `toJSON` — one implementation guarantees that every error in
 * the platform serializes to the same safe shape.
 */
export abstract class AcalysError extends Error {
  abstract readonly code: string;
  abstract readonly retryability: Retryability;

  readonly details?: Record<string, JsonValue> | undefined;
  readonly #explicitRetryable?: boolean;

  constructor(message: string, options: AcalysErrorOptions = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = new.target.name;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.retryable !== undefined) {
      this.#explicitRetryable = options.retryable;
    }
    // Without this, `instanceof` breaks for subclasses when the package is
    // compiled to a target that downlevels classes.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Resolves {@link Retryability} to the boolean a queue actually needs.
   *
   * A `conditional` error thrown without an explicit decision is treated as
   * non-retryable: refusing to retry an unknown failure is the safe default —
   * it risks a stalled job, not an infinite loop or a duplicated side effect.
   */
  get retryable(): boolean {
    switch (this.retryability) {
      case "retryable":
        return true;
      case "non_retryable":
        return false;
      case "conditional":
        return this.#explicitRetryable ?? false;
    }
  }

  /**
   * The only sanctioned way to put an error on a wire.
   *
   * Note what is *not* here: `stack`, `cause`, `name`. Adding any of them
   * would leak internal structure to an external caller.
   */
  toSerialized(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retryability: this.retryability,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }

  toJSON(): SerializedError {
    return this.toSerialized();
  }
}

/** Input failed schema or invariant validation. Retrying cannot help. */
export class ValidationError extends AcalysError {
  readonly code = "VALIDATION_ERROR";
  readonly retryability = "non_retryable" as const;
}

/** A referenced entity does not exist. */
export class NotFoundError extends AcalysError {
  readonly code = "NOT_FOUND";
  readonly retryability = "non_retryable" as const;
}

/**
 * The request conflicts with current state — a duplicate idempotency key, a
 * revision sequence collision, an illegal state transition.
 */
export class ConflictError extends AcalysError {
  readonly code = "CONFLICT";
  readonly retryability = "non_retryable" as const;
}

/** No valid credentials were presented. */
export class UnauthorizedError extends AcalysError {
  readonly code = "UNAUTHORIZED";
  readonly retryability = "non_retryable" as const;
}

/** Credentials were valid but insufficient for this tenant or resource. */
export class ForbiddenError extends AcalysError {
  readonly code = "FORBIDDEN";
  readonly retryability = "non_retryable" as const;
}

/**
 * A source provider (GitHub, GitLab, …) failed.
 *
 * `conditional` by nature: a 503 or a rate limit should be retried, a 422
 * should not. The adapter knows which; the base class refuses to guess.
 */
export class ProviderError extends AcalysError {
  readonly code = "PROVIDER_ERROR";
  readonly retryability = "conditional" as const;
}

/** Repository access, clone, or snapshot failed — usually transient. */
export class RepositoryError extends AcalysError {
  readonly code = "REPOSITORY_ERROR";
  readonly retryability = "conditional" as const;
}

/** Sandbox provisioning or execution failed. */
export class SandboxError extends AcalysError {
  readonly code = "SANDBOX_ERROR";
  readonly retryability = "conditional" as const;
}

/** A static-analysis tool failed, timed out, or produced unusable output. */
export class ToolExecutionError extends AcalysError {
  readonly code = "TOOL_EXECUTION_ERROR";
  readonly retryability = "conditional" as const;
}

/** The review pipeline itself failed in a way worth retrying once. */
export class ReviewError extends AcalysError {
  readonly code = "REVIEW_ERROR";
  readonly retryability = "conditional" as const;
}

/**
 * Configuration could not be parsed, validated, or resolved.
 *
 * Never retryable: the same `.acalys.yaml` produces the same failure until a
 * human changes it.
 */
export class ConfigurationError extends AcalysError {
  readonly code = "CONFIGURATION_ERROR";
  readonly retryability = "non_retryable" as const;
}

/**
 * An invariant the platform believed impossible was violated — a bug.
 *
 * Non-retryable on purpose: retrying a logic error burns quota and hides the
 * defect behind a flapping job.
 */
export class InternalError extends AcalysError {
  readonly code = "INTERNAL_ERROR";
  readonly retryability = "non_retryable" as const;
}

/**
 * Alias used by {@link assertNever}, which cannot import `InternalError`
 * under its bare name without shadowing the host environment's global of the
 * same name in some runtimes.
 */
export { InternalError as AcalysInternalError };

/**
 * Converts anything a `catch` block can receive into the safe wire form.
 *
 * `catch (error: unknown)` can hand you a string, a number, `undefined`, or a
 * hostile object with a getter that throws. This is the single funnel that
 * makes all of those safe, so no call site has to reason about it:
 *
 * - an {@link AcalysError} serializes itself;
 * - a native `Error` keeps only its message, and is reported as an internal,
 *   non-retryable failure — we cannot know it is safe to retry;
 * - anything else is described without interpolating its content.
 *
 * Never returns the original object, so a caught provider response cannot
 * escape into an API reply.
 */
export function toSerializedError(error: unknown): SerializedError {
  if (error instanceof AcalysError) {
    return error.toSerialized();
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message,
      retryable: false,
      retryability: "non_retryable",
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: `Non-Error value thrown (${typeof error})`,
    retryable: false,
    retryability: "non_retryable",
  };
}

/** True when `error` is any member of the platform hierarchy. */
export function isAcalysError(error: unknown): error is AcalysError {
  return error instanceof AcalysError;
}
