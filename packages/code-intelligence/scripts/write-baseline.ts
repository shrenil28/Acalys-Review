/**
 * Regenerates `eval/planner-baseline.json`.
 *
 *     npm run eval:baseline -w @acalys/code-intelligence
 *
 * Regenerating is a deliberate act with a reviewable diff, never something the
 * test suite does for itself. A baseline that rewrites itself on failure records
 * whatever the planner happens to do today and can never detect a regression.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PLANNER_CORPUS, buildBaseline } from "../src/eval/index.js";

const output = fileURLToPath(
  new URL("../eval/planner-baseline.json", import.meta.url),
);
writeFileSync(
  output,
  `${JSON.stringify(buildBaseline(PLANNER_CORPUS), null, 2)}\n`,
  "utf8",
);
process.stdout.write(`Baseline written to ${output}\n`);
