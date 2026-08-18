/**
 * Fails the run when any test was skipped, todo, or never executed.
 *
 * This exists because of a real incident. A Postgres suite silently reported
 * all ten of its tests as *skipped* whenever it ran beside another one: test
 * container ports were derived from a 90-slot hash of the suite label, two
 * labels collided, the container failed to start, and vitest renders tests
 * inside a failed `beforeAll` as skipped.
 *
 * The damage was not the flaky port. It was that four mutation runs were read
 * as "mutation killed" when the failing suite had never executed the mutated
 * code at all. **A non-zero exit is not evidence that the intended test ran and
 * failed for the intended reason.**
 *
 * So the count is machine-checked rather than left for someone to notice in a
 * summary line — which is precisely what did not happen last time.
 */

import { readFileSync } from "node:fs";

const [, , reportPath] = process.argv;
if (reportPath === undefined) {
  console.error("usage: assert-no-skipped-tests.mjs <vitest-json-report>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const tests = (report.testResults ?? []).flatMap((file) =>
  (file.assertionResults ?? []).map((test) => ({
    title: test.fullName ?? test.title,
    status: test.status,
  })),
);

if (tests.length === 0) {
  console.error(
    "No tests were reported. A suite that runs nothing cannot report success.",
  );
  process.exit(1);
}

const notRun = tests.filter(
  (test) => test.status !== "passed" && test.status !== "failed",
);

if (notRun.length > 0) {
  console.error(
    `\n${notRun.length} test(s) did not execute. A skipped test proves nothing,\n` +
      "and a suite that skips silently is how a mutation run reports a kill it\n" +
      "never earned.\n",
  );
  for (const test of notRun.slice(0, 25)) {
    console.error(`  [${test.status}] ${test.title}`);
  }
  process.exit(1);
}

console.log(`All ${tests.length} tests executed; 0 skipped.`);
