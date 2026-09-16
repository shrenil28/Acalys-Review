import { createHash, randomUUID } from "node:crypto";

import { canonicalJson } from "@acalys/contracts/domain";
import {
  DASHBOARD_DEFAULT_ORGANIZATION_REVIEW_CONFIG,
  DASHBOARD_REVIEW_CAPABILITIES,
  dashboardEffectiveReviewPolicySchema,
  dashboardOrganizationReviewConfigSchema,
  dashboardRepositoryReviewSettingsSchema,
  type DashboardEffectiveReviewPolicy,
  type DashboardOrganizationReviewConfig,
} from "@acalys/contracts/dashboard/v1";

import type { AuthRole } from "./auth-store.js";
import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export interface OrganizationReviewSettingsRow {
  readonly revision: number;
  readonly config: DashboardOrganizationReviewConfig;
  readonly updatedAt: Date | null;
}

export interface RepositoryReviewSettingsRow {
  readonly repositoryId: string;
  readonly revision: number;
  readonly lifecycle: "enabled" | "paused" | "archived";
  readonly inherit: boolean;
  readonly instructions: string;
  readonly ignorePaths: readonly string[];
  readonly updatedAt: Date | null;
}

export interface EffectiveReviewPolicyEnvelope {
  readonly policy: DashboardEffectiveReviewPolicy;
  readonly fingerprint: string;
}

export type ReviewSettingsMutationOutcome<T> =
  | { readonly kind: "updated"; readonly value: T }
  | { readonly kind: "forbidden" | "not_found" | "revision_conflict" };

interface RawOrganizationSettings {
  revision: string | number;
  config: unknown;
  updated_at: Date;
}
interface RawRepositorySettings {
  repository_id: string;
  revision: string | number;
  lifecycle: "enabled" | "paused" | "archived";
  inherit: boolean;
  instructions: string;
  ignore_paths: unknown;
  updated_at: Date;
}

function parseIgnorePaths(value: unknown): readonly string[] {
  return dashboardRepositoryReviewSettingsSchema.shape.ignorePaths.parse(value);
}
function organizationRow(
  row: RawOrganizationSettings | undefined,
): OrganizationReviewSettingsRow {
  if (row === undefined)
    return {
      revision: 0,
      config: DASHBOARD_DEFAULT_ORGANIZATION_REVIEW_CONFIG,
      updatedAt: null,
    };
  return {
    revision: Number(row.revision),
    config: dashboardOrganizationReviewConfigSchema.parse(row.config),
    updatedAt: row.updated_at,
  };
}
function repositoryRow(
  repositoryId: string,
  row: RawRepositorySettings | undefined,
): RepositoryReviewSettingsRow {
  if (row === undefined) {
    return {
      repositoryId,
      revision: 0,
      lifecycle: "enabled",
      inherit: true,
      instructions: "",
      ignorePaths: [],
      updatedAt: null,
    };
  }
  return {
    repositoryId: row.repository_id,
    revision: Number(row.revision),
    lifecycle: row.lifecycle,
    inherit: row.inherit,
    instructions: row.instructions,
    ignorePaths: parseIgnorePaths(row.ignore_paths),
    updatedAt: row.updated_at,
  };
}
function policyFingerprint(policy: DashboardEffectiveReviewPolicy): string {
  return createHash("sha256")
    .update(canonicalJson(policy), "utf8")
    .digest("hex");
}

export class DashboardSettingsStore {
  public constructor(private readonly pool: PgPool) {}

  public async getOrganizationSettings(
    organizationId: string,
  ): Promise<OrganizationReviewSettingsRow> {
    const result = await this.pool.query<RawOrganizationSettings>(
      `SELECT revision, config, updated_at
         FROM dashboard_organization_review_settings
        WHERE organization_id = $1`,
      [organizationId],
    );
    return organizationRow(result.rows[0]);
  }

  public async getRepositorySettings(
    organizationId: string,
    repositoryId: string,
  ): Promise<RepositoryReviewSettingsRow | undefined> {
    const visible = await this.pool.query<{ id: string }>(
      `SELECT id FROM repositories WHERE organization_id = $1 AND id = $2`,
      [organizationId, repositoryId],
    );
    if (visible.rows[0] === undefined) return undefined;
    const result = await this.pool.query<RawRepositorySettings>(
      `SELECT repository_id, revision, lifecycle, inherit, instructions, ignore_paths, updated_at
         FROM dashboard_repository_review_settings
        WHERE organization_id = $1 AND repository_id = $2`,
      [organizationId, repositoryId],
    );
    return repositoryRow(repositoryId, result.rows[0]);
  }

