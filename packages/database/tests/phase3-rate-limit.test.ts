import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthStore } from "../src/index.js";
import {
  assertSuiteIsActuallyRunning,
  dockerAvailable,
  startPostgres,
  type TestDatabase,
} from "./postgres.js";

const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER ? describe : describe.skip.bind(describe);
if (!HAS_DOCKER) {
  console.warn("\n  ⚠ Docker unavailable — Phase 3 rate-limit persistence tests SKIPPED.\n");
}

const ORG = "0192f8a1-2000-7000-8000-000000000101";

async function databaseMinute(database: TestDatabase): Promise<Date> {
  const result = await database.pool.query<{ minute: Date }>(
    `SELECT date_trunc('minute', clock_timestamp()) AS minute`,
  );
  const minute = result.rows[0]?.minute;
  if (minute === undefined) throw new Error("Database clock returned no minute");
  return minute;
}

describeWithPostgres("Phase 3 shared API rate limiting", () => {
  let database: TestDatabase;
  let store: AuthStore;

  beforeAll(async () => {
    database = await startPostgres("phase3_rate_limit");
    await assertSuiteIsActuallyRunning(database, ["organizations", "api_rate_windows"]);
    store = new AuthStore(database.pool);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(
      `INSERT INTO organizations(id, slug, name) VALUES ($1, 'rate-org', 'Rate Org')`,
      [ORG],
    );
  });

  it("uses the database clock as the shared fixed-window authority", async () => {
    const before = await databaseMinute(database);
    const result = await store.consumeApiRateLimits({
      organizationId: ORG,
      principalId: "credential-a",
      perPrincipalLimit: 5,
      perOrganizationLimit: 10,
    });
    const after = await databaseMinute(database);

    expect(result.allowed).toBe(true);
    expect([before.toISOString(), after.toISOString()]).toContain(
      result.windowStart.toISOString(),
    );

    const windows = await database.pool.query<{ window_start: Date }>(
      `SELECT DISTINCT window_start FROM api_rate_windows WHERE organization_id = $1`,
      [ORG],
    );
    expect(windows.rows).toHaveLength(1);
    expect(windows.rows[0]?.window_start.toISOString()).toBe(
      result.windowStart.toISOString(),
    );
  });

  it("serializes concurrent replica admissions and saturates the denied principal counter", async () => {
    const replicas = [new AuthStore(database.pool), new AuthStore(database.pool), store];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        replicas[index % replicas.length]!.consumeApiRateLimits({
          organizationId: ORG,
          principalId: "credential-hot",
          perPrincipalLimit: 3,
          perOrganizationLimit: 100,
        }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(
      results.filter((result) => !result.allowed && result.reason === "principal"),
    ).toHaveLength(17);

    const counters = await database.pool.query<{
      principal_id: string;
      request_count: number;
    }>(
      `SELECT principal_id, request_count
         FROM api_rate_windows
        WHERE organization_id = $1
        ORDER BY principal_id`,
      [ORG],
    );
    expect(counters.rows).toEqual([
      { principal_id: "organization", request_count: 3 },
      { principal_id: "principal:credential-hot", request_count: 4 },
    ]);
  });


  it("never lowers an existing counter during a rolling limit change", async () => {
    for (let index = 0; index < 8; index += 1) {
      await expect(
        store.consumeApiRateLimits({
          organizationId: ORG,
          principalId: "credential-rollout",
          perPrincipalLimit: 10,
          perOrganizationLimit: 100,
        }),
      ).resolves.toMatchObject({ allowed: true });
    }

    await expect(
      store.consumeApiRateLimits({
        organizationId: ORG,
        principalId: "credential-rollout",
        perPrincipalLimit: 3,
        perOrganizationLimit: 100,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "principal" });

    const afterDowngrade = await database.pool.query<{ request_count: number }>(
      `SELECT request_count FROM api_rate_windows
        WHERE organization_id = $1 AND principal_id = 'principal:credential-rollout'`,
      [ORG],
    );
    expect(afterDowngrade.rows[0]?.request_count).toBe(8);

    await expect(
      store.consumeApiRateLimits({
        organizationId: ORG,
        principalId: "credential-rollout",
        perPrincipalLimit: 10,
        perOrganizationLimit: 100,
      }),
    ).resolves.toMatchObject({ allowed: true });

    const afterRestore = await database.pool.query<{ request_count: number }>(
      `SELECT request_count FROM api_rate_windows
        WHERE organization_id = $1 AND principal_id = 'principal:credential-rollout'`,
      [ORG],
    );
    expect(afterRestore.rows[0]?.request_count).toBe(9);
  });

  it("does not burn principal quota when the organization bucket is already exhausted", async () => {
    const first = await store.consumeApiRateLimits({
      organizationId: ORG,
      principalId: "credential-a",
      perPrincipalLimit: 10,
      perOrganizationLimit: 2,
    });
    const second = await store.consumeApiRateLimits({
      organizationId: ORG,
      principalId: "credential-b",
      perPrincipalLimit: 10,
      perOrganizationLimit: 2,
    });
    const denied = await store.consumeApiRateLimits({
      organizationId: ORG,
      principalId: "credential-c",
      perPrincipalLimit: 10,
      perOrganizationLimit: 2,
    });
    const deniedAgain = await store.consumeApiRateLimits({
      organizationId: ORG,
      principalId: "credential-d",
      perPrincipalLimit: 10,
      perOrganizationLimit: 2,
    });

    expect([first.allowed, second.allowed, denied.allowed, deniedAgain.allowed]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(denied.reason).toBe("organization");
    expect(deniedAgain.reason).toBe("organization");

    const counters = await database.pool.query<{
      principal_id: string;
      request_count: number;
    }>(
      `SELECT principal_id, request_count
         FROM api_rate_windows
        WHERE organization_id = $1
        ORDER BY principal_id`,
      [ORG],
    );
    expect(counters.rows).toEqual([
      { principal_id: "organization", request_count: 3 },
      { principal_id: "principal:credential-a", request_count: 1 },
      { principal_id: "principal:credential-b", request_count: 1 },
    ]);
  });
});
