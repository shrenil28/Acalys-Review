import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import express, { type Express, type Request, type Response } from "express";

import {
  requireScope,
  type ApiScope,
  type AuthService,
  type Principal,
} from "@acalys/auth";
import {
  API_ROUTES,
  DEFAULT_PAGE_SIZE,
  errorResponseSchema,
  REVIEW_EVENTS_STREAM,
  REVIEW_PROGRESS_DONE_EVENT_NAME,
  REVIEW_PROGRESS_EVENT_NAME,
  reviewProgressEventSchema,
  toReviewProgressEvent,
  type RouteDefinition,
  type RouteName,
} from "@acalys/contracts/api/v1";
import {
  canonicalJson,
  isAcalysError,
  TEXT_LIMITS,
} from "@acalys/contracts/domain";
import {
  type ApiMutationStore,
  type ApiStore,
  type ApiTenantScope,
} from "@acalys/database";
import {
  createPaginationCursorCodec,
  InvalidPaginationCursor,
  type PaginationCursorBinding,
} from "./pagination-cursor.js";

export interface ApiRequestLogFields {
  readonly correlationId: string;
  readonly method: string;
  readonly routeName: RouteName | "reviewEvents" | "unknown";
  readonly status: number;
  readonly durationMs: number;
  readonly outcome: "completed" | "aborted";
  readonly organizationId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly principalKind?: Principal["kind"] | undefined;
}

export interface ApiRequestLogger {
  info(event: "api.request", fields: ApiRequestLogFields): void;
}

export interface ApiAppOptions {
  readonly auth: AuthService;
  readonly api: ApiStore;
  readonly mutations: ApiMutationStore;
  readonly consumeRate: (input: {
    readonly organizationId: string;
    readonly principalId: string;
  }) => Promise<boolean>;
  readonly logger?: ApiRequestLogger | undefined;
  /** Active cursor-encryption secret first; previous generations are decode-only. */
  readonly cursorSecrets: readonly string[];
  readonly heartbeatMillis?: number;
  readonly pollMillis?: number;
  /** Monotonic process clock used only for SSE idle scheduling. */
  readonly monotonicNow?: (() => number) | undefined;
}

interface RequestContext {
  readonly principal: Principal;
  readonly scope: ApiTenantScope;
  readonly correlationId: string;
}

const ROUTE_SCOPE: Readonly<Record<RouteName, ApiScope>> = {
  listRepositories: "repositories:read",
  getRepository: "repositories:read",
  listPullRequests: "repositories:read",
  createReview: "reviews:write",
  getReview: "reviews:read",
  cancelReview: "reviews:write",
  getReviewSummary: "reviews:read",
  listReviewFindings: "findings:read",
  listReviewChecks: "reviews:read",
  getFinding: "findings:read",
  dismissFinding: "findings:write",
  listConversations: "conversations:read",
  resolveConversation: "conversations:write",
  listKnowledge: "knowledge:read",
};

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function queryObject(request: Request): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(request.query)) {
    // Express represents duplicate or structured query parameters as arrays or
    // objects. Never drop those values before contract validation: doing so can
    // turn malformed input such as `?limit=10&limit=20` into an absent field
    // that silently receives the schema default. Query fields are scalar text
    // on the wire; any structured representation therefore fails closed before
    // a tenant-scoped handler can run.
    if (typeof value !== "string") {
      throw new RequestValidationFailure([
        {
          path: bounded(key, TEXT_LIMITS.identifier),
          message:
            "Query parameter must appear exactly once as a scalar string",
        },
      ]);
    }
    out[key] = value;
  }
  return out;
}

type ApiRetryability = "retryable" | "non_retryable" | "conditional";

interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryability: ApiRetryability;
  readonly fields?:
    readonly { readonly path: string; readonly message: string }[] | undefined;
}

const INTERNAL_ERROR_BODY: ApiErrorBody = {
  code: "INTERNAL_ERROR",
  message: "The request could not be completed",
  retryability: "non_retryable",
};

class RequestValidationFailure extends Error {
  constructor(
    readonly fields: readonly {
      readonly path: string;
      readonly message: string;
    }[],
  ) {
    super("Request validation failed");
    this.name = "RequestValidationFailure";
  }
}

class RateLimitExceeded extends Error {
  constructor() {
    super("Rate limit exceeded");
    this.name = "RateLimitExceeded";
  }
}

class IdempotencyKeyRequired extends Error {
  constructor() {
    super("A valid Idempotency-Key header is required");
    this.name = "IdempotencyKeyRequired";
  }
}

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

