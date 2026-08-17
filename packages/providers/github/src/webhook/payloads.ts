/**
 * Runtime schemas for the GitHub payloads Acalys consumes.
 *
 * # Why schemas rather than `@octokit/webhooks-types`
 *
 * The official types are excellent and would be the obvious choice. They are
 * also **types**, and a type checks nothing at runtime. A webhook body is
 * untrusted input arriving over the network; §129 requires external data to
 * enter through `unknown` and pass a runtime boundary. Typing the body as
 * `PullRequestEvent` and casting produces exactly the false confidence that
 * requirement exists to prevent — the compiler is satisfied and a malformed or
 * hostile payload walks straight into normalization.
 *
 * A signature proves the body came from GitHub. It does not prove the body has
 * the shape this code expects: GitHub adds fields, changes nullability, and
 * ships event variants that did not exist when this was written.
 *
 * # Deliberately partial, and permissive about what it ignores
 *
 * These schemas describe **only the fields Acalys reads**, and use `z.object`
 * (strip) rather than `strictObject`. That is the opposite of the domain layer,
 * and the inversion is intentional:
 *
 *     domain    strictObject   an unknown key is corruption
 *     provider  object         an unknown key is GitHub shipping a feature
 *
 * A real `pull_request` payload has upwards of 300 fields. Rejecting deliveries
 * because GitHub added `allow_auto_merge` would take the platform down on a
 * vendor's release schedule. Unknown keys are dropped at this boundary and
 * never reach the domain, so strictness upstream buys nothing and costs
 * availability.
 *
 * What is *not* permissive: every field Acalys actually reads is validated, and
 * a missing or wrong-typed one fails the delivery loudly.
 */

import { z } from "zod";

/** Bounds on strings that become domain values or database columns. */
const SHORT_TEXT = 512;
const TITLE_TEXT = 1_024;
const BODY_TEXT = 262_144;

/**
 * A 40-character SHA-1 or 64-character SHA-256 object id.
 *
 * GitHub is migrating to SHA-256; accepting both now means the adapter does not
 * need a release on the day a repository flips.
 */
export const gitShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
    error: "Expected a full Git object id (40 or 64 lowercase hex characters)",
  });

/**
 * GitHub's numeric ids.
 *
 * Read as a number and rendered to a string at the domain boundary, because
 * `ProviderReference.externalId` is a string for every provider — GitLab's
 * GraphQL ids are not numeric, and forcing one provider into the other's shape
 * is the leak §1 forbids.
 *
 * Bounded by `Number.MAX_SAFE_INTEGER`: beyond it, JSON parsing silently loses
 * precision and two distinct GitHub objects can round to one id.
 */
export const githubIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER, {
    error: "GitHub id exceeds safe integer precision",
  });

/**
 * A GitHub account.
 *
 * `login` is optional in practice: deleted accounts surface as `null` on old
 * pull requests, and a delivery about a PR whose author closed their account
 * must still be processable.
 */
export const githubUserSchema = z.object({
  id: githubIdSchema,
  login: z.string().min(1).max(SHORT_TEXT).nullish(),
  type: z.string().max(SHORT_TEXT).nullish(),
});

export type GithubUser = z.output<typeof githubUserSchema>;

export const githubRepositorySchema = z.object({
  id: githubIdSchema,
  name: z.string().min(1).max(SHORT_TEXT),
  /** `owner/name`. Read for logging only — never as identity, since it changes. */
  full_name: z.string().min(1).max(SHORT_TEXT),
  owner: z.object({
    id: githubIdSchema,
    login: z.string().min(1).max(SHORT_TEXT),
  }),
  default_branch: z.string().min(1).max(SHORT_TEXT),
  private: z.boolean(),
});

export type GithubRepository = z.output<typeof githubRepositorySchema>;

/**
 * One side of a pull request.
 *
 * `repo` is nullable and that is not a formality: for a fork whose source
 * repository was deleted, GitHub sends `head.repo: null` while the PR remains
 * open and reviewable. Code that assumes `head.repo.id` crashes on those
 * deliveries, and they arrive rarely enough that the crash reaches production.
 */
export const githubPullRequestRefSchema = z.object({
  ref: z.string().min(1).max(SHORT_TEXT),
  sha: gitShaSchema,
  repo: githubRepositorySchema.nullish(),
});

