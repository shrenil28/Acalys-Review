import { describe, expect, it } from "vitest";

import { verifyConditionValue } from "../src/verification/condition.js";
import { assessCompetence } from "../src/index.js";
import type { VerificationContext, VerificationInput } from "../src/index.js";

const contextOf = (files: Record<string, string>): VerificationContext => ({
  items: Object.entries(files).map(([path, content]) => ({
    path,
    content,
    reason: "unit",
  })),
  digest: "unit",
  incomplete: false,
});

const claimAt = (
  statement: string,
  path: string,
  line: number,
): VerificationInput => ({
  candidateId: "c",
  claim: { statement, steps: [], trigger: "the branch runs", consequence: "x" },
  location: { path, startLine: line, endLine: line },
  evidence: [],
  remediation: "await it",
  revisionId: "r",
  repositoryId: "repo",
  proposedSeverity: "high",
});

const CLAIM =
  "`enabled()` returns a promise and is used directly as a condition, so the guard never fails";

/** A gate whose condition is always on line 5, so claims can point at it. */
const gate = (declaration: string, condition: string): string =>
  [
    declaration, // three lines
    "export function run(): void {",
    `  if (${condition}) {`,
    "    return;",
    "  }",
    "}",
  ].join("\n");

const CONDITION_LINE = 5;

describe("Condition-value semantics answers one proposition", () => {
  it("verifies only when every decisive fact is established", () => {
    const attempt = verifyConditionValue(
      claimAt(CLAIM, "src/gate.ts", CONDITION_LINE),
      contextOf({
        "src/gate.ts": gate(
          "async function enabled(): Promise<boolean> {\n  return false;\n}",
          "enabled()",
        ),
      }),
    );
    expect(attempt).toMatchObject({
      decision: "verified",
      reasons: ["condition_branches_on_promise"],
    });
  });

  it("refutes the identical shape when the callee is synchronous", () => {
    // Byte-identical condition. Only the declaration differs, which is what
    // makes this the pair: a capability keyed on the `if (call())` shape would
    // verify both and score well on the positive half alone.
    const attempt = verifyConditionValue(
      claimAt(CLAIM, "src/gate.ts", CONDITION_LINE),
      contextOf({
        "src/gate.ts": gate(
          "function enabled(): boolean {\n  return false;\n}",
          "enabled()",
        ),
      }),
    );
    expect(attempt).toMatchObject({
      decision: "rejected",
      reasons: ["condition_value_is_not_a_promise"],
    });
  });

  it("refutes an awaited condition even though the declaration is async", () => {
    // The case a declaration-based check gets wrong. `enabled` really is
    // `async`; the branch simply never sees the promise. The unwrap is
    // observed at the site rather than inferred from the claim's wording.
    const attempt = verifyConditionValue(
      claimAt(CLAIM, "src/gate.ts", CONDITION_LINE),
      contextOf({
        "src/gate.ts": gate(
          "async function enabled(): Promise<boolean> {\n  return false;\n}",
          "await enabled()",
        ),
      }),
    );
    expect(attempt).toMatchObject({ decision: "rejected" });
  });

  it("abstains when the callee cannot be bound", () => {
    // Not "probably async". The pressure on this capability will be to raise
    // recall, and guessed typing is how that pressure gets released quietly.
    const attempt = verifyConditionValue(
      claimAt(CLAIM, "src/gate.ts", 2),
      contextOf({
        "src/gate.ts": [
          "export function run(source: { ready: () => unknown }): void {",
          '  if (source["ready"]()) {',
          "    return;",
          "  }",
          "}",
        ].join("\n"),
      }),
    );
    expect(attempt).toMatchObject({
      decision: "inconclusive",
      reasons: ["insufficient_evidence"],
    });
  });

  it("abstains when no branch covers the claimed line", () => {
    const attempt = verifyConditionValue(
      claimAt(CLAIM, "src/gate.ts", 2),
      contextOf({
        "src/gate.ts": "export function run(): void {\n  return;\n}",
      }),
    );
    expect(attempt).toMatchObject({
      decision: "inconclusive",
      reasons: ["context_incomplete"],
    });
  });

  it("is not the capability for an async callback handed to forEach", () => {
    // ── The narrowness check, asserted rather than trusted ────────────────
    //
    // `items.forEach(async …)` is an async defect and is NOT this proposition.
    // It is about a callback contract and an iterator discarding the promise it
    // is handed; truthiness has nothing to do with it.
    //
    // Written as a test because "control flow" is a name that invites exactly
    // this widening, and the funnel would look better for a while if it
    // happened — one more published finding, from a capability that had stopped
    // knowing what it was checking.
    expect(
      assessCompetence(
        claimAt(
          "`save()` is called for each item without awaiting completion, so the loop finishes before the work does",
          "src/loop.ts",
          3,
        ),
      ),
    ).not.toMatchObject({ capability: "condition_value_semantics" });
  });
});
