import { systemClock } from "@acalys/contracts/domain";
import {
  DashboardIntegrationStore,
  IntegrationCredentialCipher,
  createPostgresPool,
} from "@acalys/database";
import {
  AnthropicAdapter,
  JsonCassetteStore,
  OpenAIAdapter,
  StaticModelRouter,
  type CredentialPolicy,
  type ModelProvider,
  type ModelProviderAdapter,
  type ModelRoute,
  type ModelTaskClass,
} from "@acalys/model-gateway";
import {
  AppJwtSigner,
  GithubAppPrivateKey,
  GithubRepositoryReader,
  InstallationTokenProvider,
  createAuthenticatedGithubRepositoryRequest,
  createGithubInstallationTokenExchange,
} from "@acalys/provider-github";
import { z } from "zod";

import { ReviewProviderContextResolver } from "./provider-context.js";
import { createProductionReviewRuntime } from "./runtime.js";

const providerSchema = z.enum(["openai", "anthropic"]);
const tierSchema = z.enum(["cheap", "strong"]);
const routeSchema = z.object({
  provider: providerSchema,
  modelId: z.string().min(1),
  tier: tierSchema,
  maxOutputTokens: z.number().int().positive(),
  promptCaching: z.boolean(),
  inputMicroUsdPerMillion: z.number().int().nonnegative(),
  outputMicroUsdPerMillion: z.number().int().nonnegative(),
  cachedInputMicroUsdPerMillion: z.number().int().nonnegative().optional(),
  cacheCreationInputMicroUsdPerMillion: z.number().int().nonnegative().optional(),
});
const credentialSchema = z.object({
  credentialId: z.string().min(1),
  maxConcurrency: z.number().int().positive(),
  requestsPerMinute: z.number().int().positive(),
  leaseMillis: z.number().int().min(1_000),
});
const modelConfigSchema = z.object({
  routingPolicyVersion: z.string().min(1),
  routes: z.object({
    triage: routeSchema,
    correctness: routeSchema,
    verification: routeSchema,
    summary: routeSchema,
  }),
  budget: z.object({
    maxCallsPerRun: z.number().int().positive(),
    maxCostMicroUsdPerCall: z.number().int().nonnegative(),
    maxCostMicroUsdPerRun: z.number().int().nonnegative(),
    maxCostMicroUsdPerOrganization: z.number().int().nonnegative(),
    organizationWindowMs: z.number().int().min(1_000),
  }),
  credentials: z.object({
    openai: credentialSchema,
    anthropic: credentialSchema,
  }),
  retries: z.object({
    maxAttempts: z.number().int().positive(),
    baseDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
  }),
});


const integrationKeyringSchema = z.object({
  activeGeneration: z.number().int().positive(),
  keys: z.record(z.string(), z.string().min(1)),
});

function integrationCredentialCipher(): IntegrationCredentialCipher | undefined {
  const raw = process.env["ACALYS_INTEGRATION_CREDENTIAL_KEYS_JSON"];
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw) as unknown; }
  catch { throw new Error("ACALYS_INTEGRATION_CREDENTIAL_KEYS_JSON is not valid JSON"); }
  const parsed = integrationKeyringSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error("ACALYS_INTEGRATION_CREDENTIAL_KEYS_JSON does not match the required keyring schema");
  }
  const keys = new Map<number, Buffer>();
  for (const [generationText, encoded] of Object.entries(parsed.data.keys)) {
    const generation = Number(generationText);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Integration credential key generations must be positive integers");
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32) {
      throw new Error(`Integration credential key generation ${generationText} must decode to 32 bytes`);
    }
    keys.set(generation, key);
  }
  return new IntegrationCredentialCipher({ activeGeneration: parsed.data.activeGeneration, keys });
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function modelConfiguration(): z.infer<typeof modelConfigSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(required("ACALYS_MODEL_CONFIG_JSON")) as unknown;
  } catch (error) {
    throw new Error(
      `ACALYS_MODEL_CONFIG_JSON is not valid JSON (${String((error as Error).name)})`,
    );
  }
  const parsed = modelConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("ACALYS_MODEL_CONFIG_JSON does not match the required model runtime schema");
  }
  if (parsed.data.retries.maxDelayMs < parsed.data.retries.baseDelayMs) {
    throw new Error("model retry maxDelayMs must be >= baseDelayMs");
  }
  return parsed.data;
}

