/**
 * The enumeration rule, made executable.
 *
 * These fixtures are synthetic. No Epoch 2 case was read to write them, and
 * none needs to be: the rule comes from M.3.3's lesson, not from anything the
 * sealed corpus happens to contain.
 *
 * The load-bearing assertion is the middle one. Allowed anchors at lines 3 and
 * 7 make line 5 wrong, even though every hull-based scorer accepts it.
 */

import { describe, expect, it } from "vitest";

import {
  anchorMatches,
  hullOf,
  type AllowedAnchor,
} from "../src/eval/anchor-scoring.js";

const PATH = "src/codec.ts";
const at = (line: number, side?: "base" | "head") => ({
  path: PATH,
  startLine: line,
  endLine: line,
  ...(side === undefined ? {} : { side }),
});

/** Two separate one-line alternatives, with a gap between them. */
const SPLIT: readonly AllowedAnchor[] = [
  { path: PATH, startLine: 3, endLine: 3 },
  { path: PATH, startLine: 7, endLine: 7 },
];

describe("policy 2 — a candidate must match one enumerated anchor", () => {
  it.each([3, 7])("accepts line %i, which is enumerated", (line) => {
    expect(anchorMatches(at(line), SPLIT, 2)).toBe(true);
  });

  it("REJECTS line 5, which is inside the hull and inside no anchor", () => {
    // The whole point. Line 5 is not a place the defect is; accepting it would
    // reproduce the Epoch 1 anchoring defect in the machinery built to catch
    // it.
    expect(anchorMatches(at(5), SPLIT, 2)).toBe(false);
  });

  it.each([2, 4, 6, 8])("REJECTS neighbouring line %i", (line) => {
    // Off-by-one in either direction, on both sides of both anchors. A scorer
    // that widened each anchor by a line would pass the assertion above.
    expect(anchorMatches(at(line), SPLIT, 2)).toBe(false);
  });

  it("proves the hull really does contain the rejected line", () => {
    // Without this, "rejects line 5" could pass because line 5 was outside
    // everything, and the test would be true of nothing interesting.
    const hull = hullOf(SPLIT);
    expect(hull).toEqual({ startLine: 3, endLine: 7 });
    expect(anchorMatches(at(5), SPLIT, 1)).toBe(true);
  });
});

describe("policy 1 — historical behaviour, preserved not improved", () => {
  it("accepts anything overlapping the hull, defect included", () => {
    // Epoch 1 and the historical corpus were scored this way. Recomputing them
    // under policy 2 would improve numbers nobody re-measured.
    expect(anchorMatches(at(4), SPLIT, 1)).toBe(true);
    expect(anchorMatches(at(5), SPLIT, 1)).toBe(true);
    expect(anchorMatches(at(6), SPLIT, 1)).toBe(true);
  });

  it("still rejects outside the hull", () => {
    expect(anchorMatches(at(2), SPLIT, 1)).toBe(false);
    expect(anchorMatches(at(8), SPLIT, 1)).toBe(false);
  });

  it("differs from policy 2 on exactly the gap", () => {
    // The two policies must not have quietly converged.
    const gap = [4, 5, 6];
    for (const line of gap) {
      expect(anchorMatches(at(line), SPLIT, 1)).toBe(true);
      expect(anchorMatches(at(line), SPLIT, 2)).toBe(false);
    }
  });
});

describe("every alternative counts, not merely the first", () => {
  it("accepts the last enumerated anchor", () => {
    const many: readonly AllowedAnchor[] = [
      { path: PATH, startLine: 3, endLine: 3 },
      { path: PATH, startLine: 7, endLine: 7 },
      { path: PATH, startLine: 11, endLine: 11 },
    ];

    // A scorer checking only `allowed[0]` passes the line-3 case and fails
    // here.
    expect(anchorMatches(at(11), many, 2)).toBe(true);
  });
});

describe("a range inside one anchor is still one location", () => {
  it("accepts a candidate overlapping a genuine multi-line anchor", () => {
    // An allowed anchor may legitimately span a two-line statement. Overlap
    // within a single anchor is fine; overlap across separate alternatives is
    // what is forbidden.
    const ranged: readonly AllowedAnchor[] = [
      { path: PATH, startLine: 3, endLine: 4 },
    ];

    expect(anchorMatches(at(3), ranged, 2)).toBe(true);
    expect(anchorMatches(at(4), ranged, 2)).toBe(true);
    expect(anchorMatches(at(5), ranged, 2)).toBe(false);
  });
});

describe("path and side are part of the anchor", () => {
  it("rejects the right line in the wrong file", () => {
    expect(
      anchorMatches(
        { path: "src/other.ts", startLine: 3, endLine: 3 },
        SPLIT,
        2,
      ),
    ).toBe(false);
  });

  it("rejects the right line on the wrong side, where side matters", () => {
    const sided: readonly AllowedAnchor[] = [
      { path: PATH, startLine: 3, endLine: 3, side: "base" },
    ];

    expect(anchorMatches(at(3, "base"), sided, 2)).toBe(true);
    expect(anchorMatches(at(3, "head"), sided, 2)).toBe(false);
  });

  it("does not constrain the side when the corpus expresses none", () => {
    // Most of the corpus predates the distinction, and inventing a constraint
    // would fail cases that were never about sides.
    expect(anchorMatches(at(3, "base"), SPLIT, 2)).toBe(true);
    expect(anchorMatches(at(3, "head"), SPLIT, 2)).toBe(true);
  });

  it("treats an unstated published side as head", () => {
    const sided: readonly AllowedAnchor[] = [
      { path: PATH, startLine: 3, endLine: 3, side: "head" },
    ];

    expect(anchorMatches(at(3), sided, 2)).toBe(true);
  });
});

describe("an empty enumeration allows nothing", () => {
  it("rejects rather than vacuously accepting", () => {
    // A corpus case with no allowed anchors is a defect in the corpus. It must
    // not read as "anywhere is fine".
    expect(anchorMatches(at(3), [], 2)).toBe(false);
    expect(anchorMatches(at(3), [], 1)).toBe(false);
  });
});
