/**
 * A published finding the corpus did not expect is a false positive.
 *
 * Epoch 3 places its precision pressure *inside* the primary family: every
 * primary case carries a planted reachability loss and, in the same base/head
 * pair, shapes that must be refused. That design only works if the scorer
 * compares sets — expected against published — rather than asking the weaker
 * question "did the expected finding appear?".
 *
 * If it asked only the weaker question, a run could publish the right finding
 * and three wrong ones and still score a clean case. The planted refutations
 * would be decorative, and the epoch would measure less than its author
 * intended.
 *
 * These fixtures are synthetic. No Epoch 3 case was read to write them.
 */

import { describe, expect, it } from "vitest";

import { observeCase } from "../src/eval/m2-evaluate.js";
import type { M1CapabilityCase } from "../src/eval/m1-corpus.js";

const CALLER = "src/route.ts";

/** A real, detectable discarded-replacement defect on line 3. */
const BASE_CALLER = [
  'import { validate } from "./validator.js";',
  "export function route(raw: string): string {",
  "  return validate(raw);",
  "}",
].join("\n");

const HEAD_CALLER = [
  'import { validate } from "./validator.js";',
  "export function route(raw: string): string {",
  "  validate(raw);",
  "  return raw;",
  "}",
].join("\n");

const VALIDATOR =
  "export function validate(raw: string): string {\n  return raw.trim();\n}";

/** The same case, with the expected finding declared wherever we choose. */
function caseExpecting(startLine: number, endLine: number): M1CapabilityCase {
  return {
    id: "synthetic-precision-pressure",
    split: "development",
    capabilityFamily: "returned_value_usage",
    baseFiles: { [CALLER]: BASE_CALLER, "src/validator.ts": VALIDATOR },
    headFiles: { [CALLER]: HEAD_CALLER, "src/validator.ts": VALIDATOR },
    changed: [{ path: CALLER, changedLines: [1, 2, 3, 4, 5] }],
    expectedFindings: [
      {
        id: "synthetic-expected",
        correctnessFamily: "data_flow",
        path: CALLER,
        startLine,
        endLine,
        summary: "the validator's normalized result is discarded",
      },
    ],
    because: "synthetic fixture for scorer semantics",
  };
}

describe("the scorer compares sets, not merely presence", () => {
  it("counts a publication at the expected location as a true positive", () => {
    // The premise. Without it, the assertion below could pass because nothing
    // was published at all.
    return observeCase(caseExpecting(3, 3)).then((observation) => {
      expect(observation.published).toBe(true);
      expect(observation.unexpectedPublished).toBe(0);
    });
  });

  it("counts a publication the corpus did not expect as a false positive", async () => {
    // Same code, same real defect, same publication — but the corpus says the
    // finding belongs on line 5. What was published is therefore a finding the
    // case did not ask for, and it must cost precision rather than being
    // ignored because some other assertion passed.
    const observation = await observeCase(caseExpecting(5, 5));

    expect(observation.published).toBe(false);
    expect(observation.unexpectedPublished).toBe(1);
  });

  it("a case can be a false negative and a false positive at once", async () => {
    // The shape Epoch 3's primary cases rely on: the expected finding is
    // missing AND something unexpected was published. A scorer that treated
    // these as mutually exclusive would report only one of them.
    const observation = await observeCase(caseExpecting(5, 5));

    expect(observation.published).toBe(false);
    expect(observation.unexpectedPublished).toBeGreaterThan(0);
  });
});
