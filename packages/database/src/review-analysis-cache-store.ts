import { randomUUID } from "node:crypto";

import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export const REVIEW_ANALYSIS_CACHE_TTL_MILLIS = 7 * 24 * 60 * 60_000;
export const REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES = 1_048_576;
export const REVIEW_ANALYSIS_CACHE_MAX_WRITE_ENTRIES = 2_000;
export const REVIEW_ANALYSIS_CACHE_MAX_PRELOAD_BYTES = 32 * 1_048_576;
export const REVIEW_ANALYSIS_CACHE_MAX_METADATA_ENTRIES = 10_000;

export interface PersistedReviewAnalysisCacheEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly fingerprint: string;
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
}

export interface ReviewAnalysisCacheMetadata {
  readonly id: string;
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly fingerprint: string;
  readonly payloadBytes: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
}

export type ReviewAnalysisCacheDeleteOutcome =
  | { readonly kind: "deleted"; readonly count: number }
  | { readonly kind: "forbidden" };

interface RawCacheRow {
  id: string;
  organization_id: string;
  repository_id: string;
  fingerprint: string;
  payload: unknown;
  payload_bytes: string | number;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date;
  expires_at: Date;
}

interface RawMetadataRow {
  id: string;
  repository_id: string;
  fingerprint: string;
  payload_bytes: string | number;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date;
  expires_at: Date;
  repository_name: string;
}

