import { randomUUID } from "node:crypto";

import {
  dashboardAnalyticsResponseSchema,
  type DashboardAnalyticsResponse,
  type DashboardCreateReportBody,
  type DashboardReportDefinition,
  type DashboardReportRun,
} from "@acalys/contracts/dashboard/v1";
import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";
import { DashboardAnalyticsStore, type DashboardAnalyticsSnapshot } from "./dashboard-analytics-store.js";

interface RawReportRow {
  id: string;
  organization_id: string;
  created_by_membership_id: string;
  kind: "recurring" | "ondemand";
  name: string;
  revision: string | number;
  enabled: boolean;
  schedule: unknown | null;
  range_config: unknown;
  parameters: unknown;
  prompt: string;
  group_by: "none" | "repository" | "team" | "author" | "severity";
  destination: unknown;
  created_at: Date;
  updated_at: Date;
  last_generated_at: Date | null;
}

export type DashboardReportCreateOutcome =
  | { readonly kind: "created"; readonly report: DashboardReportDefinition }
  | { readonly kind: "forbidden" }
  | { readonly kind: "limit_reached" };
export type DashboardReportDeleteOutcome =
  | { readonly kind: "deleted" }
  | { readonly kind: "not_found" | "forbidden" | "revision_conflict" };
export type DashboardReportGenerateOutcome =
  | { readonly kind: "generated"; readonly run: DashboardReportRun }
  | { readonly kind: "not_found" | "forbidden" | "revision_conflict" };

const MAX_REPORT_DEFINITIONS = 500;

function isReportAdminRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

function snapshotDto(from: Date, to: Date, snapshot: DashboardAnalyticsSnapshot): DashboardAnalyticsResponse {
  return dashboardAnalyticsResponseSchema.parse({
    range: { from: from.toISOString(), to: to.toISOString(), bucketSeconds: snapshot.bucketSeconds },
    summary: snapshot.summary,
    trends: snapshot.trends.map((item) => ({ ...item, start: item.start.toISOString() })),
    severities: snapshot.severities,
    categories: snapshot.categories,
    checks: snapshot.checks,
    knowledge: snapshot.knowledge,
    repositories: snapshot.repositories.map((item) => ({ ...item, lastReviewAt: item.lastReviewAt?.toISOString() ?? null })),
    authors: snapshot.authors,
    dimensions: snapshot.dimensions,
  });
}

function reportDto(row: RawReportRow): DashboardReportDefinition {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    revision: Number(row.revision),
    enabled: row.enabled,
    schedule: row.schedule as DashboardReportDefinition["schedule"],
    range: row.range_config as DashboardReportDefinition["range"],
    parameters: row.parameters as DashboardReportDefinition["parameters"],
    prompt: row.prompt,
    groupBy: row.group_by,
    destination: row.destination as DashboardReportDefinition["destination"],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastGeneratedAt: row.last_generated_at?.toISOString() ?? null,
    lastDeliveredAt: null,
    automationStatus: row.kind === "recurring" ? "dispatcher_unavailable" : "manual",
    deliveryStatus: "not_delivered",
  };
}

/**
 * Durable report definitions plus manually generated evidence snapshots.
 *
 * Recurring schedule storage deliberately does not imply automation: until a
 * dispatcher/delivery ledger exists, definitions are returned with
 * `dispatcher_unavailable` and generated runs remain `not_delivered`.
 */
export class DashboardReportStore {
  public constructor(
    private readonly pool: PgPool,
    private readonly analytics: DashboardAnalyticsStore,
  ) {}

  public async list(organizationId: string): Promise<readonly DashboardReportDefinition[]> {
    const result = await this.pool.query<RawReportRow>(
      `SELECT r.id,r.organization_id,r.created_by_membership_id,r.kind,r.name,r.revision,r.enabled,
              r.schedule,r.range_config,r.parameters,r.prompt,r.group_by,r.destination,r.created_at,r.updated_at,
              (SELECT max(run.generated_at) FROM dashboard_report_runs AS run
                WHERE run.organization_id=r.organization_id AND run.report_id=r.id) AS last_generated_at
         FROM dashboard_reports AS r
        WHERE r.organization_id=$1
        ORDER BY r.updated_at DESC,r.id
        LIMIT ${MAX_REPORT_DEFINITIONS}`,
      [organizationId],
    );
    return result.rows.map(reportDto);
  }

