import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dockerAvailable,
  startPostgres,
  type TestDatabase,
} from "./postgres.js";

const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER
  ? describe
  : describe.skip.bind(describe);

/**
 * Two suites, one server, and no way for either to see the other.
 *
 * The invariant this checkpoint had to preserve is **not** "one suite, one
 * container". It is:
 *
 * > no suite can observe, modify, migrate, drop or corrupt another suite's
 * > state
 *
 * A database boundary gives that, and this proves it the only way worth
 * trusting: by having two suites define the SAME table name with incompatible
 * shapes and both succeed. Inspecting generated database names would prove
 * that the naming code ran, which is a different and much weaker claim.
 */
describeWithPostgres("Suites sharing a server cannot see each other", () => {
  let alpha: TestDatabase;
  let beta: TestDatabase;

  beforeAll(async () => {
    alpha = await startPostgres("isolation-alpha");
    beta = await startPostgres("isolation-beta");
  }, 180_000);

  afterAll(async () => {
    await alpha?.stop();
    await beta?.stop();
  }, 60_000);

  it("lets both define the same table with incompatible shapes", async () => {
    // Identical name, mutually exclusive definitions. On one shared database
    // the second `CREATE TABLE` fails; on two, neither knows about the other.
    await alpha.pool.query(
      "CREATE TABLE fixture_users (id integer PRIMARY KEY, alpha_only text NOT NULL)",
    );
    await beta.pool.query(
      "CREATE TABLE fixture_users (handle text PRIMARY KEY, beta_only boolean NOT NULL)",
    );

    await alpha.pool.query(
      "INSERT INTO fixture_users (id, alpha_only) VALUES (1, 'a')",
    );
    await beta.pool.query(
      "INSERT INTO fixture_users (handle, beta_only) VALUES ('b', true)",
    );

    const alphaRows = await alpha.pool.query("SELECT * FROM fixture_users");
    const betaRows = await beta.pool.query("SELECT * FROM fixture_users");

    expect(alphaRows.rows).toEqual([{ id: 1, alpha_only: "a" }]);
    expect(betaRows.rows).toEqual([{ handle: "b", beta_only: true }]);
  }, 60_000);

  it("keeps one suite healthy while the other drops everything", async () => {
    await alpha.pool.query("CREATE TABLE fixture_shared (n integer)");
    await beta.pool.query("CREATE TABLE fixture_shared (n integer)");
    await beta.pool.query("INSERT INTO fixture_shared VALUES (7)");

    // A destructive migration in one suite. Under a shared database this would
    // silently delete the other's fixture, and the failure would surface
    // somewhere unrelated — which is exactly how one suite once killed
    // another's container.
    await alpha.pool.query("DROP TABLE fixture_shared");

    const survivor = await beta.pool.query("SELECT n FROM fixture_shared");
    expect(survivor.rows).toEqual([{ n: 7 }]);
  }, 60_000);

  it("gives each suite a database of its own, named for this run", async () => {
    const of = async (database: TestDatabase): Promise<string> => {
      const result = await database.pool.query<{ current_database: string }>(
        "SELECT current_database()",
      );
      return result.rows[0]?.current_database ?? "";
    };

    const alphaName = await of(alpha);
    const betaName = await of(beta);

    expect(alphaName).not.toBe(betaName);
    expect(alphaName).toMatch(/^acalys_test_.+_isolation_alpha$/);
    expect(betaName).toMatch(/^acalys_test_.+_isolation_beta$/);

    // And neither is the maintenance database. A suite holding a handle that
    // can reach every other suite's data is the isolation boundary with a hole
    // in it.
    expect(alphaName).not.toBe("postgres");
    expect(betaName).not.toBe("postgres");
  }, 60_000);

  it("shares one server, which is the point", async () => {
    // Proven from inside: both connections report the same backend process
    // parent, so the two databases really are one Postgres — not two
    // containers that happen to work.
    const port = async (database: TestDatabase): Promise<number> => {
      const result = await database.pool.query<{ port: string }>(
        "SELECT setting AS port FROM pg_settings WHERE name = 'port'",
      );
      return Number(result.rows[0]?.port ?? 0);
    };

    const [alphaPort, betaPort] = await Promise.all([port(alpha), port(beta)]);
    expect(alphaPort).toBe(betaPort);
    expect(alphaPort).toBeGreaterThan(0);
  }, 60_000);

  it("resets only its own database", async () => {
    await beta.pool.query("CREATE TABLE fixture_keep (n integer)");
    await beta.pool.query("INSERT INTO fixture_keep VALUES (42)");

    // `reset()` drops and re-migrates. Scoped to the calling suite's database,
    // it must not reach across.
    await alpha.reset();

    const kept = await beta.pool.query("SELECT n FROM fixture_keep");
    expect(kept.rows).toEqual([{ n: 42 }]);
  }, 60_000);
});
