import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DashboardAdminStore } from "../src/index.js";
import { assertSuiteIsActuallyRunning, dockerAvailable, startPostgres, type TestDatabase } from "./postgres.js";

const describeWithPostgres = dockerAvailable() ? describe : describe.skip.bind(describe);
const ORG = "0192f8a1-4000-7000-8000-000000000101";
const USER = "0192f8a1-4000-7000-8000-000000000201";
const USER2 = "0192f8a1-4000-7000-8000-000000000202";
const MEMBER = "0192f8a1-4000-7000-8000-000000000301";
const MEMBER2 = "0192f8a1-4000-7000-8000-000000000302";
const EXCHANGE = "0192f8a1-4000-7000-8000-000000000501";
const KEY = "0192f8a1-4000-7000-8000-000000000601";
const INVITE = "0192f8a1-4000-7000-8000-000000000701";
const INVITED_USER = "0192f8a1-4000-7000-8000-000000000702";
const INVITED_MEMBER = "0192f8a1-4000-7000-8000-000000000703";
const INVITE_EXCHANGE = "0192f8a1-4000-7000-8000-000000000704";
const SESSION = "0192f8a1-4000-7000-8000-000000000801";
const NOW = new Date("2026-09-09T10:00:00.000Z");

function hash(marker: string) { return marker.padEnd(64, marker[0] ?? "a").slice(0, 64); }

