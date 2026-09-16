/**
 * Phase 3 structural-boundary probe.
 *
 * The Phase 3 handoff requires both new dependency-cruiser rules to be proven
 * by planting a forbidden edge, observing the named rule reject it, and then
 * restoring the tree. `--preflight-only` is safe for source-only checkpoints.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const TARGET = "apps/api/src/app.ts";
const TARGET_PATH = join(ROOT, TARGET);
const CONFIG = join(ROOT, ".dependency-cruiser.cjs");
const CRUISER = join(ROOT, "node_modules", ".bin", "depcruise");

const probes = [
  {
    name: "api-must-not-import-review-worker",
    line: 'import "../../review-worker/src/runtime.js";\n',
  },
  {
    name: "database-driver-only-in-database-package",
    line: 'import "pg";\n',
  },
];

function preflight() {
  const problems = [];
  if (!existsSync(TARGET_PATH)) problems.push(`missing target ${TARGET}`);
  if (!existsSync(CONFIG)) problems.push("missing .dependency-cruiser.cjs");
  const config = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : "";
  for (const probe of probes) {
    if (!config.includes(`name: "${probe.name}"`)) {
      problems.push(`missing dependency rule ${probe.name}`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(2);
  }
  console.log(
    `Phase 3 architecture probe preflight: ${String(probes.length)}/${String(probes.length)} rules present.`,
  );
}

preflight();
if (process.argv.includes("--preflight-only")) process.exit(0);
if (!existsSync(CRUISER)) {
  console.error(
    "dependency-cruiser is not installed; run the repository install first",
  );
  process.exit(2);
}

let dirty = "";
try {
  dirty = execFileSync("git", ["status", "--porcelain", "--", TARGET], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
} catch {
  console.error(
    "architecture probe execution requires a Git worktree; use --preflight-only on source archives",
  );
  process.exit(2);
}
if (dirty !== "" && process.env["ACALYS_ARCH_PROBE_ALLOW_DIRTY"] !== "1") {
  console.error(`refusing to modify a pre-existing dirty target:\n${dirty}`);
  process.exit(2);
}

const backupDir = mkdtempSync(join(tmpdir(), "acalys-phase3-architecture-"));
const backup = join(backupDir, "app.ts");
copyFileSync(TARGET_PATH, backup);
const original = readFileSync(TARGET_PATH, "utf8");
const results = [];

try {
  for (const probe of probes) {
    writeFileSync(TARGET_PATH, probe.line + original);
    let output = "";
    let exitCode = 0;
    try {
      output = execFileSync(
        CRUISER,
        ["apps", "packages", "--config", ".dependency-cruiser.cjs"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      exitCode = typeof error.status === "number" ? error.status : 1;
      output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    } finally {
      copyFileSync(backup, TARGET_PATH);
    }
    const killed = exitCode !== 0 && output.includes(probe.name);
    results.push({ name: probe.name, killed, exitCode });
  }
} finally {
  copyFileSync(backup, TARGET_PATH);
}

for (const result of results) {
  console.log(
    `${result.name}: ${result.killed ? "REJECTED AS REQUIRED" : "NOT PROVEN"} (exit ${String(result.exitCode)})`,
  );
}
process.exit(results.every((result) => result.killed) ? 0 : 1);
