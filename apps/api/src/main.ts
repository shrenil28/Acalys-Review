import {
  AuthService,
  CredentialRing,
  GithubOAuthService,
  GitlabOAuthService,
} from "@acalys/auth";
import {
  ApiMutationStore,
  ApiStore,
  AuthStore,
  DashboardAdminStore,
  DashboardIntegrationStore,
  DashboardSettingsStore,
  IntegrationCredentialCipher,
  ReviewAnalysisCacheStore,
  DashboardSecurityStore,
  DashboardNotificationStore,
  DashboardRepositoryStore,
  DashboardAnalyticsStore,
  DashboardReportStore,
  createPostgresPool,
} from "@acalys/database";
import { CircleCiIntegrationService } from "./circleci-integration.js";
import { createApiApp } from "./app.js";
import { LinearIntegrationOAuthService } from "./linear-integration-oauth.js";
import { McpIntegrationService } from "./mcp-integration.js";
import { JiraIntegrationService } from "./jira-integration.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`Missing required environment variable ${name}`);
  return value;
}
function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
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
function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function integrationCredentialCipher():
  IntegrationCredentialCipher | undefined {
  const raw = optional("ACALYS_INTEGRATION_CREDENTIAL_KEYS_JSON");
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      "ACALYS_INTEGRATION_CREDENTIAL_KEYS_JSON is not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Integration credential keyring must be an object");
  const record = parsed as Record<string, unknown>;
  const activeGeneration = record["activeGeneration"];
  const keyRecord = record["keys"];
  if (
    typeof activeGeneration !== "number" ||
    !Number.isSafeInteger(activeGeneration) ||
    typeof keyRecord !== "object" ||
    keyRecord === null ||
    Array.isArray(keyRecord)
  ) {
    throw new Error("Integration credential keyring has an invalid shape");
  }
  const keys = new Map<number, Buffer>();
  for (const [generationText, encoded] of Object.entries(
    keyRecord as Record<string, unknown>,
  )) {
    const generation = Number(generationText);
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      typeof encoded !== "string"
    ) {
      throw new Error(
        "Integration credential keyring contains an invalid generation",
      );
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32)
      throw new Error(
        `Integration credential key generation ${generationText} must decode to 32 bytes`,
      );
    keys.set(generation, key);
  }
  return new IntegrationCredentialCipher({ activeGeneration, keys });
}

