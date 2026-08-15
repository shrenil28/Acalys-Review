/**
 * A span of source lines (P0.txt §22).
 *
 * Moved here from `change/` in Checkpoint C: line ranges are a location
 * primitive, and `SourceLocation`, `DiffHunk`, and `SymbolReference` all need
 * them. One canonical home, no duplicate definitions (§99, §105).
 *
 * **Lines are 1-based and both ends are inclusive.** Stated rather than
 * implied, because §22 warns specifically against leaving the convention to be
 * inferred. 1-based matches every editor, every provider comment API, and every
 * compiler diagnostic; a 0-based span here would mean an off-by-one at every
 * boundary the platform touches.
 *
 * A single line is `{ start: n, end: n }`, not `{ start: n }` — there is one
 * representation of a one-line span, so two callers cannot disagree about what
 * an absent `end` means.
 */

import { z } from "zod";

export interface LineRange {
  /** First line. 1-based, inclusive. */
  readonly start: number;
  /** Last line. 1-based, inclusive. Equal to `start` for a single line. */
  readonly end: number;
}

export const lineRangeSchema = z
  .strictObject({
    start: z.number().int().positive({ error: "Lines are 1-based" }),
    end: z.number().int().positive({ error: "Lines are 1-based" }),
  })
  .refine((range) => range.end >= range.start, {
    error: "Line range ends before it starts",
    path: ["end"],
  });

/** Line count, inclusive of both ends. A single-line range counts 1. */
export function lineCount(range: LineRange): number {
  return range.end - range.start + 1;
}

/** Whether a 1-based line falls inside the range. */
export function containsLine(range: LineRange, line: number): boolean {
  return line >= range.start && line <= range.end;
}

/**
 * Whether two ranges share at least one line.
 *
 * Used to decide whether a finding falls inside a changed hunk — which is what
 * separates "this PR introduced it" from "this was already here".
 */
export function rangesOverlap(left: LineRange, right: LineRange): boolean {
  return left.start <= right.end && right.start <= left.end;
}
