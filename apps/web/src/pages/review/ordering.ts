/**
 * How triage rows are ordered.
 *
 * Extracted from `Triage.tsx` so it can be tested without rendering anything.
 * The rendering is not what is worth protecting here — the ordering is, because
 * it decides which pull request a reviewer looks at first, and it fails
 * silently when it is wrong.
 *
 * No behaviour changed in the move.
 */

import type { Priority, RiskLevel, TriagePr } from "@/data/review";
import type { DisplayState } from "./TriageControls";

const priorityRank: Record<Priority, number> = {
  P1: 0,
  P2: 1,
  P3: 2,
  "Safe to close": 3,
  "No priority": 4,
};

const riskRank: Record<RiskLevel, number> = { High: 0, Medium: 1, Low: 2 };

/**
 * Refuses a value the union says cannot exist.
 *
 * The parameter type is the point: when `OrderKey` gains a member, the call in
 * `compare` stops type-checking, and the omission surfaces at the switch rather
 * than as a list quietly sorted by a key nobody chose.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled ordering: ${String(value)}`);
}

export function compare(
  a: TriagePr,
  b: TriagePr,
  display: DisplayState,
): number {
  const sign = display.direction === "asc" ? 1 : -1;
  switch (display.ordering) {
    case "priority":
      return (priorityRank[a.priority] - priorityRank[b.priority]) * sign;
    case "reviewEffort":
      return (a.reviewEffort - b.reviewEffort) * sign;
    case "blastRadius":
      return (a.blastRadius - b.blastRadius) * sign;
    case "risk":
      return (riskRank[a.risk] - riskRank[b.risk]) * sign;
    case "updatedAt":
      // Was the `default` branch, which was correct and silent. Any ordering
      // added later arrived here too, sorted by a key nobody chose, with
      // nothing to say so.
      return a.updatedAt.localeCompare(b.updatedAt) * sign;
    default:
      return assertNever(display.ordering);
  }
}
