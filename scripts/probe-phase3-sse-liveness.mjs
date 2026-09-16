import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const appPath = join(ROOT, "apps/api/src/app.ts");
const suite = "apps/api/tests/app.test.ts";
const suitePath = join(ROOT, suite);

function preflight() {
  const problems = [];
  for (const path of [appPath, suitePath]) {
    if (!existsSync(path))
      problems.push(`${path.slice(ROOT.length + 1)} is missing`);
  }
  if (problems.length > 0) return problems;

  const app = readFileSync(appPath, "utf8");
  const tests = readFileSync(suitePath, "utf8");

  if (!app.includes('import { performance } from "node:perf_hooks";')) {
    problems.push("SSE idle scheduling must use a monotonic process clock");
  }
  if (/Date\.now\(\)/u.test(app)) {
    problems.push("SSE liveness must not depend on wall-clock Date.now()");
  }
  if (!app.includes("awaitWithHeartbeats(")) {
    problems.push("SSE needs a heartbeat-aware wait primitive");
  }
  if (!app.includes("delay(pollMillis)")) {
    problems.push("idle poll delay must remain heartbeat-aware");
  }
  if (
    !app.includes("options.api.reviewEvents(context.scope, id, after, 100)")
  ) {
    problems.push(
      "durable event polls must remain in the heartbeat-aware stream loop",
    );
  }
  if (!app.includes('writeSseFrame(response, ": heartbeat\\n\\n")')) {
    problems.push(
      "heartbeat writes must use the backpressure-aware SSE writer",
    );
  }
  if (!app.includes("heartbeat.markActivity();\n          after = event.id")) {
    problems.push("product frames must reset the idle heartbeat deadline");
  }
  if (!app.includes("MAX_SSE_HEARTBEAT_MILLIS = 60_000")) {
    problems.push("heartbeat configuration needs an explicit upper bound");
  }
  if (!app.includes("MAX_SSE_POLL_MILLIS = 60_000")) {
    problems.push("poll configuration needs an explicit upper bound");
  }
  if (!app.includes("heartbeatWrite !== undefined")) {
    problems.push(
      "operation completion must wait for an in-flight heartbeat write",
    );
  }

  for (const witness of [
    "writes heartbeats without product state and then resumes polling",
    "keeps sending bounded heartbeats while a database event poll is still pending",
    "uses a monotonic idle clock and bounds invalid SSE timing configuration",
  ]) {
    if (!tests.includes(witness))
      problems.push(`missing SSE liveness witness: ${witness}`);
  }

  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 SSE-liveness preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  "Phase 3 SSE-liveness preflight: monotonic bounded heartbeat scheduling, " +
    "heartbeat-aware poll/query waits, serialized keepalive writes, and 3/3 focused witnesses present.",
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 SSE-liveness execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable API result is claimed.",
  );
  process.exit(2);
}

const result = spawnSync(process.execPath, [vitest, "run", suite], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 2);
