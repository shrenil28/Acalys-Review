import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const servicePath = join(ROOT, "packages/auth/src/service.ts");
const storePath = join(ROOT, "packages/database/src/auth-store.ts");
const migrationPath = join(
  ROOT,
  "packages/database/migrations/0016_phase3_credential_membership_integrity.sql",
);
const unitSuite = "packages/auth/tests/auth.test.ts";
const postgresSuite = "packages/database/tests/phase3-auth-store.test.ts";
const unitPath = join(ROOT, unitSuite);
const postgresPath = join(ROOT, postgresSuite);

function preflight() {
  const problems = [];
  for (const path of [
    servicePath,
    storePath,
    migrationPath,
    unitPath,
    postgresPath,
  ]) {
    if (!existsSync(path))
      problems.push(`${path.slice(ROOT.length + 1)} is missing`);
  }
  if (problems.length > 0) return problems;

  const service = readFileSync(servicePath, "utf8");
  const store = readFileSync(storePath, "utf8");
  const migration = readFileSync(migrationPath, "utf8");
  const unit = readFileSync(unitPath, "utf8");
  const postgres = readFileSync(postgresPath, "utf8");

  if (!store.includes("SELECT clock_timestamp() AS database_now")) {
    problems.push("credential liveness/issuance must use the Postgres clock");
  }
  if (!store.includes("rotateSessionByHash")) {
    problems.push(
      "session rotation must be a single hash-addressed store transaction",
    );
  }
  if (!store.includes("FOR SHARE") || !store.includes("FOR UPDATE")) {
    problems.push(
      "credential auth/rotation must lock membership and credential rows",
    );
  }
  const monotonicLastUsedUpdates =
    store.split("GREATEST(COALESCE(last_used_at, $2), $2)").length - 1;
  if (monotonicLastUsedUpdates < 3) {
    problems.push(
      "session auth/rotation and API-key auth must keep last-used monotonic",
    );
  }
  if (!store.includes('located.owner_kind === "legacy_unbound"')) {
    problems.push("ambiguous legacy NULL-user API keys must fail closed");
  }
  if (!store.includes('input.userId === undefined ? "organization" : "user"')) {
    problems.push("new API keys must persist explicit ownership provenance");
  }
  if (
    !migration.includes("auth_sessions_membership_id_fkey") ||
    !migration.includes("ON DELETE SET NULL")
  ) {
    problems.push("session membership provenance FK is missing");
  }
  if (!migration.includes("api_keys_membership_id_fkey")) {
    problems.push("API-key membership provenance FK is missing");
  }
  if (!migration.includes("legacy_unbound")) {
    problems.push(
      "migration must not guess ambiguous legacy NULL-user keys are organization-owned",
    );
  }
  if (
    /authenticateSessionByHash\(hashToken\(token\),\s*this\.#now\(\)\)/u.test(
      service,
    )
  ) {
    problems.push(
      "AuthService must not pass its process clock into session liveness",
    );
  }
  if (
    /authenticateApiKeyByHash\(hashToken\(token\),\s*this\.#now\(\)\)/u.test(
      service,
    )
  ) {
    problems.push(
      "AuthService must not pass its process clock into API-key liveness",
    );
  }
  for (const witness of [
    "keeps credential liveness and rotation independent from the API replica clock",
    "lets the database reject expired or membership-less API-key issuance",
  ]) {
    if (!unit.includes(witness))
      problems.push(`missing unit witness: ${witness}`);
  }
  for (const witness of [
    "uses database time for session issuance/authentication and atomically rotates live membership-bound sessions",
    "never resurrects sessions or user API keys when membership is removed and later recreated",
    "does not convert a deleted user's API key into an organization-owned credential",
    "refuses to pre-provision user credentials without a live membership and uses database time for API-key expiry",
    "fails closed for ambiguous legacy API-key ownership even if an unrevoked row is injected",
  ]) {
    if (!postgres.includes(witness))
      problems.push(`missing Postgres witness: ${witness}`);
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 credential-authority preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  "Phase 3 credential-authority preflight: database clock, atomic rotation, durable membership provenance, " +
    "legacy fail-closed ownership, and 7 focused witnesses present.",
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 credential-authority execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable auth/Postgres result is claimed.",
  );
  process.exit(2);
}

const docker = spawnSync("docker", ["info"], { cwd: ROOT, stdio: "ignore" });
if (docker.status !== 0) {
  console.error(
    "Phase 3 credential-authority Postgres execution requires Docker. " +
      "Preflight passed, but no database result is claimed.",
  );
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  [vitest, "run", unitSuite, postgresSuite],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ACALYS_REQUIRE_POSTGRES: "1" },
  },
);
process.exit(result.status ?? 2);
