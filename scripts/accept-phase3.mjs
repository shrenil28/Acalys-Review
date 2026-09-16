/**
 * Authoritative Phase 3 acceptance runner.
 *
 * `--preflight-only` is dependency-free and safe on source archives.
 * Full mode is intentionally strict: it requires a real installed toolchain,
 * a Git worktree for planted mutations, and Docker-backed Postgres. It sets
 * ACALYS_REQUIRE_POSTGRES=1 so integration suites can never skip to green.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const PREFLIGHTS = [
  "scripts/assert-phase3-source-invariants.mjs",
  "scripts/mutate-phase3.mjs",
  "scripts/probe-phase3-architecture.mjs",
  "scripts/probe-phase3-tenant-graph.mjs",
  "scripts/probe-phase3-rate-limit.mjs",
  "scripts/probe-phase3-error-boundary.mjs",
  "scripts/probe-phase3-auth-clock.mjs",
  "scripts/probe-phase3-mutation-clock.mjs",
  "scripts/probe-phase3-oauth-commit.mjs",
  "scripts/probe-phase3-dispatch-coordination.mjs",
  "scripts/probe-phase3-sse-liveness.mjs",
  "scripts/probe-phase3-pagination-cursor.mjs",
  "scripts/probe-phase3-handler-status.mjs",
  "scripts/probe-phase3-check-page-bound.mjs",
  "scripts/probe-phase3-query-boundary.mjs",
];

const FULL_STEPS = [
  {
    name: "nine protected repository gates",
    command: "npm",
    args: ["run", "verify"],
  },
  {
    name: "planted architecture violations",
    command: "node",
    args: ["scripts/probe-phase3-architecture.mjs"],
  },
  {
    name: "four required Phase 3 mutants",
    command: "node",
    args: ["scripts/mutate-phase3.mjs"],
  },
  {
    name: "post-mutation source restoration",
    command: "node",
    args: ["scripts/assert-phase3-source-invariants.mjs"],
  },
];

function reportPath() {
  const flag = process.argv.find((arg) => arg.startsWith("--report="));
  return resolve(
    ROOT,
    flag === undefined
      ? ".phase3-acceptance-report.json"
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
  const exitCode = result.status ?? (result.error === undefined ? 1 : 2);
  return {
    name,
    command: [command, ...args].join(" "),
    exitCode,
    signal: result.signal ?? null,
    durationMs,
    error: result.error?.message,
  };
}

function writeReport(report) {
  writeFileSync(reportPath(), `${JSON.stringify(report, null, 2)}\n`);
}

const report = {
  schemaVersion: 1,
  phase: 3,
  startedAt: new Date().toISOString(),
  mode: process.argv.includes("--preflight-only") ? "preflight" : "full",
  sourcePreflights: [],
  environment: {},
  execution: [],
  accepted: false,
};

for (const script of PREFLIGHTS) {
  const args = [script];
  if (script !== "scripts/assert-phase3-source-invariants.mjs")
    args.push("--preflight-only");
  const outcome = runStep(`preflight ${script}`, "node", args);
  report.sourcePreflights.push(outcome);
  if (outcome.exitCode !== 0) {
    report.finishedAt = new Date().toISOString();
    writeReport(report);
    console.error(`Phase 3 acceptance stopped: ${script} preflight failed.`);
    process.exit(1);
  }
}

if (process.argv.includes("--preflight-only")) {
  report.accepted = false;
  report.preflightPassed = true;
  report.finishedAt = new Date().toISOString();
  writeReport(report);
  console.log(
    "Phase 3 acceptance preflight PASSED. Full acceptance was not requested.",
  );
  process.exit(0);
}

const requirements = [
  ["vitest", existsSync(resolve(ROOT, "node_modules/vitest/vitest.mjs"))],
  [
    "dependency-cruiser",
    existsSync(resolve(ROOT, "node_modules/.bin/depcruise")),
  ],
  ["typescript", existsSync(resolve(ROOT, "node_modules/.bin/tsc"))],
];
for (const [name, present] of requirements) report.environment[name] = present;

const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: ROOT,
  encoding: "utf8",
});
report.environment.gitWorktree =
  git.status === 0 && git.stdout.trim() === "true";
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
  report.finishedAt = new Date().toISOString();
  report.blockedBy = missing;
  writeReport(report);
  console.error(
    `Phase 3 full acceptance BLOCKED before execution: missing ${missing.join(", ")}. ` +
      "No blocked or skipped gate is counted as passing.",
  );
  process.exit(2);
}

const strictEnv = {
  ...process.env,
  ACALYS_REQUIRE_POSTGRES: "1",
};

for (const step of FULL_STEPS) {
  const outcome = runStep(step.name, step.command, step.args, strictEnv);
  report.execution.push(outcome);
  if (outcome.exitCode !== 0) {
    report.finishedAt = new Date().toISOString();
    writeReport(report);
    console.error(`Phase 3 acceptance FAILED at: ${step.name}.`);
    process.exit(1);
  }
}

report.accepted = true;
report.finishedAt = new Date().toISOString();
writeReport(report);
console.log(
  "PHASE 3 ACCEPTED: nine gates green, Postgres required, architecture violations rejected, 4/4 mutants killed.",
);
