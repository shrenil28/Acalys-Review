/**
 * Whether a published finding points where the corpus says the defect is.
 *
 * # Why this is a module and not a comparison
 *
 * P1-M.3's sealed holdout published a false positive whose semantics were
 * entirely correct and whose anchor was line 1 of a two-line file. Part of the
 * historical result had been earned the same way: an allowed span of lines 1-4
 * happened to include the hardcoded anchor, so a wrong location scored as
 * right.
 *
 * The rule that prevents a repeat was written down. Written down is not
 * enough — the machinery still implemented the weaker rule, and an evaluation
 * whose correctness depends on a human remembering to reinterpret its output
 * is the failure M.1's executable gate exists to eliminate.
 *
 * # Two policies, because history must not be rewritten
 *
 * ```
 * 1  hull + overlap   what Epoch 1 and the historical corpus were scored under
 * 2  enumerated       a candidate must match ONE allowed anchor
 * ```
 *
 * Version 1 is kept exactly as it behaved, defect included. Epoch 1's result
 * is permanent evidence and recomputing it under better rules would quietly
 * improve a number nobody re-measured. Version 2 is for Epoch 2 onward, which
 * must not inherit a known defect for the sake of backward compatibility.
 */

export type AnchorSide = "base" | "head";

export interface AllowedAnchor {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Constrains the side only when the corpus says it matters. */
  readonly side?: AnchorSide | undefined;
}

export interface PublishedAnchor {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly side?: AnchorSide | undefined;
}

export const ANCHOR_POLICY_VERSIONS = [1, 2] as const;
export type AnchorPolicyVersion = (typeof ANCHOR_POLICY_VERSIONS)[number];

/**
 * Side agreement, which is only a constraint when the corpus expresses one.
 *
 * An allowed anchor that names no side accepts either, because most of the
 * corpus predates the distinction. One that names a side rejects the other:
 * a comment on the wrong side of a diff points at code the author did not
 * write in this change.
 */
function sideAgrees(
  published: PublishedAnchor,
  allowed: AllowedAnchor,
): boolean {
  if (allowed.side === undefined) return true;
  return (published.side ?? "head") === allowed.side;
}

const overlaps = (
  published: PublishedAnchor,
  start: number,
  end: number,
): boolean => published.startLine <= end && published.endLine >= start;

/**
 * Whether a published anchor is one the corpus allows.
 *
 * Under policy 2 the candidate must land inside a *single* allowed anchor.
 * Overlap still applies within one anchor, because an allowed anchor may
 * legitimately be a range — a two-line statement is one location. What is
 * forbidden is overlap against the hull of several separate alternatives:
 *
 * ```
 * allowed { line 3 }, { line 7 }
 *   published 3  -> accepted
 *   published 7  -> accepted
 *   published 5  -> REJECTED, though it sits inside the hull 3-7
 * ```
 *
 * Line 5 is not a place the defect is. Accepting it would be the Epoch 1
 * defect reproduced by the very machinery built to catch it.
 */
export function anchorMatches(
  published: PublishedAnchor,
  allowed: readonly AllowedAnchor[],
  policyVersion: AnchorPolicyVersion,
): boolean {
  if (allowed.length === 0) return false;

  if (policyVersion === 1) {
    // Historical behaviour, preserved deliberately and not improved. The
    // numbers scored under it stay comparable to what was reported at the
    // time, including where that flattered the result.
    //
    // Side agreement is the one thing added, and it is a no-op on every
    // corpus scored so far: side did not exist when those expectations were
    // written, so none declares one and `sideAgrees` admits either. It is
    // here because a base-side publication satisfying a head-side expectation
    // would be provenance loss of the same family as the base/head context
    // collision — a wrong-revision coordinate accepted as right. The hull
    // defect is what policy 1 preserves; side-blindness was never part of it.
    const onPath = allowed
      .filter((entry) => entry.path === published.path)
      .filter((entry) => sideAgrees(published, entry));
    if (onPath.length === 0) return false;
    const start = Math.min(...onPath.map((entry) => entry.startLine));
    const end = Math.max(...onPath.map((entry) => entry.endLine));
    return overlaps(published, start, end);
  }

  return allowed.some(
    (entry) =>
      entry.path === published.path &&
      sideAgrees(published, entry) &&
      overlaps(published, entry.startLine, entry.endLine),
  );
}

/** The hull, exposed only so a test can prove the two policies differ. */
export function hullOf(
  allowed: readonly AllowedAnchor[],
): { readonly startLine: number; readonly endLine: number } | undefined {
  if (allowed.length === 0) return undefined;
  return {
    startLine: Math.min(...allowed.map((entry) => entry.startLine)),
    endLine: Math.max(...allowed.map((entry) => entry.endLine)),
  };
}
