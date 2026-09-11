import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

import type { AuthRole } from "./auth-store.js";
import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export type DashboardIntegrationKey = "linear" | "circleci" | "mcp" | "jira";
export type DashboardIntegrationStatus = "connected" | "disconnected" | "error";

export interface DashboardIntegrationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly key: DashboardIntegrationKey;
  readonly status: DashboardIntegrationStatus;
  readonly revision: number;
  readonly credentialVersion: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly hasCredential: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredIntegrationCredential<TCredential extends object> {
  readonly integration: DashboardIntegrationRow;
  readonly credential: TCredential;
}

export interface LinearOAuthAttempt {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly verifier: string;
}

export type IntegrationMutationOutcome =
  | { readonly kind: "updated"; readonly integration: DashboardIntegrationRow }
  | { readonly kind: "forbidden" | "not_found" | "revision_conflict" };

export type CredentialRotationOutcome =
  | { readonly kind: "updated"; readonly integration: DashboardIntegrationRow }
  | { readonly kind: "stale_generation" | "not_found" };

export type JiraChallengeCreationOutcome =
  | { readonly kind: "created"; readonly expiresAt: Date }
  | { readonly kind: "forbidden" | "revision_conflict" };

export type JiraChallengeRedemptionOutcome =
  | { readonly kind: "updated"; readonly integration: DashboardIntegrationRow }
  | { readonly kind: "invalid_challenge" | "forbidden" | "revision_conflict" };

export interface IntegrationCredentialKeyring {
  readonly activeGeneration: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

interface CredentialEnvelope {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly keyGeneration: number;
}

/**
 * Authenticated credential envelope.
 *
 * AES-GCM's auth tag is appended to the ciphertext so persistence has one
 * opaque byte string. AAD binds the envelope to organization, integration key,
 * and credential generation: copying ciphertext between rows or generations is
 * therefore an authentication failure, not a credential substitution.
 */
export class IntegrationCredentialCipher {
  readonly #activeGeneration: number;
  readonly #keys: ReadonlyMap<number, Buffer>;

  public constructor(keyring: IntegrationCredentialKeyring) {
    this.#activeGeneration = keyring.activeGeneration;
    this.#keys = keyring.keys;
    for (const [generation, key] of keyring.keys) {
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("Integration credential key generation must be a positive integer");
      }
      if (key.byteLength !== 32) {
        throw new Error(`Integration credential key generation ${String(generation)} must be 32 bytes`);
      }
    }
    if (!this.#keys.has(this.#activeGeneration)) {
      throw new Error("Active integration credential key generation is unavailable");
    }
  }

