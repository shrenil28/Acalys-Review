import { describe, expect, it } from "vitest";

import type { TriagePr } from "../src/data/review.js";
import type { DisplayState } from "../src/pages/review/TriageControls.js";
import { compare } from "../src/pages/review/ordering.js";

const pr = (overrides: Partial<TriagePr>): TriagePr =>
  ({
    id: "1",
    number: 1,
    title: "t",
    summary: "s",
    repo: "r",
    author: "a",
    reviewers: [],
    priority: "P2",
    reviewState: "Needs review",
    reviewGuidance: "",
    changeType: "Fix",
    risk: "Medium",
    securityRisk: "Low",
    blastRadius: 10,
    reviewEffort: 10,
    issueSeverity: "None",
    additions: 0,
    deletions: 0,
    comments: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    authoredByMe: false,
    needsMyReview: false,
    labels: [],
    ...overrides,
  });

const display = (
  ordering: DisplayState["ordering"],
  direction: DisplayState["direction"] = "asc",
): DisplayState => ({ ordering, direction }) as DisplayState;

/**
 * Which pull request a reviewer sees first.
 *
 * Worth testing because it fails silently: a wrong order looks like a list.
 */
describe("Triage ordering", () => {
  it("ranks priority by severity, not alphabetically", () => {
    // "P1" < "Safe to close" as strings, and the intended order is by urgency.
    const urgent = pr({ priority: "P1" });
    const safe = pr({ priority: "Safe to close" });
    expect(compare(urgent, safe, display("priority"))).toBeLessThan(0);
  });

  it("ranks risk High before Low", () => {
    expect(
      compare(pr({ risk: "High" }), pr({ risk: "Low" }), display("risk")),
    ).toBeLessThan(0);
  });

  it("orders by every declared key, none falling through", () => {
    // ── The regression this replaces ──────────────────────────────────────
    //
    // `updatedAt` used to be handled by `default:`, which was correct and
    // silent — and any ordering added later would have landed there too,
    // sorted by a key nobody chose with nothing to indicate it.
    //
    // Each key is exercised here, so a member added to `OrderKey` without a
    // case fails at the switch rather than quietly sorting by date.
    const cases: [DisplayState["ordering"], TriagePr, TriagePr][] = [
      ["priority", pr({ priority: "P1" }), pr({ priority: "P3" })],
      ["reviewEffort", pr({ reviewEffort: 5 }), pr({ reviewEffort: 50 })],
      ["blastRadius", pr({ blastRadius: 1 }), pr({ blastRadius: 90 })],
      ["risk", pr({ risk: "High" }), pr({ risk: "Low" })],
      [
        "updatedAt",
        pr({ updatedAt: "2026-01-01T00:00:00.000Z" }),
        pr({ updatedAt: "2026-06-01T00:00:00.000Z" }),
      ],
    ];

    for (const [ordering, first, second] of cases) {
      expect(compare(first, second, display(ordering)), ordering).toBeLessThan(
        0,
      );
    }
  });

  it("reverses on descending", () => {
    const urgent = pr({ priority: "P1" });
    const safe = pr({ priority: "Safe to close" });
    expect(compare(urgent, safe, display("priority", "desc"))).toBeGreaterThan(
      0,
    );
  });

  it("refuses an ordering the union does not contain", () => {
    // The runtime half of the exhaustiveness guarantee. The compile-time half
    // is that this cast is the only way to reach it.
    expect(() =>
      compare(pr({}), pr({}), display("nonsense" as DisplayState["ordering"])),
    ).toThrow(/Unhandled ordering/);
  });
});
