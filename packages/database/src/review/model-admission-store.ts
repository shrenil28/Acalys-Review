import { randomUUID } from "node:crypto";

import type { PgClient, PgPool } from "../webhook/postgres-inbox.js";

export interface ModelCredentialPolicy {
  readonly credentialId: string;
  readonly maxConcurrency: number;
  readonly requestsPerMinute: number;
  readonly leaseMillis: number;
}

export type ModelAdmissionOutcome =
  | { readonly kind: "entered"; readonly release: () => Promise<void> }
  | { readonly kind: "rate_limited" };

/**
 * Fleet-wide admission for one provider credential.
 *
 * PostgreSQL advisory locking serializes admission decisions for the same
 * credential without serializing unrelated credentials. Database time owns
 * both the one-minute request window and lease expiry, so worker clock skew
 * cannot create extra capacity.
 */
export class ModelCredentialAdmissionStore {
  readonly #pool: PgPool;

  public constructor(pool: PgPool) {
    this.#pool = pool;
  }

  public async enter(
    policy: ModelCredentialPolicy,
  ): Promise<ModelAdmissionOutcome> {
    if (
      policy.credentialId.trim() === "" ||
      !Number.isInteger(policy.maxConcurrency) ||
      policy.maxConcurrency < 1 ||
      !Number.isInteger(policy.requestsPerMinute) ||
      policy.requestsPerMinute < 1 ||
      !Number.isInteger(policy.leaseMillis) ||
      policy.leaseMillis < 1_000
    ) {
      throw new Error("invalid model credential admission policy");
    }

    const admissionId = randomUUID();
    const entered = await this.#inTransaction(async (client) => {
      // `hashtextextended` is used only as a lock key. A hash collision would
      // reduce concurrency between two credentials; it cannot grant capacity.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [policy.credentialId],
      );

      // Rows are needed only while they can still affect concurrency or the
      // rolling one-minute rate window. Prune under the same credential lock
      // so high-volume installations do not accumulate an unbounded history.
      await client.query(
        `DELETE FROM model_credential_admissions
          WHERE credential_id = $1
            AND admitted_at <= clock_timestamp() - interval '1 minute'
            AND (released_at IS NOT NULL OR lease_expires_at <= clock_timestamp())`,
        [policy.credentialId],
      );

      const counts = await client.query<{
        active: string | number;
        recent: string | number;
      }>(
        `SELECT
           COUNT(*) FILTER (
             WHERE released_at IS NULL AND lease_expires_at > clock_timestamp()
           ) AS active,
           COUNT(*) FILTER (
             WHERE admitted_at > clock_timestamp() - interval '1 minute'
           ) AS recent
         FROM model_credential_admissions
        WHERE credential_id = $1`,
        [policy.credentialId],
      );
      const row = counts.rows[0];
      const active = Number(row?.active ?? 0);
      const recent = Number(row?.recent ?? 0);
      if (
        active >= policy.maxConcurrency ||
        recent >= policy.requestsPerMinute
      ) {
        return false;
      }

      await client.query(
        `INSERT INTO model_credential_admissions (
           id, credential_id, admitted_at, lease_expires_at
         ) VALUES (
           $1, $2, clock_timestamp(),
           clock_timestamp() + ($3 * interval '1 millisecond')
         )`,
        [admissionId, policy.credentialId, policy.leaseMillis],
      );
      return true;
    });

    if (!entered) return { kind: "rate_limited" };

    let released = false;
    return {
      kind: "entered",
      release: async () => {
        if (released) return;
        released = true;
        await this.#withClient((client) =>
          client.query(
            `UPDATE model_credential_admissions
                SET released_at = clock_timestamp()
              WHERE id = $1 AND released_at IS NULL`,
            [admissionId],
          ),
        );
      },
    };
  }

  async #inTransaction<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
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

  async #withClient<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await run(client);
    } finally {
      client.release();
    }
  }
}
