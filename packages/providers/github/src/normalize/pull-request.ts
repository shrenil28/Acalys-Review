/**
 * GitHub payloads → canonical Acalys contracts.
 *
 * **This file is the boundary.** Everything above it in the call stack speaks
 * GitHub; everything below speaks the platform. No function here returns a
 * GitHub type, and no caller of these functions needs to know GitHub exists.
 *
 * The test that this holds is not a convention: `tests/fixtures.test.ts` in
 * the contracts package proves a GitHub PR and a GitLab MR describing the same
 * change normalize to equal domain structures. This module is the GitHub half
 * of making that true.
 *
 * # What is dropped, and why the dropping is the point
 *
 * A `pull_request` payload carries `node_id`, `html_url`, `diff_url`,
 * `mergeable_state`, `rebaseable`, `requested_reviewers`, `auto_merge`, and
 * roughly 290 other fields. None crosses this boundary. Each one that did
 * would become a field some downstream code reads, and then GitLab support
 * would require either inventing an equivalent or special-casing the reviewer.
 */

import {
  repositoryPath,
  timestampFromDate,
  type Actor,
  type GitRef,
  type OrganizationId,
  type ProviderChangeRequestReference,
  type PullRequest,
  type PullRequestId,
  type PullRequestReviewTarget,
  type PullRequestRevision,
  type PullRequestRevisionId,
  type PullRequestState,
  type RepositoryId,
  type RevisionTrigger,
  type Timestamp,
  REVIEW_TARGET_SCHEMA_VERSION,
} from "@acalys/contracts/domain";

import type {
  GithubPullRequest,
  GithubPullRequestEvent,
  GithubUser,
  PullRequestAction,
} from "../webhook/payloads.js";
import { PULL_REQUEST_ACTIONS } from "../webhook/payloads.js";

/**
 * Identity the platform has already resolved.
 *
 * Normalization cannot invent these: a `RepositoryId` is the platform's own
 * UUIDv7, assigned when the repository was connected, and mapping GitHub's
 * numeric id to it is a database lookup. Passing them in keeps this module a
 * **pure function** — no I/O, no clock, no store — which is what makes it
 * exhaustively testable from fixtures.
 */
export interface ResolvedIdentity {
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
}

/** Normalization refused the payload, with a reason a log can act on. */
export class NormalizationError extends Error {
  public override readonly name = "NormalizationError";

  public constructor(
    public readonly field: string,
    reason: string,
  ) {
    super(`Cannot normalize GitHub payload: ${field} — ${reason}`);
  }
}

/**
 * GitHub's timestamp format: `2026-08-16T09:58:11Z`, optionally with
 * milliseconds. Always UTC on the fields Acalys reads.
 */
const GITHUB_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?Z$/;

/**
 * Converts GitHub's ISO-8601 timestamps to the canonical form.
 *
 * GitHub sends second precision; `Timestamp` requires exactly three fractional
 * digits (§6). The conversion is the easy part — the validation is not.
 *
 * # `new Date()` is not a validator
 *
 * JavaScript's ISO parser is inconsistent about impossible dates:
 *
 *     new Date("2026-13-01T10:00:00Z")   → Invalid Date     ✓ caught
 *     new Date("2026-08-32T10:00:00Z")   → Invalid Date     ✓ caught
 *     new Date("2026-02-30T10:00:00Z")   → 2026-03-02       ✗ SILENTLY ROLLED
 *
 * It range-checks the day syntactically (≤ 31) but never against the month's
 * actual length, so February 30th becomes March 2nd with no error. A
 * `Number.isNaN` guard alone therefore lets a corrupted delivery through and
 * records an instant GitHub never sent — off by two days, in a field that
 * orders revisions and drives retention.
 *
 * So the parse is confirmed by round-tripping: if the `Date` re-emits a
 * different calendar time than the input named, the input was not a real
 * instant. That catches every rollover — Feb 29–31, Apr 31, Jun 31, Sep 31,
 * Nov 31 — with one comparison rather than a table of month lengths.
 */
