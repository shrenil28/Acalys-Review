/**
 * The gateway application.
 *
 * Deliberately assembles a *global* `express.json()` alongside the webhook
 * route, because that is what a real application looks like — health checks,
 * an admin surface, and eventually the API all want parsed bodies. The webhook
 * route's own `express.raw()` is what keeps its bytes intact, and mounting the
 * global parser here means the integration test exercises the arrangement that
 * actually ships rather than a simplified one.
 *
 * Middleware order is load-bearing and reads top to bottom:
 *
 *     security headers  → every response, including errors
 *     webhook route     → its own raw body parser
 *     global json       → everything else
 *     health            → no auth, no state
 *     error handler     → last, so it sees everything above it
 */

import express, { type Express } from "express";

import {
  createGithubWebhookRoute,
  type GithubWebhookRouteOptions,
} from "./route.js";
import { errorHandler, securityHeaders } from "./security.js";

export interface GatewayOptions {
  readonly github: GithubWebhookRouteOptions;
  /** Readiness check for durable dependencies. */
  readonly readiness?: (() => Promise<void>) | undefined;
  /** Called for every unhandled error. Never receives a response object. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

export function createGatewayApp(options: GatewayOptions): Express {
  const app = express();

  // Advertising the framework and version tells an attacker which CVEs to try.
  app.disable("x-powered-by");

  // `trust proxy` is deliberately NOT enabled. Turning it on makes Express
  // believe `X-Forwarded-For`, which is caller-supplied — so anyone could
  // forge a client address and defeat the rate limiter, or fill its key space.
  // A deployment behind a load balancer must set this to the *known* number of
  // proxies, which is a fact about the deployment and cannot be guessed here.

  app.use(securityHeaders());

  // Mounted BEFORE the global JSON parser. Route-level `express.raw()` would
  // win either way, but ordering it first states the intent and removes any
  // dependence on that subtlety.
  app.use("/webhooks/github", createGithubWebhookRoute(options.github));

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_request, response) => {
    // Liveness only: no database call, no credential check. A health endpoint
    // that touches a dependency turns a slow dependency into a restart loop,
    // which converts degradation into an outage.
    response.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_request, response) => {
    try {
      await options.readiness?.();
      response.status(200).json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });

  // Last. An error handler mounted before a route never sees that route's
  // errors, which is the quiet way this protection gets disabled.
  app.use(errorHandler(options.onError));

  return app;
}
