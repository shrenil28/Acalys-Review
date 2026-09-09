import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const appPath = join(ROOT, "apps/api/src/app.ts");
const suite = "apps/api/tests/app.test.ts";
const suitePath = join(ROOT, suite);

const mutationRoutes = [
  "createReview",
  "cancelReview",
  "dismissFinding",
  "resolveConversation",
];

function preflight() {
  const problems = [];
  for (const path of [appPath, suitePath]) {
    if (!existsSync(path))
      problems.push(`${path.slice(ROOT.length + 1)} is missing`);
  }
  if (problems.length > 0) return problems;

  const app = readFileSync(appPath, "utf8");
  const tests = readFileSync(suitePath, "utf8");

  if (
    !app.includes(
      "const declaredErrorStatuses = route.errorStatuses as readonly number[];",
    )
  ) {
    problems.push(
      "handler errors must derive their allowed status set from route.errorStatuses",
    );
  }
  if (!app.includes("if (!declaredErrorStatuses.includes(result.status))")) {
    problems.push(
      "undeclared handler error statuses must fail closed at the API boundary",
    );
  }
  if (!app.includes("if (error instanceof IdempotencyKeyRequired)")) {
    problems.push(
      "boundary-owned idempotency validation must remain outside handler status results",
    );
  }
  if (
    !tests.includes(
      "preserves the boundary-owned idempotency-key error outside route-declared handler statuses",
    )
  ) {
    problems.push("missing idempotency-boundary witness");
  }
  if (
    !tests.includes(
      "serializes a schema-valid handler error only when its status is declared by the route",
    )
  ) {
    problems.push("missing declared handler-status witness");
  }
  if (
    !tests.includes("rejects an undeclared schema-valid error status from %s")
  ) {
    problems.push("missing undeclared handler-status witness");
  }
  for (const route of mutationRoutes) {
    if (!tests.includes(`\"${route}\"`)) {
      problems.push(`missing undeclared-status mutation witness: ${route}`);
    }
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 handler-status preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  `Phase 3 handler-status preflight: manifest error-status enforcement present; ` +
    `${mutationRoutes.length}/${mutationRoutes.length} mutation status witnesses present.`,
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 handler-status execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable API result is claimed.",
  );
  process.exit(2);
}

const result = spawnSync(process.execPath, [vitest, "run", suite], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 2);
