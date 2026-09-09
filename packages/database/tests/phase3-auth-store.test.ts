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
  console.warn("\n  ⚠ Docker unavailable — Phase 3 auth persistence tests SKIPPED.\n");
}

const ORG = "0192f8a1-1000-7000-8000-000000000101";
const USER = "0192f8a1-1000-7000-8000-000000000201";
const OTHER_USER = "0192f8a1-1000-7000-8000-000000000202";
const MEMBERSHIP = "0192f8a1-1000-7000-8000-000000000301";
const REJOINED_MEMBERSHIP = "0192f8a1-1000-7000-8000-000000000302";
const SESSION = "0192f8a1-1000-7000-8000-000000000401";
const REPLACEMENT = "0192f8a1-1000-7000-8000-000000000402";
const KEY = "0192f8a1-1000-7000-8000-000000000501";
const ORG_KEY = "0192f8a1-1000-7000-8000-000000000502";
const LEGACY_KEY = "0192f8a1-1000-7000-8000-000000000503";
const NOW = new Date("2026-09-09T00:00:00.000Z");

function hash(marker: string): string {
  return marker.padEnd(64, marker[0] ?? "a").slice(0, 64);
}

describeWithPostgres("Phase 3 auth persistence boundaries", () => {
  let database: TestDatabase;
  let store: AuthStore;

  const dbNow = async (): Promise<Date> => {
    const result = await database.pool.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
    const value = result.rows[0]?.now;
    if (value === undefined) throw new Error("database clock returned no row");
    return value;
  };

  beforeAll(async () => {
    database = await startPostgres("phase3_auth");
    await assertSuiteIsActuallyRunning(database, ["users", "memberships", "auth_sessions", "api_keys"]);
    store = new AuthStore(database.pool);
  }, 180_000);

  afterAll(async () => {
    await database?.stop();
  }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(
      `INSERT INTO organizations(id, slug, name) VALUES ($1, 'auth-org', 'Auth Org')`,
      [ORG],
    );
    await database.pool.query(
      `INSERT INTO users(id, provider, provider_user_id, created_at, updated_at)
       VALUES ($1, 'github', '42', $3, $3), ($2, 'github', '84', $3, $3)`,
      [USER, OTHER_USER, NOW],
    );
    await database.pool.query(
      `INSERT INTO memberships(id, organization_id, user_id, role, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', $4, $4)`,
      [MEMBERSHIP, ORG, USER, NOW],
    );
  });

  it("returns the canonical existing user id when the same OAuth identity is upserted again", async () => {
    const returned = await store.upsertOAuthIdentity({
      userId: OTHER_USER,
      provider: "github",
      providerUserId: "42",
      displayName: "Updated Name",
      now: new Date(NOW.getTime() + 1_000),
    });

    expect(returned).toBe(USER);
    const rows = await database.pool.query<{ id: string; display_name: string | null }>(
      `SELECT id, display_name FROM users WHERE provider = 'github' AND provider_user_id = '42'`,
    );
    expect(rows.rows).toEqual([{ id: USER, display_name: "Updated Name" }]);
  });

  it("uses database time for session issuance/authentication and atomically rotates live membership-bound sessions", async () => {
    const sessionHash = hash("a");
    const replacementHash = hash("b");
    const created = await store.createSession({
      id: SESSION,
      userId: USER,
      organizationId: ORG,
      tokenHash: sessionHash,
      ttlMillis: 60_000,
    });
    expect(created).toBeDefined();
    expect((created?.expiresAt.getTime() ?? 0) - (created?.createdAt.getTime() ?? 0)).toBe(60_000);

    const beforeAuth = await dbNow();
    const authenticated = await store.authenticateSessionByHash(sessionHash);
    const afterAuth = await dbNow();
    expect(authenticated).toMatchObject({ sessionId: SESSION, organizationId: ORG, role: "member" });
    const touched = await database.pool.query<{ last_used_at: Date | null; membership_id: string | null }>(
      `SELECT last_used_at, membership_id FROM auth_sessions WHERE id = $1`,
      [SESSION],
    );
    const lastUsed = touched.rows[0]?.last_used_at;
    expect(lastUsed).not.toBeNull();
    expect(lastUsed?.getTime()).toBeGreaterThanOrEqual(beforeAuth.getTime());
    expect(lastUsed?.getTime()).toBeLessThanOrEqual(afterAuth.getTime());
    expect(touched.rows[0]?.membership_id).toBe(MEMBERSHIP);

    const rotated = await store.rotateSessionByHash({
      currentHash: sessionHash,
      replacementId: REPLACEMENT,
      replacementHash,
      ttlMillis: 60_000,
    });
    expect(rotated).toBeDefined();
    await expect(store.authenticateSessionByHash(sessionHash)).resolves.toBeUndefined();
    await expect(store.authenticateSessionByHash(replacementHash)).resolves.toMatchObject({ sessionId: REPLACEMENT });

    await expect(store.revokeSession(REPLACEMENT, "0192f8a1-1000-7000-8000-000000000999")).resolves.toBe(false);
    await expect(store.revokeSession(REPLACEMENT, ORG)).resolves.toBe(true);
    await expect(store.authenticateSessionByHash(replacementHash)).resolves.toBeUndefined();
  });

  it("invalidates user-bound API keys when membership disappears and does not advance last-used on failure", async () => {
    const keyHash = hash("c");
    await expect(
      store.createApiKey({
        id: KEY,
        organizationId: ORG,
        userId: USER,
        prefix: "prefix",
        hash: keyHash,
        name: "user key",
        role: "owner",
        scopes: ["repositories:read", "reviews:write"],
      }),
    ).resolves.toBe("created");

    const beforeRemoval = await store.authenticateApiKeyByHash(keyHash);
    expect(beforeRemoval).toMatchObject({ apiKeyId: KEY, role: "member" });
    const firstUse = await database.pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_keys WHERE id = $1`,
      [KEY],
    );

    await database.pool.query(`DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2`, [ORG, USER]);
    await expect(store.authenticateApiKeyByHash(keyHash)).resolves.toBeUndefined();

    const afterFailure = await database.pool.query<{ last_used_at: Date | null; membership_id: string | null }>(
      `SELECT last_used_at, membership_id FROM api_keys WHERE id = $1`,
      [KEY],
    );
    expect(afterFailure.rows[0]?.last_used_at?.toISOString()).toBe(firstUse.rows[0]?.last_used_at?.toISOString());
    expect(afterFailure.rows[0]?.membership_id).toBeNull();
  });

  it("never resurrects sessions or user API keys when membership is removed and later recreated", async () => {
    const sessionHash = hash("f");
    const keyHash = hash("g");
    await store.createSession({
      id: SESSION,
      userId: USER,
      organizationId: ORG,
      tokenHash: sessionHash,
      ttlMillis: 600_000,
    });
    await store.createApiKey({
      id: KEY,
      organizationId: ORG,
      userId: USER,
      prefix: "user",
      hash: keyHash,
      name: "user key",
      role: "member",
      scopes: ["repositories:read"],
    });

    await database.pool.query(`DELETE FROM memberships WHERE id = $1`, [MEMBERSHIP]);
    await expect(store.authenticateSessionByHash(sessionHash)).resolves.toBeUndefined();
    await expect(store.authenticateApiKeyByHash(keyHash)).resolves.toBeUndefined();
    await expect(
      store.rotateSessionByHash({
        currentHash: sessionHash,
        replacementId: REPLACEMENT,
        replacementHash: hash("h"),
        ttlMillis: 600_000,
      }),
    ).resolves.toBeUndefined();

    await database.pool.query(
      `INSERT INTO memberships(id, organization_id, user_id, role, created_at, updated_at)
       VALUES ($1,$2,$3,'member',clock_timestamp(),clock_timestamp())`,
      [REJOINED_MEMBERSHIP, ORG, USER],
    );
    await expect(store.authenticateSessionByHash(sessionHash)).resolves.toBeUndefined();
    await expect(store.authenticateApiKeyByHash(keyHash)).resolves.toBeUndefined();
    const replacement = await database.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM auth_sessions WHERE id = $1`,
      [REPLACEMENT],
    );
    expect(replacement.rows[0]?.count).toBe(0);
  });

  it("does not convert a deleted user's API key into an organization-owned credential", async () => {
    const keyHash = hash("i");
    await store.createApiKey({
      id: KEY,
      organizationId: ORG,
      userId: USER,
      prefix: "user",
      hash: keyHash,
      name: "user key",
      role: "owner",
      scopes: ["reviews:write"],
    });

    await database.pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
    const tombstone = await database.pool.query<{
      user_id: string | null;
      owner_kind: string;
      membership_id: string | null;
    }>(`SELECT user_id, owner_kind, membership_id FROM api_keys WHERE id = $1`, [KEY]);
    expect(tombstone.rows[0]).toEqual({ user_id: null, owner_kind: "user", membership_id: null });
    await expect(store.authenticateApiKeyByHash(keyHash)).resolves.toBeUndefined();
  });

  it("refuses to pre-provision user credentials without a live membership and uses database time for API-key expiry", async () => {
    await database.pool.query(`DELETE FROM memberships WHERE id = $1`, [MEMBERSHIP]);
    await expect(
      store.createSession({
        id: SESSION,
        userId: USER,
        organizationId: ORG,
        tokenHash: hash("j"),
        ttlMillis: 60_000,
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.createApiKey({
        id: KEY,
        organizationId: ORG,
        userId: USER,
        prefix: "user",
        hash: hash("k"),
        name: "user key",
        role: "member",
        scopes: ["repositories:read"],
      }),
    ).resolves.toBe("membership_missing");

    const alreadyExpired = new Date((await dbNow()).getTime() - 1_000);
    await expect(
      store.createApiKey({
        id: ORG_KEY,
        organizationId: ORG,
        prefix: "ci",
        hash: hash("l"),
        name: "CI",
        role: "member",
        scopes: ["reviews:write"],
        expiresAt: alreadyExpired,
      }),
    ).resolves.toBe("invalid_expiry");
  });

  it("fails closed for ambiguous legacy API-key ownership even if an unrevoked row is injected", async () => {
    const keyHash = hash("m");
    await database.pool.query(
      `INSERT INTO api_keys
         (id, organization_id, user_id, owner_kind, membership_id, key_prefix, key_hash,
          name, role, scopes, created_at, expires_at, revoked_at)
       VALUES ($1,$2,NULL,'legacy_unbound',NULL,'legacy',$3,'legacy ambiguous','owner','["reviews:write"]'::jsonb,
               clock_timestamp(),NULL,NULL)`,
      [LEGACY_KEY, ORG, keyHash],
    );

    await expect(store.authenticateApiKeyByHash(keyHash)).resolves.toBeUndefined();
    const stored = await database.pool.query<{ last_used_at: Date | null; revoked_at: Date | null }>(
      `SELECT last_used_at, revoked_at FROM api_keys WHERE id = $1`,
      [LEGACY_KEY],
    );
    expect(stored.rows[0]).toEqual({ last_used_at: null, revoked_at: null });
  });

  it("uses the lower of the API-key issuance role and the current membership role", async () => {
    const keyHash = hash("d");
    await store.createApiKey({
      id: KEY,
      organizationId: ORG,
      userId: USER,
      prefix: "prefix",
      hash: keyHash,
      name: "bounded key",
      role: "admin",
      scopes: ["repositories:read", "reviews:write"],
    });

    await expect(store.authenticateApiKeyByHash(keyHash)).resolves.toMatchObject({ role: "member" });
    await database.pool.query(
      `UPDATE memberships SET role = 'read_only', updated_at = clock_timestamp()
        WHERE organization_id = $1 AND user_id = $2`,
      [ORG, USER],
    );
    await expect(store.authenticateApiKeyByHash(keyHash)).resolves.toMatchObject({ role: "read_only" });
  });

  it("supports organization-owned CI keys with explicit provenance and tenant-scoped revocation", async () => {
    const keyHash = hash("e");
    await expect(
      store.createApiKey({
        id: ORG_KEY,
        organizationId: ORG,
        prefix: "ci",
        hash: keyHash,
        name: "CI",
        role: "member",
        scopes: ["reviews:write"],
      }),
    ).resolves.toBe("created");

    await expect(store.authenticateApiKeyByHash(keyHash)).resolves.toMatchObject({
      apiKeyId: ORG_KEY,
      userId: null,
      role: "member",
    });
    const ownership = await database.pool.query<{ owner_kind: string; membership_id: string | null }>(
      `SELECT owner_kind, membership_id FROM api_keys WHERE id = $1`,
      [ORG_KEY],
    );
    expect(ownership.rows[0]).toEqual({ owner_kind: "organization", membership_id: null });
    await expect(store.revokeApiKey(ORG_KEY, "0192f8a1-1000-7000-8000-000000000999")).resolves.toBe(false);
    await expect(store.revokeApiKey(ORG_KEY, ORG)).resolves.toBe(true);
    await expect(store.authenticateApiKeyByHash(keyHash)).resolves.toBeUndefined();
  });
});
