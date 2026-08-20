/**
 * A lock that stops anything else inspecting a tree under active mutation.
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
 * The harness mints a nonce and passes it to its own child runs, so those are
 * permitted while every other run is refused. A lock without that would make
 * mutation testing itself impossible — the harness could not run the very
 * gates it exists to run.
 *
 * # Why this covers every gate, not just `test:ci`
 *
 * Until P1-GATE-INTERLOCK this guarded exactly one gate. `typecheck`, `lint`,
 * `format:check`, `depcruise`, `build:clean`, the schema and reference checks,
 * and export conformance all read the mutable worktree unguarded, so an
 * independently launched gate could report a failure caused by a planted
 * mutation rather than by the code.
 *
 * The false failure is the annoying case. The dangerous one is its inverse:
 *
 * ```
 * a gate that PASSES against a mutated tree
 *   → recorded as evidence the tree is clean
 * ```
 *
 * That is manufactured evidence, and it is the reason this is enforced rather
 * than remembered. {@link PROTECTED_GATES} is the list, `scripts/run-gate.mjs`
 * is the single door, and a test asserts every command `verify` runs goes
 * through it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const LOCK = join(process.cwd(), ".git", "acalys-mutation-session");

/**
 * Every repository-wide correctness gate.
 *
 * A gate belongs here when it reads the worktree and reports a verdict about
 * it. That is the whole membership rule: a mutated tree can make any such
 * verdict wrong in either direction.
 *
 * `dev`, `format` (which writes), and `test:watch` are deliberately absent —
 * they are not evidence-producing gates, and blocking an interactive dev
 * server on a background mutation run would be an interlock nobody keeps.
 */
export const PROTECTED_GATES = [
  "typecheck",
  "lint",
  "format:check",
  "depcruise",
  "references",
  "schemas:check",
  "build:clean",
  "export-conformance",
  "test:ci",
];

// ---------------------------------------------------------------------------
// Holding the session
// ---------------------------------------------------------------------------

/**
 * The identity of the machine's current boot.
 *
 * Recorded so a lock that survived a reboot can be proven stale rather than
 * guessed stale: after a restart no pid from the previous boot can still be
 * running, whatever the lock's age says.
 */
function bootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * When a pid was started, in clock ticks since boot.
 *
 * This is what makes pid reuse detectable. A recycled pid is a *different*
 * process wearing a dead one's number, and treating it as the live holder
 * would make a stale lock permanent.
 *
 * Field 22 of `/proc/<pid>/stat`, parsed after the final `)` because the comm
 * field can itself contain spaces and parentheses.
 */
function pidStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // stat field 22 is the 20th field after the comm field.
    return fields[19];
  } catch {
    return undefined;
  }
}

