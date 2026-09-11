import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const migration = "packages/database/migrations/0018_phase3_premerge_check_bound.sql";
const storePath = "packages/database/src/api-store.ts";
const appPath = "apps/api/src/app.ts";
const dbSuite = "packages/database/tests/phase3-premerge-check-bound.test.ts";
const apiSuite = "apps/api/tests/app.test.ts";

function preflight() {
  const problems = [];
  for (const path of [migration, storePath, appPath, dbSuite, apiSuite]) {
    if (!existsSync(join(ROOT, path))) problems.push(`${path} is missing`);
  }
  if (problems.length > 0) return problems;

  const sql = readFileSync(join(ROOT, migration), "utf8");
  const store = readFileSync(join(ROOT, storePath), "utf8");
  const app = readFileSync(join(ROOT, appPath), "utf8");
  const dbTests = readFileSync(join(ROOT, dbSuite), "utf8");
  const apiTests = readFileSync(join(ROOT, apiSuite), "utf8");

  const migrationAnchors = [
    "premerge_check_results_run_limit",
    "pg_advisory_xact_lock",
    "existing_count >= 100",
    "HAVING COUNT(*) > 100",
    "BEFORE INSERT ON premerge_check_results",
  ];
  for (const anchor of migrationAnchors) {
    if (!sql.includes(anchor)) problems.push(`migration missing anchor: ${anchor}`);
  }
  if (!store.includes('throw new Error("PREMERGE_CHECK_RESULT_LIMIT_VIOLATION")')) {
    problems.push("ApiStore does not fail closed when the database invariant drifts");
  }
  if (/nextCursor:\s*result\.rows\[99\]/u.test(store)) {
    problems.push("ApiStore still emits the old raw pre-merge-check continuation id");
  }
  if (!app.includes('found.nextCursor!==undefined')) {
    problems.push("API boundary does not reject a continuation from the non-pageable route");
  }

  const dbWitnesses = [
    "rejects the 101st distinct check but still permits an upsert of an existing check at the cap",
    "serializes concurrent boundary inserts so exactly one 100th row can commit",
  ];
  for (const witness of dbWitnesses) {
    if (!dbTests.includes(witness)) problems.push(`missing Postgres witness: ${witness}`);
  }
  if (!apiTests.includes("refuses an unusable continuation cursor from the non-pageable pre-merge-check route")) {
    problems.push("missing API leak/fail-closed witness");
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 pre-merge-check page-bound preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}
console.log(
  "Phase 3 pre-merge-check page-bound preflight: persistence cap + advisory serialization + " +
    "API fail-closed boundary + 2 Postgres/1 API witness anchors present.",
);
if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 pre-merge-check page-bound execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable API/Postgres result is claimed.",
  );
  process.exit(2);
}
const result = spawnSync(process.execPath, [vitest, "run", apiSuite, dbSuite], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, ACALYS_REQUIRE_POSTGRES: "1" },
});
process.exit(result.status ?? 2);
