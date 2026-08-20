import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { dockerAvailable } from "./postgres.js";

const run = promisify(execFile);
const HAS_DOCKER = dockerAvailable();
const describeWithPostgres = HAS_DOCKER
  ? describe
  : describe.skip.bind(describe);

const WORKER = fileURLToPath(
  new URL("./fixtures/shared-server-worker.mjs", import.meta.url),
);

/**
 * Run through tsx, not `--experimental-strip-types`.
 *
 * The harness imports `./startup-limit.js`, which is TypeScript on disk. Node's
 * type stripping executes a `.ts` file but does not rewrite the extension in
 * its transitive imports, so the worker died with `ERR_MODULE_NOT_FOUND` and
 * the ledger was empty — which the fail-closed assertion caught rather than
 * letting four silent crashes read as a passing isolation proof.
 */
const TSX = fileURLToPath(
  new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

/**
 * Four processes, one server.
 *
 * The single-flight claim was previously "tested" against `withStartupSlot`
 * itself — the primitive, not its use. A mutation removing the permit from
 * `ensureSharedServer` survived, because nothing exercised the thing the claim
 * was actually about.
 *
 * This counts containers, which is the observable the whole checkpoint exists
 * to reduce.
 */
describeWithPostgres("The shared Postgres server boots once", () => {
  let ledger: string | undefined;
  let probeRunId: string | undefined;

  afterAll(async () => {
    if (ledger !== undefined) rmSync(ledger, { force: true });

    // ── Scoped to THIS probe's run, and nothing wider ─────────────────────
    //
    // The first version filtered on `acalys.test=true` and removed every match
    // — including the shared server the real suites were connected to. Four of
    // them died with "Connection terminated unexpectedly", which is precisely
    // the failure this repository already had once, reintroduced inside the
    // test written to prove isolation.
    //
    // Precise ownership, not "looks like ours". The rule keeps having to be
    // relearned in new places.
    if (probeRunId === undefined) return;
    const ids = await run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=acalys.run=${probeRunId}`,
    ]).catch(() => ({ stdout: "" }));
    const remaining = ids.stdout.trim().split("\n").filter(Boolean);
    if (remaining.length > 0) {
      await run("docker", ["rm", "-f", "-v", "--", ...remaining]).catch(
        () => undefined,
      );
    }
  }, 120_000);

  it("creates one container for four simultaneous processes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acalys-shared-server-"));
    ledger = join(directory, "databases.txt");
    writeFileSync(ledger, "");

    // A run id these workers share, exactly as vitest's forks share one.
    const runId = `probe-${String(Date.now())}`;
    probeRunId = runId;

    await Promise.all(
      ["alpha", "beta", "gamma", "delta"].map((label) =>
        run(process.execPath, [TSX, WORKER, ledger ?? "", label], {
          env: {
            ...process.env,
            ACALYS_TEST_RUN_ID: runId,
            // A private permit root, so booting this probe's server does not
            // consume the machine-wide permit the real suites are queueing on.
            ACALYS_STARTUP_LOCK_ROOT: join(directory, "locks"),
          },
        }).catch(() => undefined),
      ),
    );

    const names = readFileSync(ledger, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);

    // Fail-closed: an empty ledger would satisfy every count below.
    expect(names.length, "no worker reported a database").toBe(4);

    // Four distinct databases…
    expect(new Set(names).size).toBe(4);
    for (const name of names) {
      expect(name).not.toBe("postgres");
    }

    // …inside one container. This is the number that was nine.
    const containers = await run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=acalys.run=${runId}`,
    ]);
    expect(containers.stdout.trim().split("\n").filter(Boolean).length).toBe(1);
  }, 300_000);
});