export const githubLabelSchema = z.object({
  name: z.string().min(1).max(SHORT_TEXT),
});

/**
 * The pull request object, as carried on `pull_request` events.
 *
 * `merge_commit_sha` is **not** the merge base. GitHub computes a *test merge
 * commit* asynchronously and exposes it here; it is null while that is pending,
 * and it is a commit that does not exist in either branch. Using it as the diff
 * base would attribute the base branch's own commits to this change's author.
 * The merge base is resolved separately, against the Git repository.
 */
export const githubPullRequestSchema = z.object({
  id: githubIdSchema,
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  title: z.string().max(TITLE_TEXT),
  body: z.string().max(BODY_TEXT).nullish(),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  merged_at: z.string().max(SHORT_TEXT).nullish(),
  created_at: z.string().min(1).max(SHORT_TEXT),
  updated_at: z.string().min(1).max(SHORT_TEXT),
  user: githubUserSchema.nullish(),
  base: githubPullRequestRefSchema,
  head: githubPullRequestRefSchema,
  labels: z.array(githubLabelSchema).max(200).nullish(),
});

export type GithubPullRequest = z.output<typeof githubPullRequestSchema>;

/**
 * The `pull_request` event actions Acalys acts on.
 *
 * A closed set, and the omissions are decisions:
 *
 * | Action | Handled | Why |
 * | --- | --- | --- |
 * | `opened` | yes | first revision |
 * | `synchronize` | yes | a push — the incremental-review trigger |
 * | `reopened` | yes | the change is live again |
 * | `ready_for_review` | yes | a draft became reviewable |
 * | `edited` | yes | only when the **base branch** changed; a retitle is not a revision |
 * | `closed` | yes | cancel in-flight runs; do not start new ones |
 * | `labeled`/`assigned`/… | no | metadata churn, no effect on the code under review |
 *
 * Unrecognized actions are *ignored*, not rejected: GitHub adds actions, and a
 * new one must not fail a delivery that the platform simply has no use for.
 */
export const PULL_REQUEST_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "edited",
  "closed",
] as const;

export type PullRequestAction = (typeof PULL_REQUEST_ACTIONS)[number];

/**
 * `changes` is present only on `edited`, and only the `base` key matters.
 *
 * A title or body edit does not change the code, and treating it as a revision
 * would re-review the whole change every time someone fixes a typo in the
 * description — a cost and noise problem that shows up immediately in
 * production.
 */
export const githubPullRequestChangesSchema = z.object({
  base: z
    .object({
      ref: z.object({ from: z.string().max(SHORT_TEXT) }).nullish(),
      sha: z.object({ from: z.string().max(SHORT_TEXT) }).nullish(),
    })
    .nullish(),
});

export const githubPullRequestEventSchema = z.object({
  action: z.string().min(1).max(SHORT_TEXT),
  number: z.number().int().positive(),
  pull_request: githubPullRequestSchema,
  repository: githubRepositorySchema,
  sender: githubUserSchema.nullish(),
  installation: z.object({ id: githubIdSchema }).nullish(),
  changes: githubPullRequestChangesSchema.nullish(),
});

export type GithubPullRequestEvent = z.output<
  typeof githubPullRequestEventSchema
>;

/**
 * The `ping` GitHub sends when a hook is created.
 *
 * Modelled rather than ignored so the gateway can answer it correctly: a hook
 * whose ping fails is shown as broken in the GitHub UI, and the operator
 * concludes the integration is down when it is merely unmodelled.
 */
export const githubPingEventSchema = z.object({
  zen: z.string().max(SHORT_TEXT),
  hook_id: githubIdSchema,
  repository: githubRepositorySchema.nullish(),
});

export type GithubPingEvent = z.output<typeof githubPingEventSchema>;

/**
 * `installation` and `installation_repositories` — access granted or revoked.
 *
 * Revocation matters more than grant: a run in flight against a repository the
 * app can no longer read must be cancelled rather than left to fail with a 404
 * on every retry until it exhausts its attempts.
 */
export const githubInstallationEventSchema = z.object({
  action: z.string().min(1).max(SHORT_TEXT),
  installation: z.object({
    id: githubIdSchema,
    account: githubUserSchema.nullish(),
  }),
  repositories: z.array(githubRepositorySchema.partial()).max(1_000).nullish(),
});

export type GithubInstallationEvent = z.output<
  typeof githubInstallationEventSchema
>;
