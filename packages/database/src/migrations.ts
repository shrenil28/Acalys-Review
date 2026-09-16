import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PgPool } from "./webhook/postgres-inbox.js";

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK = "acalys-schema-migrations";

export interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly current: readonly string[];
}

export function defaultMigrationDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
}

function checksum(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Applies the immutable SQL migration sequence under a session advisory lock.
 *
 * Each file commits independently, so a failed deploy can safely retry. An
 * already-applied filename with different bytes is rejected: editing schema
 * history in place is data corruption disguised as a deployment.
 */
export async function runMigrations(
  pool: PgPool,
  directory = defaultMigrationDirectory(),
): Promise<MigrationResult> {
  const client = await pool.connect();
  const appliedNow: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      MIGRATION_LOCK,
    ]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS acalys_schema_migrations (
         version TEXT PRIMARY KEY,
         checksum CHAR(64) NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
       )`,
    );

    const existing = await client.query<AppliedMigration>(
      "SELECT version, checksum FROM acalys_schema_migrations ORDER BY version",
    );
    const applied = new Map(
      existing.rows.map((row) => [row.version, row.checksum] as const),
    );
    const files = (await readdir(directory))
      .filter((file) => MIGRATION_FILE.test(file))
      .sort();

    if (files.length === 0) {
      throw new Error(`No SQL migrations found in ${directory}`);
    }

    for (const file of files) {
      const source = await readFile(resolve(directory, file), "utf8");
      const digest = checksum(source);
      const recorded = applied.get(file);
      if (recorded !== undefined) {
        if (recorded !== digest) {
          throw new Error(`Migration checksum mismatch for ${file}`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(source);
        await client.query(
          "INSERT INTO acalys_schema_migrations (version, checksum) VALUES ($1, $2)",
          [file, digest],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      applied.set(file, digest);
      appliedNow.push(file);
    }

    return { applied: appliedNow, current: [...applied.keys()].sort() };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        MIGRATION_LOCK,
      ])
      .catch(() => undefined);
    client.release();
  }
}
