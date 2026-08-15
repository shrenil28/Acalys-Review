/**
 * Source-provider identity and capabilities (P0.txt §8, §110, §111).
 *
 * This is the boundary the whole architecture rests on (§1). Everything
 * upstream of it is GitHub's or GitLab's shape; everything downstream is
 * Acalys's. A `ReviewTarget` built from a GitHub webhook and one built from a
 * GitLab merge request differ only in the two fields below — `provider` and
 * `externalId` — and nothing in the review engine branches on them.
 *
 * Two rules encoded here:
 *
 * - **Provider ids are strings, always.** GitHub PR numbers are integers and
 *   GitLab IIDs are integers, but they are only unique *within a repository*,
 *   and Bitbucket uses different shapes entirely. Typing them as `string`
 *   removes any temptation to treat a provider's number as a global key (§8).
 *   The human-facing number survives separately, as display metadata.
 * - **Capabilities are declared, not assumed.** GitHub supports inline review
 *   comments, review decisions, suggestion blocks, and check runs. Not every
 *   provider does, and `local` supports none of them. Publication logic reads
 *   {@link ProviderCapabilities} instead of asking "is this GitHub?" (§110).
 */

import { z } from "zod";
import { TEXT_LIMITS } from "../primitives/limits.js";

/**
 * Providers the platform can review from.
 *
 * `local` is a first-class member, not an afterthought: the future
 * `acalys review` CLI reviews a working tree with no remote provider at all,
 * and the review engine must not care (§112).
 *
 * Adding a provider is a one-line change here plus a new adapter package. No
 * domain contract changes, because nothing else switches on this value.
 */
export const SOURCE_PROVIDERS = [
  "github",
  "gitlab",
  "bitbucket",
  "local",
] as const;

export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];

export const sourceProviderSchema = z.enum(SOURCE_PROVIDERS);

/**
 * A pointer to an entity that lives in a provider's system.
 *
 * Deliberately minimal. The temptation is to hang provider metadata here —
 * the GitHub node id, the GitLab project path, an avatar URL — and that is
 * exactly the leakage §10 forbids. Anything provider-shaped belongs in the
 * adapter.
 */
export interface ProviderReference {
  readonly provider: SourceProvider;
  /**
   * The provider's own identifier, as a string.
   *
   * Stability matters more than readability: prefer an immutable numeric id
   * (`"1296269"`) over a mutable path (`"octocat/Hello-World"`), because
   * repositories get renamed and transferred.
   */
  readonly externalId: string;
}

export const providerReferenceSchema = z.strictObject({
  provider: sourceProviderSchema,
  externalId: z.string().min(1).max(TEXT_LIMITS.identifier),
});

/** Which provider installation/connection an entity was reached through. */
export interface ProviderInstallationReference extends ProviderReference {
  readonly kind: "installation";
}

/** A repository in the provider's system. */
export interface ProviderRepositoryReference extends ProviderReference {
  readonly kind: "repository";
  /** Owning account or group, e.g. `octocat`. */
  readonly owner: string;
  /** Repository name, e.g. `Hello-World`. */
  readonly name: string;
}

export const providerRepositoryReferenceSchema = z.strictObject({
  kind: z.literal("repository"),
  provider: sourceProviderSchema,
  externalId: z.string().min(1).max(TEXT_LIMITS.identifier),
  owner: z.string().min(1).max(TEXT_LIMITS.identifier),
  name: z.string().min(1).max(TEXT_LIMITS.identifier),
});

/**
 * A pull request, merge request, or equivalent.
 *
 * Named "change request" rather than "pull request" because the concept is
 * shared and the vocabulary is not: GitHub says pull request, GitLab says
 * merge request, Gerrit says change.
 */
export interface ProviderChangeRequestReference extends ProviderReference {
  readonly kind: "change_request";
  /**
   * The number a human sees — `#1234`. Display only.
   *
   * Never a key: it is unique per repository at best, and GitLab issues and
   * merge requests share a numbering space.
   */
  readonly number?: number | undefined;
}

export const providerChangeRequestReferenceSchema = z.strictObject({
  kind: z.literal("change_request"),
  provider: sourceProviderSchema,
  externalId: z.string().min(1).max(TEXT_LIMITS.identifier),
  number: z.number().int().positive().optional(),
});

