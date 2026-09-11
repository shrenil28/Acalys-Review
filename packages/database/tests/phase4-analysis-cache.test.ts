import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ReviewAnalysisCacheStore } from "../src/index.js";
import { assertSuiteIsActuallyRunning, dockerAvailable, startPostgres, type TestDatabase } from "./postgres.js";

const describeWithPostgres = dockerAvailable() ? describe : describe.skip.bind(describe);
const ORG = "0192f8a1-4000-7000-8000-000000000101";
const OWNER = "0192f8a1-4000-7000-8000-000000000201";
const MEMBER = "0192f8a1-4000-7000-8000-000000000202";
const OWNER_MEMBERSHIP = "0192f8a1-4000-7000-8000-000000000301";
const MEMBER_MEMBERSHIP = "0192f8a1-4000-7000-8000-000000000302";
const REPO = "0192f8a1-4000-7000-8000-000000000401";
const FINGERPRINT = "a".repeat(64);

const payload = { findings: [], suppressions: [], degradations: [] } as const;

describeWithPostgres("Phase 4 durable review-analysis cache", () => {
  let database: TestDatabase;
  let store: ReviewAnalysisCacheStore;

  beforeAll(async () => {
    database = await startPostgres("phase4_analysis_cache");
    await assertSuiteIsActuallyRunning(database, ["review_analysis_cache_entries", "memberships", "repositories"]);
    store = new ReviewAnalysisCacheStore(database.pool);
  }, 180_000);
  afterAll(async () => { await database?.stop(); }, 60_000);

  beforeEach(async () => {
    await database.reset();
    await database.pool.query(`INSERT INTO organizations(id,slug,name) VALUES ($1,'cache-org','Cache Org')`, [ORG]);
    await database.pool.query(
      `INSERT INTO users(id,provider,provider_user_id,display_name,created_at,updated_at)
       VALUES ($1,'github','owner','Owner',clock_timestamp(),clock_timestamp()),
              ($2,'github','member','Member',clock_timestamp(),clock_timestamp())`,
      [OWNER, MEMBER],
    );
    await database.pool.query(
      `INSERT INTO memberships(id,organization_id,user_id,role,created_at,updated_at)
       VALUES ($1,$3,$4,'owner',clock_timestamp(),clock_timestamp()),
              ($2,$3,$5,'member',clock_timestamp(),clock_timestamp())`,
      [OWNER_MEMBERSHIP, MEMBER_MEMBERSHIP, ORG, OWNER, MEMBER],
    );
    await database.pool.query(
      `INSERT INTO repositories(id,organization_id,provider,provider_external_id,owner,name,default_branch,visibility)
       VALUES ($1,$2,'github','cache-repository','acalys','cache-repo','main','private')`,
      [REPO, ORG],
    );
  });

  it("persists successful analysis payloads with a database-clock seven-day ready window", async () => {
    await store.persist({ organizationId: ORG, repositoryId: REPO, entries: [{ fingerprint: FINGERPRINT, payload }] });
    const ready = await store.loadReady({ organizationId: ORG, repositoryId: REPO });
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ organizationId: ORG, repositoryId: REPO, fingerprint: FINGERPRINT, payload });
    expect(ready[0]!.expiresAt.getTime()).toBeGreaterThan(ready[0]!.createdAt.getTime());
    expect(ready[0]!.payloadBytes).toBeGreaterThan(0);
  });

  it("rejects oversized payloads before persistence", async () => {
    const oversized = { findings: [], suppressions: [], degradations: [{ clusterId: "c", reason: "x".repeat(1_048_577) }] };
    await expect(store.persist({ organizationId: ORG, repositoryId: REPO, entries: [{ fingerprint: FINGERPRINT, payload: oversized }] }))
      .rejects.toThrow("payload exceeds the per-entry size limit");
    await expect(store.loadReady({ organizationId: ORG, repositoryId: REPO })).resolves.toEqual([]);
  });

  it("rejects duplicate fingerprints in one write batch", async () => {
    await expect(store.persist({ organizationId: ORG, repositoryId: REPO, entries: [
      { fingerprint: FINGERPRINT, payload },
      { fingerprint: FINGERPRINT, payload },
    ] })).rejects.toThrow("duplicate fingerprints");
  });

  it("physically deletes selected cache rows only for a live owner/admin membership", async () => {
    await store.persist({ organizationId: ORG, repositoryId: REPO, entries: [{ fingerprint: FINGERPRINT, payload }] });
    const [entry] = await store.listMetadata(ORG);
    expect(entry).toBeDefined();
    await expect(store.deleteAuthorized({ organizationId: ORG, actorUserId: MEMBER, ids: [entry!.id] }))
      .resolves.toEqual({ kind: "forbidden" });
    await expect(store.loadReady({ organizationId: ORG, repositoryId: REPO })).resolves.toHaveLength(1);
    await expect(store.deleteAuthorized({ organizationId: ORG, actorUserId: OWNER, ids: [entry!.id] }))
      .resolves.toEqual({ kind: "deleted", count: 1 });
    await expect(store.loadReady({ organizationId: ORG, repositoryId: REPO })).resolves.toEqual([]);
  });

  it("does not expose expired rows as reusable or dashboard-ready", async () => {
    await store.persist({ organizationId: ORG, repositoryId: REPO, entries: [{ fingerprint: FINGERPRINT, payload }] });
    // An expired row is one whose whole lifetime is behind us. Moving only the
    // expiry would invert it against created_at, which the schema forbids, so
    // age the row the way elapsed time would.
    await database.pool.query(`UPDATE review_analysis_cache_entries SET created_at=clock_timestamp()-interval '2 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1`, [ORG]);
    await expect(store.loadReady({ organizationId: ORG, repositoryId: REPO })).resolves.toEqual([]);
    await expect(store.listMetadata(ORG)).resolves.toEqual([]);
    await expect(store.deleteExpired()).resolves.toBe(1);
  });
  it("keeps payload size metadata database-authoritative", async () => {
    await store.persist({ organizationId: ORG, repositoryId: REPO, entries: [{ fingerprint: FINGERPRINT, payload }] });
    const measured = await database.pool.query<{ payload_bytes: string; canonical_bytes: number }>(
      `SELECT payload_bytes::text,octet_length(payload::text) AS canonical_bytes FROM review_analysis_cache_entries WHERE organization_id=$1 AND repository_id=$2`,
      [ORG, REPO],
    );
    expect(Number(measured.rows[0]!.payload_bytes)).toBe(measured.rows[0]!.canonical_bytes);
    await expect(database.pool.query(
      `UPDATE review_analysis_cache_entries SET payload_bytes=1 WHERE organization_id=$1 AND repository_id=$2`,
      [ORG, REPO],
    )).rejects.toThrow();
  });

  it("validates touch batches before they reach PostgreSQL", async () => {
    await expect(store.touch({ organizationId: ORG, repositoryId: REPO, fingerprints: ["not-a-fingerprint"] }))
      .rejects.toThrow("fingerprint is invalid");
    await expect(store.touch({ organizationId: ORG, repositoryId: REPO, fingerprints: Array.from({ length: 2_001 }, () => FINGERPRINT) }))
      .rejects.toThrow("touch batch is too large");
  });

});