function modelAdapters(
  routes: Readonly<Record<ModelTaskClass, ModelRoute>>,
  replayMode: "off" | "record" | "replay",
): ReadonlyMap<ModelProvider, ModelProviderAdapter> {
  const adapters = new Map<ModelProvider, ModelProviderAdapter>();
  const openAiKey = process.env["OPENAI_API_KEY"];
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (openAiKey !== undefined && openAiKey.trim() !== "") {
    adapters.set("openai", new OpenAIAdapter(openAiKey));
  }
  if (anthropicKey !== undefined && anthropicKey.trim() !== "") {
    adapters.set("anthropic", new AnthropicAdapter(anthropicKey));
  }

  const selected = new Set(Object.values(routes).map((route) => route.provider));
  for (const provider of selected) {
    if (replayMode !== "replay" && !adapters.has(provider)) {
      throw new Error(
        `${provider} is selected by ACALYS_MODEL_CONFIG_JSON but its API key is not configured`,
      );
    }
  }
  return adapters;
}

async function main(): Promise<void> {
  const pool = createPostgresPool(required("DATABASE_URL"));
  let shuttingDown = false;

  try {
    const appKey = GithubAppPrivateKey.fromPem(required("GITHUB_APP_PRIVATE_KEY_PEM"));
    const signer = new AppJwtSigner({
      appClientId: required("GITHUB_APP_CLIENT_ID"),
      privateKey: appKey,
      clock: systemClock,
    });
    const tokens = new InstallationTokenProvider({
      exchange: createGithubInstallationTokenExchange({ signer }),
      clock: systemClock,
    });
    const githubReader = new GithubRepositoryReader({
      request: createAuthenticatedGithubRepositoryRequest({ tokens }),
    });

    const config = modelConfiguration();
    const routes = config.routes as Readonly<Record<ModelTaskClass, ModelRoute>>;
    const replayModeRaw = process.env["ACALYS_MODEL_REPLAY_MODE"] ?? "off";
    const replayMode = z.enum(["off", "record", "replay"]).parse(replayModeRaw);
    const cassettePath = process.env["ACALYS_MODEL_CASSETTE_PATH"];
    if (replayMode !== "off" && (cassettePath === undefined || cassettePath.trim() === "")) {
      throw new Error("ACALYS_MODEL_CASSETTE_PATH is required in record/replay mode");
    }

    const batchSize = optionalPositiveInteger("ACALYS_REVIEW_WORKER_BATCH_SIZE");
    const leaseMillis = optionalPositiveInteger("ACALYS_REVIEW_WORKER_LEASE_MS");
    const pollIntervalMillis = optionalPositiveInteger("ACALYS_REVIEW_WORKER_POLL_MS");
    const retryBackoffMillis = optionalPositiveInteger(
      "ACALYS_REVIEW_WORKER_RETRY_BACKOFF_MS",
    );

    const integrationCipher = integrationCredentialCipher();
    const providerContext = integrationCipher === undefined
      ? undefined
      : new ReviewProviderContextResolver({
          integrations: new DashboardIntegrationStore(pool, integrationCipher),
          ...(process.env["ACALYS_LINEAR_OAUTH_CLIENT_ID"]?.trim()
            ? { linearClientId: process.env["ACALYS_LINEAR_OAUTH_CLIENT_ID"]!.trim() }
            : {}),
        });

    const runtime = createProductionReviewRuntime({
      pool,
      githubReader,
      ...(providerContext === undefined ? {} : { providerContext }),
      model: {
        router: new StaticModelRouter(config.routingPolicyVersion, routes),
        adapters: modelAdapters(routes, replayMode),
        budget: config.budget,
        credentials: config.credentials as Readonly<Record<ModelProvider, CredentialPolicy>>,
        retries: config.retries,
        replayMode,
        ...(cassettePath === undefined || cassettePath.trim() === ""
          ? {}
          : { cassette: new JsonCassetteStore(cassettePath) }),
        logger: {
          info(event, fields) {
            console.info(JSON.stringify({ level: "info", event, ...fields }));
          },
          warn(event, fields) {
            console.warn(JSON.stringify({ level: "warn", event, ...fields }));
          },
        },
      },
      worker: {
        ...(batchSize === undefined ? {} : { batchSize }),
        ...(leaseMillis === undefined ? {} : { leaseMillis }),
        ...(pollIntervalMillis === undefined ? {} : { pollIntervalMillis }),
        ...(retryBackoffMillis === undefined ? {} : { retryBackoffMillis }),
        observer: {
          onOutcome(event) {
            console.info(JSON.stringify({ level: "info", event: "review-worker.outcome", ...event }));
          },
          onError(error) {
            console.error(
              JSON.stringify({
                level: "error",
                event: "review-worker.error",
                errorName: error instanceof Error ? error.name : "UnknownError",
              }),
            );
          },
        },
      },
    });

    const stop = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.info(JSON.stringify({ level: "info", event: "review-worker.shutdown", signal }));
      await Promise.all([runtime.worker.stop(), runtime.apiDispatchWorker.stop()]);
      await pool.end();
    };

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void stop(signal).catch(() => {
          process.exitCode = 1;
        });
      });
    }

    runtime.worker.start();
    runtime.apiDispatchWorker.start();
    console.info(JSON.stringify({ level: "info", event: "review-worker.started" }));
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "review-worker.startup_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
});
