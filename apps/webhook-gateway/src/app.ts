/**
 * The gateway application.
 *
 * Deliberately assembles a *global* `express.json()` alongside the webhook
 * route, because that is what a real application looks like — health checks,
 * an admin surface, and eventually the API all want parsed bodies. The webhook
 * route's own `express.raw()` is what keeps its bytes intact, and mounting the
 * global parser here means the integration test exercises the arrangement that
 * actually ships rather than a simplified one.
 */

import express, { type Express } from "express";

import {
  createGithubWebhookRoute,
  type GithubWebhookRouteOptions,
} from "./route.js";

export interface GatewayOptions {
  readonly github: GithubWebhookRouteOptions;
}

export function createGatewayApp(options: GatewayOptions): Express {
  const app = express();

  app.disable("x-powered-by");

  // Mounted BEFORE the global JSON parser. Route-level `express.raw()` would
  // win either way, but ordering it first states the intent and removes any
  // dependence on that subtlety.
  app.use("/webhooks/github", createGithubWebhookRoute(options.github));

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  return app;
}
