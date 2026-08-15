/**
 * Pull requests and their revisions (P0.txt §14, §15, §71).
 *
 * The split this module exists for:
 *
 *     PullRequest              mutable  — title, state, description change
 *         └── revisions        immutable — each a frozen (base, head) pair
 *               ├── 1  opened
 *               ├── 2  push
 *               ├── 3  base_changed
 *               └── 4  push          ← current
 *
 * **A review always points at a revision, never at a pull request.** That one
 * rule eliminates the race that otherwise defines the product's worst failure
 * mode:
 *
 *     review starts on PR #184
 *          ↓
 *     developer pushes
 *          ↓
 *     review analyzes code nobody asked about
 *          ↓
 *     findings cite line numbers that no longer exist
 *
 * With revisions, a run records revision 3 and stays correct forever. If
 * revision 4 arrives mid-run, the run is `superseded` (§74) — a distinct,
 * honest outcome rather than a wrong answer.
 */

import { z } from "zod";
import {
  organizationIdSchema,
  pullRequestIdSchema,
  pullRequestRevisionIdSchema,
  repositoryIdSchema,
  type OrganizationId,
  type PullRequestId,
  type PullRequestRevisionId,
  type RepositoryId,
} from "../identity/ids.js";
import { gitRefSchema, gitRefsEqual, type GitRef } from "../git/git-refs.js";
import { actorSchema, type Actor } from "../actor/actor.js";
import {
  providerChangeRequestReferenceSchema,
  sourceProviderSchema,
  type ProviderChangeRequestReference,
  type SourceProvider,
} from "../provider/provider.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { COLLECTION_LIMITS, TEXT_LIMITS } from "../primitives/limits.js";
import { ValidationError } from "../errors/errors.js";

/**
 * `merged` is separate from `closed` because they mean opposite things for
 * review: a merged change shipped and its findings describe production code,
 * while a closed one was abandoned and its findings are moot.
 */
export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * A pull request as an identity, holding whatever its metadata is *now*.
 *
 * Mutable, and that is fine — nothing here affects the correctness of a past
 * review. Anything a review's correctness depends on (base, head, merge base)
 * lives on the revision instead, where it is frozen.
 */
