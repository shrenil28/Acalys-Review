import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";
import type { AuthRole } from "./auth-store.js";

export interface DashboardOrganizationRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}
export interface DashboardSessionRow {
  readonly sessionId: string;
  readonly userId: string;
  readonly provider: string;
  readonly providerUserId: string;
  readonly primaryEmail: string | null;
  readonly displayName: string | null;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly membershipId: string;
  readonly role: AuthRole;
  readonly expiresAt: Date;
}
export interface DashboardMemberRow {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string | null;
  readonly primaryEmail: string | null;
  readonly provider: string;
  readonly providerUserId: string;
  readonly role: AuthRole;
  readonly analyticsTeam: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface DashboardApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly role: AuthRole;
  readonly scopes: readonly string[];
  readonly ownerKind: "organization" | "user";
  readonly userId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
}
export interface DashboardProviderConnectionRow {
  readonly id: string;
  readonly provider: string;
  readonly externalAccountId: string;
  readonly installationRef: string | null;
  readonly status: "active" | "suspended" | "revoked";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DashboardInvitationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: AuthRole;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface DashboardProvisionedIdentity {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
}

export type InvitationCreationOutcome =
  | { readonly kind: "created"; readonly invitation: DashboardInvitationRow }
  | { readonly kind: "forbidden" };

export type InvitationCancellationOutcome =
  | { readonly kind: "cancelled" }
  | { readonly kind: "forbidden" | "not_found" };

export type InvitationRedemptionOutcome =
  | { readonly kind: "redeemed"; readonly identity: DashboardProvisionedIdentity }
  | { readonly kind: "invalid" | "email_mismatch" | "identity_conflict" | "already_member" };

export type MemberRemovalOutcome =
  | { readonly kind: "removed"; readonly revokedSessions: number; readonly revokedApiKeys: number }
  | { readonly kind: "forbidden" | "not_found" | "last_owner" };

function canonicalEmail(value: string): string {
  return value.trim().toLowerCase();
}

export type MembershipRoleUpdate =
  | { readonly kind: "updated"; readonly member: DashboardMemberRow }
  | { readonly kind: "forbidden" | "not_found" | "last_owner" };

export class DashboardAdminStore {
  public constructor(private readonly pool: PgPool) {}

  public async getOrganization(id: string): Promise<DashboardOrganizationRow | undefined> {
    const result = await this.pool.query<DashboardOrganizationRow>(
      `SELECT id, slug, name FROM organizations WHERE id = $1 AND lifecycle = 'active'`,
      [id],
    );
    return result.rows[0];
  }

  public async createLoginExchangeForProvisionedIdentity(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly provider: string;
    readonly providerUserId: string;
    readonly exchangeHash: string;
    readonly ttlMillis: number;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(input.ttlMillis) || input.ttlMillis <= 0) {
      throw new Error("Dashboard exchange TTL must be a positive safe integer");
    }
    const result = await this.pool.query<{ id: string }>(
      `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
       INSERT INTO dashboard_login_exchanges
         (id, organization_id, user_id, membership_id, exchange_hash, created_at, expires_at)
       SELECT $1,$2,u.id,m.id,$5,clock.at,
              clock.at + ($6::double precision * INTERVAL '1 millisecond')
         FROM users AS u
         JOIN memberships AS m ON m.user_id = u.id AND m.organization_id = $2
         CROSS JOIN database_clock AS clock
        WHERE u.provider = $3 AND u.provider_user_id = $4
       RETURNING id`,
      [input.id, input.organizationId, input.provider, input.providerUserId, input.exchangeHash, input.ttlMillis],
    );
    return result.rows[0] !== undefined;
  }

