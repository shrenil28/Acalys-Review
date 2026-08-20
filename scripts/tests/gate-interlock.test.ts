/**
 * P1-GATE-INTERLOCK.
 *
 * The guarantee under test, stated once:
 *
 * > A repository-wide correctness gate cannot run against a worktree owned by
 * > a mutation session unless it is an authenticated child of that session.
 *
 * Two directions, and the second is not decoration. An interlock that refuses
 * everything is trivially "safe" and makes mutation testing impossible — the
 * harness could not run the gates it exists to run. Both are asserted:
 *
 * ```
 * session active + independent process  → refused
 * session active + harness's own child  → allowed
 * ```
 *
 * Every case here spawns a real process against a real lock directory. The
 * thing being tested is cross-process by nature, and a same-process test of it
 * would prove something adjacent to the claim rather than the claim — the
 * mistake that let a no-op startup limiter pass three green runs.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUN_GATE = join(REPO, "scripts", "run-gate.mjs");
const REFUSED = 3;

/** A throwaway worktree: the lock lives at `<cwd>/.git/acalys-mutation-session`. */
let worktree: string;
let lock: string;
let marker: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "acalys-gate-"));
  lock = join(worktree, ".git", "acalys-mutation-session");
  marker = join(worktree, "gate-ran");
  mkdirSync(join(worktree, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

/** Reads this platform's boot identity the way the guard does. */
function currentBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

/** Reads a pid's start time the way the guard does — field 22 of `stat`. */
function startTimeOf(pid: number): string {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
}

interface Holder {
  readonly pid?: number;
  readonly nonce?: string;
  readonly startedAt?: number;
  readonly bootId?: string;
  readonly pidStartTime?: string;
}

function holdSession(holder: Holder): void {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "holder.json"), JSON.stringify(holder));
}

/** A session held by a process that is definitely running: this one. */
function holdLiveSession(nonce: string): void {
  holdSession({
    pid: process.pid,
    nonce,
    startedAt: Date.now(),
    bootId: currentBootId(),
    pidStartTime: startTimeOf(process.pid),
  });
}

/**
 * Runs a gate through the wrapper, in the throwaway worktree.
 *
 * The gate body writes a marker file, so "was the gate refused?" is answered
 * by whether the command *ran*, not only by an exit code. A wrapper that
 * printed a refusal and executed anyway would pass an exit-code-only test.
 */
function runGate(
  gateName: string,
  options: { nonce?: string; exitCode?: number } = {},
): { status: number | null; stderr: string; ran: boolean } {
  const body =
    `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");` +
    `process.exit(${String(options.exitCode ?? 0)});`;

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.nonce === undefined) delete env["ACALYS_MUTATION_SESSION"];
  else env["ACALYS_MUTATION_SESSION"] = options.nonce;

  const result = spawnSync(
    process.execPath,
    [RUN_GATE, gateName, "--", process.execPath, "-e", body],
    { cwd: worktree, env, encoding: "utf8" },
  );

  return {
    status: result.status,
    stderr: result.stderr,
    ran: existsSync(marker),
  };
}

// ---------------------------------------------------------------------------

describe("the interlock refuses foreign gates", () => {
  it("runs the gate when no session is active", () => {
    const result = runGate("typecheck");
    expect(result.status).toBe(0);
    expect(result.ran).toBe(true);
  });

  it("refuses an independent gate while a session is active", () => {
    holdLiveSession("session-nonce");
    const result = runGate("typecheck");

    expect(result.status).toBe(REFUSED);
    // The decisive assertion. An exit code alone would not distinguish a
    // wrapper that refuses from one that complains and runs anyway.
    expect(result.ran).toBe(false);
    expect(result.stderr).toContain("Refusing to run `typecheck`");
  });

  it("refuses a gate carrying the wrong nonce", () => {
    holdLiveSession("the-real-nonce");
    const result = runGate("lint", { nonce: "a-different-nonce" });

    expect(result.status).toBe(REFUSED);
    expect(result.ran).toBe(false);
  });

  it("explains why a pass would be worse than a failure", () => {
    holdLiveSession("session-nonce");
    const { stderr } = runGate("depcruise");

    // The refusal has to carry the reason, because the reason is not obvious:
    // a phantom failure is annoying, a phantom PASS becomes filed evidence.
    expect(stderr).toContain("a pass would be worse");
  });
});

describe("the interlock permits the session's own children", () => {
  it("runs a gate carrying the session's nonce", () => {
    holdLiveSession("session-nonce");
    const result = runGate("typecheck", { nonce: "session-nonce" });

    expect(result.status).toBe(0);
    expect(result.ran).toBe(true);
  });

  it("permits every protected gate, not just test:ci", () => {
    holdLiveSession("session-nonce");

    // The hole this checkpoint closes ran the other way — one gate guarded,
    // eight unguarded. Widening the guard must not narrow the harness.
    for (const gate of [
      "typecheck",
      "lint",
      "format:check",
      "depcruise",
      "references",
      "schemas:check",
      "build:clean",
      "export-conformance",
      "test:ci",
    ]) {
      rmSync(marker, { force: true });
      const result = runGate(gate, { nonce: "session-nonce" });
      expect(result.status, `${gate} should be permitted`).toBe(0);
      expect(result.ran, `${gate} should have run`).toBe(true);
    }
  });
});

