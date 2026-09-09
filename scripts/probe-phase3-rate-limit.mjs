import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const storePath = join(ROOT, "packages/database/src/auth-store.ts");
const mainPath = join(ROOT, "apps/api/src/main.ts");
const appPath = join(ROOT, "apps/api/src/app.ts");
const suite = "packages/database/tests/phase3-rate-limit.test.ts";
const suitePath = join(ROOT, suite);

function count(source, needle) {
  return source.split(needle).length - 1;
}

function preflight() {
  const problems = [];
  for (const path of [storePath, mainPath, appPath, suitePath]) {
    if (!existsSync(path))
      problems.push(`${path.slice(ROOT.length + 1)} is missing`);
  }
  if (problems.length > 0) return problems;

  const store = readFileSync(storePath, "utf8");
  const main = readFileSync(mainPath, "utf8");
  const app = readFileSync(appPath, "utf8");
  const tests = readFileSync(suitePath, "utf8");

  if (count(store, "consumeApiRateLimits") !== 1) {
    problems.push(
      "AuthStore must define exactly one consumeApiRateLimits method",
    );
  }
  if (!store.includes("date_trunc('minute', clock_timestamp())")) {
    problems.push("rate-limit window must come from the Postgres clock");
  }
  if (
    !store.includes(
      "WHEN api_rate_windows.request_count < $4 THEN api_rate_windows.request_count + 1",
    ) ||
    !store.includes("ELSE api_rate_windows.request_count")
  ) {
    problems.push(
      "denied rate-limit counters must saturate monotonically without decreasing",
    );
  }
  if (!store.includes("await refund(principalBucket)")) {
    problems.push("organization denial must refund the principal increment");
  }
  if (
    main.includes("getTime()/60_000") ||
    main.includes("windowStart=new Date")
  ) {
    problems.push(
      "API bootstrap must not derive rate-limit windows from process time",
    );
  }
  if (!main.includes("authStore.consumeApiRateLimits")) {
    problems.push(
      "API bootstrap must use the transactional dual-bucket limiter",
    );
  }
  if (/consumeRate:\s*\(input:[\s\S]{0,180}readonly now: Date/u.test(app)) {
    problems.push(
      "API rate-limit callback must not accept an application timestamp",
    );
  }
  for (const witness of [
    "uses the database clock as the shared fixed-window authority",
    "serializes concurrent replica admissions",
    "does not burn principal quota when the organization bucket is already exhausted",
    "never lowers an existing counter during a rolling limit change",
  ]) {
    if (!tests.includes(witness))
      problems.push(`missing Postgres witness: ${witness}`);
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 rate-limit preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  "Phase 3 rate-limit preflight: database clock authority, transactional dual buckets, " +
    "monotonic bounded counters, refund semantics, and 4 Postgres witnesses present.",
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 rate-limit execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable Postgres result is claimed.",
  );
  process.exit(2);
}

const result = spawnSync(process.execPath, [vitest, "run", suite], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, ACALYS_REQUIRE_POSTGRES: "1" },
});
process.exit(result.status ?? 2);
