/**
 * P1-M.3.3 — where a removal is published, and on what evidence.
 *
 * M.3's sealed holdout published a false positive whose semantics were
 * entirely correct: `decode` really had stopped being public, and the reviewer
 * was sent to line 1 of a two-line file because `removedExportCandidate`
 * hardcoded the anchor. Correct detection that points at the wrong change is
 * still a broken code review.
 *
 * These fixtures are generalized from the defect rather than copied from the
 * spent holdout case. In particular the export is placed at several different
 * lines, so that `2` cannot quietly become the constant that `1` used to be.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import {
  EXPORT_REACHABILITY_RULE_ID,
  type CandidateFinding,
} from "@acalys/review-engine";

const REPO = "0192f8a1-0000-7000-8000-0000000000a3";
const SHA = "3".repeat(40);
const BASE_SHA = "4".repeat(40);
const PATH = "src/codec.ts";

const DECL = "function decode(raw: string): string {\n  return raw;\n}";

function sourceOf(base: string, head: string): AnalysisSource {
  return {
    read: () =>
      Promise.resolve({
        changed: [
          {
            path: PATH,
            content: head,
            changedLines: Array.from({ length: 40 }, (_, i) => i + 1),
            base: { kind: "present", content: base },
          },
        ],
        repository: new Map([[PATH, head]]),
        baseSha: BASE_SHA,
      }),
  };
}

async function review(base: string, head: string) {
  const outcome = await runRealAnalysis({
    repositoryId: REPO,
    headSha: SHA,
    tenantId: "tenant-1",
    source: sourceOf(base, head),
  });
  return {
    removals: outcome.report.findings.filter(
      (finding: CandidateFinding) =>
        finding.ruleId === EXPORT_REACHABILITY_RULE_ID,
    ),
    degradations: outcome.report.degradations,
  };
}

/** `n` filler lines, so the export can be placed at an arbitrary line. */
const pad = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `const filler${String(i)} = ${String(i)};`,
  ).join("\n");

describe("the anchor is the export statement, wherever it is", () => {
  it.each([2, 7, 12, 21])(
    "publishes at line %i when the alias rename is there",
    async (line) => {
      // `line` is where the head's export statement sits. A hardcoded 1 — or a
      // hardcoded 2 — fails every row but its own.
      const filler = pad(line - 1);
      const base = `${filler}\nexport { decode };\n${DECL}`;
      const head = `${filler}\nexport { decode as decodeInternal };\n${DECL}`;

      const { removals } = await review(base, head);

      expect(removals).toHaveLength(1);
      expect(removals[0]?.location).toEqual({
        path: PATH,
        startLine: line,
        endLine: line,
        side: "head",
      });
    },
  );

  it("anchors on the `export function` line when that is the export", async () => {
    const base = `${pad(4)}\nexport function decode(raw: string): string {\n  return raw;\n}`;
    const head = `${pad(4)}\nfunction decode(raw: string): string {\n  return raw;\n}\nexport { decode as decodeInternal };`;

    const { removals } = await review(base, head);

    // The head statement that decides the surface is the aliased re-export on
    // the last line, not the declaration that merely survived.
    expect(removals[0]?.location.startLine).toBe(8);
  });

  it("carries the anchor's evidence in the finding", async () => {
    const base = `${pad(3)}\nexport { decode };\n${DECL}`;
    const head = `${pad(3)}\nexport { decode as decodeInternal };\n${DECL}`;

    const { removals } = await review(base, head);

    expect(
      removals[0]?.evidence.some((entry) =>
        entry.observation.includes("The published location is established"),
      ),
    ).toBe(true);
  });
});

describe("a pure deletion is anchored on the side it happened", () => {
  it("publishes at the deleted statement, on the base side", async () => {
    // M.3.3 withheld this, because at the time the publication surface had no
    // side and inventing a head line was the only alternative. That made the
    // capability semantically correct and systematically unpublishable for
    // its own defect class — a deletion is exactly where the truthful
    // coordinate lives only in base.
    const base = `${pad(3)}\nexport { decode };\n${DECL}`;
    const head = `${pad(3)}\n${DECL}`;

    const { removals } = await review(base, head);

    expect(removals).toHaveLength(1);
    expect(removals[0]?.location).toEqual({
      path: PATH,
      startLine: 4,
      endLine: 4,
      side: "base",
    });
  });

  it("still never invents a head line for it", async () => {
    // The invariant that did not change. The anchor moved sides; it was not
    // fabricated.
    const base = `${pad(3)}\nexport { decode };\n${DECL}`;
    const head = `${pad(3)}\n${DECL}`;

    const { removals } = await review(base, head);

    expect(removals[0]?.location.side).not.toBe("head");
    expect(removals[0]?.location.startLine).not.toBe(1);
  });
});

describe("the anchor follows the public boundary, not an internal declaration", () => {
  it("points at the re-export that decides visibility", async () => {
    // The internal declaration moved to another module. What changed the
    // public surface is the wholesale re-export, and that is the coordinate a
    // reader needs.
    const base = `${pad(2)}\nexport { decode };\n${DECL}`;
    const head = `${pad(2)}\nexport * from "./impl";`;

    const { removals } = await review(base, head);

    expect(removals).toHaveLength(1);
    // Side as well as line, because they coincide here. The base
    // `export { decode };` and the head `export * from "./impl";` both sit on
    // line 3, so a resolver that skipped the wholesale branch and fell through
    // to the base statement would produce the same number on the other side of
    // the diff — right coordinate, wrong revision, and invisible to a
    // line-only assertion.
    expect(removals[0]?.location).toEqual({
      path: PATH,
      startLine: 3,
      endLine: 3,
      side: "head",
    });
  });
});
