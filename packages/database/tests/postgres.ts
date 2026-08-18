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
const CONTAINER = "acalys-test-postgres";
const PASSWORD = "acalys-test";
const DATABASE = "acalys_test";
const PORT = 55432;

export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(deadlineMillis = 60_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await run("docker", [
        "exec",
        CONTAINER,
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

export async function startPostgres(): Promise<TestDatabase> {
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

  await waitForReady();

  const pool = new pg.Pool({
    host: "127.0.0.1",
    port: PORT,
    user: "postgres",
    password: PASSWORD,
    database: DATABASE,
    max: 20,
  });

  const migration = readFileSync(
    fileURLToPath(
      new URL("../migrations/0001_webhook_inbox.sql", import.meta.url),
    ),
    "utf8",
  );

  const apply = async (): Promise<void> => {
    await pool.query("DROP TABLE IF EXISTS webhook_jobs, webhook_deliveries");
    await pool.query(migration);
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
