import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export interface DashboardNotificationPreferencesRow {
  readonly revision: number;
  readonly reviewComplete: boolean;
  readonly criticalFinding: boolean;
  readonly weeklyDigest: boolean;
  readonly productUpdates: boolean;
  readonly updatedAt: Date | null;
}

export type DashboardNotificationUpdateOutcome =
  | {
      readonly kind: "updated";
      readonly value: DashboardNotificationPreferencesRow;
    }
  | {
      readonly kind: "revision_conflict";
      readonly value: DashboardNotificationPreferencesRow;
    }
  | { readonly kind: "not_found" };

const DEFAULTS: DashboardNotificationPreferencesRow = {
  revision: 0,
  reviewComplete: true,
  criticalFinding: true,
  weeklyDigest: false,
  productUpdates: false,
  updatedAt: null,
};

export class DashboardNotificationStore {
  public constructor(private readonly pool: PgPool) {}

  public async getForUser(
    organizationId: string,
    userId: string,
  ): Promise<DashboardNotificationPreferencesRow | undefined> {
    const result = await this.pool.query<{
      membership_id: string;
      revision: string | null;
      review_complete: boolean | null;
      critical_finding: boolean | null;
      weekly_digest: boolean | null;
      product_updates: boolean | null;
      updated_at: Date | null;
    }>(
      `SELECT m.id AS membership_id, p.revision::text, p.review_complete, p.critical_finding,
              p.weekly_digest, p.product_updates, p.updated_at
         FROM memberships AS m
         LEFT JOIN dashboard_notification_preferences AS p ON p.membership_id=m.id
        WHERE m.organization_id=$1 AND m.user_id=$2`,
      [organizationId, userId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (row.revision === null) return DEFAULTS;
    return {
      revision: Number(row.revision),
      reviewComplete: row.review_complete ?? true,
      criticalFinding: row.critical_finding ?? true,
      weeklyDigest: row.weekly_digest ?? false,
      productUpdates: row.product_updates ?? false,
      updatedAt: row.updated_at,
    };
  }

  public async updateForUser(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly expectedRevision: number;
    readonly reviewComplete: boolean;
    readonly criticalFinding: boolean;
    readonly weeklyDigest: boolean;
    readonly productUpdates: boolean;
  }): Promise<DashboardNotificationUpdateOutcome> {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw new Error("DASHBOARD_NOTIFICATION_REVISION_INVALID");
    return this.#transaction(async (client) => {
      const membership = await client.query<{ id: string }>(
        `SELECT id FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE`,
        [input.organizationId, input.userId],
      );
      const membershipId = membership.rows[0]?.id;
      if (membershipId === undefined) return { kind: "not_found" };
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('dashboard-notifications:' || $1, 0))`,
        [membershipId],
      );
      const current = await client.query<{
        revision: string;
        review_complete: boolean;
        critical_finding: boolean;
        weekly_digest: boolean;
        product_updates: boolean;
        updated_at: Date;
      }>(
        `SELECT revision::text, review_complete, critical_finding, weekly_digest, product_updates, updated_at
           FROM dashboard_notification_preferences WHERE membership_id=$1 FOR UPDATE`,
        [membershipId],
      );
      const row = current.rows[0];
      const currentValue: DashboardNotificationPreferencesRow =
        row === undefined
          ? DEFAULTS
          : {
              revision: Number(row.revision),
              reviewComplete: row.review_complete,
              criticalFinding: row.critical_finding,
              weeklyDigest: row.weekly_digest,
              productUpdates: row.product_updates,
              updatedAt: row.updated_at,
            };
      if (currentValue.revision !== input.expectedRevision)
        return { kind: "revision_conflict", value: currentValue };
      const updated =
        row === undefined
          ? await client.query<{
              revision: string;
              review_complete: boolean;
              critical_finding: boolean;
              weekly_digest: boolean;
              product_updates: boolean;
              updated_at: Date;
            }>(
              `INSERT INTO dashboard_notification_preferences
               (membership_id,revision,review_complete,critical_finding,weekly_digest,product_updates,created_at,updated_at)
             SELECT $1,1,$2,$3,$4,$5,clock.at,clock.at FROM (SELECT clock_timestamp() AS at) AS clock
             RETURNING revision::text,review_complete,critical_finding,weekly_digest,product_updates,updated_at`,
              [
                membershipId,
                input.reviewComplete,
                input.criticalFinding,
                input.weeklyDigest,
                input.productUpdates,
              ],
            )
          : await client.query<{
              revision: string;
              review_complete: boolean;
              critical_finding: boolean;
              weekly_digest: boolean;
              product_updates: boolean;
              updated_at: Date;
            }>(
              `UPDATE dashboard_notification_preferences AS p
                SET revision=p.revision+1, review_complete=$2, critical_finding=$3, weekly_digest=$4, product_updates=$5,
                    updated_at=clock.at
               FROM (SELECT clock_timestamp() AS at) AS clock
              WHERE p.membership_id=$1
              RETURNING p.revision::text,p.review_complete,p.critical_finding,p.weekly_digest,p.product_updates,p.updated_at`,
              [
                membershipId,
                input.reviewComplete,
                input.criticalFinding,
                input.weeklyDigest,
                input.productUpdates,
              ],
            );
      const value = updated.rows[0];
      if (value === undefined)
        throw new Error("Notification preference update returned no row");
      return {
        kind: "updated",
        value: {
          revision: Number(value.revision),
          reviewComplete: value.review_complete,
          criticalFinding: value.critical_finding,
          weeklyDigest: value.weekly_digest,
          productUpdates: value.product_updates,
          updatedAt: value.updated_at,
        },
      };
    });
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
