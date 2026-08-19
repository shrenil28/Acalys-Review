import { describe, expect, it } from "vitest";

import { verifyAsyncCallbackContract } from "../src/verification/callback.js";
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

const at = (line: number): VerificationInput => ({
  candidateId: "c",
  claim: {
    statement: "`forEach` discards the promise its async callback returns.",
    steps: ["`forEach` ignores its callback's return value"],
    trigger: "the iteration runs",
    consequence: "the caller proceeds before the work finishes",
  },
  location: { path: "src/loop.ts", startLine: line, endLine: line },
  evidence: [],
  remediation: "await the work",
  revisionId: "r",
  repositoryId: "repo",
  proposedSeverity: "high",
});

const SAVE = "async function save(item: number): Promise<void> {\n  return;\n}";

const loop = (lines: readonly string[]): Record<string, string> => ({
  "src/loop.ts": [SAVE, ...lines].join("\n"),
});

describe("Async callback contract reads the receiver, not the name", () => {
  it("verifies when the receiver drops the promise and the caller proceeds", () => {
    const attempt = verifyAsyncCallbackContract(
      at(5),
      contextOf(
        loop([
          "export function run(items: number[]): void {",
          "  items.forEach(async (item) => {",
          "    await save(item);",
          "  });",
          "  done();",
          "}",
          "function done(): void {}",
        ]),
      ),
    );
    expect(attempt).toMatchObject({
      decision: "verified",
      reasons: ["callback_result_discarded_by_receiver"],
    });
  });

  it("refutes the identical call on a receiver that awaits its callback", () => {
    // ── The case a name-keyed rule gets wrong ─────────────────────────────
    //
    // Same syntax, same method name, opposite verdict. `Array.forEach` declares
    // its callback `void`; this `Queue.forEach` declares it returns a promise
    // and returns one itself. A rule matching on `forEach` would report a
    // defect inside someone's own abstraction, confidently and silently.
    const attempt = verifyAsyncCallbackContract(
      at(8),
      contextOf(
        loop([
          "interface Queue {",
          "  forEach(cb: (item: number) => Promise<void>): Promise<void>;",
          "}",
          "export async function run(q: Queue): Promise<void> {",
          "  await q.forEach(async (item) => {",
          "    await save(item);",
          "  });",
          "  done();",
          "}",
          "function done(): void {}",
        ]),
      ),
    );
    expect(attempt).toMatchObject({
      decision: "rejected",
      reasons: ["receiver_awaits_callback_result"],
    });
  });

  it("refutes `map`, which hands the promises back out", () => {
    // Nothing is dropped — the promises become the receiver's return value and
    // the caller awaits them. Distinguishing this from `forEach` needs the
    // declared contract; the shape is identical.
    const attempt = verifyAsyncCallbackContract(
      at(6),
      contextOf(
        loop([
          "export async function run(items: number[]): Promise<void> {",
          "  await Promise.all(",
          "    items.map(async (item) => {",
          "      await save(item);",
          "    }),",
          "  );",
          "}",
        ]),
      ),
    );
    expect(attempt).toMatchObject({ decision: "rejected" });
  });

  it("abstains when the promise is dropped but nothing depended on it", () => {
    // ── The two facts, kept apart ─────────────────────────────────────────
    //
    //     the callback's promise is ignored     language and API semantics
    //     that causes the claimed defect        correctness semantics
    //
    // Here the first holds and the second is unestablished: the enclosing
    // function returns a promise, so a caller CAN wait for it, and nothing
    // follows the iteration. Telemetry nobody waits for is not a defect, and
    // verifying on the language fact alone would publish it.
    const attempt = verifyAsyncCallbackContract(
      at(5),
      contextOf(
        loop([
          "export async function run(items: number[]): Promise<void> {",
          "  items.forEach(async (item) => {",
          "    await save(item);",
          "  });",
          "}",
        ]),
      ),
    );
    expect(attempt).toMatchObject({
      decision: "inconclusive",
      reasons: ["completion_relevance_unestablished"],
    });
  });

  it("abstains when the receiver's contract cannot be read", () => {
    const attempt = verifyAsyncCallbackContract(
      at(5),
      contextOf(
        loop([
          "export function run(x: { each(cb: unknown): unknown }): void {",
          "  x.each(async (item: number) => {",
          "    await save(item);",
          "  });",
          "  done();",
          "}",
          "function done(): void {}",
        ]),
      ),
    );
    expect(attempt).toMatchObject({
      decision: "inconclusive",
      reasons: ["receiver_contract_unavailable"],
    });
  });

  it("refutes when the callback is synchronous", () => {
    const attempt = verifyAsyncCallbackContract(
      at(5),
      contextOf({
        "src/loop.ts": [
          "function save(item: number): void {}",
          "export function run(items: number[]): void {",
          "  items.forEach((item) => {",
          "    save(item);",
          "  });",
          "  done();",
          "}",
          "function done(): void {}",
        ].join("\n"),
      }),
    );
    expect(attempt).toMatchObject({
      decision: "rejected",
      reasons: ["callback_returns_no_promise"],
    });
  });
});
