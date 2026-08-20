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
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { withStartupSlot } from "./startup-limit.js";

const run = promisify(execFile);

/**
 * Identifies this test RUN — every vitest fork of it, not each process.
 *
 * Read from the environment so that the forks share one value. A per-process
 * id would have each fork believing it owned a different server, which is the
 * nine-container arrangement this checkpoint exists to remove.
 *
 * The fallback matters for a developer running one suite directly: they get a
 * private server rather than joining or reaping someone else's.
 */
const RUN_ID = process.env["ACALYS_TEST_RUN_ID"] ?? randomUUID();

/**
 * One Postgres server for the whole run.
 *
 * ```
 * before                         after
 * suite A → container            ┌──────── one container ────────┐
 * suite B → container            │  db_run_A   db_run_B   db_…   │
 * …          (nine boots)        └───────────────────────────────┘
 * ```
 *
 * The expensive, and destabilising, operation was never the database — it was
 * booting nine container processes and nine Postgres initialisations at once
 * inside Docker Desktop's qemu VM. `CREATE DATABASE` inside an already-running
 * server costs milliseconds.
 *
 * The invariant being preserved is **not** "one suite, one container". It is:
 *
 * > no suite can observe, modify, migrate, drop or corrupt another suite's
 * > state
 *
 * which a database boundary gives, and which the two-suites-one-table-name
 * test proves rather than asserts.
 *
 * What a shared server does NOT isolate — roles, server configuration,
 * shared-state extensions, connection limits, and the Postgres process itself
 * dying — is genuinely shared. A test that needs process-level isolation must
 * ask for its own container; none does today, and nine were not worth paying
 * for one that might.
 */
const SHARED_CONTAINER = `acalys-test-postgres-${RUN_ID.slice(0, 12)}`;

const IMAGE = "postgres:16-alpine";
const PASSWORD = "acalys-test";
/**
 * The database `CREATE DATABASE` is issued from.
 *
 * Deliberately not a suite's database, and never handed to suite code.
 */
const MAINTENANCE_DATABASE = "postgres";

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
    // `docker ps`, not `docker info`.
    //
    // A daemon whose backend VM has died still answers some metadata queries
    // while every real operation fails. That is not hypothetical: a `test:ci`
    // run exited non-zero with no reported test failure, and the captured
    // diagnostics showed `Docker Desktop is unable to start / qemu: process
    // terminated unexpectedly` behind a check that had reported Docker as
    // available.
    //
    // The consequence of the weaker probe is the worst kind: suites start,
    // fail at container creation, and the failure reads as a product bug.
    // Listing containers requires the daemon to actually serve, so this fails
    // where it should — loudly, and with the real reason attached.
    execFileSync("docker", ["ps", "-q"], { stdio: "ignore", timeout: 20_000 });
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
/**
 * How many Postgres containers may be starting anywhere on this machine.
 *
 * Not a timeout, and deliberately so. Two `test:ci` runs terminated non-zero
 * with no reported test failure; the captured diagnostics showed
 * `Docker Desktop is unable to start / qemu: process terminated unexpectedly`,
 * with 45GB of disk and 9GB of memory free. The backend VM was crashing under
 * the burst of nine suites creating containers at once, and rerunning with
 * vitest limited to two forks completed every one of them.
 *
 * The first implementation of this limit was a module-level counter, and it was
 * worthless: vitest gives each test file its own fork, each fork runs one file
 * at a time and calls `startPostgres` once, so the counter could never block.
 * The limit has to be machine-wide or it is decoration — see
 * {@link withStartupSlot}, and the probe that proves it.
 *
 * Nothing is masked. The readiness timeout is untouched, a suite whose
 * container fails still fails, and full test parallelism is unchanged for
 * everything that is not booting a database.
 */
