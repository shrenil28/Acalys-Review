import { readFileSync, existsSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const checks = [];
const expectSource = (name, path, patterns) => {
  const source = read(path);
  const missing = patterns.filter((pattern) => !source.includes(pattern));
  if (missing.length) throw new Error(`${name}: missing ${missing.join(", ")}`);
  checks.push(name);
};

if (!existsSync("packages/database/migrations/0019_phase4_dashboard_admin.sql"))
  throw new Error("dashboard migration missing");
expectSource(
  "one-time hash-only login exchange",
  "packages/database/src/dashboard-admin-store.ts",
  [
    "createLoginExchangeForProvisionedIdentity",
    "redeemLoginExchange",
    "FOR UPDATE OF e",
    "clock_timestamp()",
    "membership_id",
  ],
);
const exchangeMigration = read(
  "packages/database/migrations/0019_phase4_dashboard_admin.sql",
);
const exchangeStore = read("packages/database/src/dashboard-admin-store.ts");
const dashboardRouter = read("apps/api/src/dashboard-router.ts");
for (const marker of [
  "session_ciphertext",
  "encryptSession",
  "decryptSession",
]) {
  if (
    exchangeMigration.includes(marker) ||
    exchangeStore.includes(marker) ||
    dashboardRouter.includes(marker)
  ) {
    throw new Error(
      `recoverable dashboard session credential marker remains: ${marker}`,
    );
  }
}
checks.push("dashboard exchange persists no recoverable session credential");
expectSource(
  "membership RBAC",
  "packages/database/src/dashboard-admin-store.ts",
  [
    "pg_advisory_xact_lock",
    "last_owner",
    'actorRole === "admin"',
    "role = 'owner'",
  ],
);
expectSource(
  "transactional API-key authorization",
  "packages/database/src/dashboard-admin-store.ts",
  [
    "createApiKeyAuthorized",
    "revokeApiKeyAuthorized",
    "FOR SHARE",
    "FOR UPDATE",
  ],
);
expectSource("browser OAuth bridge", "apps/api/src/dashboard-router.ts", [
  "/auth/github/start",
  "/auth/github/callback",
  "/auth/exchange",
  "createLoginExchangeForProvisionedIdentity",
  "issueSession",
]);
expectSource("strict browser CORS", "apps/api/src/app.ts", [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "dashboardOrigin",
  "CORS_ORIGIN_REJECTED",
  "Authorization,Content-Type,Idempotency-Key,Last-Event-ID,X-Correlation-ID,If-Match-Revision",
]);

expectSource(
  "dashboard validation and cache boundary",
  "apps/api/src/dashboard-router.ts",
  [
    'error.name === "ZodError"',
    "dashboardIdSchema.parse",
    "cache-control",
    "no-store",
    "dashboardMemberSchema.parse",
  ],
);
expectSource("optional dashboard deployment boundary", "apps/api/src/main.ts", [
  "dashboardConfigured",
  "Dashboard administration must configure organization id and web origin together",
  "GitHub dashboard OAuth requires dashboard administration to be configured",
  "GitLab dashboard OAuth requires dashboard administration to be configured",
]);
expectSource(
  "API-key role ceiling",
  "packages/database/src/dashboard-admin-store.ts",
  [
    "rank(input.role) > rank(membership.role)",
    "future-proofs organization-owned",
  ],
);
expectSource(
  "dashboard account contract",
  "packages/contracts/src/dashboard/v1/resources.ts",
  [
    "dashboardSessionSchema",
    "dashboardMemberSchema",
    "dashboardApiKeySchema",
    "dashboardProviderConnectionSchema",
  ],
);
expectSource(
  "authenticated shell gate",
  "apps/web/src/components/auth/DashboardSessionGate.tsx",
  [
    "redeemLoginExchange",
    "loadDashboardSession",
    "clearBrowserSession",
    "Navigate",
  ],
);
expectSource("live team", "apps/web/src/pages/account/Team.tsx", [
  "loadDashboardMembers",
  "updateDashboardMemberRole",
  "createDashboardInvitation",
  "removeDashboardMember",
]);
expectSource("live API keys", "apps/web/src/pages/account/ApiKeys.tsx", [
  "loadDashboardApiKeys",
  "createDashboardApiKey",
  "revokeDashboardApiKey",
  "dashboardScopeOptions",
]);
expectSource(
  "live provider status",
  "apps/web/src/pages/review/Integrations.tsx",
  [
    "loadProviderConnections",
    "loadDashboardIntegrations",
    "beginLinearAuthorization",
    "connectCircleCi",
    "Linear team keys",
    "Repository project slugs",
  ],
);
expectSource(
  "live versioned organization settings",
  "apps/web/src/pages/organization/OrganizationSettings.tsx",
  [
    "loadOrganizationReviewSettings",
    "updateOrganizationReviewSettings",
    "expectedRevision",
    "authoritative configuration has been restored",
    "useDashboardSession",
  ],
);
expectSource(
  "fixture-free organization settings editor",
  "apps/web/src/pages/organization/OrganizationSettingsEditor.tsx",
  [
    "initialConfig",
    "onApply",
    "setConfig(baseline)",
    "Settings were not saved",
  ],
);

const dashboardRoutes = [
  ...dashboardRouter.matchAll(
    /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g,
  ),
].map((match) => `${match[1].toUpperCase()} ${match[2]}`);
const expectedDashboardRoutes = [
  "GET /auth/config",
  "GET /auth/github/start",
  "GET /auth/github/callback",
  "GET /auth/gitlab/start",
  "GET /auth/gitlab/callback",
  "POST /auth/exchange",
  "GET /session",
  "POST /session/rotate",
  "POST /session/logout",
  "GET /notifications",
  "PUT /notifications",
  "GET /members",
  "PATCH /members/:id",
  "PUT /members/:id/analytics-team",
  "GET /invitations",
  "POST /invitations",
  "DELETE /invitations/:id",
  "DELETE /members/:id",
  "GET /api-keys",
  "POST /api-keys",
  "DELETE /api-keys/:id",
  "GET /integrations",
  "POST /integrations/mcp/servers",
  "PUT /integrations/mcp/servers/:serverId",
  "DELETE /integrations/mcp/servers/:serverId",
  "POST /integrations/jira/challenge",
  "POST /integrations/jira/redeem",
  "PUT /integrations/circleci",
  "PATCH /integrations/circleci",
  "PATCH /integrations/linear",
  "POST /integrations/:key/disconnect",
  "POST /integrations/linear/authorize",
  "GET /integrations/linear/callback",
  "GET /settings/review",
  "PUT /settings/review",
  "GET /repositories/:id/settings",
  "PUT /repositories/:id/settings",
  "PUT /repositories/:id/reviews",
  "DELETE /repositories/:id",
  "GET /repositories/metrics",
  "GET /repositories/:id/overview",
  "GET /analytics/reviews",
  "GET /reports",
  "POST /reports",
  "DELETE /reports/:id",
  "POST /reports/:id/generate",
  "GET /security/findings",
  "GET /caches",
  "DELETE /caches",
  "GET /provider-connections",
];
if (
  JSON.stringify(dashboardRoutes) !== JSON.stringify(expectedDashboardRoutes)
) {
  throw new Error(
    `dashboard route contract drifted: ${JSON.stringify(dashboardRoutes)}`,
  );
}
checks.push("50-route dashboard admin contract frozen");
expectSource(
  "dashboard HTTP witnesses",
  "apps/api/tests/dashboard-admin.test.ts",
  [
    "marks dashboard responses no-store",
    "rejects malformed member identifiers before persistence",
    "classifies malformed dashboard bodies",
    "rejects malformed API-key identifiers before revocation persistence",
  ],
);
expectSource(
  "dashboard Postgres witnesses",
  "packages/database/tests/phase4-dashboard-admin.test.ts",
  [
    "redeems a membership-bound hashed login exchange exactly once",
    "final owner",
    'role: "owner"',
    'role: "admin"',
  ],
);

const productRoutes = read("packages/contracts/src/api/v1/routes.ts");
const manifestStart = productRoutes.indexOf("export const API_ROUTES = {");
const manifestEnd = productRoutes.indexOf(
  "} as const satisfies",
  manifestStart,
);
if (manifestStart < 0 || manifestEnd < 0)
  throw new Error("could not isolate API_ROUTES manifest");
const manifestSource = productRoutes.slice(manifestStart, manifestEnd);
const routeMatches = [
  ...manifestSource.matchAll(/^  ([A-Za-z][A-Za-z0-9]+): \{/gm),
].map((match) => match[1]);
if (routeMatches.length !== 14)
  throw new Error(
    `frozen product API route count changed: ${routeMatches.length}`,
  );
if (productRoutes.includes("dashboard/v1"))
  throw new Error(
    "dashboard admin routes leaked into frozen product API manifest",
  );
checks.push("frozen 14-route product API unchanged");

const pagesAndComponents = [
  "apps/web/src/pages/Login.tsx",
  "apps/web/src/pages/account/Team.tsx",
  "apps/web/src/pages/account/ApiKeys.tsx",
  "apps/web/src/pages/account/Settings.tsx",
  "apps/web/src/pages/review/Integrations.tsx",
  "apps/web/src/components/auth/DashboardSessionGate.tsx",
];
for (const path of pagesAndComponents) {
  const source = read(path);
  if (source.includes("@acalys/contracts"))
    throw new Error(`${path} imports wire contracts directly`);
  if (source.includes('from "@/data/'))
    throw new Error(
      `${path} statically imports fixtures in its production wrapper`,
    );
}
checks.push("admin page adapter/fixture firewall");

console.log(
  `Phase 4 dashboard-admin preflight PASS (${checks.length} invariants)`,
);
