/**
 * The one door every repository-wide gate goes through.
 *
 * ```
 * node scripts/run-gate.mjs <gate-name> -- <command> [args...]
 * ```
 *
 * Checks the mutation-session interlock, then execs the real gate and
 * propagates its exit code unchanged. Nothing else — a wrapper that
 * interpreted a gate's output would become a second place gate semantics
 * live, and the first thing to drift.
 *
 * # Why a wrapper rather than a check inside each gate
 *
 * Four of the nine gates are third-party binaries (`tsc`, `eslint`,
 * `prettier`, `depcruise`). There is no "inside" to add a check to, so the
 * choice was between guarding some gates and guarding all of them through one
 * entry point. Uniformity also makes the control checkable: a test reads
 * `verify`'s command chain and asserts every element routes through this
 * file, which is a claim about the whole gate surface rather than about the
 * gates someone remembered.
 *
 * # The nonce is forwarded, not consumed
 *
 * `ACALYS_MUTATION_SESSION` passes through to the child untouched, so a gate
 * that runs other gates (`verify`, or `typecheck` fanning out across
 * workspaces) stays authorized the whole way down. Without that, the harness
 * could start a run and have it refused three levels deep by its own lock.
 */

import { spawn } from "node:child_process";
import { assertGateAllowed } from "./mutation-session.mjs";

const separator = process.argv.indexOf("--");
const gate = process.argv[2];

if (gate === undefined || separator === -1 || separator < 3) {
  console.error(
    "usage: node scripts/run-gate.mjs <gate-name> -- <command> [args...]",
  );
  process.exit(2);
}

const [command, ...args] = process.argv.slice(separator + 1);

if (command === undefined) {
  console.error(`run-gate: no command given for gate '${gate}'`);
  process.exit(2);
}

assertGateAllowed(gate, process.env["ACALYS_MUTATION_SESSION"]);

const child = spawn(command, args, {
  stdio: "inherit",
  // npm and npx are shell scripts on some platforms; on Linux they are not,
  // but `shell: false` keeps argument quoting out of the picture entirely.
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  console.error(`run-gate: could not start '${command}': ${error.message}`);
  process.exit(2);
});

child.on("exit", (code, signal) => {
  // A signalled child has no exit code. Reporting 0 there would turn a killed
  // gate into a passing one — the exact shape of failure this checkpoint
  // exists to prevent.
  if (signal !== null) {
    console.error(`run-gate: '${gate}' was terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
