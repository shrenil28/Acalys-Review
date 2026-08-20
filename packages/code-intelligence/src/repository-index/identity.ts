/**
 * What an index *is*, before anything asks what it contains.
 *
 * An index is a statement about one repository at one revision, produced by
 * one extractor under one schema. Every part of that sentence is load-bearing,
 * and leaving any of it off produces a fact that cannot be checked later.
 *
 * # Why the revision is part of the identity, not a field on the side
 *
 * ```
 * index(H1)  ≠  index(H2)
 * ```
 *
 * even when 99.9% of the records are reusable. That inequality is the whole
 * point: a finding cites index facts, and "the declaration is at line 40" is
 * only true of a revision. An index that could silently answer for a different
 * revision would let a verifier confirm a claim against code that was never
 * reviewed.
 *
 * There is deliberately no mutable `latestIndex` handed to review code. A
 * caller must name the revision it means, because a caller that cannot name it
 * does not know what its answer describes.
 *
 * # Why the versions are in the identity
 *
 * ```
 * indexSchemaVersion   the shape of the records
 * extractorVersion     the procedure that produced them
 * ```
 *
 * A cached index built by yesterday's extractor is not the index today's code
 * would build, and reusing it is how a fixed extraction bug quietly stays
 * fixed only in new repositories. Both are in the identity and both are in the
 * digest, so a stale artifact fails to match rather than being trusted.
 */

import type { GitObjectId } from "@acalys/contracts/domain";
import type { SourceProvider } from "@acalys/contracts/domain";

/**
 * The schema version of the records themselves.
 *
 * Bump when a record type gains, loses, or changes the meaning of a field.
 * Not when the extraction procedure improves — that is
 * {@link EXTRACTOR_VERSION}, and conflating the two makes it impossible to say
 * whether a digest changed because the facts changed or because their shape
 * did.
 */
export const INDEX_SCHEMA_VERSION = "acalys.repository-index.v1";

/**
 * The version of the procedure that reads source and emits records.
 *
 * Bump when extraction would produce different records from identical input:
 * a fixed bug, a newly recognized declaration form, a changed classification
 * rule.
 */
export const EXTRACTOR_VERSION = "acalys.extractor.typescript.v1";

/**
 * The languages this extractor can speak, named rather than implied.
 *
 * Production grade does not mean pretending universal support. It means
 * `supported → correct` and `unsupported → explicit`: a Python file in an
 * indexed repository is recorded as `unsupported_language`, never as a module
 * with no declarations.
 */
export const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

/**
 * Who an index belongs to — or an explicit statement that nobody has said.
 *
 * `"unknown"` was the first version of this and it was wrong in a way worth
 * naming. A placeholder string is a *value in the same domain* as a real
 * tenant id, so two different tenants entering through callers that supply
 * nothing both become `"unknown"` and their identities compare equal. Nothing
 * in the type stops that index being cached and handed to the other tenant.
 *
 * Today no caller supplies a tenant and nothing is persisted, so the risk is
 * latent rather than live. `unscoped` makes it latent *and visible*: it cannot
 * be mistaken for a tenant id, and {@link isPersistable} refuses it.
 *
 * The hard prerequisite, recorded here rather than in a document nobody reads:
 * **real tenant identity is mandatory before any index is persisted, cached,
 * or shared across runs.**
 */
export type TenantScope =
  | { readonly kind: "tenant"; readonly tenantId: string }
  | { readonly kind: "unscoped"; readonly why: string };

export interface RepositoryIndexIdentity {
  readonly tenant: TenantScope;
  readonly provider: SourceProvider;
  readonly repositoryId: string;
  /** The revision these facts describe. Never optional, never a branch name. */
  readonly revision: GitObjectId;
  readonly indexSchemaVersion: string;
  readonly extractorVersion: string;
}

export interface RepositoryIndexIdentityInput {
  readonly tenant: TenantScope;
  readonly provider: SourceProvider;
  readonly repositoryId: string;
  readonly revision: GitObjectId;
}

/**
 * Stamps an identity with the versions of the code doing the stamping.
 *
 * A caller cannot supply the versions, because a caller that could supply them
 * could claim an index was built by an extractor that did not build it.
 */
export function indexIdentity(
  input: RepositoryIndexIdentityInput,
): RepositoryIndexIdentity {
  return {
    tenant: input.tenant,
    provider: input.provider,
    repositoryId: input.repositoryId,
    revision: input.revision,
    indexSchemaVersion: INDEX_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
  };
}

/**
 * Whether two identities describe the same index.
 *
 * Field by field rather than by digest comparison of a serialized form: this
 * is used to decide whether a cached index may answer a question, and a
 * comparison that skipped a field would make exactly the wrong answer
 * available.
 */
export function sameIndex(
  left: RepositoryIndexIdentity,
  right: RepositoryIndexIdentity,
): boolean {
  return (
    sameTenant(left.tenant, right.tenant) &&
    left.provider === right.provider &&
    left.repositoryId === right.repositoryId &&
    left.revision.algorithm === right.revision.algorithm &&
    left.revision.value === right.revision.value &&
    left.indexSchemaVersion === right.indexSchemaVersion &&
    left.extractorVersion === right.extractorVersion
  );
}

function sameTenant(left: TenantScope, right: TenantScope): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "tenant" && right.kind === "tenant"
    ? left.tenantId === right.tenantId
    : // Two unscoped identities are equal as values, and that is exactly the
      // hazard: under `unscoped` the tenant component distinguishes nothing.
      // `isPersistable` is what stops that equality being acted on.
      true;
}

/**
 * Whether this index may be stored, cached, or reused across runs.
 *
 * False for `unscoped`, because an index whose tenant component distinguishes
 * nothing must never become a cache key: the next lookup for a different
 * tenant's copy of the same public revision would hit it.
 *
 * In-memory use within a single analysis is fine and is what L.1 does — the
 * index is built, used, and discarded inside one call.
 */
export function isPersistable(identity: RepositoryIndexIdentity): boolean {
  return identity.tenant.kind === "tenant";
}

/** The tenant component as it appears in logs and the digest preimage. */
export function describeTenant(tenant: TenantScope): string {
  return tenant.kind === "tenant" ? `tenant:${tenant.tenantId}` : "unscoped";
}

/** A short, stable, human-readable identity, for logs and provenance strings. */
export function describeIdentity(identity: RepositoryIndexIdentity): string {
  return [
    describeTenant(identity.tenant),
    identity.provider,
    identity.repositoryId,
    identity.revision.value,
    identity.indexSchemaVersion,
    identity.extractorVersion,
  ].join("@");
}