  public encrypt(input: {
    readonly organizationId: string;
    readonly integrationKey: DashboardIntegrationKey;
    readonly credentialVersion: number;
    readonly credential: object;
  }): CredentialEnvelope {
    const key = this.#keys.get(this.#activeGeneration);
    if (key === undefined) throw new Error("Active integration credential key is unavailable");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(this.#aad(input.organizationId, input.integrationKey, input.credentialVersion));
    const body = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(input.credential), "utf8")),
      cipher.final(),
    ]);
    return {
      ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
      nonce,
      keyGeneration: this.#activeGeneration,
    };
  }

  public decrypt<TCredential extends object>(input: {
    readonly organizationId: string;
    readonly integrationKey: DashboardIntegrationKey;
    readonly credentialVersion: number;
    readonly ciphertext: Buffer;
    readonly nonce: Buffer;
    readonly keyGeneration: number;
  }): TCredential {
    const key = this.#keys.get(input.keyGeneration);
    if (key === undefined) {
      throw new IntegrationCredentialUnavailable(`Unknown key generation ${String(input.keyGeneration)}`);
    }
    if (input.ciphertext.byteLength < 17) {
      throw new IntegrationCredentialUnavailable("Credential envelope is truncated");
    }
    try {
      const body = input.ciphertext.subarray(0, -16);
      const tag = input.ciphertext.subarray(-16);
      const decipher = createDecipheriv("aes-256-gcm", key, input.nonce);
      decipher.setAAD(this.#aad(input.organizationId, input.integrationKey, input.credentialVersion));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      const parsed = JSON.parse(plaintext) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("credential payload is not an object");
      }
      return parsed as TCredential;
    } catch (error) {
      if (error instanceof IntegrationCredentialUnavailable) throw error;
      throw new IntegrationCredentialUnavailable("Credential envelope authentication failed");
    }
  }

  public encryptLinearOAuthVerifier(input: {
    readonly organizationId: string;
    readonly stateHash: string;
    readonly verifier: string;
  }): CredentialEnvelope {
    const key = this.#keys.get(this.#activeGeneration);
    if (key === undefined) throw new Error("Active integration credential key is unavailable");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`acalys.linear-oauth.v1\u0000${input.organizationId}\u0000${input.stateHash}`, "utf8"));
    const body = Buffer.concat([cipher.update(input.verifier, "utf8"), cipher.final()]);
    return {
      ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
      nonce,
      keyGeneration: this.#activeGeneration,
    };
  }

  public decryptLinearOAuthVerifier(input: {
    readonly organizationId: string;
    readonly stateHash: string;
    readonly ciphertext: Buffer;
    readonly nonce: Buffer;
    readonly keyGeneration: number;
  }): string {
    const key = this.#keys.get(input.keyGeneration);
    if (key === undefined) throw new IntegrationCredentialUnavailable(`Unknown key generation ${String(input.keyGeneration)}`);
    if (input.ciphertext.byteLength < 17) throw new IntegrationCredentialUnavailable("OAuth verifier envelope is truncated");
    try {
      const body = input.ciphertext.subarray(0, -16);
      const tag = input.ciphertext.subarray(-16);
      const decipher = createDecipheriv("aes-256-gcm", key, input.nonce);
      decipher.setAAD(Buffer.from(`acalys.linear-oauth.v1\u0000${input.organizationId}\u0000${input.stateHash}`, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new IntegrationCredentialUnavailable("OAuth verifier envelope authentication failed");
    }
  }

  #aad(organizationId: string, integrationKey: DashboardIntegrationKey, credentialVersion: number): Buffer {
    return Buffer.from(
      `acalys.integration.v1\u0000${organizationId}\u0000${integrationKey}\u0000${String(credentialVersion)}`,
      "utf8",
    );
  }
}

export class IntegrationCredentialUnavailable extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IntegrationCredentialUnavailable";
  }
}