function toTimestamp(value: string, field: string): Timestamp {
  const match = GITHUB_TIMESTAMP.exec(value);
  if (match === null) {
    throw new NormalizationError(
      field,
      `not an ISO-8601 UTC instant: ${value}`,
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new NormalizationError(field, `not a valid instant: ${value}`);
  }

  // The round-trip. `match[1]` is the input's `YYYY-MM-DDTHH:MM:SS`; the
  // Date's own ISO rendering must name the same calendar time, or a component
  // was rolled over into the next month or year.
  const [, calendarTime] = match;
  if (parsed.toISOString().slice(0, 19) !== calendarTime) {
    throw new NormalizationError(
      field,
      `date does not exist: ${value} (would silently become ${parsed.toISOString()})`,
    );
  }

  return timestampFromDate(parsed);
}

/**
 * A GitHub account becomes a canonical {@link Actor}.
 *
 * Always `human`, never `system`, even for bot accounts. The distinction the
 * domain draws is *who initiated this* — and a bot acting on GitHub is still
 * an external party from the platform's perspective, not an Acalys component.
 * Marking Dependabot as `system` would make its pull requests appear to have
 * been opened by Acalys itself.
 *
 * A deleted account yields an actor with a provider reference and no name.
 * That is the honest record: the action happened, and the person is gone.
 */
export function toActor(user: GithubUser | null | undefined): Actor {
  if (user === null || user === undefined) {
    // GitHub omits the user on very old pull requests whose author was purged.
    // `system` is wrong (it was not us) and inventing a placeholder handle
    // would be a fabricated identity, so the actor carries no attribution.
    return { kind: "human" };
  }

  const handle = user.login ?? undefined;

  return {
    kind: "human",
    provider: {
      kind: "user",
      provider: "github",
      externalId: String(user.id),
      ...(handle === undefined ? {} : { handle }),
    },
    ...(handle === undefined ? {} : { displayName: handle }),
  };
}

/**
 * A branch name and its resolved commit become a {@link GitRef}.
 *
 * Both halves are required. A ref without a commit cannot be diffed, and a
 * commit without a ref cannot be reported to a human — "the change on
 * `feat/sse`" is meaningful where `9f8e7d6…` is not.
 */
function toGitRef(ref: { readonly ref: string; readonly sha: string }): GitRef {
  return {
    name: ref.ref,
    objectId: {
      // GitHub's SHA-1 ids are 40 hex characters; SHA-256 repositories send 64.
      algorithm: ref.sha.length === 64 ? "sha256" : "sha1",
      value: ref.sha,
    },
  };
}

/** GitHub's `state` plus `merged` collapse to the canonical three. */
function toPullRequestState(pull: GithubPullRequest): PullRequestState {
  // `merged` is the distinction GitHub's own `state` loses: a merged PR and an
  // abandoned one are both `closed`, and the platform must tell them apart —
  // findings on a merged change are history, findings on an abandoned one are
  // moot.
  if (pull.merged === true || pull.merged_at != null) return "merged";
  return pull.state === "closed" ? "closed" : "open";
}

function toChangeRequestReference(
  pull: GithubPullRequest,
): ProviderChangeRequestReference {
  return {
    kind: "change_request",
    provider: "github",
    // The immutable numeric id, not the number: `#412` is unique per
    // repository at best, and is not a key.
    externalId: String(pull.id),
    number: pull.number,
  };
}

/**
 * Whether an action produces a new revision, and what caused it.
 *
 * Returns `undefined` when the action changes no code — the platform records
 * the pull request's new metadata and starts no review.
 *
 * `edited` is the subtle one. GitHub fires it for title, body, and base-branch
 * edits alike, and only the last changes what should be reviewed. Treating
 * every `edited` as a revision means a full re-review each time someone fixes
 * a typo in the description: real cost, real noise, and a reviewer users learn
 * to ignore.
 */
export function revisionTriggerFor(
  event: GithubPullRequestEvent,
): RevisionTrigger | undefined {
  switch (event.action as PullRequestAction) {
    case "opened":
      return "opened";
    case "synchronize":
      return "push";
    case "reopened":
      return "reopened";
    case "ready_for_review":
      // The code has not changed, but it was not reviewable before and is now.
      // Modelled as a fresh look rather than a code change.
      return "manual_refresh";
    case "edited":
      return event.changes?.base != null ? "base_changed" : undefined;
    case "closed":
      return undefined;
    default:
      // An action GitHub added since this was written. Ignored, never rejected.
      return undefined;
  }
}

/** Whether the platform recognizes this action at all. */
export function isHandledAction(action: string): action is PullRequestAction {
  return (PULL_REQUEST_ACTIONS as readonly string[]).includes(action);
}

/**
 * The pull request as an identity holding its current metadata.
 *
 * `id` is passed in rather than derived: the platform's `PullRequestId` is
 * assigned on first sight and stable across every later delivery, and deriving
 * it from the payload would mint a new one per webhook.
 */
export function toPullRequest(
  event: GithubPullRequestEvent,
  identity: ResolvedIdentity,
  pullRequestId: PullRequestId,
): PullRequest {
  const pull = event.pull_request;

  return {
    id: pullRequestId,
    organizationId: identity.organizationId,
    repositoryId: identity.repositoryId,
    provider: "github",
    providerChangeRequest: toChangeRequestReference(pull),
    title: pull.title,
    ...(pull.body == null || pull.body.length === 0
      ? {}
      : { description: pull.body }),
    author: toActor(pull.user),
    state: toPullRequestState(pull),
    draft: pull.draft ?? false,
    labels: (pull.labels ?? []).map((label) => label.name),
    createdAt: toTimestamp(pull.created_at, "pull_request.created_at"),
    updatedAt: toTimestamp(pull.updated_at, "pull_request.updated_at"),
  };
}

/**
 * An immutable revision — the frozen record of what was reviewed.
 *
 * `sequence` and `createdAt` are supplied by the caller. Sequence is
 * `max(sequence) + 1` within the pull request, which only the store can
 * compute and which the store enforces with `unique (pull_request_id,
 * sequence)`; two workers racing a redelivery must not both succeed.
 *
 * `mergeBase` is absent here on purpose. GitHub's `merge_commit_sha` is a
 * *test merge commit*, not the merge base — a commit that exists in neither
 * branch, computed asynchronously, and null while pending. Using it would
 * diff against the wrong ancestor and attribute the base branch's commits to
 * this change's author. The merge base is resolved against the Git repository,
 * which is the repository service's job.
 */
export function toRevision(
  event: GithubPullRequestEvent,
  identity: ResolvedIdentity,
  pullRequestId: PullRequestId,
  revisionId: PullRequestRevisionId,
  sequence: number,
  createdAt: Timestamp,
): PullRequestRevision {
  const trigger = revisionTriggerFor(event);
  if (trigger === undefined) {
    throw new NormalizationError(
      "action",
      `'${event.action}' does not produce a revision`,
    );
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new NormalizationError("sequence", "must be a positive integer");
  }

  return {
    id: revisionId,
    organizationId: identity.organizationId,
    repositoryId: identity.repositoryId,
    pullRequestId,
    sequence,
    base: toGitRef(event.pull_request.base),
    head: toGitRef(event.pull_request.head),
    trigger,
    createdAt,
  };
}

/**
 * The canonical review target.
 *
 * The type §133 names as the definition of done: if this function can be
 * written without changing a Phase 0 contract, the provider boundary held.
 */
export function toReviewTarget(
  event: GithubPullRequestEvent,
  identity: ResolvedIdentity,
): PullRequestReviewTarget {
  const pull = event.pull_request;

  return {
    kind: "pull_request",
    schemaVersion: REVIEW_TARGET_SCHEMA_VERSION,
    repositoryId: identity.repositoryId,
    provider: "github",
    changeRequest: toChangeRequestReference(pull),
    base: toGitRef(pull.base),
    head: toGitRef(pull.head),
    title: pull.title,
    ...(pull.body == null || pull.body.length === 0
      ? {}
      : { description: pull.body }),
    author: toActor(pull.user),
    draft: pull.draft ?? false,
  };
}

/**
 * The repository path a changed file is reported at.
 *
 * GitHub returns POSIX-relative paths already, so this is validation rather
 * than conversion — and validation is the point. §64 makes `RepositoryPath` the
 * security-critical value object: a path that escapes the repository root
 * reaches the filesystem when a worktree is materialized. A provider is not
 * trusted to have sanitized it.
 */
export function toRepositoryPath(
  path: string,
): ReturnType<typeof repositoryPath> {
  return repositoryPath(path);
}