describe("a stale lock is reclaimed only on positive proof", () => {
  it("proceeds when no process holds the recorded pid", () => {
    // pid 2^22 is above Linux's default pid_max and cannot be allocated.
    holdSession({
      pid: 4_194_304,
      nonce: "gone",
      bootId: currentBootId(),
      pidStartTime: "12345",
    });

    const result = runGate("typecheck");
    expect(result.status).toBe(0);
    expect(result.ran).toBe(true);
    expect(result.stderr).toContain("no process 4194304 exists");
  });

  it("proceeds when the lock predates the current boot", () => {
    holdSession({
      // A live pid — but recorded under a boot id that is not this one, so it
      // cannot be the process that wrote the lock.
      pid: process.pid,
      nonce: "previous-boot",
      bootId: "00000000-0000-0000-0000-000000000000",
      pidStartTime: startTimeOf(process.pid),
    });

    const result = runGate("typecheck");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("rebooted");
  });

  it("proceeds when the recorded pid was recycled", () => {
    holdSession({
      pid: process.pid,
      nonce: "recycled",
      bootId: currentBootId(),
      // The pid is alive, but it started at a different time — so it is a
      // different process wearing a dead one's number.
      pidStartTime: "1",
    });

    const result = runGate("typecheck");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("recycled");
  });

  it("refuses when the holder is alive, however old the lock is", () => {
    holdSession({
      pid: process.pid,
      nonce: "long-running",
      // Two days old. Age is not evidence, and a long mutation run is exactly
      // the case a time-based reaper would destroy.
      startedAt: Date.now() - 48 * 60 * 60 * 1000,
      bootId: currentBootId(),
      pidStartTime: startTimeOf(process.pid),
    });

    const result = runGate("typecheck");
    expect(result.status).toBe(REFUSED);
    expect(result.ran).toBe(false);
  });

  it("refuses rather than guesses when liveness cannot be established", () => {
    // A lock written by an older build: pid and nonce, no provenance. The pid
    // is alive, but nothing distinguishes it from a recycled number.
    holdSession({ pid: process.pid, nonce: "no-provenance" });

    const result = runGate("typecheck");
    expect(result.status).toBe(REFUSED);
    expect(result.ran).toBe(false);
    // And it must not quietly clear a lock it could not adjudicate.
    expect(result.stderr).toContain("will not remove");
    expect(existsSync(join(lock, "holder.json"))).toBe(true);
  });
});

describe("the wrapper reports the gate's own verdict", () => {
  it("propagates a failing gate's exit code unchanged", () => {
    const result = runGate("lint", { exitCode: 1 });
    expect(result.status).toBe(1);
    expect(result.ran).toBe(true);
  });

  it("uses an exit code a real gate failure cannot produce", () => {
    // A refusal must be distinguishable from a failure. If both were 1, a CI
    // log could not tell "the code is broken" from "the gate never ran".
    holdLiveSession("session-nonce");
    expect(runGate("lint", { exitCode: 1 }).status).toBe(REFUSED);
    expect(REFUSED).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("the gate surface is covered structurally", () => {
  const manifest = JSON.parse(
    readFileSync(join(REPO, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  const PROTECTED = [
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

  it.each(PROTECTED)("`%s` routes through the guard", (gate) => {
    const script = manifest.scripts[gate];
    expect(script, `no root script named ${gate}`).toBeDefined();
    expect(script).toContain(`scripts/run-gate.mjs ${gate} --`);
  });

  it("verify runs protected gates and nothing else", () => {
    // The control that survives someone adding a tenth gate: if `verify`
    // grows a step that is not a protected gate, this fails naming it.
    const steps = (manifest.scripts["verify"] ?? "")
      .split("&&")
      .map((step) => step.trim());

    for (const step of steps) {
      expect(step, `verify step is not an npm run: ${step}`).toMatch(
        /^npm run [\w:-]+$/,
      );
      expect(PROTECTED, `verify runs an unguarded step: ${step}`).toContain(
        step.replace("npm run ", ""),
      );
    }
    expect(steps).toHaveLength(PROTECTED.length);
  });

  it("names the same gates the guard module does", () => {
    // Two lists that must not drift: this test's expectations, and the list
    // the wrapper and documentation are written against.
    const source = readFileSync(
      join(REPO, "scripts", "mutation-session.mjs"),
      "utf8",
    );
    const declared = /export const PROTECTED_GATES = \[([\s\S]*?)\]/.exec(
      source,
    );
    expect(declared).not.toBeNull();
    const names = [...(declared?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(names).toEqual(PROTECTED);
  });
});