function errorBody(
  code: string,
  message: string,
  retryability: ApiRetryability = "non_retryable",
  fields?: ApiErrorBody["fields"],
): ApiErrorBody {
  return {
    code: bounded(code, TEXT_LIMITS.identifier),
    message: bounded(message, TEXT_LIMITS.summary),
    retryability,
    ...(fields === undefined ? {} : { fields }),
  };
}

function validatedErrorBody(body: ApiErrorBody): ApiErrorBody {
  const parsed = errorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : INTERNAL_ERROR_BODY;
}

function sendErrorBody(
  response: Response,
  status: number,
  body: ApiErrorBody,
): void {
  response.status(status).json(validatedErrorBody(body));
}

function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
  retryability: ApiRetryability = "non_retryable",
): void {
  sendErrorBody(response, status, errorBody(code, message, retryability));
}

const PUBLIC_ACALYS_ERROR_MESSAGE: Readonly<Record<string, string>> = {
  VALIDATION_ERROR: "Request validation failed",
  NOT_FOUND: "Resource not found",
  CONFLICT: "Request conflicts with current state",
  UNAUTHORIZED: "Authentication is required or invalid",
  FORBIDDEN: "The credential is not authorized for this operation",
  PROVIDER_ERROR: "A source provider request failed",
  REPOSITORY_ERROR: "Repository access failed",
  SANDBOX_ERROR: "Sandbox execution failed",
  TOOL_EXECUTION_ERROR: "A review tool failed",
  REVIEW_ERROR: "Review processing failed",
  CONFIGURATION_ERROR: "Review configuration is invalid",
  INTERNAL_ERROR: INTERNAL_ERROR_BODY.message,
};

function statusForAcalysError(code: string): number {
  switch (code) {
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "VALIDATION_ERROR":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function mapError(error: unknown): {
  readonly status: number;
  readonly body: ApiErrorBody;
} {
  try {
    if (error instanceof IdempotencyKeyRequired) {
      return {
        status: 400,
        body: errorBody(
          "IDEMPOTENCY_KEY_REQUIRED",
          "A valid Idempotency-Key header is required",
        ),
      };
    }
    if (isAcalysError(error)) {
      const code = error.code;
      const message =
        PUBLIC_ACALYS_ERROR_MESSAGE[code] ?? INTERNAL_ERROR_BODY.message;
      const body = errorBody(
        code in PUBLIC_ACALYS_ERROR_MESSAGE ? code : INTERNAL_ERROR_BODY.code,
        message,
        error.retryability,
      );
      return { status: statusForAcalysError(code), body };
    }
  } catch {
    // Hostile thrown values must not be able to break the error boundary.
  }
  return { status: 500, body: INTERNAL_ERROR_BODY };
}

function safeValidationFields(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
) {
  return issues.slice(0, 100).map((issue) => ({
    path: bounded(issue.path.map(String).join("."), TEXT_LIMITS.identifier),
    message: bounded(issue.message, TEXT_LIMITS.summary),
  }));
}

function parsePart(
  schema: RouteDefinition["params"],

  value: unknown,
): unknown {
  if (schema === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new RequestValidationFailure(safeValidationFields(parsed.error.issues));
}

async function authenticate(
  options: ApiAppOptions,
  request: Request,
  routeName: RouteName,
  correlationId: string,
): Promise<RequestContext> {
  const principal = await options.auth.authenticateBearer(
    request.header("authorization"),
  );
  requireScope(principal, ROUTE_SCOPE[routeName]);
  const allowed = await options.consumeRate({
    organizationId: principal.organizationId,
    principalId: principal.id,
  });
  if (!allowed) throw new RateLimitExceeded();
  return {
    principal,
    scope: { organizationId: principal.organizationId },
    correlationId,
  };
}

function correlationId(request: Request): string {
  const supplied = request.header("x-correlation-id");
  if (
    supplied !== undefined &&
    supplied.length >= 1 &&
    supplied.length <= TEXT_LIMITS.identifier
  ) {
    return supplied;
  }
  return randomUUID();
}

function attachRequestLog(
  options: ApiAppOptions,
  request: Request,
  response: Response,
  routeName: ApiRequestLogFields["routeName"],
  requestCorrelationId: string,
): {
  setContext(context: RequestContext): void;
  setRouteName(routeName: ApiRequestLogFields["routeName"]): void;
} {
  const started = process.hrtime.bigint();
  let context: RequestContext | undefined;
  let currentRouteName = routeName;
  let emitted = false;

  const emit = (outcome: ApiRequestLogFields["outcome"]): void => {
    if (emitted) return;
    emitted = true;
    const elapsedNanos = process.hrtime.bigint() - started;
    const durationMs = Number(elapsedNanos) / 1_000_000;
    try {
      options.logger?.info("api.request", {
        correlationId: requestCorrelationId,
        method: request.method,
        routeName: currentRouteName,
        status: response.statusCode,
        durationMs,
        outcome,
        ...(context === undefined
          ? {}
          : {
              organizationId: context.scope.organizationId,
              principalId: context.principal.id,
              principalKind: context.principal.kind,
            }),
      });
    } catch {
      // Observability must never change the request outcome.
    }
  };

  response.once("finish", () => emit("completed"));
  response.once("close", () => {
    if (!response.writableEnded) emit("aborted");
  });

  return {
    setContext(next) {
      context = next;
    },
    setRouteName(next) {
      currentRouteName = next;
    },
  };
}

function sendMappedError(response: Response, error: unknown): void {
  try {
    if (error instanceof RequestValidationFailure) {
      sendErrorBody(
        response,
        400,
        errorBody(
          "VALIDATION_ERROR",
          "Request validation failed",
          "non_retryable",
          error.fields,
        ),
      );
      return;
    }
    if (error instanceof RateLimitExceeded) {
      sendError(
        response,
        429,
        "RATE_LIMITED",
        "Rate limit exceeded",
        "retryable",
      );
      return;
    }
  } catch {
    // A hostile thrown Proxy can make instanceof itself throw. Fall through.
  }
  const mapped = mapError(error);
  sendErrorBody(response, mapped.status, mapped.body);
}

function bodyParserFailure(
  error: unknown,
): "malformed" | "too_large" | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const type = (error as { readonly type?: unknown }).type;
    if (type === "entity.parse.failed") return "malformed";
    if (type === "entity.too.large") return "too_large";
    return undefined;
  } catch {
    return undefined;
  }
}

function parseLastEventId(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new RequestValidationFailure([
      { path: "Last-Event-ID", message: "Must be a non-negative integer" },
    ]);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new RequestValidationFailure([
      { path: "Last-Event-ID", message: "Must be a safe non-negative integer" },
    ]);
  }
  return parsed;
}

