/**
 * The two ways a base revision can quietly destroy the head text beside it.
 *
 * Both were live defects, not hypotheticals. Both were invisible: the context
 * simply contained less than it should, no omission was recorded, and every
 * existing test stayed green because no analyzer had yet needed both sides of
 * a comparison at once.
 *
 * They are kept here as adversarial evidence rather than as ordinary
 * regression tests, because the failure they describe is a *silent* one — the
 * pipeline goes on producing plausible reviews from half the inputs.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";

const REPO = "0192f8a1-0000-7000-8000-0000000000c0";
const SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const PATH = "src/parser.ts";

const BASE_TEXT = [
  "export function parse(raw: string): number {",
  "  return Number(raw);",
  "}",
].join("\n");

const HEAD_TEXT = [
  "function parse(raw: string): number {",
  "  return Number(raw);",
  "}",
  "export { parse as parseInternal };",
].join("\n");

function sourceOf(head: string, base: string): AnalysisSource {
  return {
    read: () =>
      Promise.resolve({
        changed: [
          {
            path: PATH,
            content: head,
            changedLines: [1, 2, 3, 4],
            base: { kind: "present", content: base },
          },
        ],
        repository: new Map([[PATH, head]]),
        baseSha: BASE_SHA,
      }),
  };
}

const review = (head: string, base: string) =>
  runRealAnalysis({
    repositoryId: REPO,
    headSha: SHA,
    tenantId: "tenant-1",
    source: sourceOf(head, base),
  });

describe("a base revision and its head text are two items, never one", () => {
  it("delivers BOTH semantic inputs for the same path", async () => {
    // The defect: deduplication identity is `path|startLine|endLine`, and
    // neither a base revision nor a changed file's full text carries a span.
    // They collided on `src/parser.ts|0|0`, the base was generated first, and
    // the head text was dropped — for every analyzer, not only comparison
    // ones.
    const outcome = await review(HEAD_TEXT, BASE_TEXT);

    const forPath = outcome.context.items.filter((item) => item.path === PATH);
    const base = forPath.find((item) => item.kind === "base_revision");
    const head = forPath.find(
      (item) => item.kind === "source_file" && item.reason === "changed_hunk",
    );

    expect(base?.suppliedContent).toBe(BASE_TEXT);
    expect(head?.suppliedContent).toBe(HEAD_TEXT);
  });

  it("records no omission, because nothing was legitimately omitted", async () => {
    // The original failure left no trace at all. Asserting the absence of an
    // omission pins that the fix restores the item rather than merely
    // reporting its loss more loudly.
    const outcome = await review(HEAD_TEXT, BASE_TEXT);

    expect(
      (outcome.context.omissions ?? []).filter(
        (omission) => omission.path === PATH,
      ),
    ).toEqual([]);
  });
});

describe("a base revision never collapses into a pointer at head text", () => {
  it("keeps its own content when the two revisions are byte-identical", async () => {
    // The more dangerous of the two, because the result looks like successful
    // deduplication. The assembler replaces text already supplied in full with
    // a pointer — and an unchanged file's base and head ARE identical, so the
    // base item would become a pointer to head material.
    //
    // A comparison capability would then be handed one revision twice and
    // conclude, every time, that nothing had changed.
    const outcome = await review(HEAD_TEXT, HEAD_TEXT);

    const base = outcome.context.items.find(
      (item) => item.path === PATH && item.kind === "base_revision",
    );

    expect(base).toBeDefined();
    expect(base?.suppliedContent).toBe(HEAD_TEXT);
    // Not a pointer. A pointer would name the other item instead of carrying
    // the revision's own text.
    expect(base?.suppliedContent).not.toMatch(/supplied in full|see /i);
  });

  it("still carries the head text alongside it", async () => {
    const outcome = await review(HEAD_TEXT, HEAD_TEXT);

    expect(
      outcome.context.items.filter(
        (item) =>
          item.path === PATH &&
          item.kind === "source_file" &&
          item.reason === "changed_hunk",
      ),
    ).toHaveLength(1);
  });
});