  public async createAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly definition: DashboardCreateReportBody;
  }): Promise<DashboardReportCreateOutcome> {
    return this.#transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-reports:' || $1, 0))`, [input.organizationId]);
      const actor = await client.query<{ id: string; role: string }>(
        `SELECT id,role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE`,
        [input.organizationId, input.actorUserId],
      );
      const membership = actor.rows[0];
      if (membership === undefined || !isReportAdminRole(membership.role)) return { kind: "forbidden" } as const;
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dashboard_reports WHERE organization_id=$1`,
        [input.organizationId],
      );
      if (Number(count.rows[0]?.count ?? "0") >= MAX_REPORT_DEFINITIONS) return { kind: "limit_reached" } as const;
      const definition = input.definition;
      const inserted = await client.query<RawReportRow>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO dashboard_reports
           (id,organization_id,created_by_membership_id,kind,name,revision,enabled,schedule,range_config,parameters,prompt,group_by,destination,created_at,updated_at)
         SELECT $1,$2,$3,$4,$5,1,TRUE,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,at,at FROM database_clock
         RETURNING id,organization_id,created_by_membership_id,kind,name,revision,enabled,schedule,range_config,parameters,prompt,group_by,destination,created_at,updated_at,NULL::timestamptz AS last_generated_at`,
        [
          randomUUID(), input.organizationId, membership.id, definition.kind, definition.name,
          definition.schedule === null ? null : JSON.stringify(definition.schedule), JSON.stringify(definition.range),
          JSON.stringify(definition.parameters), definition.prompt, definition.groupBy, JSON.stringify(definition.destination),
        ],
      );
      return { kind: "created", report: reportDto(inserted.rows[0]!) } as const;
    });
  }

  public async deleteAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly reportId: string;
    readonly expectedRevision: number;
  }): Promise<DashboardReportDeleteOutcome> {
    return this.#transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-reports:' || $1, 0))`, [input.organizationId]);
      const role = await client.query<{ role: string }>(`SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE`, [input.organizationId,input.actorUserId]);
      if (!isReportAdminRole(role.rows[0]?.role)) return { kind: "forbidden" } as const;
      const row = await client.query<{ revision: string | number }>(`SELECT revision FROM dashboard_reports WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [input.organizationId,input.reportId]);
      if (row.rows[0] === undefined) return { kind: "not_found" } as const;
      if (Number(row.rows[0].revision) !== input.expectedRevision) return { kind: "revision_conflict" } as const;
      await client.query(`DELETE FROM dashboard_reports WHERE organization_id=$1 AND id=$2`, [input.organizationId,input.reportId]);
      return { kind: "deleted" } as const;
    });
  }

  public async generateAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly reportId: string;
    readonly expectedRevision: number;
  }): Promise<DashboardReportGenerateOutcome> {
    const prepared = await this.#transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-reports:' || $1, 0))`, [input.organizationId]);
      const role = await client.query<{ role: string }>(`SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE`, [input.organizationId,input.actorUserId]);
      if (!isReportAdminRole(role.rows[0]?.role)) return { kind: "forbidden" } as const;
      const report = await client.query<RawReportRow>(
        `SELECT r.id,r.organization_id,r.created_by_membership_id,r.kind,r.name,r.revision,r.enabled,r.schedule,r.range_config,r.parameters,r.prompt,r.group_by,r.destination,r.created_at,r.updated_at,
                NULL::timestamptz AS last_generated_at
           FROM dashboard_reports AS r WHERE r.organization_id=$1 AND r.id=$2 FOR SHARE`,
        [input.organizationId,input.reportId],
      );
      const row = report.rows[0];
      if (row === undefined) return { kind: "not_found" } as const;
      if (Number(row.revision) !== input.expectedRevision) return { kind: "revision_conflict" } as const;
      const clock = await client.query<{ at: Date }>(`SELECT clock_timestamp() AS at`);
      const now = clock.rows[0]!.at;
      const range = row.range_config as DashboardReportDefinition["range"];
      const from = range.kind === "relative" ? new Date(now.getTime() - range.days * 24 * 60 * 60_000) : new Date(range.from);
      const to = range.kind === "relative" ? now : new Date(range.to);
      return { kind: "prepared", row, from, to } as const;
    });
    if (prepared.kind !== "prepared") return prepared;

    const parameters = prepared.row.parameters as DashboardReportDefinition["parameters"];
    const snapshot = await this.analytics.snapshot({
      organizationId: input.organizationId,
      from: prepared.from,
      to: prepared.to,
      repositoryIds: parameters.repositoryIds,
      usernames: parameters.usernames,
      teams: parameters.teams,
    });
    const dto = snapshotDto(prepared.from, prepared.to, snapshot);
    return this.#transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('dashboard-reports:' || $1, 0))`, [input.organizationId]);
      // The analytics snapshot can be expensive. Authorization is therefore
      // revalidated in the commit transaction so a demotion/removal that
      // happens while the snapshot is being computed cannot still persist a
      // privileged report run (authorization TOCTOU).
      const actor = await client.query<{ role: string }>(
        `SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE`,
        [input.organizationId,input.actorUserId],
      );
      if (!isReportAdminRole(actor.rows[0]?.role)) return { kind: "forbidden" } as const;
      const current = await client.query<{ revision: string | number }>(`SELECT revision FROM dashboard_reports WHERE organization_id=$1 AND id=$2 FOR SHARE`, [input.organizationId,input.reportId]);
      if (current.rows[0] === undefined) return { kind: "not_found" } as const;
      if (Number(current.rows[0].revision) !== input.expectedRevision) return { kind: "revision_conflict" } as const;
      const inserted = await client.query<{ id: string; generated_at: Date }>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO dashboard_report_runs (id,organization_id,report_id,report_revision,range_from,range_to,snapshot,generated_at)
         SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,at FROM database_clock
         RETURNING id,generated_at`,
        [randomUUID(),input.organizationId,input.reportId,input.expectedRevision,prepared.from,prepared.to,JSON.stringify(dto)],
      );
      return { kind: "generated", run: {
        id: inserted.rows[0]!.id,
        reportId: input.reportId,
        from: prepared.from.toISOString(),
        to: prepared.to.toISOString(),
        generatedAt: inserted.rows[0]!.generated_at.toISOString(),
        snapshot: dto,
        deliveryStatus: "not_delivered",
      } } as const;
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
      try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    } finally { client.release(); }
  }
}