async function writeSseFrame(
  response: Response,
  frame: string,
): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return false;
  if (response.write(frame)) return true;

  return new Promise<boolean>((resolve) => {
    const finish = (writable: boolean): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      resolve(writable);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const onError = (): void => finish(false);

    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    if (response.destroyed || response.writableEnded) finish(false);
  });
}

const MAX_SSE_HEARTBEAT_MILLIS = 60_000;
const MAX_SSE_POLL_MILLIS = 60_000;

interface HeartbeatSchedule {
  readonly intervalMillis: number;
  remainingMillis(): number;
  markActivity(): void;
}

function sseTiming(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between 1 and ${String(maximum)} milliseconds`,
    );
  }
  return value;
}

function createHeartbeatSchedule(
  intervalMillis: number,
  now: () => number,
): HeartbeatSchedule {
  const readNow = (): number => {
    const value = now();
    if (!Number.isFinite(value)) throw new Error("SSE_MONOTONIC_CLOCK_INVALID");
    return value;
  };
  let nextHeartbeatAt = readNow() + intervalMillis;

  return {
    intervalMillis,
    remainingMillis() {
      // Clamp to one full interval even if an injected/host monotonic source
      // behaves unexpectedly. A backwards jump must never suppress the
      // keepalive beyond the configured bound.
      return Math.max(0, Math.min(intervalMillis, nextHeartbeatAt - readNow()));
    },
    markActivity() {
      nextHeartbeatAt = readNow() + intervalMillis;
    },
  };
}

type HeartbeatAwaitResult<T> =
  { readonly kind: "value"; readonly value: T } | { readonly kind: "closed" };

/**
 * Waits for an operation while keeping an already-open SSE stream alive.
 *
 * Only this helper writes heartbeats while the operation is pending, and it
 * does not resolve an operation result until any in-flight heartbeat write
 * has drained. Product frames therefore never race a keepalive write.
 */
function awaitWithHeartbeats<T>(
  response: Response,
  startOperation: () => Promise<T>,
  heartbeat: HeartbeatSchedule,
): Promise<HeartbeatAwaitResult<T>> {
  if (response.destroyed || response.writableEnded) {
    return Promise.resolve({ kind: "closed" });
  }

  return new Promise<HeartbeatAwaitResult<T>>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatWrite: Promise<boolean> | undefined;
    let operationResult:
      | { readonly kind: "value"; readonly value: T }
      | { readonly kind: "error"; readonly error: unknown }
      | undefined;
    let settled = false;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      response.off("close", onClose);
      response.off("error", onClose);
    };

    const finishClosed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ kind: "closed" });
    };

    const maybeFinishOperation = (): void => {
      if (
        settled ||
        operationResult === undefined ||
        heartbeatWrite !== undefined
      )
        return;
      settled = true;
      cleanup();
      if (operationResult.kind === "error") {
        // Preserve the original rejection so the outer API error boundary can
        // classify branded/cross-realm failures without losing identity.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(operationResult.error);
      } else resolve(operationResult);
    };

    const writeHeartbeatNow = (): void => {
      heartbeatWrite = writeSseFrame(response, ": heartbeat\n\n");
      void heartbeatWrite.then(
        (writable) => {
          heartbeatWrite = undefined;
          if (!writable) {
            finishClosed();
            return;
          }
          heartbeat.markActivity();
          if (operationResult !== undefined) maybeFinishOperation();
          else scheduleHeartbeat();
        },
        () => {
          heartbeatWrite = undefined;
          finishClosed();
        },
      );
    };

    const finishSettledOperation = (): void => {
      if (operationResult?.kind !== "value") {
        maybeFinishOperation();
        return;
      }

      try {
        // A poll and its heartbeat can become due in the same timer turn. In
        // that tie, send the keepalive before exposing the poll result so a
        // succession of quick empty polls cannot starve the SSE connection.
        if (heartbeat.remainingMillis() <= 0) {
          writeHeartbeatNow();
          return;
        }
      } catch (error) {
        settled = true;
        cleanup();
        // Preserve hostile injected clock failures for the shared mapper.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
        return;
      }

      maybeFinishOperation();
    };

    const scheduleHeartbeat = (): void => {
      if (settled || operationResult !== undefined) return;
      let delay: number;
      try {
        delay = Math.ceil(heartbeat.remainingMillis());
      } catch (error) {
        settled = true;
        cleanup();
        // The injected monotonic clock is part of the hostile-boundary tests;
        // retain its exact thrown value for the shared mapper.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
        return;
      }
      // An already-exhausted budget must write now rather than through a zero
      // timer. An operation that settles faster than the interval resolves in a
      // microtask, which always precedes a due timer, so deferring here lets a
      // stream that polls quickly and finds nothing starve the client of bytes
      // indefinitely: every wait re-schedules from a budget that never refills.
      if (delay <= 0) {
        writeHeartbeatNow();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (settled || operationResult !== undefined) {
          maybeFinishOperation();
          return;
        }
        writeHeartbeatNow();
      }, delay);
    };

    const onClose = (): void => finishClosed();
    response.once("close", onClose);
    response.once("error", onClose);

    // Register the keepalive before starting the operation. When a poll delay
    // and heartbeat share a deadline, timer registration order then guarantees
    // the heartbeat is written first instead of being cancelled by the poll.
    scheduleHeartbeat();

    void Promise.resolve()
      .then(startOperation)
      .then(
        (value) => {
          operationResult = { kind: "value", value };
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          finishSettledOperation();
        },
        (error: unknown) => {
          operationResult = { kind: "error", error };
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          maybeFinishOperation();
        },
      );
  });
}

function delay(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

function page(
  query: unknown,
  binding: PaginationCursorBinding,
  decode: (binding: PaginationCursorBinding, cursor: string) => string,
): { readonly limit: number; readonly cursor?: string } {
  const parsed = (query ?? {}) as { limit?: number; cursor?: string };
  if (parsed.cursor === undefined)
    return { limit: parsed.limit ?? DEFAULT_PAGE_SIZE };
  try {
    return {
      limit: parsed.limit ?? DEFAULT_PAGE_SIZE,
      cursor: decode(binding, parsed.cursor),
    };
  } catch (error) {
    if (error instanceof InvalidPaginationCursor) {
      throw new RequestValidationFailure([
        { path: "cursor", message: "Cursor is invalid for this collection" },
      ]);
    }
    throw error;
  }
}

function publicPage<
  T extends {
    readonly items: readonly unknown[];
    readonly nextCursor?: string | undefined;
  },
>(
  value: T,
  binding: PaginationCursorBinding,
  encode: (binding: PaginationCursorBinding, rowId: string) => string,
): T {
  if (value.nextCursor === undefined) return value;
  return { ...value, nextCursor: encode(binding, value.nextCursor) };
}

function findingFilterBinding(query: unknown): string {
  const parsed = (query ?? {}) as {
    severity?: string;
    category?: string;
    state?: string;
  };
  return [
    `severity=${parsed.severity ?? ""}`,
    `category=${parsed.category ?? ""}`,
    `state=${parsed.state ?? ""}`,
  ].join("&");
}

export function createApiApp(options: ApiAppOptions): Express {
  const heartbeatMillis = sseTiming(
    "heartbeatMillis",
    options.heartbeatMillis ?? 15_000,
    MAX_SSE_HEARTBEAT_MILLIS,
  );
  const pollMillis = sseTiming(
    "pollMillis",
    options.pollMillis ?? 500,
    MAX_SSE_POLL_MILLIS,
  );
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const cursorCodec = createPaginationCursorCodec(options.cursorSecrets);

  const mutationIdentity = (
    context: RequestContext,
    routeName: RouteName,
    request: Request,
    semanticInput: unknown,
  ) => {
    const key = request.header("idempotency-key");
    if (key === undefined || key.length < 8 || key.length > 200)
      throw new IdempotencyKeyRequired();
    return {
      organizationId: context.scope.organizationId,
      principalId: context.principal.id,
      routeName,
      key,
      requestDigest: digest({ route: routeName, input: semanticInput }),
    };
  };
  const mutationResult = (
    outcome: Awaited<ReturnType<ApiMutationStore["cancelReview"]>>,
  ): { status: number; body: unknown } => {
    switch (outcome.kind) {
      case "result":
      case "replay":
        return { status: outcome.status, body: outcome.body };
      case "conflict":
        return {
          status: 409,
          body: errorBody(
            "IDEMPOTENCY_KEY_CONFLICT",
            "Idempotency key was already used for a different request",
          ),
        };
      case "in_progress":
        return {
          status: 409,
          body: errorBody(
            "IDEMPOTENCY_IN_PROGRESS",
            "An operation with this idempotency key is still in progress",
          ),
        };
    }
  };

  const app = express();
  const requestLogs = new WeakMap<
    Request,
    {
      readonly correlationId: string;
      readonly log: ReturnType<typeof attachRequestLog>;
    }
  >();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const requestCorrelationId = correlationId(request);
    response.setHeader("x-correlation-id", requestCorrelationId);
    requestLogs.set(request, {
      correlationId: requestCorrelationId,
      log: attachRequestLog(
        options,
        request,
        response,
        "unknown",
        requestCorrelationId,
      ),
    });
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: (error?: unknown) => void,
    ) => {
      const failure = bodyParserFailure(error);
      if (failure === "malformed") {
        sendError(
          response,
          400,
          "VALIDATION_ERROR",
          "Request body is not valid JSON",
        );
        return;
      }
      if (failure === "too_large") {
        sendError(
          response,
          413,
          "VALIDATION_ERROR",
          "Request body is too large",
        );
        return;
      }
      next(error);
    },
  );

  const handlers: Record<
    RouteName,
    (
      context: RequestContext,
      params: unknown,
      query: unknown,
      body: unknown,
      request: Request,
    ) => Promise<{ status: number; body: unknown }>
  > = {
    async listRepositories(context, _params, query) {
      const parsedQuery = API_ROUTES.listRepositories.query.parse(query);
      const binding: PaginationCursorBinding = {
        organizationId: context.scope.organizationId,
        collection: "repositories",
      };
      const p = page(parsedQuery, binding, (cursorBinding, cursor) =>
        cursorCodec.decode(cursorBinding, cursor),
      );
      const found = await options.api.listRepositories(
        context.scope,
        p.limit,
        p.cursor,
      );
      return {
        status: 200,
        body: publicPage(found, binding, (cursorBinding, rowId) =>
          cursorCodec.encode(cursorBinding, rowId),
        ),
      };
    },
    async getRepository(context, params) {
      const parsedParams = API_ROUTES.getRepository.params.parse(params);
      const found = await options.api.getRepository(
        context.scope,
        parsedParams.id,
      );
      return found === undefined
        ? { status: 404, body: errorBody("NOT_FOUND", "Repository not found") }
        : { status: 200, body: found };
    },
    async listPullRequests(context, params, query) {
      const parsedParams = API_ROUTES.listPullRequests.params.parse(params);
      const parsedQuery = API_ROUTES.listPullRequests.query.parse(query);
      const binding: PaginationCursorBinding = {
        organizationId: context.scope.organizationId,
        collection: "pull_requests",
        resource: parsedParams.repositoryId,
      };
      const p = page(parsedQuery, binding, (cursorBinding, cursor) =>
        cursorCodec.decode(cursorBinding, cursor),
      );
      const found = await options.api.listPullRequests(
        context.scope,
        parsedParams.repositoryId,
        p.limit,
        p.cursor,
      );
      return found === undefined
        ? { status: 404, body: errorBody("NOT_FOUND", "Repository not found") }
        : {
            status: 200,
            body: publicPage(found, binding, (cursorBinding, rowId) =>
              cursorCodec.encode(cursorBinding, rowId),
            ),
          };
    },
    async createReview(context, _params, _query, body, request) {
      const parsedBody = API_ROUTES.createReview.body.parse(body);
      if (parsedBody.pullRequestId === undefined)
        return {
          status: 409,
          body: errorBody(
            "REVIEW_TARGET_NOT_AVAILABLE",
            "This API checkpoint requires pullRequestId",
          ),
        };
      if (
        parsedBody.depth !== undefined ||
        parsedBody.categories !== undefined ||
        parsedBody.reviewDrafts !== undefined
      )
        return {
          status: 409,
          body: errorBody(
            "REVIEW_OVERRIDES_NOT_AVAILABLE",
            "Review overrides are not enabled by the current execution runtime",
          ),
        };
      const identity = mutationIdentity(
        context,
        "createReview",
        request,
        parsedBody,
      );
      return mutationResult(
        await options.mutations.createReview({
          identity,
          repositoryId: parsedBody.repositoryId,
          pullRequestId: parsedBody.pullRequestId,
          requestedBy: {
            kind: context.principal.kind,
            id: context.principal.id,
          },
          correlationId: context.correlationId,
        }),
      );
    },
    async getReview(context, params) {
      const parsedParams = API_ROUTES.getReview.params.parse(params);
      const found = await options.api.getReview(context.scope, parsedParams.id);
      return found === undefined
        ? { status: 404, body: errorBody("NOT_FOUND", "Review not found") }
        : { status: 200, body: found };
    },
    async cancelReview(context, params, _query, body, request) {
      const parsedParams = API_ROUTES.cancelReview.params.parse(params);
      const parsedBody = API_ROUTES.cancelReview.body.parse(body);
      const identity = mutationIdentity(context, "cancelReview", request, {
        params: parsedParams,
        body: parsedBody,
      });
      return mutationResult(
        await options.mutations.cancelReview({
          identity,
          reviewRunId: parsedParams.id,
          ...(parsedBody.reason === undefined
            ? {}
            : { reason: parsedBody.reason }),
        }),
      );
    },
    async getReviewSummary(context, params) {
      const parsedParams = API_ROUTES.getReviewSummary.params.parse(params);
      const found = await options.api.getReviewSummary(
        context.scope,
        parsedParams.id,
      );
      return found === undefined
        ? {
            status: 404,
            body: errorBody("NOT_FOUND", "Review summary not found"),
          }
        : { status: 200, body: found };
    },
    async listReviewFindings(context, params, query) {
      const parsedParams = API_ROUTES.listReviewFindings.params.parse(params);
      const parsedQuery = API_ROUTES.listReviewFindings.query.parse(query);
      const binding: PaginationCursorBinding = {
        organizationId: context.scope.organizationId,
        collection: "findings",
        resource: parsedParams.id,
        query: findingFilterBinding(parsedQuery),
      };
      const p = page(parsedQuery, binding, (cursorBinding, cursor) =>
        cursorCodec.decode(cursorBinding, cursor),
      );
      const found = await options.api.listReviewFindings(
        context.scope,
        parsedParams.id,
        p.limit,
        p.cursor,
        parsedQuery,
      );
      return found === undefined
        ? { status: 404, body: errorBody("NOT_FOUND", "Review not found") }
        : {
            status: 200,
            body: publicPage(found, binding, (cursorBinding, rowId) =>
              cursorCodec.encode(cursorBinding, rowId),
            ),
          };
    },
    async listReviewChecks(context, params) {
      const parsedParams = API_ROUTES.listReviewChecks.params.parse(params);
      const found = await options.api.listReviewChecks(
        context.scope,
        parsedParams.id,
      );
      if (found === undefined)
        return {
          status: 404,
          body: errorBody("NOT_FOUND", "Review not found"),
        };
      // This frozen route intentionally has no cursor query. Refuse any
      // persistence adapter that tries to surface an unusable continuation.
      if (found.nextCursor !== undefined)
        throw new Error("NON_PAGEABLE_CHECK_CURSOR_VIOLATION");
      return { status: 200, body: { items: found.items } };
    },
    async getFinding(context, params) {
      const parsedParams = API_ROUTES.getFinding.params.parse(params);
      const found = await options.api.getFinding(
        context.scope,
        parsedParams.id,
      );
      return found === undefined
        ? { status: 404, body: errorBody("NOT_FOUND", "Finding not found") }
        : { status: 200, body: found };
    },
    async dismissFinding(context, params, _query, body, request) {
      const parsedParams = API_ROUTES.dismissFinding.params.parse(params);
      const parsedBody = API_ROUTES.dismissFinding.body.parse(body);
      const identity = mutationIdentity(context, "dismissFinding", request, {
        params: parsedParams,
        body: parsedBody,
      });
      return mutationResult(
        await options.mutations.dismissFinding({
          identity,
          findingId: parsedParams.id,
          reason: parsedBody.reason,
        }),
      );
    },
    async listConversations(context, params, query) {
      const parsedParams = API_ROUTES.listConversations.params.parse(params);
      const parsedQuery = API_ROUTES.listConversations.query.parse(query);
      const binding: PaginationCursorBinding = {
        organizationId: context.scope.organizationId,
        collection: "conversations",
        resource: parsedParams.repositoryId,
      };
      const p = page(parsedQuery, binding, (cursorBinding, cursor) =>
        cursorCodec.decode(cursorBinding, cursor),
      );
      const found = await options.api.listConversations(
        context.scope,
        parsedParams.repositoryId,
        p.limit,
        p.cursor,
      );
      return found === undefined
        ? { status: 404, body: errorBody("NOT_FOUND", "Repository not found") }
        : {
            status: 200,
            body: publicPage(found, binding, (cursorBinding, rowId) =>
              cursorCodec.encode(cursorBinding, rowId),
            ),
          };
    },
    async resolveConversation(context, params, _query, _body, request) {
      const parsedParams = API_ROUTES.resolveConversation.params.parse(params);
      const identity = mutationIdentity(
        context,
        "resolveConversation",
        request,
        { params: parsedParams },
      );
      return mutationResult(
        await options.mutations.resolveConversation({
          identity,
          conversationId: parsedParams.id,
        }),
      );
    },
    async listKnowledge(context, _params, query) {
      const parsedQuery = API_ROUTES.listKnowledge.query.parse(query);
      const binding: PaginationCursorBinding = {
        organizationId: context.scope.organizationId,
        collection: "knowledge",
      };
      const p = page(parsedQuery, binding, (cursorBinding, cursor) =>
        cursorCodec.decode(cursorBinding, cursor),
      );
      const found = await options.api.listKnowledge(
        context.scope,
        p.limit,
        p.cursor,
      );
      return {
        status: 200,
        body: publicPage(found, binding, (cursorBinding, rowId) =>
          cursorCodec.encode(cursorBinding, rowId),
        ),
      };
    },
  };

  for (const [name, route] of Object.entries(API_ROUTES) as [
    RouteName,
    RouteDefinition,
  ][]) {
    const method = route.method.toLowerCase() as
      "get" | "post" | "patch" | "delete";
    app[method](`/api/v1${route.path}`, async (request, response) => {
      const requestLog = requestLogs.get(request);
      if (requestLog === undefined) {
        sendError(
          response,
          500,
          "INTERNAL_ERROR",
          "The request could not be completed",
        );
        return;
      }
      requestLog.log.setRouteName(name);

      try {
        const context = await authenticate(
          options,
          request,
          name,
          requestLog.correlationId,
        );
        requestLog.log.setContext(context);
        const params = parsePart(route.params, request.params);
        const query = parsePart(route.query, queryObject(request));
        // Express 5 leaves `request.body` undefined when a request carries no
        // body, where Express 4 substituted `{}`. A route whose body fields are
        // all optional must still accept a bodiless request, so absence is
        // normalized to an empty object and left to the route's own schema to
        // judge. This is not a relaxation: a schema with a required field still
        // rejects `{}`, and a body that was sent and failed to parse is already
        // refused upstream.
        const body = parsePart(
          route.body,
          request.body === undefined ? {} : request.body,
        );
        const result = await handlers[name](
          context,
          params,
          query,
          body,
          request,
        );
        if (result.status >= 200 && result.status < 300) {
          const checked = route.response.safeParse(result.body);
          if (!checked.success) throw new Error("RESPONSE_CONTRACT_VIOLATION");
          response.status(route.successStatus).json(checked.data);
          return;
        }
        // Keep this explicit widening as the source-level Phase 3 acceptance
        // anchor: handler status values are compared with a numeric manifest,
        // never trusted merely because a handler returned them.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const declaredErrorStatuses = route.errorStatuses as readonly number[];
        if (!declaredErrorStatuses.includes(result.status)) {
          sendErrorBody(response, 500, INTERNAL_ERROR_BODY);
          return;
        }
        const errorResult = errorResponseSchema.safeParse(result.body);
        if (!errorResult.success) {
          sendErrorBody(response, 500, INTERNAL_ERROR_BODY);
          return;
        }
        sendErrorBody(response, result.status, errorResult.data);
      } catch (error) {
        sendMappedError(response, error);
      }
    });
  }

  app.get(`/api/v1${REVIEW_EVENTS_STREAM.path}`, async (request, response) => {
    const requestLog = requestLogs.get(request);
    if (requestLog === undefined) {
      sendError(
        response,
        500,
        "INTERNAL_ERROR",
        "The request could not be completed",
      );
      return;
    }
    requestLog.log.setRouteName("reviewEvents");

    let context: RequestContext;
    let id: string;
    let after: number;
    let events: Awaited<ReturnType<ApiStore["reviewEvents"]>>;
    try {
      context = await authenticate(
        options,
        request,
        "getReview",
        requestLog.correlationId,
      );
      requestLog.log.setContext(context);
      const params = parsePart(REVIEW_EVENTS_STREAM.params, request.params) as {
        id: string;
      };
      id = params.id;
      after = parseLastEventId(request.header("last-event-id"));
      events = await options.api.reviewEvents(context.scope, id, after, 100);
      if (events === undefined) {
        sendError(response, 404, "NOT_FOUND", "Review not found");
        return;
      }
    } catch (error) {
      sendMappedError(response, error);
      return;
    }

    response.status(200);
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();

    const heartbeat = createHeartbeatSchedule(heartbeatMillis, monotonicNow);

    try {
      while (!response.destroyed && !response.writableEnded) {
        for (const event of events) {
          if (!Number.isSafeInteger(event.id) || event.id <= after) {
            throw new Error("SSE_EVENT_SEQUENCE_VIOLATION");
          }
          const raw = event.data as {
            readonly to?: unknown;
            readonly at?: unknown;
          };
          const projected = toReviewProgressEvent(
            id,
            raw.to as Parameters<typeof toReviewProgressEvent>[1],
            raw.at as Parameters<typeof toReviewProgressEvent>[2],
          );
          const checked = reviewProgressEventSchema.parse(projected);
          const terminal = [
            "completed",
            "failed",
            "cancelled",
            "superseded",
          ].includes(checked.state);
          const frame =
            `id: ${String(event.id)}\n` +
            `event: ${terminal ? REVIEW_PROGRESS_DONE_EVENT_NAME : REVIEW_PROGRESS_EVENT_NAME}\n` +
            `data: ${JSON.stringify(checked)}\n\n`;
          if (!(await writeSseFrame(response, frame))) return;
          heartbeat.markActivity();
          after = event.id;
          if (terminal) {
            response.end();
            return;
          }
        }

        if (events.length < 100) {
          const pollWait = await awaitWithHeartbeats(
            response,
            () => delay(pollMillis),
            heartbeat,
          );
          if (pollWait.kind === "closed") return;
        }

        const queried = await awaitWithHeartbeats(
          response,
          () => options.api.reviewEvents(context.scope, id, after, 100),
          heartbeat,
        );
        if (queried.kind === "closed") return;
        events = queried.value;
        if (events === undefined) {
          response.end();
          return;
        }
      }
    } catch {
      // Once SSE headers are on the wire there is no safe JSON error response.
      // Closing the transport makes the client reconnect from its last durable id.
      response.destroy();
    }
  });

  app.use("/api/v1", (_request, response) => {
    sendError(response, 404, "NOT_FOUND", "API route not found");
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: (error?: unknown) => void,
    ) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendMappedError(response, error);
    },
  );

  return app;
}
