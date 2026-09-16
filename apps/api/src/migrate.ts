import { createPostgresPool, runMigrations } from "@acalys/database";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const pool = createPostgresPool(required("DATABASE_URL"));
  try {
    const result = await runMigrations(pool);
    console.info(
      JSON.stringify({
        level: "info",
        event: "database.migrations_complete",
        applied: result.applied,
        currentCount: result.current.length,
      }),
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "database.migrations_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      message:
        error instanceof Error ? error.message : "Unknown migration failure",
    }),
  );
  process.exitCode = 1;
});
