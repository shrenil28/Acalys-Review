/**
 * The GitHub webhook route.
 *
 * One invariant, in order, and the order is the design:
 *
 *     bounded raw bytes → required headers → HMAC → durable ownership
 *                       → 202 → asynchronous processing
 *
 * Nothing semantic happens before the HMAC. An unauthenticated request must not
 * cost a JSON parse of a five-megabyte body, let alone a database round trip —
 * that asymmetry (cheap to send, expensive to reject) is what makes a public
 * endpoint a denial-of-service target.
 *
 * # The raw-body rule
 *
 * The signature is an HMAC over the bytes GitHub sent. `express.json()` parses
 * and discards them, so a route mounted after a global JSON parser can only
 * re-serialize — and `JSON.parse` → `JSON.stringify` is not the identity
 * function. Every delivery then fails verification, and the tempting fix is to
 * disable verification.
 *
 * So this route mounts `express.raw()` on itself. That wins regardless of what
 * global parsers the application has, because Express runs route-level
 * middleware for the matching route and `express.json()` skips a body it has
 * already seen consumed. `tests/gateway.test.ts` mounts a global
 * `express.json()` on purpose and asserts the handler still receives a Buffer:
 * a correct signature module behind a wrong middleware order is a broken
 * gateway, and only an integration test catches it.
 */

import express, { type Request, type Response, type Router } from "express";

import {
  digestBody,
  type IngestOutcome,
  type JobRequest,
  type WebhookInbox,
} from "@acalys/database";
import {
  isHandledAction,
  readDeliveryHeaders,
  verifyWebhookSignature,
  type SignatureFailure,
} from "@acalys/provider-github";

/**
 * Ceiling on an accepted body.
 *
 * GitHub caps payloads at 25 MB. Anything larger is not a delivery, and reading
 * it costs memory before a single byte can be authenticated. Rejected by
 * `express.raw` before the handler runs.
 */
export const MAX_BODY_BYTES = 26_214_400;

/**
 * Events the gateway schedules work for.
 *
 * A validly signed delivery for anything else is recorded and acknowledged, not
 * rejected. GitHub's event vocabulary grows, and a 4xx on an unrecognized event
 * marks the hook as failing in the GitHub UI — an operator then sees a broken
 * integration where the platform is merely uninterested.
 */
export const SUPPORTED_EVENTS = new Set([
  "pull_request",
  "installation",
  "installation_repositories",
]);

/** Job kinds this route schedules. */
export const JOB_PULL_REQUEST = "github.pull_request";
export const JOB_INSTALLATION = "github.installation";

export interface GatewayObserver {
  /** Called for every terminal outcome. Never receives a body or a signature. */
  readonly onOutcome?: (event: {
    readonly outcome: string;
    readonly deliveryId?: string | undefined;
    readonly event?: string | undefined;
    readonly reason?: string | undefined;
  }) => void;
}

export interface GithubWebhookRouteOptions {
  readonly secret: string;
  /** Identifies this endpoint; the uniqueness scope for delivery ids. */
  readonly sourceEndpointId: string;
  readonly inbox: WebhookInbox;
  readonly now?: (() => Date) | undefined;
  readonly observer?: GatewayObserver | undefined;
}

/**
 * Failure reasons, kept away from the response body.
 *
 * The client is told only the status. Distinguishing "malformed signature" from
 * "signature mismatch" in the response tells an attacker how far they got,
 * which is free reconnaissance against the one endpoint anyone can reach.
 */
const SIGNATURE_STATUS: Readonly<Record<SignatureFailure, number>> = {
  missing_signature: 401,
  malformed_signature: 401,
  mismatch: 401,
  empty_body: 400,
  // A misconfigured deployment, not a caller error. 500 so it pages someone
  // rather than looking like GitHub sending bad requests.
  empty_secret: 500,
};

/** Work a delivery schedules, if any. */
function jobsFor(event: string, body: Buffer): readonly JobRequest[] {
  if (event === "pull_request") {
    // The action is read only to decide whether to schedule. Parsing here is
    // safe: the body is authenticated by this point, and the parse result is
    // deliberately *not* passed on — the worker re-reads the retained bytes,
    // so there is one parsing path rather than two that can disagree.
    const action = readAction(body);
    if (action === undefined || !isHandledAction(action)) return [];
    return [{ kind: JOB_PULL_REQUEST, payload: { action } }];
  }
  if (event === "installation" || event === "installation_repositories") {
    return [{ kind: JOB_INSTALLATION, payload: { event } }];
  }
  return [];
}