export function acquireSession(nonce) {
  try {
    // `mkdir` is atomic: it creates or it fails because it exists.
    mkdirSync(LOCK, { recursive: false });
  } catch {
    const held = readSession();
    const liveness = held === undefined ? undefined : sessionLiveness(held);
    if (liveness !== undefined && liveness.state === "dead") {
      throw new Error(
        `A mutation session lock is present but its holder is gone ` +
          `(${liveness.reason}). Clear it with:\n\n` +
          `  rm -rf .git/acalys-mutation-session\n`,
      );
    }
    throw new Error(
      `A mutation session is already active${
        held === undefined ? "" : ` (pid ${String(held.pid)})`
      }. Two harnesses mutating one tree would test each other's mutants.`,
    );
  }
  writeFileSync(
    join(LOCK, "holder.json"),
    JSON.stringify({
      pid: process.pid,
      nonce,
      startedAt: Date.now(),
      bootId: bootId(),
      pidStartTime: pidStartTime(process.pid),
      worktree: process.cwd(),
    }),
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

// ---------------------------------------------------------------------------
// Is the holder still there?
// ---------------------------------------------------------------------------

/**
 * Whether the recorded holder still exists — proven, never estimated.
 *
 * Note what is absent: **age**. "The lock is old" is not evidence its owner
 * is gone, and this repository has twice destroyed live resources by treating
 * it as though it were (invariant 3). A long mutation run is old and healthy;
 * a crashed one is young and dead. Only these three facts settle it:
 *
 * ```
 * the machine rebooted since the lock was written  → dead, certainly
 * no /proc entry for the pid                        → dead, certainly
 * the pid exists but started at a different time    → dead, pid was recycled
 * ```
 *
 * When none of them can be established — no `/proc`, a lock written by an
 * older build with no provenance — the answer is `undeterminable`, not
 * `dead`. A guard that cannot prove the holder is gone refuses and says so,
 * because the cost of being wrong is asymmetric: refusing a gate wastes a
 * minute, reclaiming a live session corrupts a mutation run and everything
 * concluded from it.
 */
export function sessionLiveness(held) {
  const currentBoot = bootId();

  if (
    held.bootId !== undefined &&
    currentBoot !== undefined &&
    held.bootId !== currentBoot
  ) {
    return {
      state: "dead",
      reason: "the machine has rebooted since the lock was written",
    };
  }

  if (held.pid === undefined || currentBoot === undefined) {
    return {
      state: "undeterminable",
      reason:
        "this platform exposes no process table we can check, so the holder " +
        "can be neither confirmed nor ruled out",
    };
  }

  if (!existsSync(`/proc/${String(held.pid)}`)) {
    return {
      state: "dead",
      reason: `no process ${String(held.pid)} exists`,
    };
  }

  if (held.pidStartTime === undefined) {
    return {
      state: "undeterminable",
      reason:
        `process ${String(held.pid)} exists, but the lock records no start ` +
        "time, so we cannot tell it from a different process that reused " +
        "the number",
    };
  }

  const current = pidStartTime(held.pid);
  if (current !== undefined && current !== held.pidStartTime) {
    return {
      state: "dead",
      reason: `process ${String(held.pid)} was recycled — a different process holds that number now`,
    };
  }

  return { state: "alive", reason: `process ${String(held.pid)} is running` };
}

// ---------------------------------------------------------------------------
// The gate guard
// ---------------------------------------------------------------------------

/**
 * The interlock's whole guarantee, in one function.
 *
 * > A repository-wide correctness gate cannot run against a worktree owned by
 * > a mutation session unless it is an authenticated child of that session.
 *
 * Both directions matter and both are tested. Refusing everything would be a
 * trivially "safe" interlock that makes the harness unable to do its job, so
 * the nonce path is as much a requirement as the refusal path.
 *
 * Returns a decision rather than exiting, so it can be tested without
 * spawning a process for every case; {@link assertGateAllowed} is the
 * process-level wrapper.
 */
export function gateDecision(gate, nonce) {
  const held = readSession();
  if (held === undefined) return { allowed: true, reason: "no_session" };
  if (nonce !== undefined && nonce === held.nonce) {
    return { allowed: true, reason: "session_child" };
  }

  const liveness = sessionLiveness(held);
  if (liveness.state === "dead") {
    return {
      allowed: true,
      reason: "stale_session",
      held,
      liveness,
      message:
        `Ignoring a mutation session lock whose holder is gone: ` +
        `${liveness.reason}. Running \`${gate}\` anyway.`,
    };
  }

  return {
    allowed: false,
    reason: liveness.state === "alive" ? "foreign_session" : "undeterminable",
    held,
    liveness,
    message:
      `Refusing to run \`${gate}\`: a mutation session is active on this ` +
      `tree (pid ${String(held.pid)}; ${liveness.reason}).\n\n` +
      "Source files are being modified while this gate would read them, so " +
      "any verdict it reported — pass or fail — would be about a mutant " +
      "rather than about the code. A failure would be a phantom regression; " +
      "a pass would be worse, because it would be filed as evidence this " +
      "tree is clean.\n\n" +
      "Wait for the harness to finish, or stop it — it restores what it " +
      "changed on the way out." +
      (liveness.state === "undeterminable"
        ? "\n\nIf you are certain no harness is running, remove " +
          ".git/acalys-mutation-session by hand. This guard will not remove " +
          "it for you without proof its owner is gone."
        : ""),
  };
}

/** Exit code for a refused gate. Distinct from a gate's own failure (1). */
export const REFUSED_EXIT_CODE = 3;

/**
 * Refuses to continue if a mutation session is active and this process is not
 * its child.
 *
 * The failure is loud and immediate, because the alternative is a
 * plausible-looking report about code nobody wrote.
 */
export function assertGateAllowed(gate, nonce) {
  const decision = gateDecision(gate, nonce);
  if (decision.allowed) {
    if (decision.message !== undefined)
      console.error(`\n${decision.message}\n`);
    return;
  }
  console.error(`\n${decision.message}\n`);
  process.exit(REFUSED_EXIT_CODE);
}

/** Back-compat alias: `test:ci` guarded itself before there was one door. */
export function assertNoForeignSession(nonce) {
  assertGateAllowed("test:ci", nonce);
}
