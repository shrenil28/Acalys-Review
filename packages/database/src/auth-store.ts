import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export type AuthRole = "owner" | "admin" | "member" | "read_only";

const AUTH_ROLE_ORDER: Readonly<Record<AuthRole, number>> = {
  read_only: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

function lowerRole(left: AuthRole, right: AuthRole): AuthRole {
  return AUTH_ROLE_ORDER[left] <= AUTH_ROLE_ORDER[right] ? left : right;
}

export interface StoredSessionPrincipal {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly role: AuthRole;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly rotatedAt: Date | null;
}

export interface StoredApiKeyPrincipal {
  readonly apiKeyId: string;
  readonly userId: string | null;
  readonly organizationId: string;
  readonly role: AuthRole;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface OAuthIdentityInput {
  readonly userId: string;
  readonly provider: string;
  readonly providerUserId: string;
  readonly primaryEmail?: string | undefined;
  readonly displayName?: string | undefined;
}

export interface MembershipInput {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: AuthRole;
}

export interface EstablishOAuthSessionInput {
  readonly proposedUserId: string;
  readonly membershipId: string;
  readonly sessionId: string;
  readonly organizationId: string;
  readonly provider: string;
  readonly providerUserId: string;
  readonly primaryEmail?: string | undefined;
  readonly displayName?: string | undefined;
  readonly role: AuthRole;
  readonly tokenHash: string;
  readonly ttlMillis: number;
}

export class AuthStore {
  public constructor(private readonly pool: PgPool) {}

  public async upsertOAuthIdentity(input: OAuthIdentityInput): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
       INSERT INTO users (id, provider, provider_user_id, primary_email, display_name, created_at, updated_at)
       SELECT $1,$2,$3,$4,$5,clock.at,clock.at FROM database_clock AS clock
       ON CONFLICT (provider, provider_user_id) DO UPDATE SET
         primary_email = EXCLUDED.primary_email,
         display_name = EXCLUDED.display_name,
         updated_at = GREATEST(users.updated_at, EXCLUDED.updated_at)
       RETURNING id`,
      [
        input.userId,
        input.provider,
        input.providerUserId,
        input.primaryEmail ?? null,
        input.displayName ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("OAuth identity upsert returned no row");
    return row.id;
  }

  public async upsertMembership(input: MembershipInput): Promise<void> {
    await this.pool.query(
      `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
       INSERT INTO memberships (id, organization_id, user_id, role, created_at, updated_at)
       SELECT $1,$2,$3,$4,clock.at,clock.at FROM database_clock AS clock
       ON CONFLICT (organization_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         updated_at = GREATEST(memberships.updated_at, EXCLUDED.updated_at)`,
      [input.membershipId, input.organizationId, input.userId, input.role],
    );
  }

  /**
   * Commits a verified OAuth identity refresh, membership-role synchronization,
   * and first session issuance as one database transaction. A single Postgres
   * clock value owns all timestamps, and the session is bound to the exact
   * membership row returned by the same statement. If any insert/update fails,
   * no identity or membership side effect survives independently.
   */
  public async establishOAuthSession(input: EstablishOAuthSessionInput): Promise<{
    readonly userId: string;
    readonly membershipId: string;
    readonly role: AuthRole;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }> {
    if (!Number.isSafeInteger(input.ttlMillis) || input.ttlMillis <= 0) {
      throw new Error("Session TTL must be a positive safe integer");
    }

    return this.inTransaction(async (client) => {
      const result = await client.query<{
        user_id: string;
        membership_id: string;
        role: AuthRole;
        created_at: Date;
        expires_at: Date;
      }>(
        `WITH database_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS at
         ), oauth_user AS (
           INSERT INTO users
             (id, provider, provider_user_id, primary_email, display_name, created_at, updated_at)
           SELECT $1,$2,$3,$4,$5,clock.at,clock.at
             FROM database_clock AS clock
           ON CONFLICT (provider, provider_user_id) DO UPDATE SET
             primary_email = EXCLUDED.primary_email,
             display_name = EXCLUDED.display_name,
             updated_at = GREATEST(users.updated_at, EXCLUDED.updated_at)
           RETURNING id
         ), oauth_membership AS (
           INSERT INTO memberships
             (id, organization_id, user_id, role, created_at, updated_at)
           SELECT $6,$7,user_row.id,$8,clock.at,clock.at
             FROM oauth_user AS user_row
             CROSS JOIN database_clock AS clock
           ON CONFLICT (organization_id, user_id) DO UPDATE SET
             role = EXCLUDED.role,
             updated_at = GREATEST(memberships.updated_at, EXCLUDED.updated_at)
           RETURNING id, user_id, role
         ), oauth_session AS (
           INSERT INTO auth_sessions
             (id, user_id, organization_id, membership_id, token_hash, created_at, expires_at)
           SELECT $9,membership.user_id,$7,membership.id,$10,clock.at,
                  clock.at + ($11::double precision * INTERVAL '1 millisecond')
             FROM oauth_membership AS membership
             CROSS JOIN database_clock AS clock
           RETURNING user_id, membership_id, created_at, expires_at
         )
         SELECT session.user_id, session.membership_id, membership.role,
                session.created_at, session.expires_at
           FROM oauth_session AS session
           JOIN oauth_membership AS membership ON membership.id = session.membership_id`,
        [
          input.proposedUserId,
          input.provider,
          input.providerUserId,
          input.primaryEmail ?? null,
          input.displayName ?? null,
          input.membershipId,
          input.organizationId,
          input.role,
          input.sessionId,
          input.tokenHash,
          input.ttlMillis,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("OAuth session establishment returned no row");
      return {
        userId: row.user_id,
        membershipId: row.membership_id,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    });
  }

  public async createSession(input: {
    readonly id: string;
    readonly userId: string;
    readonly organizationId: string;
    readonly tokenHash: string;
    readonly ttlMillis: number;
  }): Promise<{ readonly createdAt: Date; readonly expiresAt: Date } | undefined> {
    if (!Number.isSafeInteger(input.ttlMillis) || input.ttlMillis <= 0) {
      throw new Error("Session TTL must be a positive safe integer");
    }

    return this.inTransaction(async (client) => {
      const membership = await client.query<{ membership_id: string }>(
        `SELECT id AS membership_id
           FROM memberships
          WHERE organization_id = $1 AND user_id = $2
          FOR SHARE`,
        [input.organizationId, input.userId],
      );
      const membershipId = membership.rows[0]?.membership_id;
      if (membershipId === undefined) return undefined;

      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const databaseNow = clock.rows[0]?.database_now;
      if (databaseNow === undefined) throw new Error("Database clock returned no session timestamp");
      const expiresAt = new Date(databaseNow.getTime() + input.ttlMillis);
      if (!Number.isFinite(expiresAt.getTime())) {
        throw new Error("Session expiry is outside the supported timestamp range");
      }
      await client.query(
        `INSERT INTO auth_sessions
           (id, user_id, organization_id, membership_id, token_hash, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [input.id, input.userId, input.organizationId, membershipId, input.tokenHash, databaseNow, expiresAt],
      );
      return { createdAt: databaseNow, expiresAt };
    });
  }

  /**
   * Authenticates and records use in one transaction.
   *
   * Membership is locked before the credential, then Postgres supplies the
   * liveness timestamp after both potentially-blocking reads. This closes the
   * revoke/delete/touch races and prevents a process clock (or a stale pre-lock
   * timestamp) from deciding whether a session is still valid.
   */
  public async authenticateSessionByHash(
    tokenHash: string,
  ): Promise<StoredSessionPrincipal | undefined> {
    return this.inTransaction(async (client) => {
      const locator = await client.query<{
        membership_id: string | null;
        user_id: string;
        organization_id: string;
      }>(
        `SELECT membership_id, user_id, organization_id
           FROM auth_sessions
          WHERE token_hash = $1`,
        [tokenHash],
      );
      const located = locator.rows[0];
      if (located === undefined || located.membership_id === null) return undefined;

      // Lock membership before the credential row. Membership deletion cascades
      // toward credential referents, so using the same lock order avoids a
      // delete/authenticate deadlock while making the role stable for this auth.
      const membership = await client.query<{ role: AuthRole }>(
        `SELECT role
           FROM memberships
          WHERE id = $1 AND organization_id = $2 AND user_id = $3
          FOR SHARE`,
        [located.membership_id, located.organization_id, located.user_id],
      );
      const membershipRole = membership.rows[0]?.role;
      if (membershipRole === undefined) return undefined;

      const current = await client.query<{
        session_id: string;
        user_id: string;
        organization_id: string;
        expires_at: Date;
        revoked_at: Date | null;
        rotated_at: Date | null;
      }>(
        `SELECT id AS session_id, user_id, organization_id, expires_at, revoked_at, rotated_at
           FROM auth_sessions
          WHERE token_hash = $1 AND membership_id = $2
          FOR UPDATE`,
        [tokenHash, located.membership_id],
      );
      const row = current.rows[0];
      if (row === undefined) return undefined;

      // Read the authoritative clock only after all rows that can delay the
      // decision are locked. A credential cannot expire while waiting and then
      // be accepted against a stale pre-lock timestamp.
      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const databaseNow = clock.rows[0]?.database_now;
      if (databaseNow === undefined) throw new Error("Database clock returned no session timestamp");
      if (row.revoked_at !== null || row.rotated_at !== null || row.expires_at.getTime() <= databaseNow.getTime()) {
        return undefined;
      }

      await client.query(
        `UPDATE auth_sessions
            SET last_used_at = GREATEST(COALESCE(last_used_at, $2), $2)
          WHERE id = $1`,
        [row.session_id, databaseNow],
      );
      return {
        sessionId: row.session_id,
        userId: row.user_id,
        organizationId: row.organization_id,
        role: membershipRole,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        rotatedAt: row.rotated_at,
      };
    });
  }

  public async rotateSessionByHash(input: {
    readonly currentHash: string;
    readonly replacementId: string;
    readonly replacementHash: string;
    readonly ttlMillis: number;
  }): Promise<{ readonly expiresAt: Date } | undefined> {
    if (!Number.isSafeInteger(input.ttlMillis) || input.ttlMillis <= 0) {
      throw new Error("Session TTL must be a positive safe integer");
    }

    return this.inTransaction(async (client) => {
      const locator = await client.query<{
        membership_id: string | null;
        user_id: string;
        organization_id: string;
      }>(
        `SELECT membership_id, user_id, organization_id
           FROM auth_sessions
          WHERE token_hash = $1`,
        [input.currentHash],
      );
      const located = locator.rows[0];
      if (located === undefined || located.membership_id === null) return undefined;

      const membership = await client.query(
        `SELECT 1
           FROM memberships
          WHERE id = $1 AND organization_id = $2 AND user_id = $3
          FOR SHARE`,
        [located.membership_id, located.organization_id, located.user_id],
      );
      if (membership.rows[0] === undefined) return undefined;

      const current = await client.query<{
        id: string;
        user_id: string;
        organization_id: string;
        expires_at: Date;
        revoked_at: Date | null;
        rotated_at: Date | null;
      }>(
        `SELECT id, user_id, organization_id, expires_at, revoked_at, rotated_at
           FROM auth_sessions
          WHERE token_hash = $1 AND membership_id = $2
          FOR UPDATE`,
        [input.currentHash, located.membership_id],
      );
      const row = current.rows[0];
      if (row === undefined) return undefined;

      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const databaseNow = clock.rows[0]?.database_now;
      if (databaseNow === undefined) throw new Error("Database clock returned no session timestamp");
      if (row.revoked_at !== null || row.rotated_at !== null || row.expires_at.getTime() <= databaseNow.getTime()) {
        return undefined;
      }

      const expiresAt = new Date(databaseNow.getTime() + input.ttlMillis);
      if (!Number.isFinite(expiresAt.getTime())) {
        throw new Error("Session expiry is outside the supported timestamp range");
      }
      await client.query(
        `INSERT INTO auth_sessions
           (id, user_id, organization_id, membership_id, token_hash, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.replacementId,
          row.user_id,
          row.organization_id,
          located.membership_id,
          input.replacementHash,
          databaseNow,
          expiresAt,
        ],
      );
      await client.query(
        `UPDATE auth_sessions
            SET rotated_at = $2,
                replaced_by = $3,
                last_used_at = GREATEST(COALESCE(last_used_at, $2), $2)
          WHERE id = $1`,
        [row.id, databaseNow, input.replacementId],
      );
      return { expiresAt };
    });
  }

  public async revokeSession(id: string, organizationId: string): Promise<boolean> {
    const result = await this.pool.query(
      `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
       UPDATE auth_sessions AS s
          SET revoked_at = COALESCE(s.revoked_at, clock.at)
         FROM database_clock AS clock
        WHERE s.id = $1 AND s.organization_id = $2 AND s.rotated_at IS NULL`,
      [id, organizationId],
    );
    return result.rowCount === 1;
  }

  public async createApiKey(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly userId?: string | undefined;
    readonly prefix: string;
    readonly hash: string;
    readonly name: string;
    readonly role: AuthRole;
    readonly scopes: readonly string[];
    readonly expiresAt?: Date | undefined;
  }): Promise<"created" | "membership_missing" | "invalid_expiry"> {
    return this.inTransaction(async (client) => {
      let membershipId: string | null = null;
      if (input.userId !== undefined) {
        const membership = await client.query<{ id: string }>(
          `SELECT id
             FROM memberships
            WHERE organization_id = $1 AND user_id = $2
            FOR SHARE`,
          [input.organizationId, input.userId],
        );
        membershipId = membership.rows[0]?.id ?? null;
        if (membershipId === null) return "membership_missing";
      }

      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const databaseNow = clock.rows[0]?.database_now;
      if (databaseNow === undefined) throw new Error("Database clock returned no API-key timestamp");
      if (input.expiresAt !== undefined && input.expiresAt.getTime() <= databaseNow.getTime()) {
        return "invalid_expiry";
      }

      await client.query(
        `INSERT INTO api_keys
           (id, organization_id, user_id, owner_kind, membership_id, key_prefix, key_hash,
            name, role, scopes, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [
          input.id,
          input.organizationId,
          input.userId ?? null,
          input.userId === undefined ? "organization" : "user",
          membershipId,
          input.prefix,
          input.hash,
          input.name,
          input.role,
          JSON.stringify(input.scopes),
          databaseNow,
          input.expiresAt ?? null,
        ],
      );
      return "created";
    });
  }

  /**
   * Authenticates an API key and records last-use atomically.
   *
   * User-bound keys require a live organization membership. Their stored role
   * is an issuance ceiling, so a later membership upgrade cannot silently
   * widen an old key and a downgrade takes effect immediately. Organization
   * keys (user_id IS NULL) use only their stored role.
   */
  public async authenticateApiKeyByHash(
    hash: string,
  ): Promise<StoredApiKeyPrincipal | undefined> {
    return this.inTransaction(async (client) => {
      const locator = await client.query<{
        api_key_id: string;
        user_id: string | null;
        organization_id: string;
        owner_kind: "organization" | "user" | "legacy_unbound";
        membership_id: string | null;
      }>(
        `SELECT id AS api_key_id, user_id, organization_id, owner_kind, membership_id
           FROM api_keys
          WHERE key_hash = $1`,
        [hash],
      );
      const located = locator.rows[0];
      if (located === undefined || located.owner_kind === "legacy_unbound") return undefined;

      if (
        located.owner_kind === "organization" &&
        (located.user_id !== null || located.membership_id !== null)
      ) {
        return undefined;
      }

      let membershipRole: AuthRole | undefined;
      if (located.owner_kind === "user") {
        if (located.user_id === null || located.membership_id === null) return undefined;
        const membership = await client.query<{ role: AuthRole }>(
          `SELECT role
             FROM memberships
            WHERE id = $1 AND organization_id = $2 AND user_id = $3
            FOR SHARE`,
          [located.membership_id, located.organization_id, located.user_id],
        );
        membershipRole = membership.rows[0]?.role;
        if (membershipRole === undefined) return undefined;
      }

      const current = await client.query<{
        api_key_id: string;
        user_id: string | null;
        organization_id: string;
        owner_kind: "organization" | "user" | "legacy_unbound";
        membership_id: string | null;
        role: AuthRole;
        scopes: unknown;
        expires_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT id AS api_key_id, user_id, organization_id, owner_kind, membership_id,
                role, scopes, expires_at, revoked_at
           FROM api_keys
          WHERE key_hash = $1
          FOR UPDATE`,
        [hash],
      );
      const row = current.rows[0];
      if (row === undefined) return undefined;
      if (
        row.owner_kind !== located.owner_kind ||
        row.membership_id !== located.membership_id ||
        row.user_id !== located.user_id
      ) {
        return undefined;
      }

      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const databaseNow = clock.rows[0]?.database_now;
      if (databaseNow === undefined) throw new Error("Database clock returned no API-key timestamp");
      if (row.revoked_at !== null || (row.expires_at !== null && row.expires_at.getTime() <= databaseNow.getTime())) {
        return undefined;
      }

      await client.query(
        `UPDATE api_keys
            SET last_used_at = GREATEST(COALESCE(last_used_at, $2), $2)
          WHERE id = $1`,
        [row.api_key_id, databaseNow],
      );
      const scopes = Array.isArray(row.scopes)
        ? row.scopes.filter((scope): scope is string => typeof scope === "string")
        : [];
      return {
        apiKeyId: row.api_key_id,
        userId: row.user_id,
        organizationId: row.organization_id,
        role: membershipRole === undefined ? row.role : lowerRole(row.role, membershipRole),
        scopes,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      };
    });
  }

  public async revokeApiKey(id: string, organizationId: string): Promise<boolean> {
    const result = await this.pool.query(
      `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
       UPDATE api_keys AS k
          SET revoked_at = COALESCE(k.revoked_at, clock.at)
         FROM database_clock AS clock
        WHERE k.id = $1 AND k.organization_id = $2`,
      [id, organizationId],
    );
    return result.rowCount === 1;
  }

  /**
   * Consumes the principal and organization API quotas as one database-owned
   * decision. The active minute comes from Postgres so horizontally scaled API
   * replicas cannot split a fixed window because their process clocks differ.
   *
   * Every caller acquires buckets in principal -> organization order. A request
   * rejected by the organization limit refunds the principal increment before
   * commit, so one exhausted tenant cannot silently consume a credential's
   * otherwise available quota. With a stable limit, denied counters saturate at
   * limit + 1 instead of growing without bound under sustained abuse; a rolling
   * limit change never lowers an already-observed count.
   */
  public async consumeApiRateLimits(input: {
    readonly organizationId: string;
    readonly principalId: string;
    readonly perPrincipalLimit: number;
    readonly perOrganizationLimit: number;
  }): Promise<{
    readonly allowed: boolean;
    readonly reason?: "principal" | "organization";
    readonly windowStart: Date;
  }> {
    if (!Number.isSafeInteger(input.perPrincipalLimit) || input.perPrincipalLimit <= 0) {
      throw new Error("perPrincipalLimit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(input.perOrganizationLimit) || input.perOrganizationLimit <= 0) {
      throw new Error("perOrganizationLimit must be a positive safe integer");
    }

    return this.inTransaction(async (client) => {
      const clock = await client.query<{ window_start: Date }>(
        `SELECT date_trunc('minute', clock_timestamp()) AS window_start`,
      );
      const windowStart = clock.rows[0]?.window_start;
      if (windowStart === undefined) throw new Error("Database clock returned no rate-limit window");

      const bump = async (bucket: string, limit: number): Promise<number> => {
        const result = await client.query<{ request_count: number }>(
          `INSERT INTO api_rate_windows (organization_id, principal_id, window_start, request_count)
           VALUES ($1,$2,$3,1)
           ON CONFLICT (organization_id, principal_id, window_start)
           DO UPDATE SET request_count = CASE
             WHEN api_rate_windows.request_count < $4 THEN api_rate_windows.request_count + 1
             ELSE api_rate_windows.request_count
           END
           RETURNING request_count`,
          [input.organizationId, bucket, windowStart, limit + 1],
        );
        const count = result.rows[0]?.request_count;
        if (count === undefined) throw new Error("Rate-limit increment returned no counter");
        return count;
      };

      const refund = async (bucket: string): Promise<void> => {
        const removed = await client.query(
          `DELETE FROM api_rate_windows
            WHERE organization_id = $1 AND principal_id = $2 AND window_start = $3
              AND request_count = 1`,
          [input.organizationId, bucket, windowStart],
        );
        if (removed.rowCount === 1) return;
        const decremented = await client.query(
          `UPDATE api_rate_windows
              SET request_count = request_count - 1
            WHERE organization_id = $1 AND principal_id = $2 AND window_start = $3
              AND request_count > 1`,
          [input.organizationId, bucket, windowStart],
        );
        if (decremented.rowCount !== 1) {
          throw new Error("Rate-limit refund could not find the consumed bucket");
        }
      };

      const principalBucket = `principal:${input.principalId}`;
      const principalCount = await bump(principalBucket, input.perPrincipalLimit);
      if (principalCount > input.perPrincipalLimit) {
        return { allowed: false, reason: "principal", windowStart };
      }

      const organizationCount = await bump("organization", input.perOrganizationLimit);
      if (organizationCount > input.perOrganizationLimit) {
        await refund(principalBucket);
        return { allowed: false, reason: "organization", windowStart };
      }

      return { allowed: true, windowStart };
    });
  }

  private async inTransaction<T>(work: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
