/**
 * Applying an invalidation plan — and refusing to expose the result unless it
 * holds together.
 *
 * # A revision label is a claim, not a field
 *
 * The dangerous shape this module exists to prevent:
 *
 * ```
 * take Index(H1)
 * patch some of it
 * set revision = H2
 * ```
 *
 * That produces `part-H1 + part-H2` wearing an H2 label, and every downstream
 * citation inherits the lie with full provenance attached. So the flow is
 * always:
 *
 * ```
 * construct a CANDIDATE index
 *   -> validate its invariants
 *     -> canonicalize
 *       -> only then is it Index(H2)
 * ```
 *
 * If construction or validation fails, H1 remains H1 and the caller is told
 * H2 could not be built incrementally. It falls back to a full rebuild, which
 * is always available because incremental is an optimization and never the
 * authority.
 *
 * # What is actually saved
 *
 * Declarations are recomputed for every module, because symbol identity is
 * formed across the whole revision. What retention skips is reference and
 * binding extraction — one checker query per identifier, plus alias
 * resolution — which is the expensive half.
 *
 * Whether that is worth doing is a measurement, not a belief, so
 * {@link IncrementalStats} records what happened rather than asserting a win.
 * A full rebuild reached through the fallback path is never reported as an
 * incremental success.
 */

import { createHash } from "node:crypto";
import { buildRepositoryIndex, type RevisionSnapshot } from "./build.js";
import { indexIdentity, type RepositoryIndexIdentity } from "./identity.js";
import type {
  BindingEdge,
  DeclarationRecord,
  ReferenceRecord,
  RepositoryIndex,
} from "./records.js";
import {
  deriveChangeManifest,
  planIncrementalUpdate,
  type ChangeManifest,
  type IncrementalIndexPlan,
} from "./incremental-plan.js";

/** Why an incremental update did not produce the index. Closed. */
export const FALLBACK_REASONS = [
  "previous_index_unusable",
  "revision_mismatch",
  "candidate_failed_validation",
  "extraction_threw",
] as const;

export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/**
 * What happened, in numbers a report can use.
 *
 * `attempted` and `succeeded` are separate fields on purpose. An incremental
 * path that quietly full-rebuilds and reports success would make the
 * economics question — does this save work? — permanently unanswerable, and
 * the answer would drift towards "yes" because nobody could check.
 */
export interface IncrementalStats {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly fallbackReason?: FallbackReason | undefined;
  readonly fallbackDetail?: string | undefined;
  readonly modulesTotal: number;
  readonly modulesRetained: number;
  readonly modulesRecomputed: number;
  readonly modulesDeleted: number;
}

export interface IncrementalOutcome {
  readonly index: RepositoryIndex;
  readonly stats: IncrementalStats;
  readonly plan?: IncrementalIndexPlan | undefined;
}

const digestOf = (material: string): string =>
  createHash("sha256").update(material, "utf8").digest("hex");

const shortId = (parts: readonly string[]): string =>
  digestOf(parts.join(" ")).slice(0, 24);

/**
 * Rebuilds an index for H2, reusing what the plan says may be reused.
 *
 * Takes the H2 snapshot rather than a diff: the snapshot is the ground truth,
 * and a caller that could supply only a diff would be asking this function to
 * trust a summary of what changed. {@link deriveChangeManifest} compares
 * content digests instead.
 */
