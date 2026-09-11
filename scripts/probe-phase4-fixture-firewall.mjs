import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "apps/web/src");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const checks = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx"];
function resolveLocalImport(fromFile, specifier) {
  let base;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  const candidates = [base, ...sourceExtensions.map((ext) => `${base}${ext}`), ...sourceExtensions.map((ext) => path.join(base, `index${ext}`))];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}
function runtimeStaticImports(file) {
  const text = fs.readFileSync(file, "utf8");
  const imports = [];
  const pattern = /^\s*import\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?/gm;
  for (const match of text.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

// Walk the production static import graph from the real browser entrypoint.
const entry = path.join(SRC, "main.tsx");
const queue = [entry];
const seen = new Set();
const forbidden = [];
const fixtureModules = [];
while (queue.length) {
  const file = queue.shift();
  if (!file || seen.has(file)) continue;
  seen.add(file);
  if (file.includes("Fixture.")) fixtureModules.push(file);
  if (file.startsWith(path.join(SRC, "data") + path.sep) || file === path.join(SRC, "lib/session.ts")) forbidden.push(file);
  for (const specifier of runtimeStaticImports(file)) {
    const resolved = resolveLocalImport(file, specifier);
    if (resolved) queue.push(resolved);
  }
}
assert(forbidden.length === 0, `production static graph reaches fixture data: ${forbidden.map((f) => path.relative(ROOT, f)).join(", ")}`);
assert(fixtureModules.length === 0, `production static graph reaches fixture UI modules: ${fixtureModules.map((f) => path.relative(ROOT, f)).join(", ")}`);
checks.push(`production static graph fixture-free (${seen.size} modules)`);

const deferredWrappers = [
  "apps/web/src/pages/Explore.tsx",
  "apps/web/src/pages/analytics/Reporting.tsx",
  "apps/web/src/pages/analytics/DataExport.tsx",
  "apps/web/src/pages/analytics/IdeCli.tsx",
  "apps/web/src/pages/security/AiDeepScan.tsx",
  "apps/web/src/pages/security/ActivityLog.tsx",
  "apps/web/src/pages/chat/ChatIntegrationPages.tsx",
  "apps/web/src/pages/plan/PlanPages.tsx",
];
for (const file of deferredWrappers) {
  const source = read(file);
  assert(source.includes("DeferredFeaturePage"), `${file} does not use the deferred API-mode boundary`);
  assert(source.includes("lazy("), `${file} does not lazy-load its demo surface`);
  assert(!source.includes('from "@/data/'), `${file} statically imports fixture data`);
}
checks.push(`${deferredWrappers.length} later-owned wrapper modules are lazy + deferred`);

const liveAnalyticsWrappers = [
  ["apps/web/src/pages/analytics/Summary.tsx", "LiveAnalyticsSummary"],
  ["apps/web/src/pages/analytics/QualityMetrics.tsx", "LiveQualityMetrics"],
  ["apps/web/src/pages/analytics/TimeMetrics.tsx", "LiveTimeMetrics"],
  ["apps/web/src/pages/analytics/OrganizationTrends.tsx", "LiveOrganizationTrends"],
  ["apps/web/src/pages/analytics/PreMergeChecks.tsx", "LivePreMergeChecks"],
  ["apps/web/src/pages/analytics/DataMetrics.tsx", "LiveDataMetrics"],
];
for (const [file, liveComponent] of liveAnalyticsWrappers) {
  const source = read(file);
  assert(source.includes("resolveDataMode"), `${file} does not select fixture/live mode`);
  assert(source.includes("lazy("), `${file} does not lazy-load its fixture surface`);
  assert(source.includes(liveComponent), `${file} does not render ${liveComponent} in API mode`);
  assert(!source.includes('from "@/data/'), `${file} statically imports fixture data`);
}
const analyticsLayout = read("apps/web/src/pages/analytics/DashboardLayout.tsx");
assert(analyticsLayout.includes("loadDashboardAnalytics") && analyticsLayout.includes("useAnalyticsLiveState"), "analytics layout is not backed by one authoritative live snapshot");
assert(!analyticsLayout.includes('from "@/data/'), "analytics live layout statically imports fixture data");
checks.push("six analytics wrappers moved to one authoritative live snapshot while fixtures remain lazy");

const reportWrappers = [
  ["apps/web/src/pages/reports/ReportsPage.tsx", "ReportsPageLive"],
  ["apps/web/src/pages/reports/CreateReport.tsx", "CreateReportLive"],
];
for (const [file, liveComponent] of reportWrappers) {
  const source = read(file);
  assert(source.includes("resolveDataMode") && source.includes("lazy(") && source.includes(liveComponent), `${file} lacks fixture/live report boundary`);
  assert(!source.includes('from "@/data/'), `${file} statically imports fixture data`);
}
const reportsLive = read("apps/web/src/pages/reports/ReportsPageLive.tsx");
const createReportLive = read("apps/web/src/pages/reports/CreateReportLive.tsx");
assert(reportsLive.includes("loadDashboardReports") && reportsLive.includes("generateDashboardReport") && reportsLive.includes("deleteDashboardReport"), "live reports list is not authoritative");
assert(createReportLive.includes("createDashboardReport") && createReportLive.includes("generateDashboardReport") && createReportLive.includes("loadDashboardAnalytics"), "live report creation is not wired to analytics + report APIs");
assert(!reportsLive.includes('from "@/data/') && !createReportLive.includes('from "@/data/'), "live report surfaces reach fixture data");
checks.push("reports moved to live durable definitions/manual snapshots while fixture UI remains lazy");

const securityOverview = read("apps/web/src/pages/security/Overview.tsx");
const securityOverviewLive = read("apps/web/src/pages/security/OverviewLive.tsx");
const securityFindings = read("apps/web/src/pages/security/PrFindings.tsx");
const securityFindingsLive = read("apps/web/src/pages/security/PrFindingsLive.tsx");
assert(securityOverview.includes('import("./OverviewFixture")') && securityOverview.includes("SecurityOverviewLive"), "security overview fixture/live boundary is not isolated");
assert(securityFindings.includes('import("./PrFindingsFixture")') && securityFindings.includes("PrFindingsLive"), "PR findings fixture/live boundary is not isolated");
assert(securityOverviewLive.includes("loadSecurityFindings") && securityFindingsLive.includes("loadSecurityFindings"), "live security surfaces do not use authoritative security findings");
assert(securityFindingsLive.includes("dismissFinding"), "live PR findings do not use canonical finding dismissal");
assert(!securityOverviewLive.includes('from "@/data/') && !securityFindingsLive.includes('from "@/data/'), "live security surface reaches fixture data");
checks.push("security overview + PR findings moved to live persisted-finding boundary while deep scan/activity remain deferred");

const cacheWrapper = read("apps/web/src/pages/review/Caches.tsx");
const cacheLive = read("apps/web/src/pages/review/CachesLive.tsx");
assert(cacheWrapper.includes('import("./CachesFixture")'), "cache fixture is not lazy");
assert(cacheWrapper.includes("LiveCachesPage"), "cache API mode is not wired to the live cache surface");
assert(cacheLive.includes("loadReviewCaches") && cacheLive.includes("deleteReviewCaches"), "live cache surface lacks authoritative cache controls");
assert(!cacheLive.includes('from "@/data/'), "live cache surface reaches fixture data");
checks.push("review cache moved from deferred fixture boundary to live authoritative API mode");

const shellWrappers = [
  "apps/web/src/components/layout/UserMenu.tsx",
  "apps/web/src/components/layout/WorkspaceSwitcher.tsx",
  "apps/web/src/components/layout/TopBar.tsx",
];
for (const file of shellWrappers) {
  const source = read(file);
  assert(!source.includes('from "@/lib/session"'), `${file} statically imports demo session data`);
}
assert(read("apps/web/src/components/layout/UserMenu.tsx").includes('import("./UserMenuFixture")'), "user menu fixture is not lazy");
assert(read("apps/web/src/components/layout/WorkspaceSwitcher.tsx").includes('import("./WorkspaceSwitcherFixture")'), "workspace switcher fixture is not lazy");
checks.push("authenticated shell uses live session without static demo identity");

const organization = read("apps/web/src/pages/organization/OrganizationSettings.tsx");
const organizationEditor = read("apps/web/src/pages/organization/OrganizationSettingsEditor.tsx");
const reviewPreview = read("apps/web/src/pages/organization/ReviewPreview.tsx");
assert(organization.includes('import("./OrganizationSettingsFixture")'), "organization settings fixture is not lazy");
assert(organization.includes("loadOrganizationReviewSettings"), "organization settings does not hydrate authoritative API configuration");
assert(organization.includes("updateOrganizationReviewSettings"), "organization settings does not persist authoritative API configuration");
assert(organization.includes("useDashboardSession"), "organization settings preview is not bound to authenticated identity");
assert(organization.includes("authoritative configuration has been restored"), "organization settings lacks optimistic-conflict rollback");
assert(!organizationEditor.includes('from "@/data/'), "shared organization settings editor reaches fixture data");
assert(!reviewPreview.includes('from "@/lib/session"'), "production settings preview reaches fixture identity");
checks.push("organization settings fixture isolated behind live authoritative API boundary");

const config = read("apps/web/src/lib/api/config.ts");
assert(config.includes("export const resolveDataConfig = resolveDataMode"), "dashboard/admin data-config alias is missing");
checks.push("4.3 resolveDataConfig regression repaired");

const router = read("apps/web/src/router.tsx");
const laterOwnedRoutes = [
  "/", "analytics/pr-reviews", "quality-metrics", "time-metrics", "organization-trends", "pre-merge-checks", "reporting", "data-metrics", "data-export",
  "analytics/ide-cli-reviews", "reports", "reports/recurring/new", "reports/ondemand/new", "review/cache",
  "security/overview", "security/ai-deep-scan", "security/pr-findings", "security/activity-log",
  "slack/scopes", "slack/automations", "slack/knowledge-base", "slack/connections", "slack/sandbox", "slack/activity", "slack/pr-auto-fix",
  "discord/scopes", "discord/connections", "discord/automations", "discord/knowledge-base", "discord/sandbox", "discord/activity",
  "plan/discover", "plan/new", "plan/plans", "plan/configurations",
];
for (const route of laterOwnedRoutes) {
  if (route === "/") continue;
  assert(router.includes(`path: "${route}"`), `later-owned route missing from router: ${route}`);
}
checks.push(`${laterOwnedRoutes.length} later-owned route declarations accounted for`);

const fixtureFiles = fs.readdirSync(path.join(SRC, "pages"), { recursive: true }).filter((name) => String(name).endsWith("Fixture.tsx"));
assert(fixtureFiles.length >= 25, `expected isolated fixture modules, found ${fixtureFiles.length}`);
checks.push(`${fixtureFiles.length} fixture UI modules isolated from production static graph`);

console.log(`Phase 4 fixture-firewall preflight PASS (${checks.length} invariants)`);
for (const check of checks) console.log(`  ✓ ${check}`);
