/**
 * A semaphore that actually spans processes.
 *
 * # Why the first attempt was worthless
 *
 * The limiter shipped in `5203105` was a module-level counter. Vitest's default
 * pool gives each test file its own fork, and each fork runs one file at a
 * time — so every fork held its own private `Semaphore(2)` and called
 * `startPostgres` exactly once. It could never block. It was not merely scoped
 * too narrowly, as "sixteen instead of two" would be: it was a no-op, and the
 * three green runs after it were evidence about Docker's health following a
 * restart, not about the limiter.
 *
 * That is the failure mode this project keeps meeting from a new angle — a
 * control that cannot fire, believed because the symptom stopped.
 *
 * # How this one works
 *
 * `mkdir` is atomic on every platform that matters: it either creates the
 * directory or fails because it exists. So N slot directories are N mutexes,
 * and holding any one of them is a slot.
 *
 * Each slot records the holder's pid and the time it was taken, so a slot left
 * behind by a killed process can be reclaimed. That matters more here than
 * usual: the runs this limiter exists for are the ones where something dies
 * abruptly, and a lock file that survives its owner would wedge every
 * subsequent run.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where slots live. Shared by every process on the machine — which is the whole
 * point, and also why it must be overridable.
 *
 * The probe that proves this limit works spawns processes that hold slots. Run
 * against the default root, it competes with the real harness for the same two
 * permits: it starved a Postgres suite into failing, and its own
 * "slot released after a throw" assertion read a slot held by an unrelated
 * suite. A test for a machine-wide lock must not use the machine's lock.
 */
const DEFAULT_ROOT = join(tmpdir(), "acalys-postgres-startup");

/**
 * A slot whose owner died is reclaimable after this long.
 *
 * Longer than a healthy startup and shorter than a developer's patience. Too
 * short and two processes both believe they hold the slot; too long and one
 * `kill -9` costs the next run a stall.
 */
const STALE_AFTER_MS = 120_000;

/**
 * Set when the limiter could not engage and startups ran unthrottled.
 *
 * This limiter began as a performance nicety and has become an
 * environment-stability mitigation, so its absence is now worth knowing about.
 * A future Docker crash under an unthrottled fallback would otherwise look
 * exactly like the original mystery — and the whole point of the diagnostics
 * work was that the next one should not.
 *
 * It stays fail-open. Refusing to run because a *mitigation* was unavailable
 * would turn an optimisation into a dependency. Bypass is recorded, not
 * enforced.
 */
export const bypassReasons: string[] = [];

interface Holder {
  readonly pid: number;
  readonly takenAt: number;
}

function readHolder(slot: string): Holder | undefined {
  try {
    return JSON.parse(
      readFileSync(join(slot, "holder.json"), "utf8"),
    ) as Holder;
  } catch {
    return undefined;
  }
}

/** Whether a pid is still running. Not whether it is *our* process. */
function alive(pid: number): boolean {
  try {
    // Signal 0 checks existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryTake(slot: string): boolean {
  try {
    mkdirSync(slot, { recursive: false });
  } catch {
    // Taken. Reclaim it only if its owner is gone AND it is old — both, because
    // pids are reused, and a fresh slot whose pid happens to match a dead one
    // would otherwise be stolen from a live startup.
    const holder = readHolder(slot);
    const expired =
      holder === undefined ||
      (Date.now() - holder.takenAt > STALE_AFTER_MS && !alive(holder.pid));
    if (!expired) return false;

    try {
      rmSync(slot, { recursive: true, force: true });
      mkdirSync(slot, { recursive: false });
    } catch {
      // Another process reclaimed it first. Theirs.
      return false;
    }
  }

  writeFileSync(
    join(slot, "holder.json"),
    JSON.stringify({ pid: process.pid, takenAt: Date.now() } satisfies Holder),
  );
  return true;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holds one of `slots` machine-wide permits until the returned function runs.
 *
 * Fails open rather than closed. If the lock directory cannot be created at
 * all — a read-only temp, an exotic filesystem — the caller proceeds without a
 * permit, because a test harness that refuses to run because it could not
 * acquire a *performance* mitigation has turned an optimisation into a
 * dependency.
 */
export async function withStartupSlot<T>(
  slots: number,
  work: () => Promise<T>,
  root: string = DEFAULT_ROOT,
): Promise<T> {
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    bypassReasons.push(
      `lock root unavailable at ${root}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return await work();
  }

  let held: string | undefined;
  const deadline = Date.now() + STALE_AFTER_MS * 2;

  while (held === undefined && Date.now() < deadline) {
    for (let index = 0; index < slots; index += 1) {
      const slot = join(root, `slot-${String(index)}`);
      if (tryTake(slot)) {
        held = slot;
        break;
      }
    }
    if (held === undefined) await sleep(50 + Math.random() * 100);
  }

  if (held === undefined) {
    // Every slot stayed occupied past the deadline. Proceeding unthrottled is
    // the deliberate choice; leaving no trace of it is not.
    bypassReasons.push(
      `no slot acquired within ${String(STALE_AFTER_MS * 2)}ms; proceeding unthrottled`,
    );
  }

  try {
    return await work();
  } finally {
    if (held !== undefined) rmSync(held, { recursive: true, force: true });
  }
}

/** For the conformance probe: how many slots are held right now. */
export function heldSlots(slots: number, root: string = DEFAULT_ROOT): number {
  let count = 0;
  for (let index = 0; index < slots; index += 1) {
    if (readHolder(join(root, `slot-${String(index)}`)) !== undefined) {
      count += 1;
    }
  }
  return count;
}
