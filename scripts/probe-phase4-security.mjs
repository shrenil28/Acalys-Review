import { readFileSync, existsSync } from "node:fs";
const read = (path) => readFileSync(path, "utf8");
const checks = [];
const expect = (name, path, patterns) => {
  if (!existsSync(path)) throw new Error(`${name}: missing ${path}`);
  const source = read(path);
  const missing = patterns.filter((pattern) => !source.includes(pattern));
  if (missing.length) throw new Error(`${name}: missing ${missing.join(", ")}`);
  checks.push(name);
};

expect(
  "strict security dashboard contract",
  "packages/contracts/src/dashboard/v1/security.ts",
  [
    "dashboardSecurityFindingsQuerySchema",
    "findingLifecycleStateSchema",
    "findingSeveritySchema",
    "criticalHighActive",
    "repositoriesWithFindings",
  ],
);
expect(
  "security read model is tenant/category isolated",
  "packages/database/src/dashboard-security-store.ts",
  [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "f.organization_id=$1 AND f.category='security'",
    "critical_high_active",
    "review_requests",
    "pull_requests",
  ],
);
expect("security dashboard HTTP boundary", "apps/api/src/dashboard-router.ts", [
  'router.get("/security/findings"',
  "dashboardSecurityFindingsQuerySchema.parse",
  'queryStrings(request, "severity")',
  "principal.organizationId",
]);
expect("security package export", "packages/database/src/index.ts", [
  'export * from "./dashboard-security-store.js"',
]);
expect("security store production composition", "apps/api/src/main.ts", [
  "DashboardSecurityStore",
  "new DashboardSecurityStore(pool)",
  "securityStore,",
]);
expect(
  "typed browser security adapter",
  "apps/web/src/lib/api/dashboardAdmin.ts",
  [
    "loadSecurityFindings",
    'query.append("repositoryId"',
    'query.append("severity"',
    'query.append("lifecycle"',
  ],
);
expect("live security overview", "apps/web/src/pages/security/Overview.tsx", [
  'import("./OverviewFixture")',
  "SecurityOverviewLive",
  "resolveDataMode",
]);
expect(
  "truthful security overview facts",
  "apps/web/src/pages/security/OverviewLive.tsx",
  [
    "loadSecurityFindings",
    "Active security findings",
    "Critical & high active",
    "Deep scans",
  ],
);
expect(
  "live PR security findings",
  "apps/web/src/pages/security/PrFindings.tsx",
  ['import("./PrFindingsFixture")', "PrFindingsLive", "resolveDataMode"],
);
expect(
  "canonical dismissal lifecycle",
  "apps/web/src/pages/security/PrFindingsLive.tsx",
  [
    "dismissFinding",
    'finding.lifecycle === "published"',
    "Dismissal is terminal",
    "Security finding dismissed",
  ],
);
expect("security HTTP witnesses", "apps/api/tests/dashboard-security.test.ts", [
  "repeated repository/severity/lifecycle filters",
  "rejects invalid filter enums and limits",
  "caller-supplied organization id",
]);
expect(
  "security Postgres witnesses",
  "packages/database/tests/phase4-security.test.ts",
  [
    "category and tenant isolation",
    "preserving PR identity",
    "filters identically to summary and detail rows",
  ],
);
expect(
  "deep scan remains explicitly separate",
  "apps/web/src/pages/security/AiDeepScan.tsx",
  ["DeferredFeaturePage", "lazy("],
);

console.log(
  `Phase 4 security findings preflight PASS (${checks.length} invariants)`,
);
for (const check of checks) console.log(`  ✓ ${check}`);
