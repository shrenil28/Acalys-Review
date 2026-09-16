import { PostgresWebhookInbox, createPostgresPool } from "@acalys/database";
import type { WebhookSecretSet } from "@acalys/provider-github";

import { createGatewayApp } from "./app.js";
import { createDefaultWebhookRateLimits } from "./security.js";
import { startGateway } from "./server.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function commaSeparated(name: string): readonly string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} contains no values`);
  return values;
}

async function main(): Promise<void> {
  const pool = createPostgresPool(required("DATABASE_URL"));
  let shuttingDown = false;

  try {
    await pool.query("SELECT 1");
    const secret: WebhookSecretSet = [
      required("GITHUB_WEBHOOK_SECRET"),
      ...commaSeparated("ACALYS_GITHUB_WEBHOOK_PREVIOUS_SECRETS"),
    ];
    const trustedProxies = commaSeparated("ACALYS_TRUSTED_PROXIES");
    const proxyHops = positiveInteger("ACALYS_PROXY_HOPS", 1);
    const app = createGatewayApp({
      github: {
        secret,
        sourceEndpointId: required("ACALYS_GITHUB_WEBHOOK_ENDPOINT_ID"),
        inbox: new PostgresWebhookInbox({ pool }),
        rateLimits: createDefaultWebhookRateLimits({
          trustedProxies,
          proxyHops,
        }),
        observer: {
          onOutcome(fields) {
            console.info(
              JSON.stringify({
                level: "info",
                event: "webhook.outcome",
                ...fields,
              }),
            );
          },
        },
      },
      readiness: async () => {
        await pool.query("SELECT 1");
      },
      onError(error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "webhook.unhandled_error",
            errorName: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      },
    });
    const running = await startGateway({
      app,
      port: positiveInteger("PORT", 8081),
      host: process.env["HOST"]?.trim() || "0.0.0.0",
      onListening(address) {
        console.info(
          JSON.stringify({
            level: "info",
            event: "webhook.started",
            address,
          }),
        );
      },
    });

    const stop = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.info(
        JSON.stringify({ level: "info", event: "webhook.shutdown", signal }),
      );
      await running.stop(signal);
      await pool.end();
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void stop(signal).catch(() => {
          process.exitCode = 1;
        });
      });
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "webhook.startup_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      message:
        error instanceof Error ? error.message : "Unknown startup failure",
    }),
  );
  process.exitCode = 1;
});
