import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const appPath = join(ROOT, "apps/api/src/app.ts");
const suite = "apps/api/tests/app.test.ts";
const suitePath = join(ROOT, suite);

const taxonomyCodes = [
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "PROVIDER_ERROR",
  "REPOSITORY_ERROR",
  "SANDBOX_ERROR",
  "TOOL_EXECUTION_ERROR",
  "REVIEW_ERROR",
  "CONFIGURATION_ERROR",
  "INTERNAL_ERROR",
];

function preflight() {
  const problems = [];
  for (const path of [appPath, suitePath]) {
    if (!existsSync(path)) problems.push(`${path.slice(ROOT.length + 1)} is missing`);
  }
  if (problems.length > 0) return problems;

  const app = readFileSync(appPath, "utf8");
  const tests = readFileSync(suitePath, "utf8");

  if (!app.includes("errorResponseSchema.safeParse(result.body)")) {
    problems.push("handler non-2xx bodies must be checked by errorResponseSchema");
  }
  if (!app.includes('type === "entity.parse.failed"')) {
    problems.push("malformed JSON must have an explicit framework-error projection");
  }
  if (!app.includes('type === "entity.too.large"')) {
    problems.push("oversized request bodies must have an explicit framework-error projection");
  }
  if (!app.includes('app.use("/api/v1", (_request, response) =>')) {
    problems.push("undeclared /api/v1 routes must have a JSON 404 boundary");
  }
  if (!app.includes("PUBLIC_ACALYS_ERROR_MESSAGE")) {
    problems.push("typed platform errors must use an explicit public-message projection");
  }
  if (/serialized\.message|error\.message\s*,\s*error\.retryability/u.test(app)) {
    problems.push("typed error messages must not be forwarded verbatim to the public API");
  }
  if (!tests.includes("schema-validates handler error bodies before serialization")) {
    problems.push("missing malformed handler-error witness");
  }
  if (!tests.includes("malformed JSON, oversized bodies, and unknown v1 routes")) {
    problems.push("missing framework/404 error-boundary witness");
  }
  if (!tests.includes("native or hostile thrown values")) {
    problems.push("missing hostile thrown-value witness");
  }
  for (const code of taxonomyCodes) {
    if (!tests.includes(`\"${code}\"`)) {
      problems.push(`missing public taxonomy witness: ${code}`);
    }
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 error-boundary preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  `Phase 3 error-boundary preflight: ${taxonomyCodes.length}/` +
    `${taxonomyCodes.length} taxonomy codes witnessed; framework, hostile-value, ` +
    "and non-2xx schema boundaries present.",
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 error-boundary execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable API result is claimed.",
  );
  process.exit(2);
}

const result = spawnSync(process.execPath, [vitest, "run", suite], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 2);