function cacheRow(row: RawCacheRow): PersistedReviewAnalysisCacheEntry {
  return {
    id: row.id,
    organizationId: row.organization_id,
    repositoryId: row.repository_id,
    fingerprint: row.fingerprint,
    payload: row.payload,
    payloadBytes: Number(row.payload_bytes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Durable cache for deterministic review-engine cluster results.
 *
 * The cache never decides correctness: the review-engine fingerprint remains
 * the sole reuse identity. This store merely persists successful values for a
 * bounded seven-day window and exposes deletion as a real invalidation action.
 */
export class ReviewAnalysisCacheStore {
  public constructor(private readonly pool: PgPool) {}

  public async loadReady(input: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly limit?: number | undefined;
  }): Promise<readonly PersistedReviewAnalysisCacheEntry[]> {
    const limit = input.limit ?? 2_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Review analysis cache load limit is invalid");
    }
    const result = await this.pool.query<RawCacheRow>(
      `WITH candidates AS MATERIALIZED (
         SELECT id,
                row_number() OVER (ORDER BY last_used_at DESC, id) AS ordinal,
                sum(payload_bytes) OVER (ORDER BY last_used_at DESC, id) AS cumulative_bytes
           FROM review_analysis_cache_entries
          WHERE organization_id = $1
            AND repository_id = $2
            AND expires_at > clock_timestamp()
            AND payload_bytes BETWEEN 1 AND $3
       ), bounded AS MATERIALIZED (
         SELECT id FROM candidates
          WHERE ordinal <= $4 AND cumulative_bytes <= $5
       )
       SELECT c.id, c.organization_id, c.repository_id, c.fingerprint, c.payload, c.payload_bytes,
              c.created_at, c.updated_at, c.last_used_at, c.expires_at
         FROM review_analysis_cache_entries AS c
         JOIN bounded AS b ON b.id = c.id
        ORDER BY c.last_used_at DESC, c.id`,
      [
        input.organizationId,
        input.repositoryId,
        REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES,
        limit,
        REVIEW_ANALYSIS_CACHE_MAX_PRELOAD_BYTES,
      ],
    );
    return result.rows.map(cacheRow);
  }

  public async touch(input: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly fingerprints: readonly string[];
  }): Promise<void> {
    if (input.fingerprints.length === 0) return;
    if (input.fingerprints.length > REVIEW_ANALYSIS_CACHE_MAX_WRITE_ENTRIES) {
      throw new Error("Review analysis cache touch batch is too large");
    }
    if (
      input.fingerprints.some(
        (fingerprint) => !/^[0-9a-f]{64}$/u.test(fingerprint),
      )
    ) {
      throw new Error("Review analysis cache fingerprint is invalid");
    }
    await this.pool.query(
      `UPDATE review_analysis_cache_entries
          SET last_used_at = clock_timestamp()
        WHERE organization_id = $1
          AND repository_id = $2
          AND fingerprint = ANY($3::char(64)[])
          AND expires_at > clock_timestamp()`,
      [input.organizationId, input.repositoryId, input.fingerprints],
    );
  }

  public async persist(input: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly entries: readonly {
      readonly fingerprint: string;
      readonly payload: unknown;
    }[];
    readonly ttlMillis?: number | undefined;
  }): Promise<void> {
    if (input.entries.length === 0) return;
    if (input.entries.length > REVIEW_ANALYSIS_CACHE_MAX_WRITE_ENTRIES) {
      throw new Error("Review analysis cache write batch is too large");
    }
    const fingerprints = new Set(
      input.entries.map((entry) => entry.fingerprint),
    );
    if (fingerprints.size !== input.entries.length) {
      throw new Error(
        "Review analysis cache write batch contains duplicate fingerprints",
      );
    }
    const ttlMillis = input.ttlMillis ?? REVIEW_ANALYSIS_CACHE_TTL_MILLIS;
    if (
      !Number.isSafeInteger(ttlMillis) ||
      ttlMillis < 60_000 ||
      ttlMillis > REVIEW_ANALYSIS_CACHE_TTL_MILLIS
    ) {
      throw new Error("Review analysis cache TTL is invalid");
    }
    await this.#transaction(async (client) => {
      for (const entry of input.entries) {
        if (!/^[0-9a-f]{64}$/u.test(entry.fingerprint)) {
          throw new Error("Review analysis cache fingerprint is invalid");
        }
        const serialized = JSON.stringify(entry.payload);
        if (serialized === undefined) {
          throw new Error(
            "Review analysis cache payload is not JSON-serializable",
          );
        }
        const payloadBytes = Buffer.byteLength(serialized, "utf8");
        if (
          payloadBytes < 1 ||
          payloadBytes > REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES
        ) {
          throw new Error(
            "Review analysis cache payload exceeds the per-entry size limit",
          );
        }
        const persisted = await client.query(
          `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at),
                payload_value AS MATERIALIZED (SELECT $5::jsonb AS payload)
           INSERT INTO review_analysis_cache_entries
             (id, organization_id, repository_id, fingerprint, payload, payload_bytes,
              created_at, updated_at, last_used_at, expires_at)
           SELECT $1,$2,$3,$4,payload,octet_length(payload::text),at,at,at,
                  at + ($6::bigint * interval '1 millisecond')
             FROM database_clock CROSS JOIN payload_value
            WHERE octet_length(payload::text) BETWEEN 1 AND $7
           ON CONFLICT (organization_id, repository_id, fingerprint) DO UPDATE
             SET payload = EXCLUDED.payload,
                 payload_bytes = EXCLUDED.payload_bytes,
                 updated_at = EXCLUDED.updated_at,
                 last_used_at = EXCLUDED.last_used_at,
                 expires_at = EXCLUDED.expires_at`,
          [
            randomUUID(),
            input.organizationId,
            input.repositoryId,
            entry.fingerprint,
            serialized,
            ttlMillis,
            REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES,
          ],
        );
        if ((persisted.rowCount ?? 0) !== 1) {
          throw new Error(
            "Review analysis cache canonical payload exceeds the per-entry size limit",
          );
        }
      }
    });
  }

  public async listMetadata(
    organizationId: string,
  ): Promise<readonly ReviewAnalysisCacheMetadata[]> {
    const result = await this.pool.query<RawMetadataRow>(
      `SELECT c.id, c.repository_id, c.fingerprint, c.payload_bytes,
              c.created_at, c.updated_at, c.last_used_at, c.expires_at,
              r.name AS repository_name
         FROM review_analysis_cache_entries AS c
         JOIN repositories AS r
           ON r.organization_id = c.organization_id AND r.id = c.repository_id
        WHERE c.organization_id = $1
          AND c.expires_at > clock_timestamp()
          AND c.payload_bytes BETWEEN 1 AND $2
        ORDER BY c.updated_at DESC, c.id
        LIMIT ${REVIEW_ANALYSIS_CACHE_MAX_METADATA_ENTRIES}`,
      [organizationId, REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES],
    );
    return result.rows.map((row) => ({
      id: row.id,
      repositoryId: row.repository_id,
      repositoryName: row.repository_name,
      fingerprint: row.fingerprint,
      payloadBytes: Number(row.payload_bytes),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
    }));
  }

  public async deleteAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly ids: readonly string[];
  }): Promise<ReviewAnalysisCacheDeleteOutcome> {
    if (input.ids.length === 0) return { kind: "deleted", count: 0 };
    return this.#transaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('dashboard-cache:' || $1::text, 0))`,
        [input.organizationId],
      );
      const role = await client.query<{ role: string }>(
        `SELECT role FROM memberships
          WHERE organization_id = $1 AND user_id = $2
          FOR UPDATE`,
        [input.organizationId, input.actorUserId],
      );
      if (!new Set(["owner", "admin"]).has(role.rows[0]?.role ?? "")) {
        return { kind: "forbidden" } as const;
      }
      const deleted = await client.query(
        `DELETE FROM review_analysis_cache_entries
          WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
        [input.organizationId, input.ids],
      );
      return { kind: "deleted", count: deleted.rowCount ?? 0 } as const;
    });
  }

  public async deleteExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM review_analysis_cache_entries WHERE expires_at <= clock_timestamp()`,
    );
    return result.rowCount ?? 0;
  }

  async #transaction<T>(work: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
