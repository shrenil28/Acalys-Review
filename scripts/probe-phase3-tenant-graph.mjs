import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const migrationPath = join(ROOT, "packages/database/migrations/0015_phase3_tenant_graph_integrity.sql");
const suite = "packages/database/tests/phase3-tenant-integrity.test.ts";
const suitePath = join(ROOT, suite);

const constraints = [
  "conversation_messages_conversation_tenant_fk",
  "knowledge_items_repository_tenant_fk",
  "premerge_check_results_repository_tenant_fk",
  "premerge_check_results_run_tenant_fk",
  "pull_request_revisions_pull_request_tenant_fk",
  "pull_request_revisions_repository_tenant_fk",
  "pull_requests_repository_tenant_fk",
  "review_conversations_finding_tenant_fk",
  "review_conversations_pull_request_tenant_fk",
  "review_conversations_repository_tenant_fk",
  "review_dispatch_jobs_pull_request_tenant_fk",
  "review_dispatch_jobs_revision_tenant_fk",
  "review_dispatch_jobs_run_tenant_fk",
  "review_findings_repository_tenant_fk",
  "review_findings_revision_tenant_fk",
  "review_findings_run_tenant_fk",
  "review_requests_pull_request_tenant_fk",
  "review_requests_repository_tenant_fk",
  "review_requests_revision_tenant_fk",
  "review_runs_repository_tenant_fk",
  "review_runs_request_tenant_fk",
  "review_runs_revision_tenant_fk",
  "review_summaries_run_tenant_fk",
];

const parentIndexes = [
  "repositories_organization_id_id_uq",
  "pull_requests_organization_id_id_uq",
  "pull_request_revisions_organization_id_id_uq",
  "review_requests_organization_id_id_uq",
  "review_runs_organization_id_id_uq",
  "review_findings_organization_id_id_uq",
  "review_conversations_organization_id_id_uq",
];

function count(source, needle) {
  return source.split(needle).length - 1;
}

function preflight() {
  const problems = [];
  if (!existsSync(migrationPath)) problems.push("tenant graph migration is missing");
  if (!existsSync(suitePath)) problems.push("tenant graph Postgres witness suite is missing");
  if (problems.length > 0) return problems;

  const migration = readFileSync(migrationPath, "utf8");
  for (const name of constraints) {
    if (count(migration, `ADD CONSTRAINT ${name}`) !== 1) {
      problems.push(`${name}: ADD CONSTRAINT must occur exactly once`);
    }
    if (count(migration, `VALIDATE CONSTRAINT ${name}`) !== 1) {
      problems.push(`${name}: VALIDATE CONSTRAINT must occur exactly once`);
    }
  }
  for (const name of parentIndexes) {
    if (count(migration, name) !== 1) {
      problems.push(`${name}: referenced-key index must occur exactly once`);
    }
  }
  if (!migration.includes("ON DELETE SET NULL (pull_request_id)")) {
    problems.push("conversation pull-request FK must null only pull_request_id");
  }
  if (!migration.includes("ON DELETE SET NULL (finding_id)")) {
    problems.push("conversation finding FK must null only finding_id");
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 tenant graph preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  `Phase 3 tenant graph preflight: ${constraints.length} validated tenant FKs, ` +
    `${parentIndexes.length} referenced-key indexes, Postgres witness suite present.`,
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 tenant graph execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable database result is claimed.",
  );
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  [vitest, "run", suite],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ACALYS_REQUIRE_POSTGRES: "1" },
  },
);
process.exit(result.status ?? 2);
