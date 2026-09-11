import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const servicePath = join(ROOT, "packages/auth/src/service.ts");
const storePath = join(ROOT, "packages/database/src/auth-store.ts");
const unitSuite = "packages/auth/tests/auth.test.ts";
const postgresSuite = "packages/database/tests/phase3-auth-store.test.ts";
const unitPath = join(ROOT, unitSuite);
const postgresPath = join(ROOT, postgresSuite);

function preflight() {
  const problems = [];
  for (const path of [servicePath, storePath, unitPath, postgresPath]) {
    if (!existsSync(path)) problems.push(`${path.slice(ROOT.length + 1)} is missing`);
  }
  if (problems.length > 0) return problems;

  const service = readFileSync(servicePath, "utf8");
  const store = readFileSync(storePath, "utf8");
  const unit = readFileSync(unitPath, "utf8");
  const postgres = readFileSync(postgresPath, "utf8");

  if (!service.includes("this.#store.establishOAuthSession({")) {
    problems.push("GitHub session establishment must delegate to one atomic store operation");
  }
  const establishStart = service.indexOf("public async establishGithubSession");
  const establishEnd = service.indexOf("public async issueSession", establishStart);
  const establishBody = establishStart >= 0 && establishEnd > establishStart
    ? service.slice(establishStart, establishEnd)
    : "";
  if (establishBody.includes("upsertOAuthIdentity") || establishBody.includes("upsertMembership") || establishBody.includes("this.issueSession")) {
    problems.push("GitHub session establishment must not split identity, membership, and session persistence");
  }
  if (establishBody.includes("#now") || establishBody.includes("new Date(")) {
    problems.push("OAuth commit chronology must not come from the API process clock");
  }
  if (!store.includes("public async establishOAuthSession")) {
    problems.push("AuthStore.establishOAuthSession is missing");
  }
  if (!store.includes("WITH database_clock AS MATERIALIZED") || !store.includes("oauth_user AS (") || !store.includes("oauth_membership AS (") || !store.includes("oauth_session AS (")) {
    problems.push("OAuth commit must use one Postgres-clock data-modifying transaction graph");
  }
  if (!store.includes("JOIN oauth_membership AS membership ON membership.id = session.membership_id")) {
    problems.push("issued session must be projected from the exact committed membership row");
  }
  if (/readonly now: Date/u.test(store)) {
    problems.push("OAuth identity/membership store inputs must not accept a replica-supplied timestamp");
  }
  if (!store.includes("updated_at = GREATEST(users.updated_at, EXCLUDED.updated_at)")) {
    problems.push("OAuth identity updated_at must remain monotonic under clock adjustments");
  }
  if (!store.includes("updated_at = GREATEST(memberships.updated_at, EXCLUDED.updated_at)")) {
    problems.push("membership updated_at must remain monotonic under clock adjustments");
  }

  for (const witness of [
    "commits GitHub identity, membership role, and first session through one store operation",
  ]) {
    if (!unit.includes(witness)) problems.push(`missing unit witness: ${witness}`);
  }
  for (const witness of [
    "commits OAuth identity, membership role, and first session with one database timestamp",
    "rolls back identity and membership refresh when first-session insertion fails",
    "concurrent OAuth callbacks converge on one canonical identity and membership",
  ]) {
    if (!postgres.includes(witness)) problems.push(`missing Postgres witness: ${witness}`);
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 OAuth-commit preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  "Phase 3 OAuth-commit preflight: one database-owned identity/membership/session commit, " +
    "monotonic identity metadata, and 4 focused witnesses present.",
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 OAuth-commit execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable auth/Postgres result is claimed.",
  );
  process.exit(2);
}

const docker = spawnSync("docker", ["info"], { cwd: ROOT, stdio: "ignore" });
if (docker.status !== 0) {
  console.error(
    "Phase 3 OAuth-commit Postgres execution requires Docker. " +
      "Preflight passed, but no database result is claimed.",
  );
  process.exit(2);
}

const result = spawnSync(process.execPath, [vitest, "run", unitSuite, postgresSuite], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, ACALYS_REQUIRE_POSTGRES: "1" },
});
process.exit(result.status ?? 2);
