import pg from "pg";

import type { PgClient, PgPool } from "./webhook/postgres-inbox.js";

export interface CloseablePgPool extends PgPool {
  end(): Promise<void>;
}

/**
 * Creates the production Postgres pool behind the database package boundary.
 *
 * Callers receive only the narrow pool surface the persistence stores consume,
 * plus explicit shutdown. No application workspace needs to import `pg`
 * directly, which keeps the repository's database dependency boundary real.
 */
export function createPostgresPool(connectionString: string): CloseablePgPool {
  if (connectionString.trim() === "") {
    throw new TypeError("Postgres connection string is required");
  }

  const pool = new pg.Pool({ connectionString });
  return {
    async connect(): Promise<PgClient> {
      return await pool.connect();
    },
    async query<TRow = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) {
      const result = await pool.query(text, values as unknown[] | undefined);
      return {
        rows: result.rows as TRow[],
        rowCount: result.rowCount,
      };
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}
