/**
 * Authoritative Phase 4 acceptance runner.
 *
 * `--preflight-only` is dependency-free and suitable for a source archive.
 * Full mode is fail-closed: it requires the installed repository toolchain and
 * Docker/Postgres, forces Postgres-backed suites to execute, and runs the
 * repository's complete protected verify pipeline. Browser/CDP validation is a
 * separate release witness and is intentionally not represented as passing here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const PREFLIGHTS = [
  "scripts/probe-phase4-live-foundation.mjs",
  "scripts/probe-phase4-review-workflow.mjs",
  "scripts/probe-phase4-dashboard-admin.mjs",
  "scripts/probe-phase4-fixture-firewall.mjs",
  "scripts/probe-phase4-provider-context.mjs",
  "scripts/probe-phase4-review-policy.mjs",
  "scripts/probe-phase4-auth-membership.mjs",
  "scripts/probe-phase4-analytics-reports.mjs",
  "scripts/probe-phase4-cache.mjs",
  "scripts/probe-phase4-notifications-repositories.mjs",
  "scripts/probe-phase4-security.mjs",
];

function reportPath() {
  const flag = process.argv.find((arg) => arg.startsWith("--report="));
  return resolve(
    ROOT,
    flag === undefined
      ? ".phase4-acceptance-report.json"
      : flag.slice("--report=".length),
  );
}

function runStep(name, command, args, env = process.env) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    name,
    command: [command, ...args].join(" "),
    exitCode: result.status ?? (result.error === undefined ? 1 : 2),
    signal: result.signal ?? null,
    durationMs,
    error: result.error?.message,
  };
}

function writeReport(report) {
  writeFileSync(reportPath(), `${JSON.stringify(report, null, 2)}\n`);
}

const preflightOnly = process.argv.includes("--preflight-only");
const report = {
  schemaVersion: 1,
  phase: 4,
  startedAt: new Date().toISOString(),
  mode: preflightOnly ? "preflight" : "full-source-and-integration",
  sourcePreflights: [],
  inheritedPhase3Preflight: null,
  environment: {},
  execution: [],
  sourcePreflightPassed: false,
  executableAcceptancePassed: false,
  browserAcceptanceIncluded: false,
};

for (const script of PREFLIGHTS) {
  const outcome = runStep(`preflight ${script}`, "node", [script]);
  report.sourcePreflights.push(outcome);
  if (outcome.exitCode !== 0) {
    report.finishedAt = new Date().toISOString();
    writeReport(report);
    console.error(`Phase 4 acceptance stopped: ${script} preflight failed.`);
    process.exit(1);
  }
}

const phase3 = runStep("frozen Phase 3 preflight", "node", [
  "scripts/accept-phase3.mjs",
  "--preflight-only",
]);
report.inheritedPhase3Preflight = phase3;
if (phase3.exitCode !== 0) {
  report.finishedAt = new Date().toISOString();
  writeReport(report);
  console.error(
    "Phase 4 acceptance stopped: inherited Phase 3 preflight failed.",
  );
  process.exit(1);
}
report.sourcePreflightPassed = true;

if (preflightOnly) {
  report.finishedAt = new Date().toISOString();
  writeReport(report);
  console.log(
    "Phase 4 source preflight PASSED. Dependency/Postgres/browser acceptance was not requested.",
  );
  process.exit(0);
}

const requirements = [
  ["vitest", existsSync(resolve(ROOT, "node_modules/vitest/vitest.mjs"))],
  [
    "dependencyCruiser",
    existsSync(resolve(ROOT, "node_modules/.bin/depcruise")),
  ],
  ["typescript", existsSync(resolve(ROOT, "node_modules/.bin/tsc"))],
  ["eslint", existsSync(resolve(ROOT, "node_modules/.bin/eslint"))],
  ["prettier", existsSync(resolve(ROOT, "node_modules/.bin/prettier"))],
];
for (const [name, present] of requirements) report.environment[name] = present;
const docker = spawnSync("docker", ["ps", "-q"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 20_000,
});
report.environment.dockerPostgresRuntime = docker.status === 0;

const missing = Object.entries(report.environment)
  .filter(([, present]) => present !== true)
  .map(([name]) => name);
if (missing.length > 0) {
  report.blockedBy = missing;
  report.finishedAt = new Date().toISOString();
  writeReport(report);
  console.error(
    `Phase 4 executable acceptance BLOCKED: missing ${missing.join(", ")}. No blocked gate is counted as passing.`,
  );
  process.exit(2);
}

const strictEnv = { ...process.env, ACALYS_REQUIRE_POSTGRES: "1" };
const verify = runStep(
  "protected repository verify pipeline with required Postgres",
  "npm",
  ["run", "verify"],
  strictEnv,
);
report.execution.push(verify);
if (verify.exitCode !== 0) {
  report.finishedAt = new Date().toISOString();
  writeReport(report);
  console.error(
    "Phase 4 executable acceptance FAILED in the protected verify pipeline.",
  );
  process.exit(1);
}

report.executableAcceptancePassed = true;
report.finishedAt = new Date().toISOString();
writeReport(report);
console.log(
  "PHASE 4 SOURCE/INTEGRATION ACCEPTANCE PASSED. Browser/CDP release validation remains a separate required witness.",
);
