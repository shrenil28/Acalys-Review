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

/**
 * Waits for a database that will actually accept a connection.
 *
 * `pg_isready` over the container's unix socket is **not** sufficient, and the
 * reason is a real race rather than flakiness: the official Postgres image runs
 * `initdb` against a *temporary* server first, and that server answers
 * `pg_isready` on the socket. A client that connects then gets
 * "Connection terminated unexpectedly" when the temp server shuts down and the
 * real one starts.
 *
 * So readiness is probed over **TCP**, which the temporary server does not
 * listen on, and then confirmed with a real query — the only check that proves
 * the thing under test is reachable.
 */
async function waitForReady(
  container: string,
  port: number,
  deadlineMillis = 90_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      // -h forces TCP. The init-time temporary server is socket-only, so this
      // cannot succeed against it.
      await run("docker", [
        "exec",
        container,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        DATABASE,
      ]);

      // And confirm from outside the container, which is where the tests run.
      const probe = new pg.Client({
        host: "127.0.0.1",
        port,
        user: "postgres",
        password: PASSWORD,
        database: DATABASE,
        connectionTimeoutMillis: 3_000,
      });
      await probe.connect();
      await probe.query("SELECT 1");
      await probe.end();
      return;
    } catch {
      if (Date.now() - started > deadlineMillis) {
        throw new Error(
          `Postgres container ${container} did not become reachable on port ${String(port)}`,
        );
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
/**
 * The host port Docker assigned.
 *
 * Read back rather than assumed. `docker port` is the only authority on it, and
 * parsing its output is cheaper than any scheme for predicting it.
 */
async function publishedPort(container: string): Promise<number> {
  const { stdout: mapping } = await run("docker", [
    "port",
    container,
    "5432/tcp",
  ]);
  // Formats seen: "0.0.0.0:49154", "[::]:49154", and both on separate lines.
  const match = /:(\d+)\s*$/m.exec(mapping.trim());
  const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `Could not determine the published port for ${container}. ` +
        `\`docker port\` returned: ${mapping.trim()}`,
    );
  }
  return port;
}

export async function startPostgres(label = "default"): Promise<TestDatabase> {
  const CONTAINER = `acalys-test-postgres-${label}`;
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
    // Docker picks the host port.
    //
    // This used to be derived from the label — `55_400 + charCodeSum % 90` —
    // which is a 90-slot hash over arbitrary strings, so collisions were a
    // matter of when. "hardening" collided with an existing suite and the
    // container failed to start; vitest reported the ten tests inside as
    // *skipped* while the suite itself failed, which is the exact shape of the
    // three vacuous-test bugs this project has already shipped.
    //
    // Deterministic ports existed so a stale container could be found and
    // removed. The container **name** already does that, and it is derived from
    // the label too — so the port was buying nothing and costing a collision
    // class. Letting Docker assign one removes the class rather than making it
    // less likely.
    "0:5432",
    IMAGE,
    // fsync off: this database is discarded, and durability of the *test*
    // database is not what is under test. The transaction semantics that are
    // under test are unaffected.
    "-c",
    "fsync=off",
  ]);

  const PORT = await publishedPort(CONTAINER);
  await waitForReady(CONTAINER, PORT);

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
    "0003_review_stages.sql",
    "0004_publication_ledger.sql",
    "0005_analysis_coverage.sql",
    "0006_verification_attempts.sql",
  ].map((name) =>
    readFileSync(
      fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
      "utf8",
    ),
  );

  const apply = async (): Promise<void> => {
    await pool.query(
      `DROP TABLE IF EXISTS publication_intents, verification_attempts, review_findings, verifications,
         candidate_findings, review_run_transitions, review_runs, review_requests,
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
