/**
 * What is being reviewed (P0.txt §12, §112).
 *
 * The most important contract in Phase 0, because it is the type the review
 * engine actually consumes. Everything upstream — a GitHub webhook, a GitLab
 * merge request, a local working tree — collapses into one of four variants
 * here, and nothing downstream branches on where it came from.
 *
 *     GitHub PR      ─┐
 *     GitLab MR      ─┼─> adapter ─> ReviewTarget ─> review engine
 *     local worktree ─┘
 *
 * Designing this around pull requests alone would have been the easy mistake.
 * The future `acalys review` CLI reviews a working tree, a commit range, or a
 * single commit with **no provider, no PR number, and no comment thread**, and
 * it must reuse the same engine (§112). So the union carries four kinds, and
 * `repositoryId` is the only field every one of them shares.
 *
 * Every variant is a *snapshot of intent*: the exact commits to compare, fixed
 * at request time. A target never says "the current head of this PR" — that
 * would reintroduce the race the revision model exists to eliminate (§15).
 */

import { z } from "zod";
import { assertNever } from "../primitives/assert-never.js";
import { repositoryIdSchema, type RepositoryId } from "../identity/ids.js";
import {
  gitRefSchema,
  type GitObjectId,
  type GitRef,
} from "../git/git-refs.js";
import { actorSchema, type Actor } from "../actor/actor.js";
import {
  providerChangeRequestReferenceSchema,
  sourceProviderSchema,
  type ProviderChangeRequestReference,
  type SourceProvider,
} from "../provider/provider.js";
import { TEXT_LIMITS } from "../primitives/limits.js";

/** Schema version for this transported contract (§7). */
export const REVIEW_TARGET_SCHEMA_VERSION = 1;

/**
 * A pull request, merge request, or equivalent.
 *
 * The only variant that carries provider identity — and it carries a
 * `ProviderChangeRequestReference`, not a raw number, because a PR number is
 * unique per repository at best (§8).
 */
export interface PullRequestReviewTarget {
  readonly kind: "pull_request";
  readonly schemaVersion: number;
  readonly repositoryId: RepositoryId;
  readonly provider: SourceProvider;
  readonly changeRequest: ProviderChangeRequestReference;
  /** Branch the change would merge into, resolved to a commit. */
  readonly base: GitRef;
  /** Tip of the change under review. */
  readonly head: GitRef;
  /**
   * Common ancestor of base and head.
   *
   * Optional but strongly preferred. Diffing `base..head` attributes every
   * commit that landed on the base branch since the PR opened to this
   * change's author; `mergeBase..head` shows only their work. Getting it wrong
   * means reviewing — and reporting findings against — other people's code.
   */
  readonly mergeBase?: GitRef | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly author: Actor;
  readonly draft: boolean;
}

/** A range of commits: `acalys review HEAD~3..HEAD`, or a pushed branch. */
export interface CommitRangeReviewTarget {
  readonly kind: "commit_range";
  readonly schemaVersion: number;
  readonly repositoryId: RepositoryId;
  readonly base: GitRef;
  readonly head: GitRef;
  readonly mergeBase?: GitRef | undefined;
}

/**
 * A single commit, reviewed against its first parent.
 *
 * `parent` is optional because a root commit has none — the repository's very
 * first commit is reviewable as "everything added".
 */
export interface CommitReviewTarget {
  readonly kind: "commit";
  readonly schemaVersion: number;
  readonly repositoryId: RepositoryId;
  readonly commit: GitRef;
  readonly parent?: GitRef | undefined;
}

/**
 * Uncommitted local changes — the `acalys review` case.
 *
 * Carries no provider, no change-request reference, no author, and no title,
 * because none of those exist yet. `baseline` is what the dirty tree is
 * compared against, usually `HEAD`.
 *
 * This variant is the standing proof that the engine is not PR-shaped: if a
 * future field cannot be filled in here, it does not belong on a target.
 */
export interface WorkingTreeReviewTarget {
  readonly kind: "working_tree";
  readonly schemaVersion: number;
  readonly repositoryId: RepositoryId;
  readonly baseline: GitRef;
  /** Whether only staged changes are under review, or the whole dirty tree. */
  readonly stagedOnly: boolean;
}

export type ReviewTarget =
  | PullRequestReviewTarget
  | CommitRangeReviewTarget
  | CommitReviewTarget
  | WorkingTreeReviewTarget;

