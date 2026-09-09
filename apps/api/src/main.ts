import { AuthService } from "@acalys/auth";
import {
  ApiMutationStore,
  ApiStore,
  AuthStore,
  createPostgresPool,
} from "@acalys/database";
import { createApiApp } from "./app.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`Missing required environment variable ${name}`);
  return value;
}
function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
function optionalSecretGenerations(name: string): readonly string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return [];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (values.length === 0)
    throw new Error(
      `${name} must contain at least one non-empty secret when set`,
    );
  return values;
}

function main(): void {
  const pool = createPostgresPool(required("DATABASE_URL"));
  const authStore = new AuthStore(pool);
  const auth = new AuthService({ store: authStore });
  const api = new ApiStore(pool);
  const mutations = new ApiMutationStore(pool);
  const perPrincipal = positive("ACALYS_API_REQUESTS_PER_MINUTE", 120);
  const perOrg = positive("ACALYS_API_ORG_REQUESTS_PER_MINUTE", 3000);
  const cursorSecrets = [
    required("ACALYS_API_CURSOR_SECRET"),
    ...optionalSecretGenerations("ACALYS_API_CURSOR_PREVIOUS_SECRETS"),
  ];
  const app = createApiApp({
    auth,
    api,
    mutations,
    cursorSecrets,
    async consumeRate({ organizationId, principalId }) {
      const result = await authStore.consumeApiRateLimits({
        organizationId,
        principalId,
        perPrincipalLimit: perPrincipal,
        perOrganizationLimit: perOrg,
      });
      return result.allowed;
    },
    logger: {
      info(event, fields) {
        console.info(JSON.stringify({ level: "info", event, ...fields }));
      },
    },
  });
  const port = positive("PORT", 8080);
  const server = app.listen(port, () =>
    console.info(JSON.stringify({ level: "info", event: "api.started", port })),
  );
  const stop = async () => {
    server.close();
    await pool.end();
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
}
void Promise.resolve()
  .then(main)
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "api.startup_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    process.exitCode = 1;
  });
