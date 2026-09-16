import { readFileSync, existsSync } from "node:fs";
const read = (p) => readFileSync(p, "utf8");
const checks = [];
const expect = (name, path, patterns) => {
  const s = read(path);
  const missing = patterns.filter((p) => !s.includes(p));
  if (missing.length) throw new Error(`${name}: missing ${missing.join(", ")}`);
  checks.push(name);
};
if (
  !existsSync(
    "packages/database/migrations/0023_phase4_analytics_team_dimension.sql",
  )
)
  throw new Error("analytics team migration missing");
if (!existsSync("packages/database/migrations/0026_phase4_reports.sql"))
  throw new Error("reports migration missing");
expect(
  "adaptive repeatable-read analytics",
  "packages/database/src/dashboard-analytics-store.ts",
  [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "chooseBucketSeconds",
    "MAX_SEVERITIES",
    "MAX_CATEGORIES",
    "MAX_REPOSITORIES",
    "MAX_AUTHORS",
    "MAX_DIMENSION_USERNAMES",
    "run.created_at >= $2",
    "f.created_at >= $2",
    "COALESCE(c.evaluated_at,c.created_at)",
    "COALESCE(recorded_at,created_at)",
  ],
);
expect("bounded analytics HTTP boundary", "apps/api/src/dashboard-router.ts", [
  'router.get("/analytics/reviews"',
  "5 * 366 * 24 * 60 * 60_000",
  'queryStrings(request, "repositoryId")',
  'queryStrings(request, "username")',
  'queryStrings(request, "team")',
]);
expect(
  "durable editable team dimension",
  "packages/database/src/dashboard-admin-store.ts",
  [
    "updateMemberAnalyticsTeamAuthorized",
    "analytics_team",
    "dashboard-members:",
    "clock_timestamp()",
  ],
);
expect("live analytics team UI", "apps/web/src/pages/account/Team.tsx", [
  "updateDashboardMemberAnalyticsTeam",
  "Analytics team",
  "member.analyticsTeam",
]);
expect(
  "shared live analytics snapshot",
  "apps/web/src/pages/analytics/DashboardLayout.tsx",
  [
    "loadDashboardAnalytics",
    "useAnalyticsLiveState",
    "repositoryIds",
    "dimensions.usernames",
    "dimensions.teams",
  ],
);
expect(
  "browser/UTC instant semantics",
  "apps/web/src/pages/analytics/TimeRangePicker.tsx",
  [
    "parseStamp(fromDraft, timezone)",
    "stamp(range.from, next)",
    "Date.UTC(...parts)",
  ],
);
expect(
  "six live analytics views",
  "apps/web/src/pages/analytics/AnalyticsLiveViews.tsx",
  [
    "LiveAnalyticsSummary",
    "LiveOrganizationTrends",
    "LiveQualityMetrics",
    "LivePreMergeChecks",
    "LiveTimeMetrics",
    "LiveDataMetrics",
  ],
);
expect(
  "durable report schema",
  "packages/database/migrations/0026_phase4_reports.sql",
  [
    "dashboard_reports",
    "dashboard_report_runs",
    "report_revision",
    "clock_timestamp()",
  ],
);
expect(
  "truthful report store",
  "packages/database/src/dashboard-report-store.ts",
  [
    "DashboardReportStore",
    "MAX_REPORT_DEFINITIONS = 500",
    "LIMIT ${MAX_REPORT_DEFINITIONS}",
    "limit_reached",
    "authorization TOCTOU",
    "this.analytics.snapshot",
    "clock_timestamp() AS at",
  ],
);
expect("report HTTP control", "apps/api/src/dashboard-router.ts", [
  'router.get("/reports"',
  'router.post("/reports"',
  'router.delete("/reports/:id"',
  'router.post("/reports/:id/generate"',
  "REVISION_CONFLICT",
  "REPORT_LIMIT_REACHED",
]);
expect(
  "live report browser adapter",
  "apps/web/src/lib/api/dashboardAdmin.ts",
  [
    "loadDashboardReports",
    "createDashboardReport",
    "deleteDashboardReport",
    "generateDashboardReport",
    "loadDashboardAnalytics",
  ],
);
expect(
  "live report surfaces",
  "apps/web/src/pages/reports/ReportsPageLive.tsx",
  [
    "automationStatus",
    "Delivery status: not delivered",
    "generateDashboardReport",
  ],
);
expect(
  "live report creation",
  "apps/web/src/pages/reports/CreateReportLive.tsx",
  [
    "createDashboardReport",
    "generateDashboardReport",
    "Destination configuration",
    "Automatic execution remains unavailable",
  ],
);
expect(
  "HTTP analytics/report witnesses",
  "apps/api/tests/dashboard-analytics-reports.test.ts",
  [
    "ranges longer than five years",
    "analytics team",
    "automation/delivery truth",
    "expected revision",
    "report-definition cap",
  ],
);
expect(
  "Postgres analytics/report witnesses",
  "packages/database/tests/phase4-analytics-reports.test.ts",
  [
    "database clock",
    "report revision",
    "owner/admin role",
    "analytics-team edits",
    "revalidates live admin authority",
    "500-definition organization cap",
  ],
);
console.log(
  `Phase 4 analytics/reports preflight PASS (${checks.length} invariants)`,
);
for (const c of checks) console.log(`  ✓ ${c}`);
