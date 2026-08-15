/**
 * Where in the repository something is (P0.txt §22).
 *
 * This contract eventually drives GitHub and GitLab inline comments, so it has
 * to carry everything a provider needs to anchor a comment — path, line span,
 * and which side of the diff — while staying provider-neutral.
 *
 * Two conventions are stated explicitly rather than left to be inferred (§22):
 *
 * - **Lines are 1-based and inclusive at both ends** (see {@link LineRange}).
 * - **Columns are 1-based**, matching every compiler diagnostic and editor.
 *
 * `path` is a {@link RepositoryPath}: repository-relative, traversal-free, and
 * validated. An absolute filesystem path could never be portable across the
 * API process, a worker, and a sandbox, and would be an escape vector once
 * sandboxes materialize (§64).
 *
 * **Identity vs display.** A location says where to *render* something. It is
 * not what makes a finding the same finding across revisions — that is
 * {@link FindingFingerprint}, which deliberately excludes line numbers (§28).
 * The `symbol` field is the bridge: it travels with the location for display
 * and is reused as a fingerprint anchor.
 */

import { z } from "zod";
import {
  pullRequestRevisionIdSchema,
  repositoryIdSchema,
  type PullRequestRevisionId,
  type RepositoryId,
} from "../identity/ids.js";
import { gitObjectIdSchema, type GitObjectId } from "../git/git-refs.js";
import {
  repositoryPathSchema,
  type RepositoryPath,
} from "../primitives/repository-path.js";
import { lineRangeSchema, type LineRange } from "./line-range.js";
import {
  symbolReferenceSchema,
  type SymbolReference,
} from "./symbol-reference.js";

/**
 * Which side of a diff a location refers to.
 *
 * `head` is the changed code — where nearly every finding lives. `base` is
 * needed for findings about *removed* code: "this deletion drops the only
 * bounds check" can only be anchored to lines that no longer exist on head.
 * Providers require the distinction to place an inline comment at all.
 */
export const DIFF_SIDES = ["base", "head"] as const;
export type DiffSide = (typeof DIFF_SIDES)[number];

export const diffSideSchema = z.enum(DIFF_SIDES);

/**
 * A concrete position in repository content.
 *
 * `repositoryId` is present despite being derivable from the owning finding.
 * It is the §107 invariant made checkable: a finding's location must belong to
 * the repository under review, and a location that cannot state its repository
 * cannot be checked against one. It also lets a location be passed to
 * publication code on its own.
 *
 * `revisionId` and `commit` both appear because they answer different
 * questions. `revisionId` ties the location to the platform's own immutable
 * snapshot (§15) and is absent for local reviews, which have no revision.
 * `commit` is the raw Git anchor a provider API needs, and is present whenever
 * the content is committed.
 */
export interface SourceLocation {
  readonly repositoryId: RepositoryId;
  readonly path: RepositoryPath;
  readonly side: DiffSide;
  readonly lines: LineRange;
  /** 1-based column span within the first/last line. Rarely available. */
  readonly columns?: LineRange | undefined;
  /** The platform's revision snapshot. Absent for local reviews (§112). */
  readonly revisionId?: PullRequestRevisionId | undefined;
  /** The exact commit this location is valid against. */
  readonly commit?: GitObjectId | undefined;
  /** Semantic anchor. Also the strongest fingerprint input (§28). */
  readonly symbol?: SymbolReference | undefined;
}

export const sourceLocationSchema = z.strictObject({
  repositoryId: repositoryIdSchema,
  path: repositoryPathSchema,
  side: diffSideSchema,
  lines: lineRangeSchema,
  // Columns reuse LineRange: an inclusive 1-based interval is the same shape,
  // and a second near-identical type would be one more thing to keep in sync.
  columns: lineRangeSchema.optional(),
  revisionId: pullRequestRevisionIdSchema.optional(),
  commit: gitObjectIdSchema.optional(),
  symbol: symbolReferenceSchema.optional(),
});

/** Human-readable `path:start-end`, or `path:line` for a single line. */
export function formatLocation(location: SourceLocation): string {
  const { start, end } = location.lines;
  return start === end
    ? `${location.path}:${String(start)}`
    : `${location.path}:${String(start)}-${String(end)}`;
}

/**
 * Whether two locations point at the same place.
 *
 * Line-sensitive on purpose — this answers "is this the same position?", which
 * is a display question. It is emphatically *not* how findings are matched
 * across revisions; use {@link FindingFingerprint} for that.
 */
export function locationsEqual(
  left: SourceLocation,
  right: SourceLocation,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.path === right.path &&
    left.side === right.side &&
    left.lines.start === right.lines.start &&
    left.lines.end === right.lines.end
  );
}
