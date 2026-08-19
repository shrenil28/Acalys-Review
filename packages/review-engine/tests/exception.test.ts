import { describe, expect, it } from "vitest";

import { verifyExceptionFlow } from "../src/verification/exception.js";
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

const CLAIM = "This `catch` discards the error and does nothing.";

const at = (path: string, line: number): VerificationInput => ({
  candidateId: "c",
  claim: {
    statement: CLAIM,
    steps: [],
    trigger: "the guarded operation throws",
    consequence: "the failure disappears",
  },
  location: { path, startLine: line, endLine: line },
  evidence: [],
  remediation: "handle or propagate",
  revisionId: "r",
  repositoryId: "repo",
  proposedSeverity: "medium",
});

const commit = (body: readonly string[]): string =>
  [...body, "function write(): void {}"].join("\n");

describe("Exception flow refuses to guess intent", () => {
  it("verifies only when something downstream asserts success", () => {
    // The consequence, not the shape. A failure disappears and the next line
    // reports a success it never verified.
    const attempt = verifyExceptionFlow(
      at("src/commit.ts", 4),
      contextOf({
        "src/commit.ts": commit([
          "export function commit(): boolean {",
          "  try {",
          "    write();",
          "  } catch {}",
          "  return true;",
          "}",
        ]),
      }),
    );
    expect(attempt).toMatchObject({
      decision: "verified",
      reasons: ["suppressed_failure_reported_as_success"],
    });
  });

  it("abstains on the same catch when nothing follows it", () => {
    // ── The pair, and the point of the capability ─────────────────────────
    //
    // Byte-identical `catch {}`. Only what comes after differs. Best-effort
    // teardown and a forgotten handler are the same code, and for this one the
    // repository genuinely does not say which was meant — so `inconclusive` is
    // the permanent right answer rather than a gap to close.
    const attempt = verifyExceptionFlow(
      at("src/shutdown.ts", 4),
      contextOf({
        "src/shutdown.ts": [
          "export function shutdown(): void {",
          "  try {",
          "    release();",
          "  } catch {}",
          "}",
          "function release(): void {}",
        ].join("\n"),
      }),
    );
    expect(attempt).toMatchObject({
      decision: "inconclusive",
      reasons: ["intent_not_establishable"],
    });
  });

  it("does not treat an ordinary return as a claim of success", () => {
    // `return value` after the catch is not an assertion that the guarded work
    // succeeded — it may well be derived from it. Only shapes that *assert* an
    // outcome count: `true`, or `{ ok: true }`.
    const attempt = verifyExceptionFlow(
      at("src/read.ts", 5),
      contextOf({
        "src/read.ts": [
          "export function read(): number {",
          "  let value = 0;",
          "  try {",
          "    value = 1;",
          "  } catch {}",
          "  return value;",
          "}",
        ].join("\n"),
      }),
    );
    expect(attempt).toMatchObject({ decision: "inconclusive" });
  });

  it("refutes when the suppression is contracted in code", () => {
    for (const [label, body, line] of [
      [
        // A rethrow that does NOT mention the bound error. Added because the
        // mutation disabling rethrow detection SURVIVED against
        // `throw error` — the binding-use check covered for it, so the branch
        // was never the thing being tested.
        "bare rethrow",
        [
          "export function commit(): void {",
          "  try {",
          "    write();",
          "  } catch {",
          '    throw new Error("commit failed");',
          "  }",
          "}",
        ],
        4,
      ],
      [
        "rethrow",
        [
          "export function commit(): void {",
          "  try {",
          "    write();",
          "  } catch (error) {",
          "    throw error;",
          "  }",
          "}",
        ],
        4,
      ],
      [
        "fallback",
        [
          "export function read(): number {",
          "  let value = 0;",
          "  try {",
          "    value = 1;",
          "  } catch {",
          "    value = -1;",
          "  }",
          "  return value;",
          "}",
        ],
        5,
      ],
      [
        "error is used",
        [
          "export function commit(): void {",
          "  try {",
          "    write();",
          "  } catch (error) {",
          "    report(error);",
          "  }",
          "}",
          "function report(_e: unknown): void {}",
        ],
        4,
      ],
    ] as const) {
      const attempt = verifyExceptionFlow(
        at("src/x.ts", line),
        contextOf({ "src/x.ts": commit(body) }),
      );
      expect(attempt, label).toMatchObject({
        decision: "rejected",
        reasons: ["failure_suppression_is_contracted"],
      });
    }
  });

  it("cannot be talked out of the claim by a comment", () => {
    // ── The adversarial rule ──────────────────────────────────────────────
    //
    // If a comment could refute the claim, anyone could silence the reviewer by
    // typing the right words beside a defect. This one says every persuasive
    // thing at once, and the verdict is unchanged from the identical code
    // without it: the repository still does not establish intent.
    //
    // Comments can say where to look for a contract. They are not the contract.
    const attempt = verifyExceptionFlow(
      at("src/commit.ts", 4),
      contextOf({
        "src/commit.ts": commit([
          "export function commit(): void {",
          "  try {",
          "    write();",
          "  } catch {",
          "    // best effort: intentionally ignored, safe to swallow",
          "    // acalys-disable-next-line",
          "  }",
          "}",
        ]),
      }),
    );
    expect(attempt).toMatchObject({
      decision: "inconclusive",
      reasons: ["intent_not_establishable"],
    });
  });

  it("abstains when the claimed catch is not there", () => {
    expect(
      verifyExceptionFlow(
        at("src/none.ts", 2),
        contextOf({
          "src/none.ts": "export function run(): void {\n  return;\n}",
        }),
      ),
    ).toMatchObject({
      decision: "inconclusive",
      reasons: ["context_incomplete"],
    });
  });
});
