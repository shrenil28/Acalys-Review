/**
 * A throwaway Postgres, for tests that must exercise the real constraint.
 *
 * The exactly-once guarantee is a unique index. An in-memory double can model
 * it, but a double is written by the same person who wrote the code it checks,
 * and it agrees with them by construction. The constraint either exists in the
 * migration or it does not, and only Postgres can say which.
 *
 * Skips rather than fails when Docker is unavailable, so the suite stays
 * runnable on a machine without it — with `describeWithPostgres` reporting the
 * skip loudly rather than silently passing.
 */

import { execFileSync, execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import pg from "pg";

const run = promisify(execFile);

const IMAGE = "postgres:16-alpine";
const PASSWORD = "acalys-test";
const DATABASE = "acalys_test";

/**
 * Whether integration tests may be skipped at all.
 *
 * `ACALYS_REQUIRE_POSTGRES=1` makes a missing Docker a hard failure. CI sets
 * it, so an infrastructure problem there can never masquerade as a green run —
 * which is the whole of the fail-closed rule below.
 */
export const POSTGRES_REQUIRED = process.env["ACALYS_REQUIRE_POSTGRES"] === "1";

export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    if (POSTGRES_REQUIRED) {
      throw new Error(
        "ACALYS_REQUIRE_POSTGRES=1 but Docker is unavailable. Refusing to skip: " +
          "an integration suite that reports success without running is worse " +
          "than one that fails.",
      );
    }
    return false;
  }
}

/**
 * Suite-level guard against a green-but-empty run.
 *
 * Three separate bugs in this project shared one shape: **the suite reported
 * success while the property was never exercised.** An unawaited `fc.assert`,
 * a misspelled field masked by `?? 0`, and two test files fighting over one
 * container that turned 16 assertions into silent skips.
 *
 * Vigilance does not fix a recurring class of bug; a mechanism does. Every
 * Postgres-backed suite calls this after setup, so a database that failed to
 * start or a schema that failed to migrate fails the suite instead of quietly
 * degrading it to zero assertions.
 */
export async function assertSuiteIsActuallyRunning(
  database: TestDatabase,
  expectedTables: readonly string[],
): Promise<void> {
  const result = await database.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const present = new Set(result.rows.map((row) => row.table_name));
  const missing = expectedTables.filter((table) => !present.has(table));

  if (missing.length > 0) {
    throw new Error(
      `Schema is not migrated; missing: ${missing.join(", ")}. ` +
        "Refusing to run assertions against an empty database.",
    );
  }
}

async function waitForReady(
  container: string,
  deadlineMillis = 60_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await run("docker", [
        "exec",
        container,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        DATABASE,
      ]);
      return;
    } catch {
      if (Date.now() - started > deadlineMillis) {
        throw new Error("Postgres did not become ready in time");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export interface TestDatabase {
  readonly pool: pg.Pool;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts a container **per test file**.
 *
 * Vitest runs files in parallel, so a single shared container name means one
 * file's `docker rm -f` destroys the other's database mid-run. That surfaced as
 * 16 tests reporting *skipped* rather than failing — the quiet failure mode
 * this project keeps finding, where a suite claims success while verifying
 * nothing.
 *
 * The name and port are derived from the caller's label so the isolation is
 * visible in `docker ps` during a hung run.
 */
export async function startPostgres(label = "default"): Promise<TestDatabase> {
  const CONTAINER = `acalys-test-postgres-${label}`;
  // Deterministic per label, so a crashed run's container is found and removed
  // by the next one rather than leaking a random port.
  const PORT =
    55_400 +
    ([...label].reduce((total, char) => total + char.charCodeAt(0), 0) % 90);
  // Removed first, so a container left by an interrupted run does not make the
  // next one fail with a stale schema.
  await run("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
  await run("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-e",
    `POSTGRES_DB=${DATABASE}`,
    "-p",
    `${String(PORT)}:5432`,
    IMAGE,
    // fsync off: this database is discarded, and durability of the *test*
    // database is not what is under test. The transaction semantics that are
    // under test are unaffected.
    "-c",
    "fsync=off",
  ]);

  await waitForReady(CONTAINER);

  const pool = new pg.Pool({
    host: "127.0.0.1",
    port: PORT,
    user: "postgres",
    password: PASSWORD,
    database: DATABASE,
    max: 20,
  });

  // Applied in order, as a real deployment would. 0002 alters tables 0001
  // creates, so running them independently would not exercise the schema that
  // actually ships.
  const migrations = [
    "0001_webhook_inbox.sql",
    "0002_review_ingestion.sql",
  ].map((name) =>
    readFileSync(
      fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
      "utf8",
    ),
  );

  const apply = async (): Promise<void> => {
    await pool.query(
      `DROP TABLE IF EXISTS review_run_transitions, review_runs, review_requests,
         pull_request_revisions, pull_requests, repositories, organizations,
         webhook_jobs, webhook_deliveries CASCADE`,
    );
    for (const migration of migrations) {
      await pool.query(migration);
    }
  };

  await apply();

  return {
    pool,
    reset: apply,
    async stop() {
      await pool.end();
      await run("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
    },
  };
}
