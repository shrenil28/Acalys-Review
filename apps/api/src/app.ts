import { createHash, randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";

import { requireScope, type ApiScope, type AuthService, type Principal } from "@acalys/auth";
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
  ApiMutationStore,
  ApiStore,
  type ApiTenantScope,
} from "@acalys/database";

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
  readonly now?: () => Date;
  readonly heartbeatMillis?: number;
  readonly pollMillis?: number;
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
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request.query)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

type ApiRetryability = "retryable" | "non_retryable" | "conditional";

interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryability: ApiRetryability;
  readonly fields?: readonly { readonly path: string; readonly message: string }[] | undefined;
}

const INTERNAL_ERROR_BODY: ApiErrorBody = {
  code: "INTERNAL_ERROR",
  message: "The request could not be completed",
  retryability: "non_retryable",
};

class RequestValidationFailure extends Error {
  constructor(
    readonly fields: readonly { readonly path: string; readonly message: string }[],
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

function sendErrorBody(response: Response, status: number, body: ApiErrorBody): void {
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

function mapError(error: unknown): { readonly status: number; readonly body: ApiErrorBody } {
  try {
    if (isAcalysError(error)) {
      const code = error.code;
      const message = PUBLIC_ACALYS_ERROR_MESSAGE[code] ?? INTERNAL_ERROR_BODY.message;
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

function safeValidationFields(issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]) {
  return issues.slice(0, 100).map((issue) => ({
    path: bounded(issue.path.map(String).join("."), TEXT_LIMITS.identifier),
    message: bounded(issue.message, TEXT_LIMITS.summary),
  }));
}

function parsePart(schema: RouteDefinition["params"] | RouteDefinition["query"] | RouteDefinition["body"], value: unknown): unknown {
  if (schema === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new RequestValidationFailure(safeValidationFields(parsed.error.issues));
}

async function authenticate(options: ApiAppOptions, request: Request, routeName: RouteName, correlationId: string): Promise<RequestContext> {
  const principal = await options.auth.authenticateBearer(request.header("authorization"));
  requireScope(principal, ROUTE_SCOPE[routeName]);
  const allowed = await options.consumeRate({
    organizationId: principal.organizationId,
    principalId: principal.id,
  });
  if (!allowed) throw new RateLimitExceeded();
  return { principal, scope: { organizationId: principal.organizationId }, correlationId };
}


function correlationId(request: Request): string {
  const supplied = request.header("x-correlation-id");
  if (supplied !== undefined && supplied.length >= 1 && supplied.length <= TEXT_LIMITS.identifier) {
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
      sendError(response, 429, "RATE_LIMITED", "Rate limit exceeded", "retryable");
      return;
    }
  } catch {
    // A hostile thrown Proxy can make instanceof itself throw. Fall through.
  }
  const mapped = mapError(error);
  sendErrorBody(response, mapped.status, mapped.body);
}

function bodyParserFailure(error: unknown): "malformed" | "too_large" | undefined {
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

async function writeSseFrame(response: Response, frame: string): Promise<boolean> {
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

async function waitForPoll(response: Response, millis: number): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(true), millis);
    const onClose = (): void => finish(false);
    const finish = (open: boolean): void => {
      clearTimeout(timer);
      response.off("close", onClose);
      resolve(open);
    };
    response.once("close", onClose);
  });
}

function page(query: unknown): { readonly limit: number; readonly cursor?: string } {
  const parsed = (query ?? {}) as { limit?: number; cursor?: string };
  return { limit: parsed.limit ?? DEFAULT_PAGE_SIZE, ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }) };
}

export function createApiApp(options: ApiAppOptions): Express {
  const mutationIdentity = (context: RequestContext, routeName: RouteName, request: Request, semanticInput: unknown) => {
    const key=request.header("idempotency-key");
    if(key===undefined||key.length<8||key.length>200)return undefined;
    return { organizationId:context.scope.organizationId, principalId:context.principal.id, routeName, key, requestDigest:digest({route:routeName,input:semanticInput}), now:(options.now??(()=>new Date()))() };
  };
  const mutationResult = (outcome: Awaited<ReturnType<ApiMutationStore["cancelReview"]>>): {status:number;body:unknown} => {
    switch(outcome.kind){
      case "result": case "replay": return {status:outcome.status,body:outcome.body};
      case "conflict": return {status:409,body:errorBody("IDEMPOTENCY_KEY_CONFLICT","Idempotency key was already used for a different request")};
      case "in_progress": return {status:409,body:errorBody("IDEMPOTENCY_IN_PROGRESS","An operation with this idempotency key is still in progress")};
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
      log: attachRequestLog(options, request, response, "unknown", requestCorrelationId),
    });
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use((error: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
    const failure = bodyParserFailure(error);
    if (failure === "malformed") {
      sendError(response, 400, "VALIDATION_ERROR", "Request body is not valid JSON");
      return;
    }
    if (failure === "too_large") {
      sendError(response, 413, "VALIDATION_ERROR", "Request body is too large");
      return;
    }
    next(error);
  });

  const handlers: Record<RouteName, (context: RequestContext, params: any, query: any, body: any, request: Request) => Promise<{ status: number; body: unknown }>> = {
    async listRepositories(context, _params, query) {
      const p = page(query); return { status: 200, body: await options.api.listRepositories(context.scope, p.limit, p.cursor) };
    },
    async getRepository(context, params) {
      const found = await options.api.getRepository(context.scope, params.id);
      return found === undefined ? { status: 404, body: errorBody("NOT_FOUND", "Repository not found") } : { status: 200, body: found };
    },
    async listPullRequests(context, params, query) {
      const p = page(query); const found = await options.api.listPullRequests(context.scope, params.repositoryId, p.limit, p.cursor);
      return found === undefined ? { status: 404, body: errorBody("NOT_FOUND", "Repository not found") } : { status: 200, body: found };
    },
    async createReview(context, _params, _query, body, request) {
      if(body.pullRequestId===undefined)return{status:409,body:errorBody("REVIEW_TARGET_NOT_AVAILABLE","This API checkpoint requires pullRequestId")};
      if(body.depth!==undefined||body.categories!==undefined||body.reviewDrafts!==undefined)return{status:409,body:errorBody("REVIEW_OVERRIDES_NOT_AVAILABLE","Review overrides are not enabled by the current execution runtime")};
      const identity=mutationIdentity(context,"createReview",request,body); if(identity===undefined)return{status:400,body:errorBody("IDEMPOTENCY_KEY_REQUIRED","A valid Idempotency-Key header is required")};
      return mutationResult(await options.mutations.createReview({identity,repositoryId:body.repositoryId,pullRequestId:body.pullRequestId,requestedBy:{kind:context.principal.kind,id:context.principal.id},correlationId:context.correlationId}));
    },
    async getReview(context, params) {
      const found = await options.api.getReview(context.scope, params.id); return found === undefined ? { status: 404, body: errorBody("NOT_FOUND", "Review not found") } : { status: 200, body: found };
    },
    async cancelReview(context, params, _query, body, request) {
      const identity=mutationIdentity(context,"cancelReview",request,{params,body}); if(identity===undefined)return{status:400,body:errorBody("IDEMPOTENCY_KEY_REQUIRED","A valid Idempotency-Key header is required")};
      return mutationResult(await options.mutations.cancelReview({identity,reviewRunId:params.id,...(body?.reason===undefined?{}:{reason:body.reason})}));
    },
    async getReviewSummary(context, params) { const found = await options.api.getReviewSummary(context.scope, params.id); return found === undefined ? { status: 404, body: errorBody("NOT_FOUND", "Review summary not found") } : { status: 200, body: found }; },
    async listReviewFindings(context, params, query) { const p=page(query); const found=await options.api.listReviewFindings(context.scope, params.id, p.limit, p.cursor, query ?? {}); return found===undefined?{status:404,body:errorBody("NOT_FOUND","Review not found")}:{status:200,body:found}; },
    async listReviewChecks(context, params) { const found=await options.api.listReviewChecks(context.scope, params.id); return found===undefined?{status:404,body:errorBody("NOT_FOUND","Review not found")}:{status:200,body:found}; },
    async getFinding(context, params) { const found=await options.api.getFinding(context.scope, params.id); return found===undefined?{status:404,body:errorBody("NOT_FOUND","Finding not found")}:{status:200,body:found}; },
    async dismissFinding(context, params, _query, body, request) {
      const identity=mutationIdentity(context,"dismissFinding",request,{params,body}); if(identity===undefined)return{status:400,body:errorBody("IDEMPOTENCY_KEY_REQUIRED","A valid Idempotency-Key header is required")};
      return mutationResult(await options.mutations.dismissFinding({identity,findingId:params.id,reason:body.reason}));
    },
    async listConversations(context, params, query) { const p=page(query); const found=await options.api.listConversations(context.scope,params.repositoryId,p.limit,p.cursor); return found===undefined?{status:404,body:errorBody("NOT_FOUND","Repository not found")}:{status:200,body:found}; },
    async resolveConversation(context, params, _query, _body, request) {
      const identity=mutationIdentity(context,"resolveConversation",request,{params}); if(identity===undefined)return{status:400,body:errorBody("IDEMPOTENCY_KEY_REQUIRED","A valid Idempotency-Key header is required")};
      return mutationResult(await options.mutations.resolveConversation({identity,conversationId:params.id}));
    },
    async listKnowledge(context, _params, query) { const p=page(query); return{status:200,body:await options.api.listKnowledge(context.scope,p.limit,p.cursor)}; },
  };

  for (const [name, route] of Object.entries(API_ROUTES) as [RouteName, RouteDefinition][]) {
    const method = route.method.toLowerCase() as "get" | "post" | "patch" | "delete";
    app[method](`/api/v1${route.path}`, async (request, response) => {
      const requestLog = requestLogs.get(request);
      if (requestLog === undefined) {
        sendError(response, 500, "INTERNAL_ERROR", "The request could not be completed");
        return;
      }
      requestLog.log.setRouteName(name);

      try {
        const context = await authenticate(options, request, name, requestLog.correlationId);
        requestLog.log.setContext(context);
        const params = parsePart(route.params, request.params);
        const query = parsePart(route.query, queryObject(request));
        const body = parsePart(route.body, request.body);
        const result = await handlers[name](context, params, query, body, request);
        if (result.status >= 200 && result.status < 300) {
          const checked = route.response.safeParse(result.body);
          if (!checked.success) throw new Error("RESPONSE_CONTRACT_VIOLATION");
          response.status(route.successStatus).json(checked.data);
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
      sendError(response, 500, "INTERNAL_ERROR", "The request could not be completed");
      return;
    }
    requestLog.log.setRouteName("reviewEvents");

    let context: RequestContext;
    let id: string;
    let after: number;
    let events: Awaited<ReturnType<ApiStore["reviewEvents"]>>;
    try {
      context = await authenticate(options, request, "getReview", requestLog.correlationId);
      requestLog.log.setContext(context);
      const params = parsePart(REVIEW_EVENTS_STREAM.params, request.params) as { id: string };
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

    const pollMillis = options.pollMillis ?? 500;
    const heartbeatMillis = options.heartbeatMillis ?? 15_000;
    let lastBeat = Date.now();

    try {
      while (!response.destroyed && !response.writableEnded) {
        for (const event of events) {
          if (!Number.isSafeInteger(event.id) || event.id <= after) {
            throw new Error("SSE_EVENT_SEQUENCE_VIOLATION");
          }
          const raw = event.data as { readonly to?: unknown; readonly at?: unknown };
          const projected = toReviewProgressEvent(id, raw.to as Parameters<typeof toReviewProgressEvent>[1], raw.at as Parameters<typeof toReviewProgressEvent>[2]);
          const checked = reviewProgressEventSchema.parse(projected);
          const terminal = ["completed", "failed", "cancelled", "superseded"].includes(
            checked.state,
          );
          const frame =
            `id: ${String(event.id)}\n` +
            `event: ${terminal ? REVIEW_PROGRESS_DONE_EVENT_NAME : REVIEW_PROGRESS_EVENT_NAME}\n` +
            `data: ${JSON.stringify(checked)}\n\n`;
          if (!(await writeSseFrame(response, frame))) return;
          after = event.id;
          if (terminal) {
            response.end();
            return;
          }
        }

        if (events.length < 100) {
          if (Date.now() - lastBeat >= heartbeatMillis) {
            if (!(await writeSseFrame(response, ": heartbeat\n\n"))) return;
            lastBeat = Date.now();
          }
          if (!(await waitForPoll(response, pollMillis))) return;
        }

        events = await options.api.reviewEvents(context.scope, id, after, 100);
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

  app.use((error: unknown, _request: Request, response: Response, _next: (error?: unknown) => void) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendMappedError(response, error);
  });

  return app;
}
