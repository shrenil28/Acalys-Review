/**
 * Evidence gathered only when a run terminates abnormally.
 *
 * One `test:ci` run exited non-zero with no test failure reported, then passed
 * five times. That shape — a non-zero exit with no normal failure output — is
 * consistent with several unrelated causes, and nothing on record distinguishes
 * them:
 *
 * ```
 * Vitest reported failures            a product or test problem
 * the wrapper itself failed           tooling
 * the child was killed by a signal    OOM, or something reaping it
 * a container never became ready      Docker startup
 * the disk or memory ran out          resource exhaustion
 * ```
 *
 * The point is not more logging. It is that if it happens again, the recording
 * is enough to tell those apart — because the tempting response to an
 * unexplained slow-or-failed startup is to raise the timeout, and that converts
 * a real deadlock or resource bug into a slower flaky suite.
 *
 * # What is deliberately not captured
 *
 * No environment variables, no process arguments beyond the command name, no
 * request headers, no connection strings. A diagnostic bundle is written to
 * disk and may be attached to an issue; a secret in it is a secret published.
 * Everything here is either a Docker object's own state or a host resource
 * figure.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Runs a command, returning its output or a marker. Never throws. */
function probe(command, args, { limit = 4000 } = {}) {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.length > limit
      ? `${output.slice(0, limit)}\n…[truncated]`
      : output;
  } catch (error) {
    return `[unavailable: ${error.code ?? error.message ?? "unknown"}]`;
  }
}

/**
 * Whether Docker can actually serve a request.
 *
 * `docker ps`, not `docker info`. The distinction was not hypothetical: the
 * daemon can answer metadata queries while its backend VM is dead, so an
 * `info`-based check reports a healthy Docker to a suite that is about to fail
 * on every real operation.
 */
function dockerAvailable() {
  try {
    execFileSync("docker", ["ps", "-q"], {
      stdio: "ignore",
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every Acalys test container's own account of itself.
 *
 * `OOMKilled` and `ExitCode` are the two fields that separate "the container
 * was slow" from "the container was killed", which is the distinction that
 * decides whether a longer timeout is a fix or a disguise.
 */
function containers() {
  if (!dockerAvailable()) return "[docker daemon unavailable]";

  const listed = probe("docker", [
    "ps",
    "-aq",
    "--filter",
    "label=acalys.test=true",
  ]);

  // A failed probe returns a marker, not ids. Without this guard the marker
  // was split on newlines and each LINE passed to `docker inspect` as a
  // container id — the first captured bundle nested the same daemon error four
  // levels deep and buried the one line that mattered.
  if (listed.startsWith("[unavailable")) {
    return `[container listing failed]\n${listed}`;
  }

  const ids = listed.trim().split("\n").filter(Boolean);
  if (ids.length === 0) return "[no acalys test containers present]";

  return ids
    .map((id) => {
      const state = probe("docker", [
        "inspect",
        "--format",
        [
          "name={{.Name}}",
          "created={{.Created}}",
          "started={{.State.StartedAt}}",
          "finished={{.State.FinishedAt}}",
          "status={{.State.Status}}",
          "exit={{.State.ExitCode}}",
          "oom={{.State.OOMKilled}}",
          "restarts={{.RestartCount}}",
          'suite={{index .Config.Labels "acalys.suite"}}',
          'run={{index .Config.Labels "acalys.run"}}',
        ].join(" "),
        id,
      ]).trim();
      // Bounded: enough to see a startup failure, not enough to bury it.
      const logs = probe("docker", ["logs", "--tail", "40", id], {
        limit: 3000,
      });
      return `── ${id}\n${state}\n${logs}`;
    })
    .join("\n\n");
}

export function captureDiagnostics(outcome) {
  const bundle = [
    "# Acalys test-run failure diagnostics",
    "",
    `captured: ${new Date().toISOString()}`,
    "",
    "## Termination",
    `wrapper exit code : ${String(outcome.wrapperExitCode ?? "n/a")}`,
    `child exit code   : ${String(outcome.childExitCode ?? "n/a")}`,
    `terminating signal: ${String(outcome.signal ?? "none")}`,
    `wall duration ms  : ${String(outcome.durationMs ?? "n/a")}`,
    `phase reached     : ${outcome.phase ?? "unknown"}`,
    "",
    "## Docker",
    `daemon reachable  : ${String(dockerAvailable())}`,
    "",
    "### Acalys test containers",
    containers(),
    "",
    "### Docker disk",
    probe("docker", ["system", "df"]),
    "",
    "## Host resources",
    "### Filesystem",
    probe("df", ["-h", "/"]),
    "### Memory",
    probe("free", ["-m"]),
    "",
  ].join("\n");

  const directory = join(process.cwd(), ".diagnostics");
  mkdirSync(directory, { recursive: true });
  const path = join(
    directory,
    `test-ci-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
  );
  writeFileSync(path, bundle);
  return path;
}