/** The `action` field, or undefined if the body is not a JSON object. */
function readAction(body: Buffer): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const action = (parsed as { readonly action?: unknown }).action;
    return typeof action === "string" ? action : undefined;
  } catch {
    // A body that passed the HMAC and is not JSON means GitHub changed its
    // encoding, not that someone forged it. Recorded and ignored.
    return undefined;
  }
}

function statusFor(outcome: IngestOutcome): number {
  switch (outcome.kind) {
    case "accepted":
    case "duplicate":
      // A redelivery of something already owned is the system working. A
      // non-2xx would mark the hook as failing in the GitHub UI.
      return 202;
    case "conflict":
      // Same delivery id, different bytes. Not a duplicate, and not something
      // to silently drop — 409 makes it visible in GitHub's delivery log too.
      return 409;
  }
}

export function createGithubWebhookRoute(
  options: GithubWebhookRouteOptions,
): Router {
  const router = express.Router();
  const now = options.now ?? (() => new Date());
  const report = options.observer?.onOutcome ?? (() => undefined);

  router.post(
    "/",
    // Route-level, so the exact bytes survive whatever the application mounted
    // globally. `type: () => true` accepts any content type: GitHub sends
    // `application/json`, but a content-type check here would reject a delivery
    // the signature would have proven genuine.
    express.raw({ type: () => true, limit: MAX_BODY_BYTES }),
    (request: Request, response: Response): void => {
      void handle(request, response);
    },
  );

  async function handle(request: Request, response: Response): Promise<void> {
    const body: unknown = request.body;

    // A non-Buffer body means a JSON parser ran first and the bytes are gone.
    // Failing loudly beats verifying a re-serialization that can never match.
    if (!Buffer.isBuffer(body)) {
      report({ outcome: "raw_body_missing" });
      response.status(500).json({ error: "internal_error" });
      return;
    }

    const headers = readDeliveryHeaders(request.headers);
    if (headers === undefined) {
      report({ outcome: "invalid_headers" });
      response.status(400).json({ error: "bad_request" });
      return;
    }

    const verification = verifyWebhookSignature(
      options.secret,
      body,
      headers.signature,
    );
    if (!verification.ok) {
      // The reason goes to the observer, never to the response.
      report({
        outcome: "signature_rejected",
        deliveryId: headers.deliveryId,
        event: headers.event,
        reason: verification.reason,
      });
      response
        .status(SIGNATURE_STATUS[verification.reason])
        .json({ error: "unauthorized" });
      return;
    }

    // Authenticated from here. Semantic work may begin.
    const receivedAt = now();
    const jobs = SUPPORTED_EVENTS.has(headers.event)
      ? jobsFor(headers.event, body)
      : [];

    let outcome: IngestOutcome;
    try {
      outcome = await options.inbox.ingest(
        {
          provider: "github",
          sourceEndpointId: options.sourceEndpointId,
          deliveryId: headers.deliveryId,
          event: headers.event,
          action: readAction(body) ?? null,
          bodyDigest: digestBody(body),
          payload: body,
          receivedAt,
        },
        jobs,
      );
    } catch (error) {
      // Persistence is down. 5xx, so GitHub records a failure an operator can
      // find — but note it will **not** redeliver, so this must also feed the
      // recovery path. Never 2xx: acknowledging work that was not stored loses
      // the event permanently.
      report({
        outcome: "ingest_failed",
        deliveryId: headers.deliveryId,
        event: headers.event,
        reason: (error as Error).name,
      });
      response.status(503).json({ error: "unavailable" });
      return;
    }

    if (outcome.kind === "accepted" && jobs.length === 0) {
      // Validly signed, durably recorded, nothing to do. Distinct from
      // `processed`, so "did we act on this?" stays answerable.
      await options.inbox.markDeliveryState(
        outcome.delivery.id,
        "ignored",
        `unsupported event or action: ${headers.event}`,
      );
    }

    report({
      outcome:
        outcome.kind === "accepted" && jobs.length === 0
          ? "ignored"
          : outcome.kind,
      deliveryId: headers.deliveryId,
      event: headers.event,
    });

    response.status(statusFor(outcome)).json({ status: outcome.kind });
  }

  return router;
}
