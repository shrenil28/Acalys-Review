import { randomUUID } from "node:crypto";

import { createPostgresPool } from "@acalys/database";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function main(): Promise<void> {
  const pool = createPostgresPool(required("DATABASE_URL"));
  try {
    const organizationId = required("ACALYS_BOOTSTRAP_ORGANIZATION_ID");
    const provider = required("ACALYS_BOOTSTRAP_OWNER_PROVIDER");
    if (provider !== "github" && provider !== "gitlab") {
      throw new Error(
        "ACALYS_BOOTSTRAP_OWNER_PROVIDER must be github or gitlab",
      );
    }
    const providerUserId = required("ACALYS_BOOTSTRAP_OWNER_PROVIDER_USER_ID");
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (id, slug, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         slug = EXCLUDED.slug,
         name = EXCLUDED.name,
         updated_at = clock_timestamp()
       RETURNING id`,
      [
        organizationId,
        required("ACALYS_BOOTSTRAP_ORGANIZATION_SLUG"),
        required("ACALYS_BOOTSTRAP_ORGANIZATION_NAME"),
      ],
    );
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users
         (id, provider, provider_user_id, primary_email, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp())
       ON CONFLICT (provider, provider_user_id) DO UPDATE SET
         primary_email = EXCLUDED.primary_email,
         display_name = EXCLUDED.display_name,
         updated_at = clock_timestamp()
       RETURNING id`,
      [
        randomUUID(),
        provider,
        providerUserId,
        optional("ACALYS_BOOTSTRAP_OWNER_EMAIL") ?? null,
        optional("ACALYS_BOOTSTRAP_OWNER_DISPLAY_NAME") ?? null,
      ],
    );
    const userId = user.rows[0]?.id;
    if (organization.rows[0] === undefined || userId === undefined) {
      throw new Error("Bootstrap upsert returned no identity");
    }
    await pool.query(
      `INSERT INTO memberships
         (id, organization_id, user_id, role, created_at, updated_at)
       VALUES ($1, $2, $3, 'owner', clock_timestamp(), clock_timestamp())
       ON CONFLICT (organization_id, user_id) DO UPDATE SET
         role = 'owner',
         updated_at = clock_timestamp()`,
      [randomUUID(), organizationId, userId],
    );
    console.info(
      JSON.stringify({
        level: "info",
        event: "bootstrap.completed",
        organizationId,
        userId,
        provider,
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
      event: "bootstrap.failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      message:
        error instanceof Error ? error.message : "Unknown bootstrap failure",
    }),
  );
  process.exitCode = 1;
});