describeWithPostgres("Phase 4 dashboard administration persistence", () => {
  let database: TestDatabase;
  let store: DashboardAdminStore;
  beforeAll(async () => {
    database = await startPostgres("phase4_dashboard_admin");
    await assertSuiteIsActuallyRunning(database, ["dashboard_login_exchanges", "dashboard_membership_invitations", "memberships", "api_keys"]);
    store = new DashboardAdminStore(database.pool);
  }, 180_000);
  afterAll(async () => { await database?.stop(); }, 60_000);
  beforeEach(async () => {
    await database.reset();
    await database.pool.query(`INSERT INTO organizations(id,slug,name) VALUES ($1,'dashboard-org','Dashboard Org')`, [ORG]);
    await database.pool.query(
      `INSERT INTO users(id,provider,provider_user_id,primary_email,display_name,created_at,updated_at)
       VALUES ($1,'github','41','owner@example.test','Owner',$3,$3),($2,'github','42','member@example.test','Member',$3,$3)`,
      [USER, USER2, NOW],
    );
    await database.pool.query(
      `INSERT INTO memberships(id,organization_id,user_id,role,created_at,updated_at)
       VALUES ($1,$3,$4,'owner',$5,$5),($2,$3,$6,'member',$5,$5)`,
      [MEMBER, MEMBER2, ORG, USER, NOW, USER2],
    );
  });

  it("redeems a membership-bound hashed login exchange exactly once even when two browser retries race", async () => {
    await expect(store.createLoginExchangeForProvisionedIdentity({
      id: EXCHANGE, organizationId: ORG, provider: "github", providerUserId: "41",
      exchangeHash: hash("x"), ttlMillis: 60_000,
    })).resolves.toBe(true);
    const [left, right] = await Promise.all([store.redeemLoginExchange(hash("x")), store.redeemLoginExchange(hash("x"))]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    expect(left ?? right).toEqual({ organizationId: ORG, userId: USER, membershipId: MEMBER });

    const columns = await database.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'dashboard_login_exchanges'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain("session_ciphertext");
    expect(names).not.toContain("session_id");
  });

  it("does not redeem an exchange after the exact membership that authorized it is removed", async () => {
    await expect(store.createLoginExchangeForProvisionedIdentity({
      id: EXCHANGE, organizationId: ORG, provider: "github", providerUserId: "41",
      exchangeHash: hash("x"), ttlMillis: 60_000,
    })).resolves.toBe(true);
    await database.pool.query(`DELETE FROM memberships WHERE id = $1`, [MEMBER]);
    await expect(store.redeemLoginExchange(hash("x"))).resolves.toBeUndefined();
  });

  it("serializes role changes and refuses to demote the final owner", async () => {
    await expect(store.updateMemberRole({ organizationId: ORG, actorUserId: USER, memberId: MEMBER, role: "admin" })).resolves.toEqual({ kind: "last_owner" });
    await expect(store.updateMemberRole({ organizationId: ORG, actorUserId: USER2, memberId: MEMBER, role: "member" })).resolves.toEqual({ kind: "forbidden" });
    await expect(store.updateMemberRole({ organizationId: ORG, actorUserId: USER, memberId: MEMBER2, role: "admin" })).resolves.toMatchObject({ kind: "updated", member: { role: "admin" } });
  });

  it("authorizes API-key creation and revocation from the live membership inside the write transaction", async () => {
    await expect(store.createApiKeyAuthorized({ id: KEY, organizationId: ORG, actorUserId: USER2, ownerKind: "organization", prefix: "prefix", hash: hash("k"), name: "org key", role: "read_only", scopes: ["repositories:read"] })).resolves.toBe("forbidden");
    await expect(store.updateMemberRole({ organizationId: ORG, actorUserId: USER, memberId: MEMBER2, role: "admin" })).resolves.toMatchObject({ kind: "updated", member: { role: "admin" } });
    await expect(store.createApiKeyAuthorized({ id: KEY, organizationId: ORG, actorUserId: USER2, ownerKind: "organization", prefix: "prefix", hash: hash("k"), name: "org key", role: "owner", scopes: ["repositories:read"] })).resolves.toBe("forbidden");
    await expect(store.createApiKeyAuthorized({ id: KEY, organizationId: ORG, actorUserId: USER2, ownerKind: "organization", prefix: "prefix", hash: hash("k"), name: "org key", role: "admin", scopes: ["repositories:read"] })).resolves.toBe("created");
    await expect(store.revokeApiKeyAuthorized({ organizationId: ORG, actorUserId: USER2, apiKeyId: KEY })).resolves.toBe(true);
  });


  it("stores only an invitation digest and redeems the capability once for the exact verified email", async () => {
    const inviteHash = hash("i");
    const created = await store.createInvitationAuthorized({
      id: INVITE, organizationId: ORG, actorUserId: USER, email: "  NEW@Example.Test ", role: "member",
      inviteHash, ttlMillis: 7 * 24 * 60 * 60_000,
    });
    expect(created).toMatchObject({ kind: "created", invitation: { email: "new@example.test", role: "member" } });
    const stored = await database.pool.query<{ invite_hash: string }>(
      `SELECT invite_hash FROM dashboard_membership_invitations WHERE id = $1`, [INVITE],
    );
    expect(stored.rows[0]?.invite_hash).toBe(inviteHash);
    const columns = await database.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'dashboard_membership_invitations'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("invite_token");

    const first = await store.redeemInvitationForVerifiedIdentity({
      inviteHash, provider: "github", providerUserId: "9001", displayName: "Invited",
      verifiedEmails: ["other@example.test", "NEW@example.test"], proposedUserId: INVITED_USER,
      proposedMembershipId: INVITED_MEMBER, exchangeId: INVITE_EXCHANGE,
      exchangeHash: hash("e"), exchangeTtlMillis: 60_000,
    });
    expect(first).toEqual({ kind: "redeemed", identity: { organizationId: ORG, userId: INVITED_USER, membershipId: INVITED_MEMBER } });
    await expect(store.redeemInvitationForVerifiedIdentity({
      inviteHash, provider: "github", providerUserId: "9001", verifiedEmails: ["new@example.test"],
      proposedUserId: "0192f8a1-4000-7000-8000-000000000705", proposedMembershipId: "0192f8a1-4000-7000-8000-000000000706",
      exchangeId: "0192f8a1-4000-7000-8000-000000000707", exchangeHash: hash("r"), exchangeTtlMillis: 60_000,
    })).resolves.toEqual({ kind: "invalid" });
  });

  it("fails invitation redemption closed on unverified email and pre-existing email identity collisions", async () => {
    const inviteHash = hash("j");
    await store.createInvitationAuthorized({ id: INVITE, organizationId: ORG, actorUserId: USER, email: "target@example.test", role: "member", inviteHash, ttlMillis: 60_000 });
    await expect(store.redeemInvitationForVerifiedIdentity({
      inviteHash, provider: "github", providerUserId: "9010", verifiedEmails: ["different@example.test"], proposedUserId: INVITED_USER,
      proposedMembershipId: INVITED_MEMBER, exchangeId: INVITE_EXCHANGE, exchangeHash: hash("q"), exchangeTtlMillis: 60_000,
    })).resolves.toEqual({ kind: "email_mismatch" });
    await database.pool.query(
      `INSERT INTO users(id,provider,provider_user_id,primary_email,display_name,created_at,updated_at)
       VALUES ($1,'gitlab','gl-existing','target@example.test','Existing',$2,$2)`,
      [INVITED_USER, NOW],
    );
    await expect(store.redeemInvitationForVerifiedIdentity({
      inviteHash, provider: "github", providerUserId: "9010", verifiedEmails: ["target@example.test"],
      proposedUserId: "0192f8a1-4000-7000-8000-000000000705", proposedMembershipId: INVITED_MEMBER,
      exchangeId: INVITE_EXCHANGE, exchangeHash: hash("q"), exchangeTtlMillis: 60_000,
    })).resolves.toEqual({ kind: "identity_conflict" });
  });

  it("revokes membership-bound sessions and user keys before removing the membership", async () => {
    await database.pool.query(
      `INSERT INTO auth_sessions(id,user_id,organization_id,membership_id,token_hash,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp() + interval '1 hour')`,
      [SESSION, USER2, ORG, MEMBER2, hash("s")],
    );
    await database.pool.query(
      `INSERT INTO api_keys(id,organization_id,user_id,owner_kind,membership_id,key_prefix,key_hash,name,role,scopes,created_at)
       VALUES ($1,$2,$3,'user',$4,'member',$5,'member key','member','["repositories:read"]'::jsonb,clock_timestamp())`,
      [KEY, ORG, USER2, MEMBER2, hash("a")],
    );
    await expect(store.removeMemberAuthorized({ organizationId: ORG, actorUserId: USER, memberId: MEMBER2 }))
      .resolves.toEqual({ kind: "removed", revokedSessions: 1, revokedApiKeys: 1 });
    const session = await database.pool.query<{ revoked_at: Date | null; membership_id: string | null }>(`SELECT revoked_at,membership_id FROM auth_sessions WHERE id=$1`, [SESSION]);
    const key = await database.pool.query<{ revoked_at: Date | null; membership_id: string | null }>(`SELECT revoked_at,membership_id FROM api_keys WHERE id=$1`, [KEY]);
    expect(session.rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect(session.rows[0]?.membership_id).toBeNull();
    expect(key.rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect(key.rows[0]?.membership_id).toBeNull();
    await expect(store.removeMemberAuthorized({ organizationId: ORG, actorUserId: USER, memberId: MEMBER }))
      .resolves.toEqual({ kind: "last_owner" });
  });
});