export interface PullRequest {
  readonly id: PullRequestId;
  /** Denormalized tenant key (§9). */
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
  readonly provider: SourceProvider;
  readonly providerChangeRequest: ProviderChangeRequestReference;
  readonly title: string;
  readonly description?: string | undefined;
  readonly author: Actor;
  readonly state: PullRequestState;
  readonly draft: boolean;
  /** Labels as the provider reports them. Display and policy input only. */
  readonly labels: readonly string[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export const pullRequestSchema = z.strictObject({
  id: pullRequestIdSchema,
  organizationId: organizationIdSchema,
  repositoryId: repositoryIdSchema,
  provider: sourceProviderSchema,
  providerChangeRequest: providerChangeRequestReferenceSchema,
  title: z.string().min(1).max(TEXT_LIMITS.title),
  description: z.string().max(TEXT_LIMITS.description).optional(),
  author: actorSchema,
  state: z.enum(PULL_REQUEST_STATES),
  draft: z.boolean(),
  labels: z
    .array(z.string().min(1).max(TEXT_LIMITS.identifier))
    .max(COLLECTION_LIMITS.labels),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * Why a new revision came into existence.
 *
 * Provider-neutral by design (§20): an adapter maps GitHub's
 * `pull_request.synchronize` and GitLab's `push` hook to the same `push`. The
 * domain never sees a webhook event name.
 *
 * `base_changed` earns its own value because retargeting a PR from `main` to
 * `release/2.0` changes the diff completely without touching a single commit
 * on the branch — a revision that a naive "did head move?" check would miss
 * entirely.
 */
export const REVISION_TRIGGERS = [
  "opened",
  "push",
  "reopened",
  "base_changed",
  "manual_refresh",
  "unknown",
] as const;

export type RevisionTrigger = (typeof REVISION_TRIGGERS)[number];

/**
 * An **immutable** snapshot of a pull request's geometry at one moment (§71).
 *
 * Nothing on this record may ever be updated in place. If the world changes, a
 * new revision is appended with the next sequence number. That append-only
 * rule is what lets the platform answer "which code did run R analyze?" with
 * certainty months later (§15, §72).
 *
 * `sequence` is a per-pull-request counter starting at 1, not a timestamp: it
 * is dense, totally ordered, and safe to compare, and `(pullRequestId,
 * sequence)` is the natural unique constraint (§66).
 */
export interface PullRequestRevision {
  readonly id: PullRequestRevisionId;
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
  readonly pullRequestId: PullRequestId;
  /** 1-based, dense, monotonic within one pull request. */
  readonly sequence: number;
  readonly base: GitRef;
  readonly head: GitRef;
  readonly mergeBase?: GitRef | undefined;
  readonly trigger: RevisionTrigger;
  /** When the revision was recorded. Immutable; there is no `updatedAt`. */
  readonly createdAt: Timestamp;
}

export const pullRequestRevisionSchema = z.strictObject({
  id: pullRequestRevisionIdSchema,
  organizationId: organizationIdSchema,
  repositoryId: repositoryIdSchema,
  pullRequestId: pullRequestIdSchema,
  sequence: z.number().int().positive({
    error: "Revision sequence is 1-based",
  }),
  base: gitRefSchema,
  head: gitRefSchema,
  mergeBase: gitRefSchema.optional(),
  trigger: z.enum(REVISION_TRIGGERS),
  createdAt: timestampSchema,
});

/** Chronological comparison within one pull request. */
export function compareRevisions(
  left: PullRequestRevision,
  right: PullRequestRevision,
): number {
  return left.sequence - right.sequence;
}

/**
 * Whether two revisions describe the same code.
 *
 * Compares geometry, not identity: a `manual_refresh` produces a new revision
 * row with the same base and head, and for the purpose of "do we need to
 * re-analyze?" that is the same code. Callers deciding whether to reuse a
 * cached `ChangeManifest` want this, not `id` equality.
 */
export function revisionsDescribeSameCode(
  left: PullRequestRevision,
  right: PullRequestRevision,
): boolean {
  if (!gitRefsEqual(left.base, right.base)) return false;
  if (!gitRefsEqual(left.head, right.head)) return false;
  if (left.mergeBase === undefined || right.mergeBase === undefined) {
    return left.mergeBase === right.mergeBase;
  }
  return gitRefsEqual(left.mergeBase, right.mergeBase);
}

/**
 * Validates a revision series as a dense, ordered, single-parent chain.
 *
 * Each check catches a specific real failure:
 *
 * - **mixed parents** — a bug that would silently interleave two PRs' history;
 * - **gaps** — a lost write; sequence 4 arriving after 2 means 3 vanished, and
 *   incremental review would compare against the wrong baseline;
 * - **duplicates** — a double-processed webhook (§73);
 * - **backwards time** — clock skew or a reordered write.
 *
 * Times are non-decreasing rather than strictly increasing: two revisions can
 * legitimately land in the same millisecond.
 *
 * @throws {ValidationError} naming the specific break
 */
export function assertValidRevisionSeries(
  revisions: readonly PullRequestRevision[],
): void {
  if (revisions.length === 0) return;

  const first = revisions[0];
  if (first === undefined) return;

  if (first.sequence !== 1) {
    throw new ValidationError(
      `Revision series must start at sequence 1, but starts at ${String(first.sequence)}`,
      { details: { sequence: first.sequence } },
    );
  }

  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index];
    if (revision === undefined) continue;

    if (revision.pullRequestId !== first.pullRequestId) {
      throw new ValidationError(
        `Revision series mixes pull requests at index ${String(index)}`,
        { details: { index } },
      );
    }

    const previous = index > 0 ? revisions[index - 1] : undefined;
    if (previous === undefined) continue;

    if (revision.sequence !== previous.sequence + 1) {
      throw new ValidationError(
        `Revision sequence is not dense at index ${String(index)}: ${String(previous.sequence)} is followed by ${String(revision.sequence)}`,
        {
          details: {
            index,
            expected: previous.sequence + 1,
            actual: revision.sequence,
          },
        },
      );
    }

    if (revision.createdAt < previous.createdAt) {
      throw new ValidationError(
        `Revision series moves backwards in time at index ${String(index)}`,
        { details: { index } },
      );
    }
  }
}

/** The newest revision, or `undefined` for an empty series. */
export function currentRevision(
  revisions: readonly PullRequestRevision[],
): PullRequestRevision | undefined {
  let latest: PullRequestRevision | undefined;
  for (const revision of revisions) {
    if (latest === undefined || revision.sequence > latest.sequence) {
      latest = revision;
    }
  }
  return latest;
}

/**
 * Whether a run analyzing `analyzed` has been overtaken.
 *
 * The supersession test (§74). Compares sequence rather than identity so it
 * stays correct regardless of which revision object the caller happens to
 * hold.
 */
export function isSupersededBy(
  analyzed: PullRequestRevision,
  candidate: PullRequestRevision,
): boolean {
  return (
    analyzed.pullRequestId === candidate.pullRequestId &&
    candidate.sequence > analyzed.sequence
  );
}
