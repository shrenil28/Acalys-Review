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
 *
 * # Every removal in this file passes `-v`
 *
 * The Postgres image declares its data directory as a VOLUME, so each container
 * creates an anonymous one. `docker rm -f` without `-v` deletes the container
 * and orphans the volume. The container reaping added earlier was half a fix:
 * containers stopped accumulating while volumes kept growing, reached 872 and
 * 62GB, filled the disk, and stopped new containers becoming reachable.
 *
 * Cleanup that depends on a process exiting gracefully cannot be the whole
 * story — SIGKILL, a crashed machine and a dead daemon all skip it — so a
 * dangling-volume sweep runs at startup as well, alongside the container reap.
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
/**
 * What this run created no longer exists.
 *
 * Two generations of the same operational bug landed here: containers leaked,
 * that was fixed, and the anonymous volumes underneath them filled the disk
 * anyway. Both fixes were of the form *we called the cleanup command*, and both
 * were believed until a symptom appeared somewhere else — the second as nine
 * integration suites failing to start.
 *
 * So the invariant is not that cleanup ran. It is that the resources are gone,
 * checked by asking Docker rather than by trusting the call.
 *
 * Scoped to this suite's own label, so a parallel suite's live container is
 * never counted against it — the failure mode that once had one suite killing
 * another's database.
 */
export async function assertResourcesReleased(suite: string): Promise<void> {
  const containers = await run("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=acalys.suite=${suite}`,
  ]).catch(() => ({ stdout: "" }));
  const remaining = containers.stdout.trim().split("\n").filter(Boolean);

  if (remaining.length > 0) {
    throw new Error(
      `Suite ${suite} left ${String(remaining.length)} container(s) behind: ` +
        `${remaining.join(", ")}. Cleanup ran and the resources are still here, ` +
        "which is the distinction this check exists to make.",
    );
  }

  // Anonymous volumes are not labelled, so they cannot be attributed to a
  // suite. Dangling is the closest safe proxy: a volume any container still
  // uses is not dangling, so a parallel suite's data is never implicated.
  const dangling = await run("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    "dangling=true",
  ]).catch(() => ({ stdout: "" }));
  const orphaned = dangling.stdout.trim().split("\n").filter(Boolean);

  if (orphaned.length > 0) {
    throw new Error(
      `${String(orphaned.length)} dangling volume(s) remain after ${suite}. ` +
        "The Postgres image declares its data directory as a VOLUME, so a " +
        "removal without `-v` orphans one per container — which reached 872 " +
        "volumes and 62GB before the disk filled and containers stopped " +
        "becoming reachable.",
    );
  }
}

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
 * Containers this suite left behind on a previous run.
 *
 * Only this suite's, and only ones no longer running: a container that is up
 * belongs to a concurrent run, and removing it would delete a live database
 * out from under another vitest file.
 */
async function staleContainers(label: string): Promise<readonly string[]> {
  try {
    const { stdout } = await run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=acalys.suite=${label}`,
      "--filter",
      "status=exited",
      "--filter",
      "status=created",
      "--filter",
      "status=dead",
    ]);
    return stdout.split("\n").filter((id) => id.trim() !== "");
  } catch {
    return [];
  }
}

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
  // `-v`, on every removal in this file.
  //
  // The Postgres image declares `/var/lib/postgresql/data` as a VOLUME, so each
  // container creates an anonymous volume. `docker rm -f` deletes the container
  // and leaves the volume, and nothing ever refers to it again.
  //
  // The container reaping added earlier was therefore only half a fix: it
  // stopped containers accumulating while every run kept adding ~70MB of
  // orphaned volume. It reached **872 volumes and 62GB**, the disk filled, and
  // Postgres containers stopped becoming reachable — which surfaced as nine
  // integration suites failing to start, not as a disk error.
  //
  // The suites failed rather than skipping, which is the fail-closed rule
  // working. But an infrastructure leak that presents as a product test failure
  // costs an investigation every time, so the leak is closed at the source.
  await run("docker", ["rm", "-f", "-v", CONTAINER]).catch(() => undefined);
  await run("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER,
    // Labels are what make an abandoned container findable later. A name alone
    // only helps if the next run happens to use the same one.
    "--label",
    "acalys.test=true",
    "--label",
    `acalys.suite=${label}`,
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

  // Reap containers abandoned by earlier runs, before starting a new one.
  //
  // Process handlers cannot cover SIGKILL, a machine crash, or the daemon
  // dying, so cleanup must not depend on this process getting a chance to run.
  // Every container is labelled, and each run sweeps the ones a previous run
  // left behind — which is what stops abandoned resources repeatedly inflating
  // Docker's internal high-water mark.
  //
  // Scoped to this suite's label so parallel vitest files cannot destroy each
  // other's databases: the failure that would cause is a suite whose tables
  // vanish mid-run, which reads as a product bug rather than a harness one.
  await run("docker", [
    "rm",
    "-f",
    "-v",
    "--",
    ...(await staleContainers(label)),
  ]).catch(() => undefined);

  // And anonymous volumes no container references any more.
  //
  // Scoped to dangling volumes, which is safe: a volume in use by any container
  // — including another suite's, running right now — is not dangling and is not
  // touched. This is the sweep that recovers from runs killed before the
  // handlers below could fire, which is the case the handlers cannot cover.
  await run("docker", ["volume", "prune", "-f"]).catch(() => undefined);

  // Removed on an abrupt exit too, not only on a clean `stop()`.
  //
  // An interrupted run — Ctrl-C, a crashed worker, a killed CI job — used to
  // leave its container behind. Each one is small, but Docker Desktop's disk
  // image only ever grows to its high-water mark, so the leak is permanent
  // even after the container is gone. Dozens of aborted runs is how a test
  // harness quietly consumes a third of a laptop.
  const reap = (): void => {
    try {
      execFileSync("docker", ["rm", "-f", "-v", CONTAINER], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {
      // Best effort: the process is already on its way out.
    }
  };
  process.once("SIGINT", reap);
  process.once("SIGTERM", reap);
  process.once("exit", reap);

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
    "0007_verification_scheduling.sql",
    "0008_promotion_referent.sql",
  ].map((name) =>
    readFileSync(
      fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
      "utf8",
    ),
  );

  const apply = async (): Promise<void> => {
    await pool.query(
      `DROP TABLE IF EXISTS premerge_check_results, publication_intents,
         publication_decisions, verification_attempts, verification_invocations,
         review_findings, verifications, candidate_findings,
         review_run_transitions, review_runs, review_requests,
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
      await run("docker", ["rm", "-f", "-v", CONTAINER]).catch(() => undefined);
    },
  };
}
