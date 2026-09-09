import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const storePath = join(
  ROOT,
  "packages/database/src/review/api-dispatch-store.ts",
);
const mutationPath = join(ROOT, "packages/database/src/api-mutation-store.ts");
const workerPath = join(ROOT, "apps/review-worker/src/api-dispatch-worker.ts");
const migrationPath = join(
  ROOT,
  "packages/database/migrations/0017_phase3_dispatch_coordination.sql",
);
const unitSuite = "apps/review-worker/tests/api-dispatch-worker.test.ts";
const postgresSuite =
  "packages/database/tests/phase3-dispatch-coordination.test.ts";
const unitPath = join(ROOT, unitSuite);
const postgresPath = join(ROOT, postgresSuite);

function preflight() {
  const problems = [];
  for (const path of [
    storePath,
    mutationPath,
    workerPath,
    migrationPath,
    unitPath,
    postgresPath,
  ]) {
    if (!existsSync(path))
      problems.push(`${path.slice(ROOT.length + 1)} is missing`);
  }
  if (problems.length > 0) return problems;

  const store = readFileSync(storePath, "utf8");
  const mutation = readFileSync(mutationPath, "utf8");
  const worker = readFileSync(workerPath, "utf8");
  const migration = readFileSync(migrationPath, "utf8");
  const unit = readFileSync(unitPath, "utf8");
  const postgres = readFileSync(postgresPath, "utf8");

  // Whitespace-tolerant: the formatter is free to wrap a long signature, and an
  // exact-string anchor would report a missing invariant on a purely cosmetic
  // change. What must stay true is the parameter list itself — no worker clock.
  if (
    !/public async claim\(\s*limit:\s*number,\s*leaseMillis:\s*number,?\s*\)/.test(
      store,
    )
  ) {
    problems.push("dispatch claim must not accept a worker-process timestamp");
  }
  if (!store.includes("clock_timestamp() AS at")) {
    problems.push(
      "dispatch scheduling and lease chronology must come from Postgres",
    );
  }
  if (!store.includes("pg_try_advisory_xact_lock(hashtextextended($1,0))")) {
    problems.push(
      "claim must refuse rows protected by a live executor advisory lock",
    );
  }
  if (!mutation.includes("reviewDispatchExecutionLockKey(input.reviewRunId)")) {
    problems.push(
      "cancellation must serialize on the same per-run execution fence",
    );
  }
  if (
    !mutation.includes(
      "SELECT id FROM review_runs WHERE organization_id=$1 AND id=$2",
    )
  ) {
    problems.push(
      "cancellation must tenant-check before touching a foreign run's advisory fence",
    );
  }
  if (!store.includes("pg_try_advisory_lock(hashtextextended($1,0))")) {
    problems.push(
      "execution must acquire a process-lifetime session advisory fence",
    );
  }
  if (!store.includes("public async acquireExecutionGuard")) {
    problems.push("dispatch execution guard is missing");
  }
  if (!store.includes("renew: async (leaseMillis)")) {
    problems.push(
      "active execution must renew its lease through the fenced guard",
    );
  }
  if (!store.includes("public async replayDeadLetter")) {
    problems.push("dead-letter replay entry point is missing");
  }
  if (!store.includes("newAttempt = row.attempt + 1")) {
    problems.push(
      "dead-letter replay must create a new run attempt instead of reviving terminal state",
    );
  }
  if (!mutation.includes("DELETE FROM review_dispatch_jobs")) {
    problems.push(
      "API cancellation must remove its dispatch obligation transactionally",
    );
  }
  if (!worker.includes("acquireExecutionGuard(")) {
    problems.push(
      "API dispatch worker must acquire the execution guard before review execution",
    );
  }
  if (!worker.includes("guard.renew(leaseMillis)")) {
    problems.push("API dispatch worker must heartbeat the current lease");
  }
  if (
    !migration.includes("review_dispatch_jobs_expired_lease_idx") ||
    !migration.includes(
      "lease_expires_at IS NOT NULL AND dead_lettered_at IS NULL",
    )
  ) {
    problems.push(
      "expired dispatch leases must retain an indexed crash-recovery path",
    );
  }
  if (/Date\.now\(\)|new Date\(\)/u.test(worker)) {
    problems.push(
      "API dispatch worker must not use process time for durable scheduling",
    );
  }

  for (const witness of [
    "defers peer-owned execution without treating it as a failure",
    "treats a live peer execution guard as coordination and never executes",
    "drops a lifecycle-settled claim without entering review execution",
    "does not settle after a heartbeat proves the generation is no longer current",
  ]) {
    if (!unit.includes(witness))
      problems.push(`missing worker witness: ${witness}`);
  }
  for (const witness of [
    "lets concurrent worker replicas claim one run only once",
    "serializes cancellation with claiming and removes the dispatch obligation",
    "waits for a live execution guard before cancellation can commit",
    "reclaims an abandoned claim after lease expiry with a higher generation",
    "does not steal an expired timestamp lease while the live executor guard is held",
    "replays a dead letter as one new run attempt and keeps the old generation fenced",
  ]) {
    if (!postgres.includes(witness))
      problems.push(`missing Postgres witness: ${witness}`);
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 dispatch-coordination preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  "Phase 3 dispatch-coordination preflight: database-clock claims, active-executor fencing, " +
    "lease renewal, cancellation serialization, crash recovery, generation-safe replay, and 10 focused witnesses present.",
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 dispatch-coordination execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable result is claimed.",
  );
  process.exit(2);
}

const docker = spawnSync("docker", ["info"], { cwd: ROOT, stdio: "ignore" });
if (docker.status !== 0) {
  console.error(
    "Phase 3 dispatch-coordination Postgres execution requires Docker. " +
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
