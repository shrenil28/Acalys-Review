/**
 * The planner's context and the compiler's environment are not the same thing.
 *
 * ```
 * planner context      what a reader of the claim was shown as evidence
 * revision environment what TypeScript needs to compile the project faithfully
 * ```
 *
 * Collapsing the two was a live defect. The compatibility verifier built its
 * head file set from `context.items`, which is selected, budgeted and scoped
 * to the claimed location — so a module the planner had no reason to *show*
 * was also a module the compiler could not *resolve*.
 *
 * The fixture below is chosen so the difference has a verdict attached rather
 * than merely a smaller file list: the `export *` target exists in the
 * revision and is deliberately absent from the reading selection. A verifier
 * that compiles the selection reports a removal that did not happen.
 */

import { describe, expect, it } from "vitest";

import {
  planVerificationContext,
  verifyDeterministically,
} from "../src/index.js";
import type { VerificationInput } from "../src/verification/input.js";

const BOUNDARY = "src/parser.ts";
const TARGET = "src/impl.ts";
const SHA = "9".repeat(40);
const BASE_SHA = "8".repeat(40);

const DECLARATION =
  "export function parse(raw: string): number {\n  return Number(raw);\n}";

const CLAIM =
  "`parse` was exported from src/parser.ts at the base revision and no longer appears in its exported value surface.";

const inputFor = (): VerificationInput => ({
  candidateId: "revision-scope",
  repositoryId: "0192f8a1-0000-7000-8000-0000000000c1",
  revisionId: SHA,
  remediation: "Re-export `parse`.",
  claim: {
    statement: CLAIM,
    steps: [],
    trigger: "importing `parse` from src/parser.ts",
    consequence: "the consumer no longer compiles",
  },
  // Only the boundary. `src/impl.ts` is never cited, so the context planner
  // has no reason to select it — which is exactly the situation under test.
  location: { path: BOUNDARY, startLine: 1, endLine: 1 },
  evidence: [],
  proposedSeverity: "medium",
});

describe("the verifier compiles the revision, not the reading selection", () => {
  const HEAD = new Map([
    [BOUNDARY, 'export * from "./impl";'],
    [TARGET, DECLARATION],
  ]);
  const BASE = new Map([[BOUNDARY, DECLARATION]]);

  it("does not select the re-export target for reading", () => {
    // The premise of this whole file. If the planner happened to include
    // `src/impl.ts` anyway, the assertion below would pass for the wrong
    // reason and prove nothing about revision scope.
    const input = inputFor();
    const context = planVerificationContext({
      verificationInput: input,
      repository: { revisionId: SHA, files: HEAD },
      comparison: { revisionId: BASE_SHA, files: BASE },
    });

    expect(context.items.map((item) => item.path)).not.toContain(TARGET);
  });

  it("still REJECTS, because the revision contains what resolution needs", () => {
    const input = inputFor();
    const context = planVerificationContext({
      verificationInput: input,
      repository: { revisionId: SHA, files: HEAD },
      comparison: { revisionId: BASE_SHA, files: BASE },
    });

    const attempt = verifyDeterministically(input, context);

    expect(attempt.status).toBe("completed");
    if (attempt.status !== "completed") return;
    // A verifier compiling `context.items` sees `export * from "./impl"` with
    // no `./impl`, resolves nothing, and reports a removal that never
    // happened.
    expect(attempt.decision).toBe("rejected");
    expect(attempt.reasons).toContain("public_export_still_reachable");
  });

  it("carries the whole revision on the context, separate from the items", () => {
    const input = inputFor();
    const context = planVerificationContext({
      verificationInput: input,
      repository: { revisionId: SHA, files: HEAD },
      comparison: { revisionId: BASE_SHA, files: BASE },
    });

    expect(context.revision?.files.has(TARGET)).toBe(true);
    expect(context.revision?.revisionId).toBe(SHA);
    // And the comparison revision stays its own thing, never merged in.
    expect(context.comparison?.revisionId).toBe(BASE_SHA);
    expect(context.comparison?.files.has(TARGET)).toBe(false);
  });
});