async function main(): Promise<void> {
  const pool = createPostgresPool(required("DATABASE_URL"));
  await pool.query("SELECT 1");
  const authStore = new AuthStore(pool);
  const auth = new AuthService({ store: authStore });
  const api = new ApiStore(pool);
  const mutations = new ApiMutationStore(pool);
  const dashboardStore = new DashboardAdminStore(pool);
  const settingsStore = new DashboardSettingsStore(pool);
  const cacheStore = new ReviewAnalysisCacheStore(pool);
  const securityStore = new DashboardSecurityStore(pool);
  const notificationStore = new DashboardNotificationStore(pool);
  const repositoryStore = new DashboardRepositoryStore(pool);
  const analyticsStore = new DashboardAnalyticsStore(pool);
  const reportStore = new DashboardReportStore(pool, analyticsStore);
  const integrationCipher = integrationCredentialCipher();
  const integrationStore =
    integrationCipher === undefined
      ? undefined
      : new DashboardIntegrationStore(pool, integrationCipher);
  const circleCi =
    integrationStore === undefined
      ? undefined
      : new CircleCiIntegrationService();
  const mcp =
    integrationStore === undefined ? undefined : new McpIntegrationService();
  const jira =
    integrationStore === undefined ? undefined : new JiraIntegrationService();
  const linearClientId = optional("ACALYS_LINEAR_OAUTH_CLIENT_ID");
  const linearCallbackUrl = optional("ACALYS_LINEAR_OAUTH_CALLBACK_URL");
  if ((linearClientId === undefined) !== (linearCallbackUrl === undefined)) {
    throw new Error(
      "Linear OAuth must configure client id and callback URL together",
    );
  }
  if (linearClientId !== undefined && integrationStore === undefined) {
    throw new Error(
      "Linear OAuth requires ACALYS_INTEGRATION_CREDENTIAL_KEYS_JSON",
    );
  }
  const linearOAuth =
    linearClientId === undefined ||
    linearCallbackUrl === undefined ||
    integrationStore === undefined
      ? undefined
      : new LinearIntegrationOAuthService({
          clientId: linearClientId,
          callbackUrl: linearCallbackUrl,
          store: integrationStore,
        });
  const perPrincipal = positive("ACALYS_API_REQUESTS_PER_MINUTE", 120);
  const perOrg = positive("ACALYS_API_ORG_REQUESTS_PER_MINUTE", 3000);
  const cursorSecrets = [
    required("ACALYS_API_CURSOR_SECRET"),
    ...optionalSecretGenerations("ACALYS_API_CURSOR_PREVIOUS_SECRETS"),
  ];

  const dashboardOrganizationId = optional("ACALYS_DASHBOARD_ORGANIZATION_ID");
  const dashboardWebOrigin = optional("ACALYS_DASHBOARD_WEB_ORIGIN");
  const dashboardConfigured =
    dashboardOrganizationId !== undefined && dashboardWebOrigin !== undefined;
  if (
    (dashboardOrganizationId === undefined) !==
    (dashboardWebOrigin === undefined)
  ) {
    throw new Error(
      "Dashboard administration must configure organization id and web origin together",
    );
  }
  const githubClientId = optional("ACALYS_GITHUB_OAUTH_CLIENT_ID");
  const githubClientSecret = optional("ACALYS_GITHUB_OAUTH_CLIENT_SECRET");
  const githubStateSecret = optional("ACALYS_GITHUB_OAUTH_STATE_SECRET");
  const githubCallbackUrl = optional("ACALYS_GITHUB_OAUTH_CALLBACK_URL");
  const githubConfigured = [
    githubClientId,
    githubClientSecret,
    githubStateSecret,
    githubCallbackUrl,
  ].every((value) => value !== undefined);
  if (
    [
      githubClientId,
      githubClientSecret,
      githubStateSecret,
      githubCallbackUrl,
    ].some((value) => value !== undefined) &&
    !githubConfigured
  ) {
    throw new Error(
      "GitHub dashboard OAuth must configure client id, client secret, state secret, and callback URL together",
    );
  }
  if (githubConfigured && !dashboardConfigured) {
    throw new Error(
      "GitHub dashboard OAuth requires dashboard administration to be configured",
    );
  }
  const githubOAuth = githubConfigured
    ? new GithubOAuthService({
        clientId: githubClientId!,
        clientSecrets: new CredentialRing(githubClientSecret!),
        stateSecrets: new CredentialRing(githubStateSecret!),
        callbackUrl: githubCallbackUrl!,
        ...(optional("ACALYS_GITHUB_APP_SLUG") === undefined
          ? {}
          : { appSlug: optional("ACALYS_GITHUB_APP_SLUG") }),
      })
    : undefined;

  const gitlabClientId = optional("ACALYS_GITLAB_OAUTH_CLIENT_ID");
  const gitlabClientSecret = optional("ACALYS_GITLAB_OAUTH_CLIENT_SECRET");
  const gitlabStateSecret = optional("ACALYS_GITLAB_OAUTH_STATE_SECRET");
  const gitlabCallbackUrl = optional("ACALYS_GITLAB_OAUTH_CALLBACK_URL");
  const gitlabConfigured = [
    gitlabClientId,
    gitlabClientSecret,
    gitlabStateSecret,
    gitlabCallbackUrl,
  ].every((value) => value !== undefined);
  if (
    [
      gitlabClientId,
      gitlabClientSecret,
      gitlabStateSecret,
      gitlabCallbackUrl,
    ].some((value) => value !== undefined) &&
    !gitlabConfigured
  ) {
    throw new Error(
      "GitLab dashboard OAuth must configure client id, client secret, state secret, and callback URL together",
    );
  }
  if (gitlabConfigured && !dashboardConfigured) {
    throw new Error(
      "GitLab dashboard OAuth requires dashboard administration to be configured",
    );
  }
  const gitlabOAuth = gitlabConfigured
    ? new GitlabOAuthService({
        clientId: gitlabClientId!,
        clientSecrets: new CredentialRing(gitlabClientSecret!),
        stateSecrets: new CredentialRing(gitlabStateSecret!),
        callbackUrl: gitlabCallbackUrl!,
      })
    : undefined;

  const app = createApiApp({
    auth,
    api,
    mutations,
    cursorSecrets,
    readiness: async () => {
      await pool.query("SELECT 1");
      if (
        dashboardConfigured &&
        (await dashboardStore.getOrganization(dashboardOrganizationId)) ===
          undefined
      ) {
        throw new Error("Configured dashboard organization is unavailable");
      }
    },
    ...(dashboardConfigured
      ? {
          dashboard: {
            auth,
            store: dashboardStore,
            settingsStore,
            cacheStore,
            securityStore,
            notificationStore,
            repositoryStore,
            analyticsStore,
            reportStore,
            organizationId: dashboardOrganizationId,
            webOrigin: dashboardWebOrigin,
            ...(githubOAuth === undefined ? {} : { githubOAuth }),
            ...(gitlabOAuth === undefined ? {} : { gitlabOAuth }),
            ...(integrationStore === undefined ? {} : { integrationStore }),
            ...(linearOAuth === undefined ? {} : { linearOAuth }),
            ...(circleCi === undefined ? {} : { circleCi }),
            ...(mcp === undefined ? {} : { mcp }),
            ...(jira === undefined ? {} : { jira }),
            cookieSecure: booleanEnv("ACALYS_DASHBOARD_COOKIE_SECURE", true),
          },
        }
      : {}),
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
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 5_000;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= new Promise<void>((resolveStop) => {
      const forced = setTimeout(() => {
        server.closeAllConnections();
        resolveStop();
      }, 15_000);
      forced.unref();
      server.close(() => {
        clearTimeout(forced);
        resolveStop();
      });
      server.closeIdleConnections();
    }).then(async () => {
      await pool.end();
    });
    return stopping;
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
}
void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "api.startup_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
});
