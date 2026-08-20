/**
 * One process that asks for a Postgres database and reports what it got.
 *
 * Spawned several times at once to prove the shared server boots once. Run
 * in-process, this would prove nothing: the single-flight claim is about
 * separate OS processes racing, which is what vitest's fork pool creates.
 */
import { appendFileSync } from "node:fs";

const [, , ledger, label] = process.argv;

const { startPostgres } = await import(
  new URL("../postgres.ts", import.meta.url).href
);

const database = await startPostgres(label);
const result = await database.pool.query("SELECT current_database() AS name");
appendFileSync(ledger, `${result.rows[0].name}\n`);
await database.stop();
