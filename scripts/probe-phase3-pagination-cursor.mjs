import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const codecPath = join(ROOT, "apps/api/src/pagination-cursor.ts");
const appPath = join(ROOT, "apps/api/src/app.ts");
const mainPath = join(ROOT, "apps/api/src/main.ts");
const codecSuite = "apps/api/tests/pagination-cursor.test.ts";
const appSuite = "apps/api/tests/app.test.ts";
const kinds = [
  "repositories",
  "pull_requests",
  "findings",
  "conversations",
  "knowledge",
];

function preflight() {
  const problems = [];
  for (const path of [
    codecPath,
    appPath,
    mainPath,
    join(ROOT, codecSuite),
    join(ROOT, appSuite),
  ]) {
    if (!existsSync(path))
      problems.push(`${path.slice(ROOT.length + 1)} is missing`);
  }
  if (problems.length > 0) return problems;

  const codec = readFileSync(codecPath, "utf8");
  const app = readFileSync(appPath, "utf8");
  const main = readFileSync(mainPath, "utf8");
  const codecTests = readFileSync(join(ROOT, codecSuite), "utf8");
  const appTests = readFileSync(join(ROOT, appSuite), "utf8");

  const codecAnchors = [
    'createCipheriv("aes-256-gcm"',
    'createDecipheriv("aes-256-gcm"',
    "timingSafeEqual(tenant",
    'bindingHash("tenant", binding.organizationId)',
    'bindingHash("resource", binding.resource)',
    'bindingHash("query", binding.query)',
    'const TOKEN_PREFIX = "c1."',
    "secretGenerations.length > MAX_SECRET_GENERATIONS",
  ];
  for (const anchor of codecAnchors) {
    if (!codec.includes(anchor))
      problems.push(`cursor codec missing anchor: ${anchor}`);
  }
  for (const kind of kinds) {
    if (!codec.includes(`${kind}:`))
      problems.push(`cursor codec missing collection code: ${kind}`);
    if (!app.includes(`collection: "${kind}"`))
      problems.push(`API route is not cursor-bound: ${kind}`);
  }
  if (!main.includes('required("ACALYS_API_CURSOR_SECRET")')) {
    problems.push("production cursor secret is not required");
  }
  if (
    !main.includes(
      'optionalSecretGenerations("ACALYS_API_CURSOR_PREVIOUS_SECRETS")',
    )
  ) {
    problems.push(
      "previous cursor secret generations are not wired for rotation",
    );
  }

  const directWitnesses = [
    "round-trips the row id without exposing it on the wire",
    "rejects tampering",
    "binds the cursor to the organization",
    "binds the cursor to its collection",
    "binds nested collection cursors to the parent resource",
    "binds filtered collection cursors to the canonical filter set",
    "decodes the previous secret generation during rolling rotation",
    "rejects raw UUID cursors and invalid source row ids",
    "fails startup configuration closed for weak or empty secret rings",
  ];
  for (const witness of directWitnesses) {
    if (!codecTests.includes(witness))
      problems.push(`missing codec witness: ${witness}`);
  }
  const integrationWitnesses = [
    "emits an opaque repository cursor and round-trips it to the persistence cursor",
    "rejects raw or tampered cursors before the tenant query",
    "rejects cursor replay across organizations, collections, and parent resources",
    "rejects a findings cursor when the filter set changes",
  ];
  for (const witness of integrationWitnesses) {
    if (!appTests.includes(witness))
      problems.push(`missing API cursor witness: ${witness}`);
  }
  return problems;
}

const problems = preflight();
if (problems.length > 0) {
  console.error("Phase 3 pagination-cursor preflight FAILED:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(2);
}

console.log(
  "Phase 3 pagination-cursor preflight: 5/5 cursor-bearing collections cryptographically bound; " +
    "9 codec + 4 API integration witness anchors present.",
);

if (process.argv.includes("--preflight-only")) process.exit(0);

const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
if (!existsSync(vitest)) {
  console.error(
    "Phase 3 pagination-cursor execution requires installed Vitest dependencies. " +
      "Preflight passed, but no executable API result is claimed.",
  );
  process.exit(2);
}
const result = spawnSync(
  process.execPath,
  [vitest, "run", codecSuite, appSuite],
  {
    cwd: ROOT,
    stdio: "inherit",
  },
);
process.exit(result.status ?? 2);
