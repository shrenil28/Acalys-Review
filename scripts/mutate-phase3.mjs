/**
 * Phase 3 contract mutation harness.
 *
 * These four mutants are the minimum acceptance witnesses named by the Phase 3
 * capability contract: authentication liveness, tenant isolation, idempotency
 * digest binding, and outbound response validation. A mutant is counted only
 * when its declared suite actually runs. Stale anchors, skipped suites, and
 * compile/startup failures never become passing mutation evidence.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { acquireSession, releaseSession } from "./mutation-session.mjs";

const run = promisify(execFile);
const ROOT = process.cwd();
const SESSION_NONCE = randomUUID();

const ALL_MUTATIONS = [
  {
    id: 1,
    boundary: "auth",
    name: "a user-bound API key bypasses live membership enforcement",
    file: "packages/database/src/auth-store.ts",
    find: '      if (located.owner_kind === "user") {',
    replace: "      if (false) {",
    suite: "packages/database/tests/phase3-auth-store.test.ts",
  },
  {
    id: 2,
    boundary: "tenant_query",
    name: "repository lookup ignores the organization boundary",
    file: "packages/database/src/api-store.ts",
    find: "         FROM repositories WHERE organization_id = $1 AND id = $2",
    replace: "         FROM repositories WHERE id = $2",
    suite: "packages/database/tests/phase3-api.test.ts",
  },
  {
    id: 3,
    boundary: "idempotency",
    name: "an idempotency key may be reused for a different canonical request",
    file: "packages/database/src/api-mutation-store.ts",
    find:
      "        if (row.request_digest !== identity.requestDigest)\n" +
      '          return { kind: "conflict" };',
    replace: '        if (false)\n          return { kind: "conflict" };',
    suite: "packages/database/tests/phase3-api.test.ts",
  },
  {
    id: 4,
    boundary: "response_validation",
    name: "a malformed successful handler result is serialized",
    file: "apps/api/src/app.ts",
    find:
      "          const checked = route.response.safeParse(result.body);\n" +
      '          if (!checked.success) throw new Error("RESPONSE_CONTRACT_VIOLATION");',
    replace:
      "          const checked = { success: true, data: result.body } as const;",
    suite: "apps/api/tests/app.test.ts",
  },
];

const requested = process.env["ACALYS_MUTATION_IDS"];
const requestedIds =
  requested === undefined
    ? undefined
    : new Set(requested.split(",").map((entry) => Number(entry.trim())));
const MUTATIONS =
  requestedIds === undefined
    ? ALL_MUTATIONS
    : ALL_MUTATIONS.filter((mutation) => requestedIds.has(mutation.id));

function manifestPreflight() {
  const problems = [];
  const ids = new Set();

  if (MUTATIONS.length === 0) problems.push("no mutation definitions selected");

  for (const mutation of MUTATIONS) {
    if (ids.has(mutation.id))
      problems.push(`duplicate mutation id ${String(mutation.id)}`);
    ids.add(mutation.id);

    const target = join(ROOT, mutation.file);
    if (!existsSync(target)) {
      problems.push(
        `#${String(mutation.id)} target does not exist: ${mutation.file}`,
      );
      continue;
    }
    if (!existsSync(join(ROOT, mutation.suite))) {
      problems.push(
        `#${String(mutation.id)} suite does not exist: ${mutation.suite}`,
      );
    }

    const source = readFileSync(target, "utf8");
    const occurrences = source.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      problems.push(
        `#${String(mutation.id)} anchor occurs ${String(occurrences)} times in ${mutation.file}; expected exactly 1`,
      );
    }
    if (mutation.find === mutation.replace) {
      problems.push(`#${String(mutation.id)} replacement is a no-op`);
    }
  }

  if (problems.length > 0) {
    console.error("Phase 3 mutation preflight FAILED:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(2);
  }

  console.log(
    `Phase 3 mutation preflight: ${String(MUTATIONS.length)} definitions, ` +
      `${String(MUTATIONS.length)} unique anchors, ${String(MUTATIONS.length)} suites present.`,
  );
}

function assertExecutionTreeIsSafe() {
  let dirty;
  try {
    dirty = execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        ...new Set(MUTATIONS.map((mutation) => mutation.file)),
      ],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
  } catch {
    throw new Error(
      "Mutation execution requires a Git worktree so planted edits can be distinguished from pre-existing changes. Use --preflight-only on source archives.",
    );
  }

  if (dirty !== "" && process.env["ACALYS_MUTATE_ALLOW_DIRTY"] !== "1") {
    throw new Error(
      `Refusing to mutate files with pre-existing changes:\n${dirty}\n` +
        "Commit/restore them first, or set ACALYS_MUTATE_ALLOW_DIRTY=1 deliberately.",
    );
  }
}

function parseReport(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

async function runSuite(suite) {
  try {
    const { stdout } = await run(
      "node",
      ["./node_modules/vitest/vitest.mjs", "run", suite, "--reporter=json"],
      {
        cwd: ROOT,
        maxBuffer: 200 * 1024 * 1024,
        env: { ...process.env, ACALYS_MUTATION_SESSION: SESSION_NONCE },
      },
    );
    return { stdout, stderr: "" };
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

manifestPreflight();
if (process.argv.includes("--preflight-only")) process.exit(0);

try {
  assertExecutionTreeIsSafe();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const backupDir = mkdtempSync(join(tmpdir(), "acalys-phase3-mutate-"));
const outstanding = new Map();
let sessionHeld = false;

function restoreAll() {
  for (const [file, backup] of outstanding) {
    try {
      copyFileSync(backup, join(ROOT, file));
    } catch {
      // Best-effort recovery while the process is terminating.
    }
  }
  outstanding.clear();
}

function restore(file, backup) {
  copyFileSync(backup, join(ROOT, file));
  outstanding.delete(file);
}

function releaseHeldSession() {
  if (!sessionHeld) return;
  releaseSession();
  sessionHeld = false;
}

process.once("SIGINT", () => {
  restoreAll();
  releaseHeldSession();
  process.exit(130);
});
process.once("SIGTERM", () => {
  restoreAll();
  releaseHeldSession();
  process.exit(143);
});
process.once("exit", () => {
  restoreAll();
  releaseHeldSession();
});

try {
  acquireSession(SESSION_NONCE);
  sessionHeld = true;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const results = [];

for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file);
  const original = readFileSync(path, "utf8");
  const backup = join(backupDir, mutation.file.replaceAll("/", "__"));
  copyFileSync(path, backup);
  outstanding.set(mutation.file, backup);

  const mutated = original.replace(mutation.find, mutation.replace);
  writeFileSync(path, mutated);
  const present =
    readFileSync(path, "utf8").includes(mutation.replace) &&
    mutated !== original;

  if (!present) {
    restore(mutation.file, backup);
    results.push({
      ...mutation,
      verdict: "INVALID",
      detail: "mutation not present on disk",
    });
    continue;
  }

  const outcome = await runSuite(mutation.suite);
  const report = parseReport(outcome.stdout);
  restore(mutation.file, backup);

  if (report === undefined) {
    results.push({
      ...mutation,
      verdict: "INVALID",
      detail: `suite did not produce a Vitest report: ${outcome.stderr.split("\n").slice(0, 2).join(" ")}`,
    });
    continue;
  }

  const assertions = (report.testResults ?? []).flatMap(
    (file) => file.assertionResults ?? [],
  );
  const notRun = new Set(["pending", "skipped", "todo"]);
  const executed = assertions.filter((test) => !notRun.has(test.status)).length;
  const skipped = assertions.filter((test) => notRun.has(test.status)).length;
  const failed = assertions.filter((test) => test.status === "failed").length;
  const brokenSuites = (report.testResults ?? []).filter(
    (file) =>
      file.status === "failed" && (file.assertionResults ?? []).length === 0,
  ).length;

  const verdict =
    executed > 0 && skipped === 0 && failed > 0 && brokenSuites === 0
      ? "SEMANTIC_KILL"
      : executed === 0 || skipped > 0 || brokenSuites > 0
        ? "INVALID"
        : "SURVIVED";
  results.push({
    ...mutation,
    verdict,
    executed,
    skipped,
    failed,
    brokenSuites,
  });
}

for (const result of results) {
  console.log(
    `#${String(result.id)} [${result.boundary}] ${result.name}\n` +
      `  ${result.verdict}` +
      (result.executed === undefined
        ? ` — ${result.detail ?? "no execution evidence"}`
        : ` — executed=${String(result.executed)} skipped=${String(result.skipped)} failed=${String(result.failed)}`),
  );
}

const semantic = results.filter(
  (result) => result.verdict === "SEMANTIC_KILL",
).length;
const survived = results.filter(
  (result) => result.verdict === "SURVIVED",
).length;
const invalid = results.filter((result) => result.verdict === "INVALID").length;
console.log(
  `Phase 3 mutations: ${String(semantic)} semantic kills, ` +
    `${String(survived)} survived, ${String(invalid)} invalid.`,
);

process.exit(survived > 0 || invalid > 0 ? 1 : 0);
