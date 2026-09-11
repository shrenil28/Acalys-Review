import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const checks = [];
const expect = (name, path, patterns) => {
  const source = read(path);
  const missing = patterns.filter((pattern) => !source.includes(pattern));
  if (missing.length) throw new Error(`${name}: missing ${missing.join(", ")}`);
  checks.push(name);
};

if (!existsSync("packages/database/migrations/0021_phase4_review_settings.sql")) throw new Error("review-settings migration missing");
expect("validated organization policy contract", "packages/contracts/src/dashboard/v1/review-settings.ts", [
  "dashboardOrganizationReviewConfigSchema", "dashboardEffectiveReviewPolicySchema", "DASHBOARD_REVIEW_CAPABILITIES",
]);
expect("repository override contract", "packages/contracts/src/dashboard/v1/review-settings.ts", [
  "dashboardRepositoryReviewSettingsSchema", "instructions", "ignorePaths", "repositoryLifecycle",
]);
expect("immutable request policy columns", "packages/database/migrations/0021_phase4_review_settings.sql", [
  "policy_snapshot", "policy_fingerprint", "review_requests_policy_immutable", "reject_review_request_policy_mutation",
]);
expect("settings audit history", "packages/database/migrations/0021_phase4_review_settings.sql", [
  "dashboard_review_settings_audit", "recorded_at",
]);
expect("shared RBAC/settings serialization", "packages/database/src/dashboard-settings-store.ts", [
  "dashboard-members:", "dashboard-settings:", "#lockMutationDomain", "#canAdmin",
]);
expect("database-clock settings mutations", "packages/database/src/dashboard-settings-store.ts", [
  "clock_timestamp()", "revision_conflict", "FOR UPDATE",
]);
expect("deterministic effective policy fingerprint", "packages/database/src/dashboard-settings-store.ts", [
  "canonicalJson(policy)", 'createHash("sha256")', "resolveEffectivePolicyWithClient",
]);
expect("webhook admission consumes effective policy", "apps/review-worker/src/pipeline.ts", [
  "resolveEffectivePolicy", "repositoryLifecycle", "autoReview", "autoReviewDrafts", "autoIncrementalReview",
]);
expect("base-branch glob admission", "apps/review-worker/src/pipeline.ts", [
  "matchesGlob(pattern, event.pull_request.base.ref)", "base branch excluded by review policy",
]);
expect("abort-on-close prepublication fence", "apps/review-worker/src/pipeline.ts", [
  "abortOnClose", "cancelPrePublicationRuns", 'event.action === "closed"',
]);
expect("webhook persists admitted snapshot", "apps/review-worker/src/pipeline.ts", [
  "policySnapshot: admitted.policy", "policyFingerprint: admitted.fingerprint",
]);
expect("manual API review persists admitted snapshot", "packages/database/src/api-mutation-store.ts", [
  "resolveEffectivePolicyWithClient", "policy_snapshot", "policy_fingerprint", "REPOSITORY_REVIEWS_DISABLED",
]);
expect("runtime validates policy fingerprint", "packages/database/src/review/ingestion-store.ts", [
  "policy_fingerprint", "canonicalJson(policy.data)", "Fail closed instead of executing against mutable settings",
]);
expect("ignored paths removed from changed and repository context", "apps/review-worker/src/analysis.ts", [
  "changed.filter", "snapshot.repository", "filterInstructionObservation", "isIgnoredByReviewPolicy",
]);
expect("trusted policy frame", "apps/review-worker/src/analysis.ts", [
  "trustedReviewPolicyText", "Tone instructions:", "Repository instructions:",
]);
expect("live organization settings hydration/save", "apps/web/src/pages/organization/OrganizationSettings.tsx", [
  "loadOrganizationReviewSettings", "updateOrganizationReviewSettings", "expectedRevision", "useDashboardSession",
]);
expect("organization conflict rollback", "apps/web/src/pages/organization/OrganizationSettings.tsx", [
  "loadOrganizationReviewSettings()", "authoritative configuration has been restored",
]);
expect("live repository settings", "apps/web/src/pages/review/RepositoryDetail.tsx", [
  "loadRepositoryReviewSettings", "updateRepositoryReviewSettings", "updateRepositoryReviewLifecycle", "archiveRepositoryReviewSettings",
]);
expect("repository-list lifecycle mutation", "apps/web/src/pages/review/Repositories.tsx", [
  "toggleRepositoryReviews", "loadRepositoryReviewSettings", "updateRepositoryReviewLifecycle", "authoritative repository state was restored",
]);
expect("browser mutation CORS", "apps/api/src/app.ts", [
  "GET,POST,PUT,PATCH,DELETE,OPTIONS", "If-Match-Revision",
]);

console.log(`Phase 4 review-policy preflight PASS (${checks.length} invariants)`);
for (const check of checks) console.log(`  ✓ ${check}`);