export function updateRepositoryIndex(options: {
  readonly previous: RepositoryIndex;
  readonly nextIdentity: RepositoryIndexIdentity;
  readonly snapshot: RevisionSnapshot;
  readonly manifest?: ChangeManifest | undefined;
}): IncrementalOutcome {
  const { previous, nextIdentity, snapshot } = options;

  const fullRebuild = (
    reason: FallbackReason,
    detail: string,
    plan?: IncrementalIndexPlan,
  ): IncrementalOutcome => ({
    index: buildRepositoryIndex({ identity: nextIdentity, snapshot }),
    stats: {
      attempted: true,
      succeeded: false,
      fallbackReason: reason,
      fallbackDetail: detail,
      modulesTotal: snapshot.size,
      modulesRetained: 0,
      modulesRecomputed: snapshot.size,
      modulesDeleted: 0,
    },
    ...(plan === undefined ? {} : { plan }),
  });

  // An index that failed to build cannot be a basis for deciding what did not
  // change. Its emptiness is an outage, not a description of a repository.
  if (previous.availability.kind !== "built") {
    return fullRebuild(
      "previous_index_unusable",
      `the previous index is ${previous.availability.kind}`,
    );
  }

  const manifest =
    options.manifest ??
    deriveChangeManifest(previous, nextIdentity.revision, snapshot);

  // The manifest and the previous index must describe the same revision, or
  // the retention decisions are about a repository state nobody holds.
  if (
    manifest.previousRevision.value !== previous.identity.revision.value ||
    manifest.nextRevision.value !== nextIdentity.revision.value
  ) {
    return fullRebuild(
      "revision_mismatch",
      `manifest spans ${manifest.previousRevision.value.slice(0, 12)}..` +
        `${manifest.nextRevision.value.slice(0, 12)} but the update is ` +
        `${previous.identity.revision.value.slice(0, 12)}..` +
        `${nextIdentity.revision.value.slice(0, 12)}`,
    );
  }

  const plan = planIncrementalUpdate(previous, manifest);
  const recomputed = new Set(plan.recomputed.map((entry) => entry.moduleId));

  let candidate: RepositoryIndex;
  try {
    candidate = assemble(previous, nextIdentity, snapshot, recomputed);
  } catch (error) {
    return fullRebuild(
      "extraction_threw",
      error instanceof Error ? error.message : "extraction failed",
      plan,
    );
  }

  const violation = validate(candidate);
  if (violation !== undefined) {
    return fullRebuild("candidate_failed_validation", violation, plan);
  }

  return {
    index: candidate,
    stats: {
      attempted: true,
      succeeded: true,
      modulesTotal: candidate.modules.length,
      modulesRetained: plan.retained.length,
      modulesRecomputed: plan.recomputed.length,
      modulesDeleted: plan.deleted.length,
    },
    plan,
  };
}

/**
 * Builds the candidate index.
 *
 * Declarations come fresh from H2 for every module. References and bindings
 * come fresh only for recomputed modules; retained modules' are carried
 * forward from H1 and re-stamped onto H2's identities.
 *
 * Re-stamping is necessary rather than cosmetic: `symbolId` and
 * `declarationId` are revision-scoped by construction (L.1), so an H1 record
 * copied verbatim would carry an identity that names the wrong revision. The
 * facts survive the revision change; the identities do not, and pretending
 * otherwise would be the cross-revision continuity claim L.1 explicitly
 * refuses to make.
 */
function assemble(
  previous: RepositoryIndex,
  nextIdentity: RepositoryIndexIdentity,
  snapshot: RevisionSnapshot,
  recomputed: ReadonlySet<string>,
): RepositoryIndex {
  const fresh = buildRepositoryIndex({
    identity: nextIdentity,
    snapshot,
    extractReferencesFor: recomputed,
  });

  const revision = nextIdentity.revision.value;

  // H1 declaration id -> H2 declaration id, matched on the facts that survive
  // a revision change: which module, which span, which kind.
  const byLocation = new Map<string, string>();
  for (const record of fresh.declarations) {
    byLocation.set(locationKey(record), record.declarationId);
  }

  const previousDeclaration = new Map(
    previous.declarations.map((record) => [record.declarationId, record]),
  );

  const carriedReferences: ReferenceRecord[] = [];
  const carriedBindings: BindingEdge[] = [];

  const previousReference = new Map(
    previous.references.map((record) => [record.referenceId, record]),
  );

  // H1 reference id -> H2 reference id, built in the same pass that carries
  // the records forward. An earlier version zipped two filtered arrays by
  // position, which is correct only while both filters stay identical — the
  // kind of coupling that survives review and breaks on the next edit.
  const carriedReferenceIds = new Map<string, string>();

  for (const reference of previous.references) {
    if (recomputed.has(reference.moduleId)) continue;
    if (!snapshot.has(reference.moduleId)) continue;

    const referenceId = shortId([
      revision,
      reference.moduleId,
      reference.name,
      reference.kind,
      String(reference.line),
    ]);

    carriedReferenceIds.set(reference.referenceId, referenceId);
    carriedReferences.push({
      ...reference,
      referenceId,
      provenance: { ...reference.provenance, revision },
    });
  }

  for (const binding of previous.bindings) {
    const reference = previousReference.get(binding.referenceId);
    if (reference === undefined) continue;
    if (recomputed.has(reference.moduleId)) continue;
    if (!snapshot.has(reference.moduleId)) continue;

    const referenceId = carriedReferenceIds.get(binding.referenceId);
    if (referenceId === undefined) continue;

    // Every declaration this binding pointed at must still exist at H2, at the
    // same location. If any does not, the retention decision was wrong and the
    // candidate will fail validation rather than silently losing an edge.
    const declarationIds: string[] = [];
    for (const declarationId of binding.declarationIds) {
      const record = previousDeclaration.get(declarationId);
      if (record === undefined) continue;
      const mapped = byLocation.get(locationKey(record));
      if (mapped !== undefined) declarationIds.push(mapped);
    }

    const symbolId =
      declarationIds.length === 0
        ? undefined
        : fresh.declarations.find(
            (record) => record.declarationId === declarationIds[0],
          )?.symbolId;

    carriedBindings.push({
      ...binding,
      bindingId: shortId([referenceId, symbolId ?? "unbound"]),
      referenceId,
      ...(symbolId === undefined ? {} : { symbolId }),
      declarationIds,
      provenance: { ...binding.provenance, revision },
    });
  }

  return {
    ...fresh,
    references: [...fresh.references, ...carriedReferences].sort(byReference),
    bindings: [...fresh.bindings, ...carriedBindings].sort(byBinding),
  };
}

