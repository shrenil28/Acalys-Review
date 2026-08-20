import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalJson } from "@acalys/contracts/domain";

import { L5_DEFAULT_PRODUCTION_POLICIES } from "./l5-production.js";
import { runL5FinalReport } from "./l5-report.js";

const root = resolve(import.meta.dirname, "../../../..");
const output = resolve(
  root,
  process.argv[2] ?? "docs/review/phase-1/l5-report.json",
);
const sourceFreezeCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

const report = await runL5FinalReport({
  repositoryId: "acalys/p1-l5/frozen-corpus",
  tenantId: "acalys-p1-l5",
  policies: L5_DEFAULT_PRODUCTION_POLICIES,
  sourceFreezeCommit,
  generatedAt: new Date().toISOString(),
});

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${canonicalJson(report)}\n`, "utf8");
process.stdout.write(`${output}\n`);
