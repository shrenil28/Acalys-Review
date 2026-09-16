import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runMigrations,
  type PgClient,
  type PgQueryResult,
} from "../src/index.js";

class MigrationClient implements PgClient {
  public readonly statements: string[] = [];
  public readonly applied = new Map<string, string>();
  public released = false;

  public query<TRow = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<TRow>> {
    this.statements.push(text);
    if (text.startsWith("SELECT version")) {
      return Promise.resolve({
        rows: [...this.applied].map(([version, checksum]) => ({
          version,
          checksum,
        })) as TRow[],
        rowCount: this.applied.size,
      });
    }
    if (text.startsWith("INSERT INTO acalys_schema_migrations")) {
      this.applied.set(String(values?.[0]), String(values?.[1]));
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  public release(): void {
    this.released = true;
  }
}

const temporaryDirectories: string[] = [];

async function migrationDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acalys-migrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production migration runner", () => {
  it("applies files in order and records immutable checksums", async () => {
    const directory = await migrationDirectory();
    await writeFile(join(directory, "0002_second.sql"), "SELECT 2;\n");
    await writeFile(join(directory, "0001_first.sql"), "SELECT 1;\n");
    const client = new MigrationClient();
    const pool = {
      connect: () => Promise.resolve(client),
      query: client.query.bind(client),
    };

    const first = await runMigrations(pool, directory);
    expect(first.applied).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(client.applied.size).toBe(2);
    expect(client.released).toBe(true);

    const secondClient = new MigrationClient();
    for (const [version, digest] of client.applied) {
      secondClient.applied.set(version, digest);
    }
    const second = await runMigrations(
      {
        connect: () => Promise.resolve(secondClient),
        query: secondClient.query.bind(secondClient),
      },
      directory,
    );
    expect(second.applied).toEqual([]);
    expect(second.current).toEqual(["0001_first.sql", "0002_second.sql"]);
  });

  it("rejects edited migration history", async () => {
    const directory = await migrationDirectory();
    const file = join(directory, "0001_first.sql");
    await writeFile(file, "SELECT 1;\n");
    const firstClient = new MigrationClient();
    await runMigrations(
      {
        connect: () => Promise.resolve(firstClient),
        query: firstClient.query.bind(firstClient),
      },
      directory,
    );
    await writeFile(file, "SELECT 2;\n");

    const secondClient = new MigrationClient();
    for (const [version, digest] of firstClient.applied) {
      secondClient.applied.set(version, digest);
    }
    await expect(
      runMigrations(
        {
          connect: () => Promise.resolve(secondClient),
          query: secondClient.query.bind(secondClient),
        },
        directory,
      ),
    ).rejects.toThrow("Migration checksum mismatch for 0001_first.sql");
  });
});
