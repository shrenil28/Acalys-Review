/**
 * `test:ci`, with evidence preserved when it terminates abnormally.
 *
 * Adds nothing to a passing run and changes no timeout. Its whole purpose is
 * that the next unexplained non-zero exit is diagnosable rather than dismissed
 * — the previous one passed five times afterwards and remains unexplained,
 * which is not the same as fixed.
 *
 * The distinction this preserves, and which the bare npm script could not:
 *
 * ```
 * vitest exited non-zero      tests failed, or vitest itself did
 * vitest was killed           signal, OOM, an external reaper
 * the skip assertion failed   a suite silently did not run
 * ```
 */
import { spawn } from "node:child_process";
import { captureDiagnostics } from "./failure-diagnostics.mjs";

const started = Date.now();

function run(command, args, phase) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("close", (code, signal) => {
      resolve({ code, signal, phase });
    });
    child.on("error", (error) => {
      resolve({ code: null, signal: null, phase, error: error.message });
    });
  });
}

const vitest = await run(
  "node",
  [
    "./node_modules/vitest/vitest.mjs",
    "run",
    "--reporter=json",
    "--outputFile=.vitest-report.json",
  ],
  "vitest",
);

let outcome = vitest;

if (vitest.code === 0 && vitest.signal === null) {
  outcome = await run(
    "node",
    ["scripts/assert-no-skipped-tests.mjs", ".vitest-report.json"],
    "skip-assertion",
  );
}

const failed = outcome.code !== 0 || outcome.signal !== null;

if (failed) {
  const path = captureDiagnostics({
    wrapperExitCode: outcome.code ?? 1,
    childExitCode: outcome.code,
    signal: outcome.signal,
    durationMs: Date.now() - started,
    phase: outcome.phase,
  });
  console.error(
    `\ntest:ci terminated abnormally during ${outcome.phase}` +
      `${outcome.signal === null ? "" : ` (signal ${outcome.signal})`}.` +
      `\nDiagnostics written to ${path}` +
      "\n\nA non-zero exit with no reported test failure is not the same as a " +
      "flaky suite. Read the bundle before raising any timeout: a longer wait " +
      "turns a deadlock or a resource exhaustion bug into a slower flaky suite.",
  );
}

process.exit(failed ? (outcome.code ?? 1) : 0);
