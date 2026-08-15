/**
 * Canonical repository identity (P0.txt §10, §89).
 *
 * The central distinction: **Acalys repository identity is not provider
 * repository identity** (§132, "Provider ID != Acalys ID").
 *
 *     RepositoryId          a UUIDv7 the platform mints and owns forever
 *     providerRepository    { provider, externalId, owner, name }
 *
 * They must be separate because provider identity is not stable in the ways a
 * primary key must be. A repository can be renamed, transferred between
 * organizations, or migrated from GitHub to GitLab. Every one of those changes
 * `owner`/`name`, and the last changes the provider entirely — while the
 * review history, findings, and learnings must survive intact. Keying on
 * anything provider-owned means losing that history.
 *
 * (The existing dashboard fixtures key repositories by `name` with no id at
 * all, which is exactly the design this replaces.)
 */

import { z } from "zod";
import {
  organizationIdSchema,
  providerConnectionIdSchema,
  repositoryIdSchema,
  type OrganizationId,
  type ProviderConnectionId,
  type RepositoryId,
} from "../identity/ids.js";
import {
  providerRepositoryReferenceSchema,
  sourceProviderSchema,
  type ProviderRepositoryReference,
  type SourceProvider,
} from "../provider/provider.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { TEXT_LIMITS } from "../primitives/limits.js";
import { gitObjectIdSchema, type GitObjectId } from "../git/git-refs.js";

/**
 * Who can see the repository.
 *
 * `unknown` is a real, useful state rather than a modelling failure: a
 * connection can lose the scope needed to read visibility, and guessing
 * "private" or "public" both cause harm — one blocks legitimate review, the
 * other risks treating private code as public. Making ignorance explicit lets
 * policy decide.
 */
export const REPOSITORY_VISIBILITIES = [
  "public",
  "private",
  "internal",
  "unknown",
] as const;

export type RepositoryVisibility = (typeof REPOSITORY_VISIBILITIES)[number];

/**
 * Whether the repository participates in review.
 *
 * `disabled` — a human turned reviews off; the repository still exists.
 * `archived` — the provider archived it, or it was deleted; no new reviews
 * will ever arrive, but history is retained.
 */
export const REPOSITORY_LIFECYCLES = [
  "active",
  "disabled",
  "archived",
] as const;
export type RepositoryLifecycle = (typeof REPOSITORY_LIFECYCLES)[number];

/**
 * A repository under review.
 *
 * Provider-specific fields — stars, topics, license, language breakdown, the
 * GitHub node id — are absent by design (§10). They belong to the adapter or
 * to a separate metadata projection, not to the canonical entity, or every
 * provider's quirks accumulate here.
 */
export interface Repository {
  readonly id: RepositoryId;
  /** Denormalized tenant key — see the tenancy module for why (§9). */
  readonly organizationId: OrganizationId;
  /** Which connection reaches this repository. Absent for `local`. */
  readonly providerConnectionId?: ProviderConnectionId | undefined;
  readonly provider: SourceProvider;
  /** The provider's own identity for this repository. */
  readonly providerRepository: ProviderRepositoryReference;
  /**
   * Branch reviews compare against when a target does not say otherwise.
   *
   * Optional because a freshly created repository has no commits and therefore
   * no default branch.
   */
  readonly defaultBranch?: string | undefined;
  readonly visibility: RepositoryVisibility;
  readonly lifecycle: RepositoryLifecycle;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export const repositorySchema = z.strictObject({
  id: repositoryIdSchema,
  organizationId: organizationIdSchema,
  providerConnectionId: providerConnectionIdSchema.optional(),
  provider: sourceProviderSchema,
  providerRepository: providerRepositoryReferenceSchema,
  defaultBranch: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  visibility: z.enum(REPOSITORY_VISIBILITIES),
  lifecycle: z.enum(REPOSITORY_LIFECYCLES),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * A tenant's authenticated link to a provider — a GitHub App installation, a
 * GitLab group token, a Bitbucket workspace grant.
 *
 * **No credential appears in this contract** (§63). Not the installation's
 * private key, not an access token, not a refresh token. The connection
 * carries only the identity needed to *find* the credential in a secret store
 * at the moment it is used. Anything else would put secrets into every event
 * and queue message that references a connection.
 */
export interface ProviderConnection {
  readonly id: ProviderConnectionId;
  readonly organizationId: OrganizationId;
  readonly provider: SourceProvider;
  /** Provider-side installation identifier. Not a secret. */
  readonly externalInstallationId: string;
  /**
   * Host for self-managed deployments, e.g. `gitlab.internal.acme.com`.
   * Absent for the provider's public cloud.
   */
  readonly host?: string | undefined;
  readonly lifecycle: ProviderConnectionLifecycle;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * `suspended` and `revoked` are distinct because recovery differs: a suspended
 * installation can be resumed by the tenant, a revoked one requires
 * reinstallation. Collapsing them would lose the difference between "retry
 * later" and "ask the user to act".
 */
export const PROVIDER_CONNECTION_LIFECYCLES = [
  "active",
  "suspended",
  "revoked",
] as const;

export type ProviderConnectionLifecycle =
  (typeof PROVIDER_CONNECTION_LIFECYCLES)[number];

export const providerConnectionSchema = z.strictObject({
  id: providerConnectionIdSchema,
  organizationId: organizationIdSchema,
  provider: sourceProviderSchema,
  externalInstallationId: z.string().min(1).max(TEXT_LIMITS.identifier),
  host: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  lifecycle: z.enum(PROVIDER_CONNECTION_LIFECYCLES),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * A pointer to materialized repository content at one commit (§89).
 *
 * The snapshot **subsystem** — cloning, worktrees, caching, eviction — is a
 * later phase. What Phase 0 must provide is the identifier later contracts use
 * to say "the review ran against this exact tree", which is what makes a run
 * reproducible (§72).
 *
 * `storageReference` is opaque: an object-store key, a cache path, a content
 * address. Nothing in the domain interprets it; only the snapshot service does.
 */
export interface RepositorySnapshotReference {
  readonly repositoryId: RepositoryId;
  /** The exact commit this snapshot materializes. */
  readonly commit: GitObjectId;
  /** Opaque locator, meaningful only to the snapshot service. */
  readonly storageReference: string;
}

export const repositorySnapshotReferenceSchema = z.strictObject({
  repositoryId: repositoryIdSchema,
  commit: gitObjectIdSchema,
  storageReference: z.string().min(1).max(TEXT_LIMITS.url),
});

/**
 * `owner/name` — for logs and UI only.
 *
 * Never an identifier: it changes on rename and collides across providers.
 */
export function formatRepositoryName(repository: Repository): string {
  return `${repository.providerRepository.owner}/${repository.providerRepository.name}`;
}

/** Whether new reviews may be created for this repository. */
export function acceptsReviews(repository: Repository): boolean {
  return repository.lifecycle === "active";
}