  public async redeemLoginExchange(exchangeHash: string): Promise<{
    readonly organizationId: string;
    readonly userId: string;
    readonly membershipId: string;
  } | undefined> {
    return this.inTransaction(async (client) => {
      const result = await client.query<{
        id: string;
        organization_id: string;
        user_id: string;
        membership_id: string;
        expires_at: Date;
        redeemed_at: Date | null;
        database_now: Date;
      }>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         SELECT e.id, e.organization_id, e.user_id, e.membership_id,
                e.expires_at, e.redeemed_at, clock.at AS database_now
           FROM dashboard_login_exchanges AS e
           JOIN memberships AS m
             ON m.id = e.membership_id
            AND m.organization_id = e.organization_id
            AND m.user_id = e.user_id
           CROSS JOIN database_clock AS clock
          WHERE e.exchange_hash = $1
          FOR UPDATE OF e`,
        [exchangeHash],
      );
      const row = result.rows[0];
      if (
        row === undefined ||
        row.redeemed_at !== null ||
        row.expires_at.getTime() <= row.database_now.getTime()
      ) {
        return undefined;
      }
      await client.query(`UPDATE dashboard_login_exchanges SET redeemed_at = $2 WHERE id = $1`, [row.id, row.database_now]);
      return { organizationId: row.organization_id, userId: row.user_id, membershipId: row.membership_id };
    });
  }

  public async getSession(input: {
    readonly sessionId: string;
    readonly organizationId: string;
    readonly userId: string;
  }): Promise<DashboardSessionRow | undefined> {
    const result = await this.pool.query<{
      session_id: string; user_id: string; provider: string; provider_user_id: string;
      primary_email: string | null; display_name: string | null; organization_id: string;
      organization_slug: string; organization_name: string; membership_id: string; role: AuthRole; expires_at: Date;
    }>(
      `SELECT s.id AS session_id, u.id AS user_id, u.provider, u.provider_user_id,
              u.primary_email, u.display_name, o.id AS organization_id,
              o.slug AS organization_slug, o.name AS organization_name,
              m.id AS membership_id, m.role, s.expires_at
         FROM auth_sessions AS s
         JOIN users AS u ON u.id = s.user_id
         JOIN memberships AS m ON m.id = s.membership_id AND m.user_id = s.user_id AND m.organization_id = s.organization_id
         JOIN organizations AS o ON o.id = s.organization_id
        WHERE s.id = $1 AND s.organization_id = $2 AND s.user_id = $3`,
      [input.sessionId, input.organizationId, input.userId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      sessionId: row.session_id, userId: row.user_id, provider: row.provider,
      providerUserId: row.provider_user_id, primaryEmail: row.primary_email,
      displayName: row.display_name, organizationId: row.organization_id,
      organizationSlug: row.organization_slug, organizationName: row.organization_name,
      membershipId: row.membership_id, role: row.role, expiresAt: row.expires_at,
    };
  }

  public async listMembers(organizationId: string): Promise<readonly DashboardMemberRow[]> {
    const result = await this.pool.query<{
      id: string; user_id: string; display_name: string | null; primary_email: string | null;
      provider: string; provider_user_id: string; role: AuthRole; analytics_team: string | null; created_at: Date; updated_at: Date;
    }>(
      `SELECT m.id, m.user_id, u.display_name, u.primary_email, u.provider, u.provider_user_id,
              m.role, m.analytics_team, m.created_at, m.updated_at
         FROM memberships AS m JOIN users AS u ON u.id = m.user_id
        WHERE m.organization_id = $1
        ORDER BY lower(COALESCE(u.display_name, u.primary_email, u.provider_user_id)), m.id`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      id: row.id, userId: row.user_id, displayName: row.display_name, primaryEmail: row.primary_email,
      provider: row.provider, providerUserId: row.provider_user_id, role: row.role, analyticsTeam: row.analytics_team,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  public async updateMemberRole(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly memberId: string;
    readonly role: AuthRole;
  }): Promise<MembershipRoleUpdate> {
    return this.inTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-members:' || $1, 0))`, [input.organizationId]);
      const actor = await client.query<{ role: AuthRole }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
        [input.organizationId, input.actorUserId],
      );
      const actorRole = actor.rows[0]?.role;
      if (actorRole !== "owner" && actorRole !== "admin") return { kind: "forbidden" };
      const target = await client.query<{ role: AuthRole }>(
        `SELECT role FROM memberships WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [input.memberId, input.organizationId],
      );
      const targetRole = target.rows[0]?.role;
      if (targetRole === undefined) return { kind: "not_found" };
      if (actorRole === "admin" && (targetRole === "owner" || input.role === "owner")) return { kind: "forbidden" };
      if (targetRole === "owner" && input.role !== "owner") {
        const owners = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM memberships WHERE organization_id = $1 AND role = 'owner'`,
          [input.organizationId],
        );
        if (Number(owners.rows[0]?.count ?? "0") <= 1) return { kind: "last_owner" };
      }
      const updated = await client.query<{
        id: string; user_id: string; display_name: string | null; primary_email: string | null;
        provider: string; provider_user_id: string; role: AuthRole; analytics_team: string | null; created_at: Date; updated_at: Date;
      }>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at), changed AS (
           UPDATE memberships AS m SET role = $3, updated_at = GREATEST(m.updated_at, clock.at)
             FROM database_clock AS clock
            WHERE m.id = $1 AND m.organization_id = $2
            RETURNING m.id, m.user_id, m.role, m.analytics_team, m.created_at, m.updated_at
         )
         SELECT c.id, c.user_id, u.display_name, u.primary_email, u.provider, u.provider_user_id,
                c.role, c.analytics_team, c.created_at, c.updated_at
           FROM changed AS c JOIN users AS u ON u.id = c.user_id`,
        [input.memberId, input.organizationId, input.role],
      );
      const row = updated.rows[0];
      if (row === undefined) return { kind: "not_found" };
      return { kind: "updated", member: {
        id: row.id, userId: row.user_id, displayName: row.display_name, primaryEmail: row.primary_email,
        provider: row.provider, providerUserId: row.provider_user_id, role: row.role, analyticsTeam: row.analytics_team,
        createdAt: row.created_at, updatedAt: row.updated_at,
      } };
    });
  }

  public async updateMemberAnalyticsTeamAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly memberId: string;
    readonly team: string | null;
  }): Promise<{ readonly kind: "updated"; readonly member: DashboardMemberRow } | { readonly kind: "not_found" | "forbidden" }> {
    const team = input.team === null ? null : input.team.trim();
    if (team !== null && (team.length < 1 || team.length > 100)) throw new Error("Dashboard analytics team is invalid");
    return this.inTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-members:' || $1, 0))`, [input.organizationId]);
      const actor = await client.query<{ role: AuthRole }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
        [input.organizationId, input.actorUserId],
      );
      const actorRole = actor.rows[0]?.role;
      if (actorRole !== "owner" && actorRole !== "admin") return { kind: "forbidden" } as const;
      const updated = await client.query<{
        id: string; user_id: string; display_name: string | null; primary_email: string | null;
        provider: string; provider_user_id: string; role: AuthRole; analytics_team: string | null; created_at: Date; updated_at: Date;
      }>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at), changed AS (
           UPDATE memberships AS m
              SET analytics_team = $3, updated_at = GREATEST(m.updated_at, clock.at)
             FROM database_clock AS clock
            WHERE m.id = $1 AND m.organization_id = $2
            RETURNING m.id, m.user_id, m.role, m.analytics_team, m.created_at, m.updated_at
         )
         SELECT c.id, c.user_id, u.display_name, u.primary_email, u.provider, u.provider_user_id,
                c.role, c.analytics_team, c.created_at, c.updated_at
           FROM changed AS c JOIN users AS u ON u.id = c.user_id`,
        [input.memberId, input.organizationId, team],
      );
      const row = updated.rows[0];
      if (row === undefined) return { kind: "not_found" } as const;
      return { kind: "updated", member: {
        id: row.id, userId: row.user_id, displayName: row.display_name, primaryEmail: row.primary_email,
        provider: row.provider, providerUserId: row.provider_user_id, role: row.role, analyticsTeam: row.analytics_team,
        createdAt: row.created_at, updatedAt: row.updated_at,
      } } as const;
    });
  }

  public async listInvitations(organizationId: string): Promise<readonly DashboardInvitationRow[]> {
    const result = await this.pool.query<{
      id: string; organization_id: string; email: string; role: AuthRole; created_by: string;
      created_at: Date; expires_at: Date;
    }>(
      `SELECT id, organization_id, email, role, created_by, created_at, expires_at
         FROM dashboard_membership_invitations
        WHERE organization_id = $1
          AND cancelled_at IS NULL
          AND redeemed_at IS NULL
          AND expires_at > clock_timestamp()
        ORDER BY created_at DESC, id DESC`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      email: row.email,
      role: row.role,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  public async createInvitationAuthorized(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly email: string;
    readonly role: AuthRole;
    readonly inviteHash: string;
    readonly ttlMillis: number;
  }): Promise<InvitationCreationOutcome> {
    if (!Number.isSafeInteger(input.ttlMillis) || input.ttlMillis < 60_000 || input.ttlMillis > 30 * 24 * 60 * 60_000) {
      throw new Error("Dashboard invitation TTL must be between one minute and 30 days");
    }
    const email = canonicalEmail(input.email);
    if (email.length === 0 || email.length > 320) throw new Error("Dashboard invitation email is invalid");
    return this.inTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-members:' || $1, 0))`, [input.organizationId]);
      const actor = await client.query<{ role: AuthRole }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
        [input.organizationId, input.actorUserId],
      );
      const actorRole = actor.rows[0]?.role;
      if (actorRole !== "owner" && actorRole !== "admin") return { kind: "forbidden" };
      if (actorRole === "admin" && input.role === "owner") return { kind: "forbidden" };

      const existing = await client.query<{ role: AuthRole }>(
        `SELECT role
           FROM dashboard_membership_invitations
          WHERE organization_id = $1
            AND lower(email) = $2
            AND cancelled_at IS NULL
            AND redeemed_at IS NULL
            AND expires_at > clock_timestamp()
          FOR UPDATE`,
        [input.organizationId, email],
      );
      if (actorRole === "admin" && existing.rows.some((row) => row.role === "owner")) return { kind: "forbidden" };

      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const now = clock.rows[0]?.database_now;
      if (now === undefined) throw new Error("Database clock returned no invitation timestamp");
      await client.query(
        `UPDATE dashboard_membership_invitations
            SET cancelled_at = $3
          WHERE organization_id = $1
            AND lower(email) = $2
            AND cancelled_at IS NULL
            AND redeemed_at IS NULL`,
        [input.organizationId, email, now],
      );
      const created = await client.query<{
        id: string; organization_id: string; email: string; role: AuthRole; created_by: string;
        created_at: Date; expires_at: Date;
      }>(
        `INSERT INTO dashboard_membership_invitations
           (id, organization_id, email, role, invite_hash, created_by, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz + ($8::double precision * INTERVAL '1 millisecond'))
         RETURNING id, organization_id, email, role, created_by, created_at, expires_at`,
        [input.id, input.organizationId, email, input.role, input.inviteHash, input.actorUserId, now, input.ttlMillis],
      );
      const row = created.rows[0];
      if (row === undefined) throw new Error("Invitation insert returned no row");
      return { kind: "created", invitation: {
        id: row.id,
        organizationId: row.organization_id,
        email: row.email,
        role: row.role,
        createdBy: row.created_by,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      } };
    });
  }

  public async cancelInvitationAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly invitationId: string;
  }): Promise<InvitationCancellationOutcome> {
    return this.inTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-members:' || $1, 0))`, [input.organizationId]);
      const actor = await client.query<{ role: AuthRole }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
        [input.organizationId, input.actorUserId],
      );
      const actorRole = actor.rows[0]?.role;
      if (actorRole !== "owner" && actorRole !== "admin") return { kind: "forbidden" };
      const target = await client.query<{ role: AuthRole }>(
        `SELECT role
           FROM dashboard_membership_invitations
          WHERE id = $1 AND organization_id = $2
            AND cancelled_at IS NULL AND redeemed_at IS NULL
            AND expires_at > clock_timestamp()
          FOR UPDATE`,
        [input.invitationId, input.organizationId],
      );
      const targetRole = target.rows[0]?.role;
      if (targetRole === undefined) return { kind: "not_found" };
      if (actorRole === "admin" && targetRole === "owner") return { kind: "forbidden" };
      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const now = clock.rows[0]?.database_now;
      if (now === undefined) throw new Error("Database clock returned no invitation cancellation timestamp");
      await client.query(
        `UPDATE dashboard_membership_invitations SET cancelled_at = $3
          WHERE id = $1 AND organization_id = $2 AND cancelled_at IS NULL AND redeemed_at IS NULL`,
        [input.invitationId, input.organizationId, now],
      );
      return { kind: "cancelled" };
    });
  }

  public async redeemInvitationForVerifiedIdentity(input: {
    readonly inviteHash: string;
    readonly provider: string;
    readonly providerUserId: string;
    readonly displayName?: string | undefined;
    readonly verifiedEmails: readonly string[];
    readonly proposedUserId: string;
    readonly proposedMembershipId: string;
    readonly exchangeId: string;
    readonly exchangeHash: string;
    readonly exchangeTtlMillis: number;
  }): Promise<InvitationRedemptionOutcome> {
    if (!Number.isSafeInteger(input.exchangeTtlMillis) || input.exchangeTtlMillis <= 0) {
      throw new Error("Dashboard exchange TTL must be a positive safe integer");
    }
    const provider = input.provider.trim().toLowerCase();
    if (provider.length === 0 || input.providerUserId.trim().length === 0) return { kind: "invalid" };
    const verifiedEmails = new Set(input.verifiedEmails.map(canonicalEmail).filter((value) => value.length > 0));
    return this.inTransaction(async (client) => {
      // Resolve the tenant from the one-way capability digest, then use the same
      // organization fence as role/removal operations before locking the row.
      const located = await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM dashboard_membership_invitations WHERE invite_hash = $1`,
        [input.inviteHash],
      );
      const organizationId = located.rows[0]?.organization_id;
      if (organizationId === undefined) return { kind: "invalid" };
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-members:' || $1, 0))`, [organizationId]);

      const invitation = await client.query<{
        id: string; organization_id: string; email: string; role: AuthRole; expires_at: Date;
        cancelled_at: Date | null; redeemed_at: Date | null; database_now: Date;
      }>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         SELECT i.id, i.organization_id, i.email, i.role, i.expires_at, i.cancelled_at, i.redeemed_at,
                clock.at AS database_now
           FROM dashboard_membership_invitations AS i
           CROSS JOIN database_clock AS clock
          WHERE i.invite_hash = $1
          FOR UPDATE OF i`,
        [input.inviteHash],
      );
      const row = invitation.rows[0];
      if (
        row === undefined || row.organization_id !== organizationId || row.cancelled_at !== null ||
        row.redeemed_at !== null || row.expires_at.getTime() <= row.database_now.getTime()
      ) return { kind: "invalid" };
      const email = canonicalEmail(row.email);
      if (!verifiedEmails.has(email)) return { kind: "email_mismatch" };

      // Users are global across organizations, so tenant fencing alone cannot
      // serialize simultaneous invitations for the same provider identity/email.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('dashboard-user-provider:' || $1 || ':' || $2, 0))`,
        [provider, input.providerUserId],
      );
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('dashboard-user-email:' || $1, 0))`,
        [email],
      );

      const byProvider = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE provider = $1 AND provider_user_id = $2 FOR UPDATE`,
        [provider, input.providerUserId],
      );
      let userId = byProvider.rows[0]?.id;
      if (userId === undefined) {
        // Matching an existing row by email would silently link identities. The
        // invitation proves email ownership, not that two provider identities
        // are the same Acalys user, so collisions fail closed.
        const byEmail = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE lower(primary_email) = $1 FOR UPDATE`,
          [email],
        );
        if (byEmail.rows[0] !== undefined) return { kind: "identity_conflict" };
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO users (id, provider, provider_user_id, primary_email, display_name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6)
           RETURNING id`,
          [input.proposedUserId, provider, input.providerUserId, email, input.displayName ?? null, row.database_now],
        );
        userId = inserted.rows[0]?.id;
        if (userId === undefined) throw new Error("Invited user insert returned no row");
      }

      const existingMembership = await client.query<{ id: string }>(
        `SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
        [organizationId, userId],
      );
      if (existingMembership.rows[0] !== undefined) return { kind: "already_member" };

      const membership = await client.query<{ id: string }>(
        `INSERT INTO memberships (id, organization_id, user_id, role, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)
         RETURNING id`,
        [input.proposedMembershipId, organizationId, userId, row.role, row.database_now],
      );
      const membershipId = membership.rows[0]?.id;
      if (membershipId === undefined) throw new Error("Invited membership insert returned no row");
      await client.query(`UPDATE dashboard_membership_invitations SET redeemed_at = $2 WHERE id = $1`, [row.id, row.database_now]);
      await client.query(
        `INSERT INTO dashboard_login_exchanges
           (id, organization_id, user_id, membership_id, exchange_hash, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz + ($7::double precision * INTERVAL '1 millisecond'))`,
        [input.exchangeId, organizationId, userId, membershipId, input.exchangeHash, row.database_now, input.exchangeTtlMillis],
      );
      return { kind: "redeemed", identity: { organizationId, userId, membershipId } };
    });
  }

  public async removeMemberAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly memberId: string;
  }): Promise<MemberRemovalOutcome> {
    return this.inTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-members:' || $1, 0))`, [input.organizationId]);
      const actor = await client.query<{ role: AuthRole }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
        [input.organizationId, input.actorUserId],
      );
      const actorRole = actor.rows[0]?.role;
      if (actorRole !== "owner" && actorRole !== "admin") return { kind: "forbidden" };
      const target = await client.query<{ role: AuthRole }>(
        `SELECT role FROM memberships WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [input.memberId, input.organizationId],
      );
      const targetRole = target.rows[0]?.role;
      if (targetRole === undefined) return { kind: "not_found" };
      if (actorRole === "admin" && targetRole === "owner") return { kind: "forbidden" };
      if (targetRole === "owner") {
        const owners = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM memberships WHERE organization_id = $1 AND role = 'owner'`,
          [input.organizationId],
        );
        if (Number(owners.rows[0]?.count ?? "0") <= 1) return { kind: "last_owner" };
      }
      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const now = clock.rows[0]?.database_now;
      if (now === undefined) throw new Error("Database clock returned no member-removal timestamp");
      const sessions = await client.query(
        `UPDATE auth_sessions
            SET revoked_at = $2
          WHERE membership_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL`,
        [input.memberId, now],
      );
      const apiKeys = await client.query(
        `UPDATE api_keys
            SET revoked_at = $2
          WHERE membership_id = $1 AND owner_kind = 'user' AND revoked_at IS NULL`,
        [input.memberId, now],
      );
      await client.query(`DELETE FROM memberships WHERE id = $1 AND organization_id = $2`, [input.memberId, input.organizationId]);
      return {
        kind: "removed",
        revokedSessions: sessions.rowCount ?? 0,
        revokedApiKeys: apiKeys.rowCount ?? 0,
      };
    });
  }

  public async listApiKeys(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
  }): Promise<readonly DashboardApiKeyRow[]> {
    const result = await this.pool.query<{
      id: string; name: string; key_prefix: string; role: AuthRole; scopes: unknown;
      owner_kind: "organization" | "user" | "legacy_unbound"; user_id: string | null;
      created_at: Date; expires_at: Date | null; last_used_at: Date | null;
    }>(
      `SELECT id, name, key_prefix, role, scopes, owner_kind, user_id, created_at, expires_at, last_used_at
         FROM api_keys
        WHERE organization_id = $1 AND revoked_at IS NULL AND owner_kind <> 'legacy_unbound'
          AND (
            EXISTS (SELECT 1 FROM memberships AS actor WHERE actor.organization_id = $1 AND actor.user_id = $2 AND actor.role IN ('owner','admin'))
            OR user_id = $2
          )
        ORDER BY created_at DESC, id DESC`,
      [input.organizationId, input.actorUserId],
    );
    return result.rows.flatMap((row) => {
      if (row.owner_kind === "legacy_unbound") return [];
      const scopes = Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === "string") : [];
      return [{ id: row.id, name: row.name, prefix: row.key_prefix, role: row.role, scopes,
        ownerKind: row.owner_kind, userId: row.user_id, createdAt: row.created_at,
        expiresAt: row.expires_at, lastUsedAt: row.last_used_at }];
    });
  }

  public async createApiKeyAuthorized(input: {
    readonly id: string; readonly organizationId: string; readonly actorUserId: string;
    readonly ownerKind: "organization" | "user"; readonly prefix: string; readonly hash: string;
    readonly name: string; readonly role: AuthRole; readonly scopes: readonly string[];
    readonly expiresAt?: Date | undefined;
  }): Promise<"created" | "forbidden" | "invalid_expiry"> {
    return this.inTransaction(async (client) => {
      const actor = await client.query<{ id: string; role: AuthRole }>(
        `SELECT id, role FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
        [input.organizationId, input.actorUserId],
      );
      const membership = actor.rows[0];
      if (membership === undefined) return "forbidden";
      const rank = (role: AuthRole) => ({ read_only: 0, member: 1, admin: 2, owner: 3 } as const)[role];
      if (input.ownerKind === "organization" && membership.role !== "owner" && membership.role !== "admin") return "forbidden";
      // No actor may mint a credential with a role above the live membership
      // that authorized creation. This also future-proofs organization-owned
      // keys if owner/admin capabilities diverge later.
      if (rank(input.role) > rank(membership.role)) return "forbidden";
      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const databaseNow = clock.rows[0]?.database_now;
      if (databaseNow === undefined) throw new Error("Database clock returned no dashboard API-key timestamp");
      if (input.expiresAt !== undefined && input.expiresAt.getTime() <= databaseNow.getTime()) return "invalid_expiry";
      await client.query(
        `INSERT INTO api_keys
           (id, organization_id, user_id, owner_kind, membership_id, key_prefix, key_hash,
            name, role, scopes, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [input.id, input.organizationId, input.ownerKind === "user" ? input.actorUserId : null,
         input.ownerKind, input.ownerKind === "user" ? membership.id : null, input.prefix, input.hash,
         input.name, input.role, JSON.stringify(input.scopes), databaseNow, input.expiresAt ?? null],
      );
      return "created";
    });
  }

  public async revokeApiKeyAuthorized(input: {
    readonly organizationId: string; readonly actorUserId: string; readonly apiKeyId: string;
  }): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const actor = await client.query<{ role: AuthRole }>(
        `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2 FOR SHARE`,
        [input.organizationId, input.actorUserId],
      );
      const actorRole = actor.rows[0]?.role;
      if (actorRole === undefined) return false;
      const key = await client.query<{ user_id: string | null }>(
        `SELECT user_id FROM api_keys WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL FOR UPDATE`,
        [input.apiKeyId, input.organizationId],
      );
      const row = key.rows[0];
      if (row === undefined) return false;
      if (actorRole !== "owner" && actorRole !== "admin" && row.user_id !== input.actorUserId) return false;
      const clock = await client.query<{ database_now: Date }>(`SELECT clock_timestamp() AS database_now`);
      const now = clock.rows[0]?.database_now;
      if (now === undefined) throw new Error("Database clock returned no API-key revocation timestamp");
      await client.query(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1`, [input.apiKeyId, now]);
      return true;
    });
  }

  public async listProviderConnections(organizationId: string): Promise<readonly DashboardProviderConnectionRow[]> {
    const result = await this.pool.query<{
      id: string; provider: string; external_account_id: string; installation_ref: string | null;
      status: "active" | "suspended" | "revoked"; created_at: Date; updated_at: Date;
    }>(
      `SELECT id, provider, external_account_id, installation_ref, status, created_at, updated_at
         FROM provider_connections WHERE organization_id = $1 ORDER BY provider, external_account_id`,
      [organizationId],
    );
    return result.rows.map((row) => ({ id: row.id, provider: row.provider,
      externalAccountId: row.external_account_id, installationRef: row.installation_ref,
      status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  private async inTransaction<T>(work: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* original error wins */ }
      throw error;
    } finally {
      client.release();
    }
  }
}