  public async updateOrganizationSettingsAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly expectedRevision: number;
    readonly config: DashboardOrganizationReviewConfig;
  }): Promise<ReviewSettingsMutationOutcome<OrganizationReviewSettingsRow>> {
    const validated = dashboardOrganizationReviewConfigSchema.parse(
      input.config,
    );
    return this.#transaction(async (client) => {
      await this.#lockMutationDomain(client, input.organizationId);
      if (
        !(await this.#canAdmin(client, input.organizationId, input.actorUserId))
      )
        return { kind: "forbidden" };
      const currentResult = await client.query<RawOrganizationSettings>(
        `SELECT revision, config, updated_at FROM dashboard_organization_review_settings
          WHERE organization_id = $1 FOR UPDATE`,
        [input.organizationId],
      );
      const current = organizationRow(currentResult.rows[0]);
      if (current.revision !== input.expectedRevision)
        return { kind: "revision_conflict" };
      const nextRevision = current.revision + 1;
      const result = await client.query<RawOrganizationSettings>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO dashboard_organization_review_settings
           (organization_id, revision, config, updated_by, created_at, updated_at)
         SELECT $1,$2,$3::jsonb,$4,at,at FROM database_clock
         ON CONFLICT (organization_id) DO UPDATE
           SET revision = EXCLUDED.revision, config = EXCLUDED.config, updated_by = EXCLUDED.updated_by,
               updated_at = EXCLUDED.updated_at
         RETURNING revision, config, updated_at`,
        [
          input.organizationId,
          nextRevision,
          JSON.stringify(validated),
          input.actorUserId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error("Organization review settings update returned no row");
      await this.#audit(
        client,
        input.organizationId,
        null,
        input.actorUserId,
        nextRevision,
        "organization_update",
        validated,
      );
      return { kind: "updated", value: organizationRow(row) };
    });
  }

  public async updateRepositorySettingsAuthorized(input: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly actorUserId: string;
    readonly expectedRevision: number;
    readonly inherit: boolean;
    readonly instructions: string;
    readonly ignorePaths: readonly string[];
  }): Promise<ReviewSettingsMutationOutcome<RepositoryReviewSettingsRow>> {
    const parsed = dashboardRepositoryReviewSettingsSchema
      .pick({ inherit: true, instructions: true, ignorePaths: true })
      .parse({
        inherit: input.inherit,
        instructions: input.instructions,
        ignorePaths: input.ignorePaths,
      });
    return this.#mutateRepository(
      input.organizationId,
      input.repositoryId,
      input.actorUserId,
      input.expectedRevision,
      async (client, current, now) => {
        const nextRevision = current.revision + 1;
        const result = await client.query<RawRepositorySettings>(
          `INSERT INTO dashboard_repository_review_settings
           (repository_id, organization_id, revision, lifecycle, inherit, instructions, ignore_paths, updated_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9)
         ON CONFLICT (repository_id) DO UPDATE
           SET revision=EXCLUDED.revision, lifecycle=EXCLUDED.lifecycle, inherit=EXCLUDED.inherit,
               instructions=EXCLUDED.instructions, ignore_paths=EXCLUDED.ignore_paths,
               updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at
         RETURNING repository_id, revision, lifecycle, inherit, instructions, ignore_paths, updated_at`,
          [
            input.repositoryId,
            input.organizationId,
            nextRevision,
            current.lifecycle,
            parsed.inherit,
            parsed.instructions,
            JSON.stringify(parsed.ignorePaths),
            input.actorUserId,
            now,
          ],
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new Error("Repository review settings update returned no row");
        const value = repositoryRow(input.repositoryId, row);
        await this.#audit(
          client,
          input.organizationId,
          input.repositoryId,
          input.actorUserId,
          nextRevision,
          "repository_update",
          value,
        );
        return { kind: "updated", value } as const;
      },
    );
  }

  public async updateRepositoryLifecycleAuthorized(input: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly actorUserId: string;
    readonly expectedRevision: number;
    readonly lifecycle: "enabled" | "paused" | "archived";
  }): Promise<ReviewSettingsMutationOutcome<RepositoryReviewSettingsRow>> {
    return this.#mutateRepository(
      input.organizationId,
      input.repositoryId,
      input.actorUserId,
      input.expectedRevision,
      async (client, current, now) => {
        const nextRevision = current.revision + 1;
        const result = await client.query<RawRepositorySettings>(
          `INSERT INTO dashboard_repository_review_settings
           (repository_id, organization_id, revision, lifecycle, inherit, instructions, ignore_paths, updated_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9)
         ON CONFLICT (repository_id) DO UPDATE
           SET revision=EXCLUDED.revision, lifecycle=EXCLUDED.lifecycle,
               updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at
         RETURNING repository_id, revision, lifecycle, inherit, instructions, ignore_paths, updated_at`,
          [
            input.repositoryId,
            input.organizationId,
            nextRevision,
            input.lifecycle,
            current.inherit,
            current.instructions,
            JSON.stringify(current.ignorePaths),
            input.actorUserId,
            now,
          ],
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new Error("Repository lifecycle update returned no row");
        const value = repositoryRow(input.repositoryId, row);
        await this.#audit(
          client,
          input.organizationId,
          input.repositoryId,
          input.actorUserId,
          nextRevision,
          "repository_lifecycle",
          value,
        );
        return { kind: "updated", value } as const;
      },
    );
  }

  public async resolveEffectivePolicy(
    organizationId: string,
    repositoryId: string,
  ): Promise<EffectiveReviewPolicyEnvelope | undefined> {
    return this.#transaction(async (client) => {
      await this.#lockSettings(client, organizationId);
      return this.resolveEffectivePolicyWithClient(
        client,
        organizationId,
        repositoryId,
      );
    });
  }

  public async resolveEffectivePolicyWithClient(
    client: PgClient,
    organizationId: string,
    repositoryId: string,
  ): Promise<EffectiveReviewPolicyEnvelope | undefined> {
    const repository = await client.query<{ id: string }>(
      `SELECT id FROM repositories WHERE organization_id=$1 AND id=$2`,
      [organizationId, repositoryId],
    );
    if (repository.rows[0] === undefined) return undefined;
    // A single node-postgres client is a single transaction stream. Keep these
    // reads explicitly ordered rather than relying on Promise.all queueing; it
    // also makes the snapshot boundary obvious to future transaction callers.
    const organizationResult = await client.query<RawOrganizationSettings>(
      `SELECT revision, config, updated_at FROM dashboard_organization_review_settings WHERE organization_id=$1`,
      [organizationId],
    );
    const repositoryResult = await client.query<RawRepositorySettings>(
      `SELECT repository_id, revision, lifecycle, inherit, instructions, ignore_paths, updated_at
         FROM dashboard_repository_review_settings WHERE organization_id=$1 AND repository_id=$2`,
      [organizationId, repositoryId],
    );
    const organization = organizationRow(organizationResult.rows[0]);
    const repositorySettings = repositoryRow(
      repositoryId,
      repositoryResult.rows[0],
    );
    const policy = dashboardEffectiveReviewPolicySchema.parse({
      schemaVersion: 1,
      organizationRevision: organization.revision,
      repositoryRevision: repositorySettings.revision,
      repositoryLifecycle: repositorySettings.lifecycle,
      organizationConfig: organization.config,
      repository: {
        inherit: repositorySettings.inherit,
        instructions: repositorySettings.instructions,
        ignorePaths: repositorySettings.ignorePaths,
      },
    });
    return { policy, fingerprint: policyFingerprint(policy) };
  }

  public static capabilities() {
    return DASHBOARD_REVIEW_CAPABILITIES;
  }

  async #mutateRepository<T>(
    organizationId: string,
    repositoryId: string,
    actorUserId: string,
    expectedRevision: number,
    work: (
      client: PgClient,
      current: RepositoryReviewSettingsRow,
      now: Date,
    ) => Promise<ReviewSettingsMutationOutcome<T>>,
  ): Promise<ReviewSettingsMutationOutcome<T>> {
    return this.#transaction(async (client) => {
      await this.#lockMutationDomain(client, organizationId);
      if (!(await this.#canAdmin(client, organizationId, actorUserId)))
        return { kind: "forbidden" };
      const visible = await client.query<{ id: string }>(
        `SELECT id FROM repositories WHERE organization_id=$1 AND id=$2 FOR SHARE`,
        [organizationId, repositoryId],
      );
      if (visible.rows[0] === undefined) return { kind: "not_found" };
      const currentResult = await client.query<RawRepositorySettings>(
        `SELECT repository_id, revision, lifecycle, inherit, instructions, ignore_paths, updated_at
           FROM dashboard_repository_review_settings
          WHERE organization_id=$1 AND repository_id=$2 FOR UPDATE`,
        [organizationId, repositoryId],
      );
      const current = repositoryRow(repositoryId, currentResult.rows[0]);
      if (current.revision !== expectedRevision)
        return { kind: "revision_conflict" };
      const time = await client.query<{ at: Date }>(
        `SELECT clock_timestamp() AS at`,
      );
      const now = time.rows[0]?.at;
      if (!(now instanceof Date))
        throw new Error("Postgres did not return settings mutation time");
      return work(client, current, now);
    });
  }

  async #canAdmin(
    client: PgClient,
    organizationId: string,
    actorUserId: string,
  ): Promise<boolean> {
    const result = await client.query<{ role: AuthRole }>(
      `SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE`,
      [organizationId, actorUserId],
    );
    const role = result.rows[0]?.role;
    return role === "owner" || role === "admin";
  }
  async #lockMutationDomain(
    client: PgClient,
    organizationId: string,
  ): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('dashboard-members:' || $1, 0))`,
      [organizationId],
    );
    await this.#lockSettings(client, organizationId);
  }
  async #lockSettings(client: PgClient, organizationId: string): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('dashboard-settings:' || $1, 0))`,
      [organizationId],
    );
  }
  async #audit(
    client: PgClient,
    organizationId: string,
    repositoryId: string | null,
    actorUserId: string,
    revision: number,
    action:
      "organization_update" | "repository_update" | "repository_lifecycle",
    snapshot: unknown,
  ): Promise<void> {
    await client.query(
      `INSERT INTO dashboard_review_settings_audit
        (id, organization_id, repository_id, actor_user_id, revision, action, snapshot, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,clock_timestamp())`,
      [
        randomUUID(),
        organizationId,
        repositoryId,
        actorUserId,
        revision,
        action,
        JSON.stringify(snapshot),
      ],
    );
  }
  async #transaction<T>(work: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