interface RawIntegrationRow {
  id: string;
  organization_id: string;
  integration_key: string;
  status: DashboardIntegrationStatus;
  revision: string | number;
  credential_version: string | number;
  config: unknown;
  has_credential: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RawCredentialRow extends RawIntegrationRow {
  credential_ciphertext: Buffer | null;
  credential_nonce: Buffer | null;
  credential_key_generation: number | null;
}

function isIntegrationKey(value: string): value is DashboardIntegrationKey {
  return value === "linear" || value === "circleci" || value === "mcp" || value === "jira";
}

function objectConfig(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Readonly<Record<string, unknown>>;
}

function toIntegration(row: RawIntegrationRow): DashboardIntegrationRow {
  if (!isIntegrationKey(row.integration_key)) {
    throw new Error(`Unsupported dashboard integration key ${row.integration_key}`);
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    key: row.integration_key,
    status: row.status,
    revision: Number(row.revision),
    credentialVersion: Number(row.credential_version),
    config: objectConfig(row.config),
    hasCredential: row.has_credential,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DashboardIntegrationStore {
  public constructor(
    private readonly pool: PgPool,
    private readonly cipher: IntegrationCredentialCipher,
  ) {}

  /** Metadata-only read. Ciphertext is deliberately absent from the SELECT. */
  public async getIntegration(
    organizationId: string,
    key: DashboardIntegrationKey,
  ): Promise<DashboardIntegrationRow | undefined> {
    const result = await this.pool.query<RawIntegrationRow>(
      `SELECT id, organization_id, integration_key, status, revision, credential_version, config,
              (credential_ciphertext IS NOT NULL) AS has_credential, created_at, updated_at
         FROM dashboard_integrations
        WHERE organization_id = $1 AND integration_key = $2`,
      [organizationId, key],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toIntegration(row);
  }

  public async listIntegrations(organizationId: string): Promise<readonly DashboardIntegrationRow[]> {
    const result = await this.pool.query<RawIntegrationRow>(
      `SELECT id, organization_id, integration_key, status, revision, credential_version, config,
              (credential_ciphertext IS NOT NULL) AS has_credential, created_at, updated_at
         FROM dashboard_integrations
        WHERE organization_id = $1
        ORDER BY integration_key`,
      [organizationId],
    );
    return result.rows.map(toIntegration);
  }

  public async readCredential<TCredential extends object>(
    organizationId: string,
    key: DashboardIntegrationKey,
  ): Promise<StoredIntegrationCredential<TCredential> | undefined> {
    const result = await this.pool.query<RawCredentialRow>(
      `SELECT id, organization_id, integration_key, status, revision, credential_version, config,
              (credential_ciphertext IS NOT NULL) AS has_credential, created_at, updated_at,
              credential_ciphertext, credential_nonce, credential_key_generation
         FROM dashboard_integrations
        WHERE organization_id = $1 AND integration_key = $2`,
      [organizationId, key],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      row.status !== "connected" ||
      row.credential_ciphertext === null ||
      row.credential_nonce === null ||
      row.credential_key_generation === null
    ) return undefined;
    const integration = toIntegration(row);
    return {
      integration,
      credential: this.cipher.decrypt<TCredential>({
        organizationId,
        integrationKey: key,
        credentialVersion: integration.credentialVersion,
        ciphertext: row.credential_ciphertext,
        nonce: row.credential_nonce,
        keyGeneration: row.credential_key_generation,
      }),
    };
  }

  /** Owner/admin connect or replace. Both revision and credential generation advance. */
  public async connectAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly key: DashboardIntegrationKey;
    readonly expectedRevision?: number | undefined;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential?: object | undefined;
  }): Promise<IntegrationMutationOutcome> {
    return this.#inTransaction(async (client) => {
      await this.#lockOrganization(client, input.organizationId);
      if (!(await this.#canAdmin(client, input.organizationId, input.actorUserId))) return { kind: "forbidden" };

      const current = await this.#selectForUpdate(client, input.organizationId, input.key);
      if (current !== undefined && input.expectedRevision !== undefined && Number(current.revision) !== input.expectedRevision) {
        return { kind: "revision_conflict" };
      }
      if (current === undefined && input.expectedRevision !== undefined && input.expectedRevision !== 0) {
        return { kind: "revision_conflict" };
      }

      const nextRevision = current === undefined ? 1 : Number(current.revision) + 1;
      const nextCredentialVersion = current === undefined ? 1 : Number(current.credential_version) + 1;
      const envelope = input.credential === undefined
        ? undefined
        : this.cipher.encrypt({
            organizationId: input.organizationId,
            integrationKey: input.key,
            credentialVersion: nextCredentialVersion,
            credential: input.credential,
          });
      const id = current?.id ?? randomUUID();
      const result = await client.query<RawIntegrationRow>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO dashboard_integrations
           (id, organization_id, integration_key, status, revision, credential_version, config,
            credential_ciphertext, credential_nonce, credential_key_generation, created_at, updated_at)
         SELECT $1,$2,$3,'connected',$4,$5,$6::jsonb,$7,$8,$9,at,at FROM database_clock
         ON CONFLICT (organization_id, integration_key) DO UPDATE
            SET status = 'connected', revision = EXCLUDED.revision,
                credential_version = EXCLUDED.credential_version, config = EXCLUDED.config,
                credential_ciphertext = EXCLUDED.credential_ciphertext,
                credential_nonce = EXCLUDED.credential_nonce,
                credential_key_generation = EXCLUDED.credential_key_generation,
                updated_at = EXCLUDED.updated_at
         RETURNING id, organization_id, integration_key, status, revision, credential_version, config,
                   (credential_ciphertext IS NOT NULL) AS has_credential, created_at, updated_at`,
        [id, input.organizationId, input.key, nextRevision, nextCredentialVersion, JSON.stringify(input.config),
         envelope?.ciphertext ?? null, envelope?.nonce ?? null, envelope?.keyGeneration ?? null],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Integration connect returned no row");
      await this.#audit(client, row, input.actorUserId, "connect");
      return { kind: "updated", integration: toIntegration(row) };
    });
  }

  /** Settings-only mutation. Credential generation deliberately does not change. */
  public async updateConfigAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly key: DashboardIntegrationKey;
    readonly expectedRevision: number;
    readonly config: Readonly<Record<string, unknown>>;
  }): Promise<IntegrationMutationOutcome> {
    return this.#inTransaction(async (client) => {
      await this.#lockOrganization(client, input.organizationId);
      if (!(await this.#canAdmin(client, input.organizationId, input.actorUserId))) return { kind: "forbidden" };
      const current = await this.#selectForUpdate(client, input.organizationId, input.key);
      if (current === undefined) return { kind: "not_found" };
      if (Number(current.revision) !== input.expectedRevision) return { kind: "revision_conflict" };
      const result = await client.query<RawIntegrationRow>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         UPDATE dashboard_integrations
            SET config = $4::jsonb, revision = revision + 1, updated_at = database_clock.at
           FROM database_clock
          WHERE organization_id = $1 AND integration_key = $2 AND id = $3
         RETURNING id, organization_id, integration_key, status, revision, credential_version, config,
                   (credential_ciphertext IS NOT NULL) AS has_credential, created_at, updated_at`,
        [input.organizationId, input.key, current.id, JSON.stringify(input.config)],
      );
      const row = result.rows[0];
      if (row === undefined) return { kind: "not_found" };
      await this.#audit(client, row, input.actorUserId, "settings_update");
      return { kind: "updated", integration: toIntegration(row) };
    });
  }

  /**
   * Runtime-only CAS used by OAuth refresh. No actor/RBAC is involved because
   * authorization was represented by the credential generation that was read.
   */
  public async rotateCredentialIfCurrent(input: {
    readonly organizationId: string;
    readonly key: DashboardIntegrationKey;
    readonly expectedCredentialVersion: number;
    readonly credential: object;
  }): Promise<CredentialRotationOutcome> {
    return this.#inTransaction(async (client) => {
      await this.#lockIntegration(client, input.organizationId);
      const current = await this.#selectForUpdate(client, input.organizationId, input.key);
      if (current === undefined) return { kind: "not_found" };
      if (
        current.status !== "connected" ||
        Number(current.credential_version) !== input.expectedCredentialVersion ||
        current.credential_ciphertext === null
      ) return { kind: "stale_generation" };

      const nextCredentialVersion = input.expectedCredentialVersion + 1;
      const envelope = this.cipher.encrypt({
        organizationId: input.organizationId,
        integrationKey: input.key,
        credentialVersion: nextCredentialVersion,
        credential: input.credential,
      });
      const result = await client.query<RawIntegrationRow>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         UPDATE dashboard_integrations
            SET credential_version = $4,
                credential_ciphertext = $5, credential_nonce = $6, credential_key_generation = $7,
                updated_at = database_clock.at
           FROM database_clock
          WHERE organization_id = $1 AND integration_key = $2 AND id = $3
            AND status = 'connected' AND credential_version = $8 AND credential_ciphertext IS NOT NULL
         RETURNING id, organization_id, integration_key, status, revision, credential_version, config,
                   (credential_ciphertext IS NOT NULL) AS has_credential, created_at, updated_at`,
        [input.organizationId, input.key, current.id, nextCredentialVersion,
         envelope.ciphertext, envelope.nonce, envelope.keyGeneration, input.expectedCredentialVersion],
      );
      const row = result.rows[0];
      if (row === undefined) return { kind: "stale_generation" };
      await this.#audit(client, row, null, "credential_rotate");
      return { kind: "updated", integration: toIntegration(row) };
    });
  }

  /** Disconnect destroys ciphertext and advances generation before returning. */
  public async disconnectAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly key: DashboardIntegrationKey;
    readonly expectedRevision: number;
    readonly config?: Readonly<Record<string, unknown>> | undefined;
  }): Promise<IntegrationMutationOutcome> {
    return this.#inTransaction(async (client) => {
      await this.#lockOrganization(client, input.organizationId);
      if (!(await this.#canAdmin(client, input.organizationId, input.actorUserId))) return { kind: "forbidden" };
      const current = await this.#selectForUpdate(client, input.organizationId, input.key);
      if (current === undefined) return { kind: "not_found" };
      if (Number(current.revision) !== input.expectedRevision) return { kind: "revision_conflict" };
      const result = await client.query<RawIntegrationRow>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         UPDATE dashboard_integrations
            SET status = 'disconnected', revision = revision + 1,
                credential_version = credential_version + 1,
                config = COALESCE($4::jsonb, config),
                credential_ciphertext = NULL, credential_nonce = NULL, credential_key_generation = NULL,
                updated_at = database_clock.at
           FROM database_clock
          WHERE organization_id = $1 AND integration_key = $2 AND id = $3
         RETURNING id, organization_id, integration_key, status, revision, credential_version, config,
                   (credential_ciphertext IS NOT NULL) AS has_credential, created_at, updated_at`,
        [input.organizationId, input.key, current.id, input.config === undefined ? null : JSON.stringify(input.config)],
      );
      const row = result.rows[0];
      if (row === undefined) return { kind: "not_found" };
      await this.#audit(client, row, input.actorUserId, "disconnect");
      return { kind: "updated", integration: toIntegration(row) };
    });
  }

  /** Creates one show-once Jira installation capability; only its digest is persisted. */
  public async createJiraInstallationChallengeAuthorized(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly expectedRevision: number;
    readonly secret: string;
    readonly ttlMillis: number;
  }): Promise<JiraChallengeCreationOutcome> {
    if (!Number.isSafeInteger(input.ttlMillis) || input.ttlMillis < 60_000 || input.ttlMillis > 30 * 60_000) {
      throw new Error("Jira installation challenge TTL must be between one and thirty minutes");
    }
    const secretHash = createHash("sha256").update(input.secret, "utf8").digest("hex");
    return this.#inTransaction(async (client) => {
      await this.#lockOrganization(client, input.organizationId);
      if (!(await this.#canAdmin(client, input.organizationId, input.actorUserId))) return { kind: "forbidden" };
      const current = await this.#selectForUpdate(client, input.organizationId, "jira");
      const revision = current === undefined ? 0 : Number(current.revision);
      if (revision !== input.expectedRevision) return { kind: "revision_conflict" };

      // A new challenge supersedes every older unconsumed challenge for this
      // organization. Marking rather than deleting preserves forensic history.
      await client.query(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         UPDATE dashboard_jira_install_challenges
            SET consumed_at = database_clock.at
           FROM database_clock
          WHERE organization_id = $1 AND consumed_at IS NULL`,
        [input.organizationId],
      );
      const result = await client.query<{ expires_at: Date }>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO dashboard_jira_install_challenges
           (id, organization_id, actor_user_id, secret_hash, expected_revision, created_at, expires_at)
         SELECT $1,$2,$3,$4,$5,at,at + ($6::bigint * interval '1 millisecond')
           FROM database_clock
         RETURNING expires_at`,
        [randomUUID(), input.organizationId, input.actorUserId, secretHash, input.expectedRevision, input.ttlMillis],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Jira challenge insert returned no row");
      return { kind: "created", expiresAt: row.expires_at };
    });
  }

  /**
   * Redeems Jira's capability and installs the credential in one transaction.
   * Consumption, revision check, live RBAC check and credential replacement are
   * atomic, so a stale or demoted installation cannot partially succeed.
   */
  public async redeemJiraInstallationChallenge(input: {
    readonly secret: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: object;
  }): Promise<JiraChallengeRedemptionOutcome> {
    const secretHash = createHash("sha256").update(input.secret, "utf8").digest("hex");
    return this.#inTransaction(async (client) => {
      const candidate = await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM dashboard_jira_install_challenges WHERE secret_hash = $1`,
        [secretHash],
      );
      const organizationId = candidate.rows[0]?.organization_id;
      if (organizationId === undefined) return { kind: "invalid_challenge" };
      await this.#lockOrganization(client, organizationId);
      const challenge = await client.query<{ id: string; actor_user_id: string; expected_revision: string | number }>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         SELECT c.id, c.actor_user_id, c.expected_revision
           FROM dashboard_jira_install_challenges c, database_clock
          WHERE c.organization_id = $1 AND c.secret_hash = $2
            AND c.consumed_at IS NULL AND c.expires_at > database_clock.at
          FOR UPDATE OF c`,
        [organizationId, secretHash],
      );
      const pending = challenge.rows[0];
      if (pending === undefined) return { kind: "invalid_challenge" };
      if (!(await this.#canAdmin(client, organizationId, pending.actor_user_id))) return { kind: "forbidden" };

      const current = await this.#selectForUpdate(client, organizationId, "jira");
      const revision = current === undefined ? 0 : Number(current.revision);
      if (revision !== Number(pending.expected_revision)) return { kind: "revision_conflict" };

      const nextRevision = current === undefined ? 1 : Number(current.revision) + 1;
      const nextCredentialVersion = current === undefined ? 1 : Number(current.credential_version) + 1;
      const envelope = this.cipher.encrypt({
        organizationId,
        integrationKey: "jira",
        credentialVersion: nextCredentialVersion,
        credential: input.credential,
      });
      const id = current?.id ?? randomUUID();
      const result = await client.query<RawIntegrationRow>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at), consumed AS (
           UPDATE dashboard_jira_install_challenges
              SET consumed_at = database_clock.at
             FROM database_clock
            WHERE id = $9 AND consumed_at IS NULL
            RETURNING id
         )
         INSERT INTO dashboard_integrations
           (id, organization_id, integration_key, status, revision, credential_version, config,
            credential_ciphertext, credential_nonce, credential_key_generation, created_at, updated_at)
         SELECT $1,$2,'jira','connected',$3,$4,$5::jsonb,$6,$7,$8,at,at
           FROM database_clock, consumed
         ON CONFLICT (organization_id, integration_key) DO UPDATE
            SET status='connected', revision=EXCLUDED.revision,
                credential_version=EXCLUDED.credential_version, config=EXCLUDED.config,
                credential_ciphertext=EXCLUDED.credential_ciphertext,
                credential_nonce=EXCLUDED.credential_nonce,
                credential_key_generation=EXCLUDED.credential_key_generation,
                updated_at=EXCLUDED.updated_at
         RETURNING id, organization_id, integration_key, status, revision, credential_version, config,
                   (credential_ciphertext IS NOT NULL) AS has_credential, created_at, updated_at`,
        [id, organizationId, nextRevision, nextCredentialVersion, JSON.stringify(input.config),
         envelope.ciphertext, envelope.nonce, envelope.keyGeneration, pending.id],
      );
      const row = result.rows[0];
      if (row === undefined) return { kind: "invalid_challenge" };
      await this.#audit(client, row, pending.actor_user_id, "connect");
      return { kind: "updated", integration: toIntegration(row) };
    });
  }

  public async createLinearOAuthAttempt(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly state: string;
    readonly browserNonce: string;
    readonly verifier: string;
    readonly ttlMillis: number;
  }): Promise<"created" | "forbidden"> {
    if (!Number.isSafeInteger(input.ttlMillis) || input.ttlMillis < 60_000 || input.ttlMillis > 30 * 60_000) {
      throw new Error("Linear OAuth attempt TTL must be between one and thirty minutes");
    }
    return this.#inTransaction(async (client) => {
      await this.#lockOrganization(client, input.organizationId);
      if (!(await this.#canAdmin(client, input.organizationId, input.actorUserId))) return "forbidden";
      const stateHash = createHash("sha256").update(input.state, "utf8").digest("hex");
      const browserNonceHash = createHash("sha256").update(input.browserNonce, "utf8").digest("hex");
      const envelope = this.cipher.encryptLinearOAuthVerifier({
        organizationId: input.organizationId, stateHash, verifier: input.verifier,
      });
      await client.query(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
         INSERT INTO dashboard_linear_oauth_attempts
           (id, organization_id, actor_user_id, state_hash, browser_nonce_hash, verifier_ciphertext, verifier_nonce,
            verifier_key_generation, created_at, expires_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,at,at + ($9::bigint * interval '1 millisecond')
           FROM database_clock`,
        [randomUUID(), input.organizationId, input.actorUserId, stateHash, browserNonceHash, envelope.ciphertext,
         envelope.nonce, envelope.keyGeneration, input.ttlMillis],
      );
      return "created";
    });
  }

  /** Atomically consumes one state/browser-bound PKCE verifier using DB time. */
  public async consumeLinearOAuthAttempt(input: {
    readonly organizationId: string;
    readonly state: string;
    readonly browserNonce: string;
  }): Promise<LinearOAuthAttempt | undefined> {
    const stateHash = createHash("sha256").update(input.state, "utf8").digest("hex");
    const browserNonceHash = createHash("sha256").update(input.browserNonce, "utf8").digest("hex");
    return this.#inTransaction(async (client) => {
      await this.#lockIntegration(client, input.organizationId);
      const result = await client.query<{
        actor_user_id: string; verifier_ciphertext: Buffer; verifier_nonce: Buffer; verifier_key_generation: number;
      }>(
        `WITH database_clock AS MATERIALIZED (SELECT clock_timestamp() AS at), consumed AS (
           UPDATE dashboard_linear_oauth_attempts
              SET consumed_at = database_clock.at
             FROM database_clock
            WHERE organization_id = $1 AND state_hash = $2 AND browser_nonce_hash = $3
              AND consumed_at IS NULL AND expires_at > database_clock.at
            RETURNING actor_user_id, verifier_ciphertext, verifier_nonce, verifier_key_generation
         )
         SELECT actor_user_id, verifier_ciphertext, verifier_nonce, verifier_key_generation FROM consumed`,
        [input.organizationId, stateHash, browserNonceHash],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        organizationId: input.organizationId,
        actorUserId: row.actor_user_id,
        verifier: this.cipher.decryptLinearOAuthVerifier({
          organizationId: input.organizationId, stateHash, ciphertext: row.verifier_ciphertext,
          nonce: row.verifier_nonce, keyGeneration: row.verifier_key_generation,
        }),
      };
    });
  }

  async #selectForUpdate(
    client: PgClient,
    organizationId: string,
    key: DashboardIntegrationKey,
  ): Promise<RawCredentialRow | undefined> {
    const result = await client.query<RawCredentialRow>(
      `SELECT id, organization_id, integration_key, status, revision, credential_version, config,
              (credential_ciphertext IS NOT NULL) AS has_credential, created_at, updated_at,
              credential_ciphertext, credential_nonce, credential_key_generation
         FROM dashboard_integrations
        WHERE organization_id = $1 AND integration_key = $2
        FOR UPDATE`,
      [organizationId, key],
    );
    return result.rows[0];
  }

  async #canAdmin(client: PgClient, organizationId: string, actorUserId: string): Promise<boolean> {
    const result = await client.query<{ role: AuthRole }>(
      `SELECT role FROM memberships
        WHERE organization_id = $1 AND user_id = $2
        FOR SHARE`,
      [organizationId, actorUserId],
    );
    const role = result.rows[0]?.role;
    return role === "owner" || role === "admin";
  }

  async #lockOrganization(client: PgClient, organizationId: string): Promise<void> {
    // Separate statements make lock order explicit; SQL expression evaluation
    // order inside one SELECT is not a concurrency contract.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('dashboard-members:' || $1, 0))`,
      [organizationId],
    );
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('dashboard-integrations:' || $1, 0))`,
      [organizationId],
    );
  }

  #lockIntegration(client: PgClient, organizationId: string): Promise<unknown> {
    return client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('dashboard-integrations:' || $1, 0))`,
      [organizationId],
    );
  }

  async #audit(
    client: PgClient,
    row: RawIntegrationRow,
    actorUserId: string | null,
    action: "connect" | "settings_update" | "credential_rotate" | "disconnect",
  ): Promise<void> {
    await client.query(
      `INSERT INTO dashboard_integration_audit
         (id, organization_id, integration_id, integration_key, actor_user_id, action,
          revision, credential_version, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,
      [randomUUID(), row.organization_id, row.id, row.integration_key, actorUserId,
       action, Number(row.revision), Number(row.credential_version)],
    );
  }

  async #inTransaction<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