const schemaVersionSchema = z
  .number()
  .int()
  .positive()
  .max(REVIEW_TARGET_SCHEMA_VERSION, {
    error: `Unsupported ReviewTarget schemaVersion; this build understands up to ${String(REVIEW_TARGET_SCHEMA_VERSION)}`,
  });

export const pullRequestReviewTargetSchema = z.strictObject({
  kind: z.literal("pull_request"),
  schemaVersion: schemaVersionSchema,
  repositoryId: repositoryIdSchema,
  provider: sourceProviderSchema,
  changeRequest: providerChangeRequestReferenceSchema,
  base: gitRefSchema,
  head: gitRefSchema,
  mergeBase: gitRefSchema.optional(),
  title: z.string().min(1).max(TEXT_LIMITS.title),
  description: z.string().max(TEXT_LIMITS.description).optional(),
  author: actorSchema,
  draft: z.boolean(),
});

export const commitRangeReviewTargetSchema = z.strictObject({
  kind: z.literal("commit_range"),
  schemaVersion: schemaVersionSchema,
  repositoryId: repositoryIdSchema,
  base: gitRefSchema,
  head: gitRefSchema,
  mergeBase: gitRefSchema.optional(),
});

export const commitReviewTargetSchema = z.strictObject({
  kind: z.literal("commit"),
  schemaVersion: schemaVersionSchema,
  repositoryId: repositoryIdSchema,
  commit: gitRefSchema,
  parent: gitRefSchema.optional(),
});

export const workingTreeReviewTargetSchema = z.strictObject({
  kind: z.literal("working_tree"),
  schemaVersion: schemaVersionSchema,
  repositoryId: repositoryIdSchema,
  baseline: gitRefSchema,
  stagedOnly: z.boolean(),
});

export const reviewTargetSchema = z.discriminatedUnion("kind", [
  pullRequestReviewTargetSchema,
  commitRangeReviewTargetSchema,
  commitReviewTargetSchema,
  workingTreeReviewTargetSchema,
]);

/**
 * The repository every target belongs to.
 *
 * Exhaustive by construction: adding a fifth variant without handling it here
 * fails `assertNever` at compile time (§85), so this cannot silently return
 * `undefined` for an unhandled kind.
 */
export function targetRepositoryId(target: ReviewTarget): RepositoryId {
  switch (target.kind) {
    case "pull_request":
    case "commit_range":
    case "commit":
    case "working_tree":
      return target.repositoryId;
    default:
      return assertNever(target, "targetRepositoryId");
  }
}

/**
 * Whether this target has a provider-side change request to publish to.
 *
 * The check publication logic performs instead of asking "is this GitHub?".
 * A commit-range or working-tree review has findings but nowhere to post them,
 * and that is a normal outcome rather than an error.
 */
export function isPublishable(
  target: ReviewTarget,
): target is PullRequestReviewTarget {
  return target.kind === "pull_request";
}

/**
 * The commits a target compares, when it has a well-defined pair.
 *
 * A working-tree target returns `undefined` for `head`: the content under
 * review is not committed and therefore has no object id. That is precisely
 * why {@link ChangeManifest} takes its comparison explicitly rather than
 * deriving one from the target.
 */
export function targetComparison(target: ReviewTarget): {
  readonly base: GitObjectId;
  readonly head?: GitObjectId | undefined;
} {
  switch (target.kind) {
    case "pull_request":
    case "commit_range":
      return {
        base: (target.mergeBase ?? target.base).objectId,
        head: target.head.objectId,
      };
    case "commit":
      return target.parent === undefined
        ? { base: target.commit.objectId, head: target.commit.objectId }
        : { base: target.parent.objectId, head: target.commit.objectId };
    case "working_tree":
      // No head: the dirty tree is not a commit.
      return { base: target.baseline.objectId };
    default:
      return assertNever(target, "targetComparison");
  }
}

/** Short label for logs and UI. Never includes untrusted body text (§125). */
export function describeTarget(target: ReviewTarget): string {
  switch (target.kind) {
    case "pull_request": {
      const number = target.changeRequest.number;
      return number === undefined
        ? `pull request ${target.changeRequest.externalId}`
        : `pull request #${String(number)}`;
    }
    case "commit_range":
      return `commits ${target.base.objectId.value.slice(0, 7)}..${target.head.objectId.value.slice(0, 7)}`;
    case "commit":
      return `commit ${target.commit.objectId.value.slice(0, 7)}`;
    case "working_tree":
      return target.stagedOnly ? "staged changes" : "working tree";
    default:
      return assertNever(target, "describeTarget");
  }
}
