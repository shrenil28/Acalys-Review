import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const appPath = "apps/api/src/app.ts";
const suite = "apps/api/tests/app.test.ts";
const queryRoutes = [
  "listRepositories",
  "listPullRequests",
  "listReviewFindings",
  "listConversations",
  "listKnowledge",
];

function preflight() {
  const problems = [];
  for (const path of [appPath, suite]) {
    if (!existsSync(join(ROOT, path))) problems.push(`${path} is missing`);
  }
  if (problems.length > 0) return problems;

  const app = readFileSync(join(ROOT, appPath), "utf8");
  const tests = readFileSync(join(ROOT, suite), "utf8");
  if (!app.includes('if (typeof value !== "string")')) {
    problems.push("query boundary does not fail closed on structured/duplicate values");
  }
  if (!app.includes("Query parameter must appear exactly once as a scalar string")) {
    problems.push("query boundary is missing the duplicate/structured validation failure");
  }
  if (/if \(typeof value === "string"\) out\[key\] = value;/u.test(app)) {
    problems.push("old query-value dropping path is still present");
  }
  if (!tests.includes("rejects duplicate scalar query values before the %s handler")) {
    problems.push("missing duplicate-query short-circuit witness matrix");
  }
  for (const route of queryRoutes) {
    if (!tests.includes(`"${route}"`)) problems.push(`missing query-bearing route witness: ${route}`);
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 query-boundary preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}
console.log(
  `Phase 3 query-boundary preflight: structured/duplicate values fail closed; ` +
    `${queryRoutes.length}/${queryRoutes.length} query-bearing route witnesses present.`,
);
if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 query-boundary execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable API result is claimed.",
  );
  process.exit(2);
}
const result = spawnSync(process.execPath, [vitest, "run", suite], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 2);