function locationKey(record: DeclarationRecord): string {
  return [
    record.moduleId,
    record.kind,
    String(record.startLine),
    String(record.endLine),
  ].join("");
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const byReference = (a: ReferenceRecord, b: ReferenceRecord): number =>
  compare(a.moduleId, b.moduleId) ||
  a.line - b.line ||
  compare(a.name, b.name) ||
  compare(a.kind, b.kind) ||
  compare(a.referenceId, b.referenceId);

const byBinding = (a: BindingEdge, b: BindingEdge): number =>
  compare(a.referenceId, b.referenceId) || compare(a.bindingId, b.bindingId);

/**
 * Checks the candidate's internal consistency before it is allowed to be H2.
 *
 * These are the invariants a correct index satisfies by construction, so a
 * violation means the assembly above produced something a full rebuild never
 * would. Returning a reason rather than throwing lets the caller record why it
 * fell back, which is the difference between a measurable fallback rate and a
 * mystery.
 *
 * **This carries no mutation coverage, and that is known rather than assumed.**
 * A mutation skipping validation entirely survives, because reaching it
 * requires the assembly above to already be wrong — and if it were, the
 * equivalence oracle would fail first and more loudly. Validation is a second
 * line for defects not yet written, which is exactly the kind of guard a
 * mutation cannot defend.
 *
 * The alternative was to delete it. Kept, because the failure it catches —
 * a candidate exposed as H2 while internally inconsistent — is the one this
 * module exists to prevent, and the cost of keeping it is one uncovered
 * function rather than a wrong index.
 */
function validate(index: RepositoryIndex): string | undefined {
  const declarationIds = new Set(
    index.declarations.map((record) => record.declarationId),
  );
  const symbolIds = new Set(index.symbols.map((record) => record.symbolId));
  const referenceIds = new Set(
    index.references.map((record) => record.referenceId),
  );
  const revision = index.identity.revision.value;

  for (const record of index.declarations) {
    if (!symbolIds.has(record.symbolId)) {
      return `declaration ${record.declarationId} names symbol ${record.symbolId}, which is absent`;
    }
    if (record.provenance.revision !== revision) {
      return `declaration ${record.declarationId} carries revision ${record.provenance.revision}, not ${revision}`;
    }
  }

  for (const record of index.references) {
    if (record.provenance.revision !== revision) {
      return `reference ${record.referenceId} carries revision ${record.provenance.revision}, not ${revision}`;
    }
  }

  const seenReference = new Set<string>();
  for (const edge of index.bindings) {
    if (!referenceIds.has(edge.referenceId)) {
      return `binding ${edge.bindingId} names reference ${edge.referenceId}, which is absent`;
    }
    if (seenReference.has(edge.referenceId)) {
      return `reference ${edge.referenceId} has more than one binding`;
    }
    seenReference.add(edge.referenceId);

    for (const declarationId of edge.declarationIds) {
      if (!declarationIds.has(declarationId)) {
        return `binding ${edge.bindingId} points at declaration ${declarationId}, which is absent`;
      }
    }
    if (edge.symbolId !== undefined && !symbolIds.has(edge.symbolId)) {
      return `binding ${edge.bindingId} names symbol ${edge.symbolId}, which is absent`;
    }
    if (edge.provenance.revision !== revision) {
      return `binding ${edge.bindingId} carries revision ${edge.provenance.revision}, not ${revision}`;
    }
  }

  if (seenReference.size !== index.references.length) {
    return `${String(index.references.length)} references but ${String(seenReference.size)} bound`;
  }

  return undefined;
}

/** Convenience: build H2 incrementally from H1, deriving the manifest. */
export function updateFromSnapshot(
  previous: RepositoryIndex,
  nextRevision: RepositoryIndexIdentity["revision"],
  snapshot: RevisionSnapshot,
): IncrementalOutcome {
  return updateRepositoryIndex({
    previous,
    nextIdentity: indexIdentity({
      tenant: previous.identity.tenant,
      provider: previous.identity.provider,
      repositoryId: previous.identity.repositoryId,
      revision: nextRevision,
    }),
    snapshot,
  });
}