/**
 * How many Postgres SERVERS may be booting at once, machine-wide.
 *
 * One, now that a run needs exactly one. The value used to be two because
 * nine suites each booted their own; with a single shared server the permit
 * exists to make the boot single-flight — eight forks arriving together
 * produce one container rather than eight.
 */
const MAX_CONCURRENT_STARTUPS = 1;

let volumeBaseline: ReadonlySet<string> | undefined;

/** Volumes that existed before this process started creating any. */
async function captureVolumeBaseline(): Promise<void> {
  if (volumeBaseline !== undefined) return;
  const listed = await run("docker", ["volume", "ls", "-q"]).catch(() => ({
    stdout: "",
  }));
  volumeBaseline = new Set(listed.stdout.trim().split("\n").filter(Boolean));
}

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
  // suite by name. Attribution is by TIME instead: anything dangling that did
  // not exist when this process started.
  //
  // Not "everything dangling". A developer's local compose database is dangling
  // whenever its stack is stopped, and failing the suite over it — or worse,
  // pruning it — would make the harness a hazard on the machine it runs on.
  const dangling = await run("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    "dangling=true",
  ]).catch(() => ({ stdout: "" }));
  const orphaned = dangling.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((volume) => volumeBaseline?.has(volume) !== true);

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
        MAINTENANCE_DATABASE,
      ]);

      // And confirm from outside the container, which is where the tests run.
      const probe = new pg.Client({
        host: "127.0.0.1",
        port,
        user: "postgres",
        password: PASSWORD,
        database: MAINTENANCE_DATABASE,
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
/**
 * How long a container from another run must have existed before it counts as
 * abandoned.
 *
 * "A different run id" is not enough on its own, and that cost four suites.
 * The shared-server probe spawns processes with their own run id, so from
 * their perspective the MAIN run's container was another run's — and they
 * deleted it, mid-test, producing `Connection terminated unexpectedly` in
 * four unrelated suites.
 *
 * A concurrent run's container is seconds old. One a crashed run left behind
 * is not. Age plus foreign ownership is the pair; either alone deletes
 * something someone is using.
 */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/**
 * Containers this machine's EARLIER runs abandoned.
 *
 * Foreign run id AND old enough that no live run could own it. Precise
 * ownership rather than "looks temporary", which is the rule the 62GB volume
 * incident paid for and which keeps needing to be relearned somewhere new.
 */
async function abandonedContainers(): Promise<readonly string[]> {
  const listed = await run("docker", [
    "ps",
    "-aq",
    "--filter",
    "label=acalys.test=true",
  ]).catch(() => ({ stdout: "" }));

  const abandoned: string[] = [];
  for (const id of listed.stdout.trim().split("\n").filter(Boolean)) {
    const inspected = await run("docker", [
      "inspect",
      "--format",
      '{{index .Config.Labels "acalys.run"}} {{.Created}}',
      id,
    ]).catch(() => ({ stdout: "" }));

    const [label, created] = inspected.stdout.trim().split(" ");
    if (label === undefined || label === RUN_ID) continue;

    const age = Date.now() - Date.parse(created ?? "");
    if (Number.isFinite(age) && age > ABANDONED_AFTER_MS) abandoned.push(id);
  }
  return abandoned;
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

/**
 * Boots the shared server if nobody has, then hands back a private database.
 *
 * Single-flight: the boot runs under a machine-wide permit of one, so eight
 * forks arriving together produce one container rather than eight. The permit
 * is held across readiness, not just creation — a second fork that saw the
 * container exist but not yet serve would otherwise start its own.
 */
async function ensureSharedServer(): Promise<number> {
  return await withStartupSlot(
    MAX_CONCURRENT_STARTUPS,
    async () => {
      const existing = await run("docker", [
        "ps",
        "-q",
        "--filter",
        `name=^${SHARED_CONTAINER}$`,
      ]).catch(() => ({ stdout: "" }));

      if (existing.stdout.trim() === "") {
        await captureVolumeBaseline();

        // Reaped on first boot, not on every suite: containers an earlier run
        // abandoned, identified by run label. Process handlers cannot cover
        // SIGKILL or a dead daemon, so recovery has to happen on the way in.
        const abandoned = await abandonedContainers();
        if (abandoned.length > 0) {
          await run("docker", ["rm", "-f", "-v", "--", ...abandoned]).catch(
            () => undefined,
          );
        }

        await run("docker", ["rm", "-f", "-v", SHARED_CONTAINER]).catch(
          () => undefined,
        );
        await run("docker", [
          "run",
          "-d",
          "--name",
          SHARED_CONTAINER,
          "--label",
          "acalys.test=true",
          "--label",
          `acalys.run=${RUN_ID}`,
          "-e",
          `POSTGRES_PASSWORD=${PASSWORD}`,
          "-e",
          `POSTGRES_DB=${MAINTENANCE_DATABASE}`,
          "-p",
          "0:5432",
          IMAGE,
        ]);
      }

      const port = await publishedPort(SHARED_CONTAINER);
      await waitForReady(SHARED_CONTAINER, port);
      return port;
    },
    // Overridable so a test that spawns its own harness processes can take a
    // private lock. The shared-server probe needs to boot a server of its own,
    // and against the default root it competed with the real suites for the
    // single permit — starving four of them into failure while booting a
    // second container. A probe must not contend on the resource it measures.
    process.env["ACALYS_STARTUP_LOCK_ROOT"],
  );
}

/**
 * A database of this suite's own, inside the shared server.
 *
 * The name carries the run and the suite, so cleanup can drop **exactly** what
 * this run created. Never `DROP DATABASE LIKE 'acalys_test_%'`: the Docker
 * volume incident already taught that lesson at a cost of 62GB, and the rule
 * transfers unchanged —
 *
 * > never replace precise ownership with "looks temporary"
 */
export async function startPostgres(label = "default"): Promise<TestDatabase> {
  const port = await ensureSharedServer();
  const database = `acalys_test_${RUN_ID.slice(0, 12)}_${label}`.replace(
    /[^a-z0-9_]/gi,
    "_",
  );

  // Connected to the maintenance database only long enough to create the
  // suite's own. Suite code never receives this connection: a handle that can
  // reach every other suite's database is the isolation boundary with a hole
  // in it.
  const admin = new pg.Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: PASSWORD,
    database: MAINTENANCE_DATABASE,
    max: 2,
  });

  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }

  // Removed on abrupt exit too. The container is shared and outlives any one
  // suite, so what a dying process must clean up is its DATABASE — dropping
  // the container here would take the other suites down with it.
  const reap = (): void => {
    try {
      execFileSync(
        "docker",
        [
          "exec",
          SHARED_CONTAINER,
          "psql",
          "-U",
          "postgres",
          "-d",
          MAINTENANCE_DATABASE,
          "-c",
          `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
        ],
        { stdio: "ignore", timeout: 10_000 },
      );
    } catch {
      // Best effort: the process is already on its way out, and the next run
      // reaps the whole container by run label anyway.
    }
  };
  process.once("SIGINT", reap);
  process.once("SIGTERM", reap);
  process.once("exit", reap);

  return await connect(port, database);
}

async function connect(port: number, database: string): Promise<TestDatabase> {
  const pool = new pg.Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: PASSWORD,
    // This suite's database, and only this one.
    database,
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
      // The suite's own database, by exact name. The container is shared and
      // stays: another suite is very likely still using it.
      const admin = new pg.Pool({
        host: "127.0.0.1",
        port,
        user: "postgres",
        password: PASSWORD,
        database: MAINTENANCE_DATABASE,
        max: 1,
      });
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      } catch {
        // A suite that cannot drop its database must not fail the suite that
        // passed; the run-scoped container is removed wholesale afterwards.
      } finally {
        await admin.end();
      }
    },
  };
}