/** A comment the platform created or is replying to. */
export interface ProviderCommentReference extends ProviderReference {
  readonly kind: "comment";
  /** Provider thread/discussion id, where threading is supported. */
  readonly threadId?: string | undefined;
}

export const providerCommentReferenceSchema = z.strictObject({
  kind: z.literal("comment"),
  provider: sourceProviderSchema,
  externalId: z.string().min(1).max(TEXT_LIMITS.identifier),
  threadId: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
});

/** A user account in the provider's system. */
export interface ProviderUserReference extends ProviderReference {
  readonly kind: "user";
  /** Login handle, e.g. `octocat`. Display only — handles can be changed. */
  readonly handle?: string | undefined;
}

export const providerUserReferenceSchema = z.strictObject({
  kind: z.literal("user"),
  provider: sourceProviderSchema,
  externalId: z.string().min(1).max(TEXT_LIMITS.identifier),
  handle: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
});

/** A CI check run or pipeline job (§42). */
export interface ProviderCheckReference extends ProviderReference {
  readonly kind: "check";
  readonly name: string;
}

export const providerCheckReferenceSchema = z.strictObject({
  kind: z.literal("check"),
  provider: sourceProviderSchema,
  externalId: z.string().min(1).max(TEXT_LIMITS.identifier),
  name: z.string().min(1).max(TEXT_LIMITS.identifier),
});

/**
 * What a provider can actually do (§110).
 *
 * Publication reads these flags and degrades gracefully: without
 * `inlineComments` findings are folded into a summary comment; without
 * `reviewDecision` an approval becomes a plain comment; without
 * `suggestionBlocks` a suggested fix renders as a fenced diff.
 *
 * The alternative — `if (provider === "github")` scattered through the
 * publisher — is what makes adding Bitbucket a rewrite instead of an adapter.
 */
export interface ProviderCapabilities {
  /** Comments anchored to a file and line in a diff. */
  readonly inlineComments: boolean;
  /** A formal approve / request-changes verdict distinct from a comment. */
  readonly reviewDecision: boolean;
  /** Machine-applicable suggested edits, e.g. GitHub's ```suggestion blocks. */
  readonly suggestionBlocks: boolean;
  /** Replies grouped into resolvable threads. */
  readonly threadedComments: boolean;
  /** Commit status or check-run reporting. */
  readonly checks: boolean;
}

export const providerCapabilitiesSchema = z.strictObject({
  inlineComments: z.boolean(),
  reviewDecision: z.boolean(),
  suggestionBlocks: z.boolean(),
  threadedComments: z.boolean(),
  checks: z.boolean(),
});

/**
 * Capabilities of a purely local review — nothing to publish to.
 *
 * Provided here because `local` has no adapter package of its own; the CLI is
 * the adapter. Real remote providers declare their own capabilities in their
 * adapter package, where the knowledge belongs.
 */
export const LOCAL_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  inlineComments: false,
  reviewDecision: false,
  suggestionBlocks: false,
  threadedComments: false,
  checks: false,
};

/**
 * Where a completed review should be published (§111).
 *
 * Intent only — no tokens, no client, no API call. Carrying a credential here
 * would put it into every queue message and event that references the target,
 * which §63 forbids outright. Authentication is resolved by the publishing
 * adapter from the tenant's stored connection at the moment it publishes.
 */
export interface PublicationTarget {
  readonly provider: SourceProvider;
  readonly repository: ProviderRepositoryReference;
  readonly changeRequest: ProviderChangeRequestReference;
}

export const publicationTargetSchema = z.strictObject({
  provider: sourceProviderSchema,
  repository: providerRepositoryReferenceSchema,
  changeRequest: providerChangeRequestReferenceSchema,
});

/**
 * Structural equality for provider pointers (§124).
 *
 * Both fields must match: `github:42` and `gitlab:42` are unrelated entities
 * that happen to share a number.
 */
export function providerReferencesEqual(
  left: ProviderReference,
  right: ProviderReference,
): boolean {
  return (
    left.provider === right.provider && left.externalId === right.externalId
  );
}

/** Stable display/log form, e.g. `github:1296269`. */
export function formatProviderReference(reference: ProviderReference): string {
  return `${reference.provider}:${reference.externalId}`;
}
