import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const mutationPath = join(ROOT, "packages/database/src/api-mutation-store.ts");
const apiStorePath = join(ROOT, "packages/database/src/api-store.ts");
const appPath = join(ROOT, "apps/api/src/app.ts");
const suite = "packages/database/tests/phase3-mutation-clock.test.ts";
const suitePath = join(ROOT, suite);

function preflight() {
  const problems = [];
  for (const path of [mutationPath, apiStorePath, appPath, suitePath]) {
    if (!existsSync(path)) problems.push(`${path.slice(ROOT.length + 1)} is missing`);
  }
  if (problems.length > 0) return problems;

  const mutation = readFileSync(mutationPath, "utf8");
  const apiStore = readFileSync(apiStorePath, "utf8");
  const app = readFileSync(appPath, "utf8");
  const tests = readFileSync(suitePath, "utf8");

  if (!mutation.includes("SELECT clock_timestamp() AS mutation_at")) {
    problems.push("ApiMutationStore must acquire its mutation timestamp from Postgres");
  }
  if (mutation.includes("readonly now: Date")) {
    problems.push("IdempotencyIdentity must not carry a replica-supplied clock");
  }
  if (!mutation.includes("const result = await work(client, mutationAt);")) {
    problems.push("the same database timestamp must be passed through the idempotent mutation work");
  }
  if (!mutation.includes("created_at)\n         VALUES ($1,$2,$3,$4,$5,'in_progress',$6)")) {
    problems.push("idempotency creation must persist the shared mutation timestamp");
  }
  if (!mutation.includes("completed_at=$8")) {
    problems.push("idempotency completion must persist the shared mutation timestamp");
  }
  if (!mutation.includes("completed_at=GREATEST($3::timestamptz, created_at, COALESCE(started_at, created_at))")) {
    problems.push("review cancellation must never move completion behind durable run history");
  }
  if (!mutation.includes("updated_at=GREATEST(updated_at, $4::timestamptz)")) {
    problems.push("finding dismissal must keep updated_at monotonic");
  }
  if (!mutation.includes("updated_at=GREATEST(updated_at, $3::timestamptz)")) {
    problems.push("conversation resolution must keep updated_at monotonic");
  }
  if (app.includes("requestDigest:digest({route:routeName,input:semanticInput}), now:")) {
    problems.push("the API process must not attach its local clock to mutation identity");
  }
  if (apiStore.includes("input.now]")) {
    problems.push("legacy ApiStore idempotency helpers must not write caller-supplied time");
  }
  if (!apiStore.includes("GREATEST(clock_timestamp(), created_at, COALESCE(started_at, created_at))")) {
    problems.push("legacy cancellation helper must also be database-clock/monotonic");
  }

  for (const witness of [
    "uses one Postgres timestamp for idempotency, request, run, dispatch, and the create response",
    "never moves review completion or transition history backward when durable state is already ahead",
    "converges concurrent same-key replicas on one database-timestamped response",
    "never completes an idempotency record before its own database-created timestamp",
  ]) {
    if (!tests.includes(witness)) problems.push(`missing Postgres witness: ${witness}`);
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 mutation-clock preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  "Phase 3 mutation-clock preflight: Postgres-owned mutation time, monotonic durable updates, " +
    "legacy clock bypass hardening, and 4 focused Postgres witnesses present.",
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 mutation-clock execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable result is claimed.",
  );
  process.exit(2);
}

const docker = spawnSync("docker", ["info"], { cwd: ROOT, stdio: "ignore" });
if (docker.status !== 0) {
  console.error(
    "Phase 3 mutation-clock Postgres execution requires Docker. " +
      "Preflight passed, but no database result is claimed.",
  );
  process.exit(2);
}

const result = spawnSync(process.execPath, [vitest, "run", suite], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, ACALYS_REQUIRE_POSTGRES: "1" },
});
process.exit(result.status ?? 2);
