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
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { captureDiagnostics } from "./failure-diagnostics.mjs";

const started = Date.now();

/**
 * One identity for the whole run, inherited by every vitest fork.
 *
 * The Postgres harness names its shared container and its per-suite databases
 * from this. Without a shared value each fork would mint its own and boot its
 * own server, which is the nine-container arrangement that destabilised Docker
 * Desktop in the first place.
 */
process.env["ACALYS_TEST_RUN_ID"] ??= randomUUID();

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

// The run's container, removed once every fork has finished with it.
//
// Suites drop their own databases; only the parent knows when the last one is
// done, so the container is the parent's to remove. Selected by this run's
// label — never by "looks like a test container", which is the rule the 62GB
// volume incident paid for.
//
// `docker rm` takes ids, not filters. The first version passed `--filter`
// straight to it and printed `Run 'docker rm --help'` while leaving the
// container and its anonymous volume behind — the leak this checkpoint exists
// to reduce, reintroduced by its own cleanup.
try {
  const ids = execFileSync(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      `label=acalys.run=${process.env["ACALYS_TEST_RUN_ID"] ?? "none"}`,
    ],
    { encoding: "utf8", timeout: 15_000 },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  if (ids.length > 0) {
    execFileSync("docker", ["rm", "-f", "-v", "--", ...ids], {
      stdio: "ignore",
      timeout: 30_000,
    });
  }
} catch {
  // Best effort. The next run reaps by run label on its way in, which is the
  // path that has to work anyway — SIGKILL never reaches this line.
}

process.exit(failed ? (outcome.code ?? 1) : 0);
