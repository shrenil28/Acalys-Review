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
 *
 * # The candidate is checked here, and only here
 *
 * `validateIndexConsistency` is the production barrier. The full-rebuild
 * equivalence oracle runs in tests and nowhere else, so its existence is not a
 * reason to leave the consistency rules without direct coverage — a claim an
 * earlier version of this file made and a call-graph trace disproved. See
 * `consistency.ts`.
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
import { validateIndexConsistency } from "./consistency.js";
import {
  deriveChangeManifest,
  planIncrementalUpdate,
  type ChangeManifest,
  type IncrementalIndexPlan,
  type RecomputeReason,
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
  /**
   * How many modules each recompute reason accounts for.
   *
   * A map rather than two counters named `invalidatedByDirectChange` and
   * `invalidatedByDependency`, because those categories are not disjoint: a
   * module can be modified *and* bind into something that moved. Counters
   * would force the arithmetic to close by dropping one reason, which loses
   * provenance exactly where an optimization decision would later need it.
   *
   * The planner records one reason per module today. The shape is a map so
   * that recording several does not require changing this contract.
   */
  readonly recomputeReasons: Readonly<Partial<Record<RecomputeReason, number>>>;
  /**
   * References and bindings the extractor actually produced afresh.
   *
   * Counted from the candidate, not from the plan. "Planned 12, recomputed 14"
   * is a real thing to be able to notice, and a statistic derived from
   * intentions could never show it.
   */
  readonly referencesRecomputed: number;
  readonly bindingsRecomputed: number;
  /**
   * The same two counts carried forward from H1 rather than re-extracted.
   *
   * This is what the optimization actually saved. Recorded beside the
   * recomputed counts so the ratio is visible without arithmetic on a report.
   */
  readonly referencesRetained: number;
  readonly bindingsRetained: number;
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
      recomputeReasons: {},
      referencesRecomputed: 0,
      bindingsRecomputed: 0,
      referencesRetained: 0,
      bindingsRetained: 0,
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
  let assembled: AssemblyCounts;
  try {
    const result = assemble(previous, nextIdentity, snapshot, recomputed);
    candidate = result.index;
    assembled = result.counts;
  } catch (error) {
    return fullRebuild(
      "extraction_threw",
      error instanceof Error ? error.message : "extraction failed",
      plan,
    );
  }

  // The production commit barrier. Nothing else checks this candidate before
  // it becomes H2 — the full-rebuild oracle is a test construct and does not
  // run here — so a violation means no H2 escapes and the caller full-rebuilds.
  const violation = validateIndexConsistency(candidate);
  if (violation !== undefined) {
    return fullRebuild(
      "candidate_failed_validation",
      `${violation.rule}: ${violation.detail}`,
      plan,
    );
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
      recomputeReasons: plan.recomputed.reduce<
        Partial<Record<RecomputeReason, number>>
      >(
        (tally, entry) => ({
          ...tally,
          [entry.reason]: (tally[entry.reason] ?? 0) + 1,
        }),
        {},
      ),
      ...assembled,
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
interface AssemblyCounts {
  readonly referencesRecomputed: number;
  readonly bindingsRecomputed: number;
  readonly referencesRetained: number;
  readonly bindingsRetained: number;
}

function assemble(
  previous: RepositoryIndex,
  nextIdentity: RepositoryIndexIdentity,
  snapshot: RevisionSnapshot,
  recomputed: ReadonlySet<string>,
): { readonly index: RepositoryIndex; readonly counts: AssemblyCounts } {
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
    index: {
      ...fresh,
      references: [...fresh.references, ...carriedReferences].sort(byReference),
      bindings: [...fresh.bindings, ...carriedBindings].sort(byBinding),
    },
    // Counted from what was produced, not from what the plan asked for.
    counts: {
      referencesRecomputed: fresh.references.length,
      bindingsRecomputed: fresh.bindings.length,
      referencesRetained: carriedReferences.length,
      bindingsRetained: carriedBindings.length,
    },
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
