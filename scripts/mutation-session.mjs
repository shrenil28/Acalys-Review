/**
 * A lock that stops anything else testing a tree under active mutation.
 *
 * The dirty-tree guard checks the state at startup. It cannot help with the
 * sequence that actually happened here:
 *
 * ```
 * test:ci starts against a clean tree
 * the mutation harness applies a mutant
 * test:ci reaches those files and fails
 * → two runs reported failures that were nobody's bug
 * ```
 *
 * A clean tree can become mutated *after* a run begins, so the interlock is
 * about concurrency rather than initial state. Both guards are kept: this one
 * catches the race, the other catches the leftover.
 *
 * The harness mints a nonce and passes it to its own child test runs, so those
 * are permitted while every other run is refused. A lock without that would
 * make the harness unable to run its own tests.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK = join(process.cwd(), ".git", "acalys-mutation-session");

export function acquireSession(nonce) {
  try {
    // `mkdir` is atomic: it creates or it fails because it exists.
    mkdirSync(LOCK, { recursive: false });
  } catch {
    const held = readSession();
    throw new Error(
      `A mutation session is already active${
        held === undefined ? "" : ` (pid ${String(held.pid)})`
      }. Two harnesses mutating one tree would test each other's mutants.`,
    );
  }
  writeFileSync(
    join(LOCK, "holder.json"),
    JSON.stringify({ pid: process.pid, nonce, startedAt: Date.now() }),
  );
}

export function releaseSession() {
  rmSync(LOCK, { recursive: true, force: true });
}

export function readSession() {
  try {
    return JSON.parse(readFileSync(join(LOCK, "holder.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Refuses to continue if a mutation session is active and this process is not
 * its child.
 *
 * Called by `test:ci`. The failure is loud and immediate, because the
 * alternative is a plausible-looking regression report about code nobody
 * wrote.
 */
export function assertNoForeignSession(nonce) {
  const held = readSession();
  if (held === undefined) return;
  if (nonce !== undefined && nonce === held.nonce) return;

  console.error(
    "\nRefusing to run: a mutation session is active on this tree" +
      ` (pid ${String(held.pid)}).\n\n` +
      "Source files are being modified while you read them, so any failure " +
      "reported here would be about a mutant rather than about the code. " +
      "Wait for the harness to finish, or stop it — it restores what it " +
      "changed on the way out.\n",
  );
  process.exit(3);
}
