/**
 * Deciding what an incremental update may keep — before anything is built.
 *
 * Planning is separated from execution because they fail differently and
 * should be provable differently. This module touches no compiler, does no
 * I/O, and returns a value: given an index for H1 and a description of what
 * changed, it says which modules may be carried forward and which must be
 * recomputed. That makes the interesting question — *is this invalidation
 * safe?* — answerable by a pure function test rather than by inspecting an
 * index afterwards and hoping the difference would have shown.
 *
 * # The asymmetry that decides every judgement call here
 *
 * ```
 * invalidate too much   slower, still equal to a full rebuild
 * invalidate too little  a stale fact survives, and the index lies
 * ```
 *
 * Those are not two sides of one trade-off. The first costs time; the second
 * produces a confident wrong answer with full provenance attached, which is
 * the worst artifact this system can emit. So the retention rule below is
 * deliberately, visibly over-conservative, and narrowing it is a later
 * exercise justified by measurement rather than by intuition.
 *
 * # Incremental is an optimization; full rebuild is the oracle
 *
 * Nothing here is authoritative about what the index *should* contain. The
 * full rebuild answers that. This decides only what work can be skipped, and
 * the equivalence property
 *
 * ```
 * canonical(full(H2)) == canonical(incremental(full(H1), H1 -> H2))
 * ```
 *
 * is what makes a mistake here detectable rather than merely regrettable.
 */

import type { GitObjectId } from "@acalys/contracts/domain";
import type { RepositoryIndex } from "./records.js";
import type { RevisionSnapshot } from "./build.js";
import { createHash } from "node:crypto";

/**
 * What changed between two revisions, in terms of modules.
 *
 * Paths rather than diffs: the index is per-module, so a hunk-level change
 * description would carry precision this planner cannot use and would invite
 * someone to try.
 */
export interface ChangeManifest {
  readonly previousRevision: GitObjectId;
  readonly nextRevision: GitObjectId;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly modified: readonly string[];
}

/** Why a module has to be recomputed. Closed, so a plan can be argued with. */
export const RECOMPUTE_REASONS = [
  "added",
  "modified",
  "references_changed_module",
  "unresolved_reference_present",
  "not_indexed_previously",
] as const;

export type RecomputeReason = (typeof RECOMPUTE_REASONS)[number];

export interface ModuleDecision {
  readonly moduleId: string;
  readonly reason: RecomputeReason;
}

export interface IncrementalIndexPlan {
  readonly previousRevision: GitObjectId;
  readonly nextRevision: GitObjectId;
  /** Carried forward from H1, with revision-scoped identity re-stamped. */
  readonly retained: readonly string[];
  /** Extracted afresh from H2 source. */
  readonly recomputed: readonly ModuleDecision[];
  /** Present at H1, absent at H2. */
  readonly deleted: readonly string[];
}

const digestOf = (material: string): string =>
  createHash("sha256").update(material, "utf8").digest("hex");

/**
 * Derives a manifest by comparing an index's recorded content digests to a
 * new snapshot.
 *
 * Offered because the alternative — trusting a caller's list of changed files
 * — makes the whole update only as correct as whatever produced that list. A
 * provider's "files changed" payload is a summary, and summaries omit things.
 * Comparing digests is cheap and cannot omit.
 *
 * `modified` is decided by content, not by mtime or by the provider's word.
 */
export function deriveChangeManifest(
  previous: RepositoryIndex,
  nextRevision: GitObjectId,
  next: RevisionSnapshot,
): ChangeManifest {
  const before = new Map(
    previous.modules.map((record) => [record.moduleId, record.contentDigest]),
  );

  const added: string[] = [];
  const modified: string[] = [];
  for (const [path, content] of next) {
    const known = before.get(path);
    if (known === undefined) added.push(path);
    else if (known !== digestOf(content)) modified.push(path);
  }

  const removed = [...before.keys()].filter((path) => !next.has(path));

  return {
    previousRevision: previous.identity.revision,
    nextRevision,
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
  };
}

/**
 * Which modules a module's facts depend on.
 *
 * Derived from the bindings already recorded: if anything in module M binds to
 * a declaration in module N, then M's facts can change when N does. This is
 * exactly the relationship L.2 exists to record, and it is the reason
 * invalidation could not be built before bindings were.
 *
 * Note what is deliberately included beyond that: a module holding any
 * `unresolved` reference depends on *every* module, because a name that
 * resolved to nothing at H1 may resolve to something at H2 the moment a file
 * is added. Treating unresolved references as dependency-free is the most
 * plausible way to under-invalidate, so it is ruled out here rather than
 * discovered later.
 */
function dependenciesOf(index: RepositoryIndex): {
  readonly byModule: ReadonlyMap<string, ReadonlySet<string>>;
  readonly universal: ReadonlySet<string>;
} {
  const declarationModule = new Map(
    index.declarations.map((record) => [record.declarationId, record.moduleId]),
  );
  const referenceModule = new Map(
    index.references.map((record) => [record.referenceId, record.moduleId]),
  );

  const byModule = new Map<string, Set<string>>();
  const universal = new Set<string>();

  for (const binding of index.bindings) {
    const from = referenceModule.get(binding.referenceId);
    if (from === undefined) continue;

    if (binding.resolution === "unresolved") {
      universal.add(from);
      continue;
    }

    let targets = byModule.get(from);
    if (targets === undefined) {
      targets = new Set<string>();
      byModule.set(from, targets);
    }
    for (const declarationId of binding.declarationIds) {
      const target = declarationModule.get(declarationId);
      if (target !== undefined) targets.add(target);
    }
  }

  // A symbol declared in more than one module — ambient and global
  // declarations merge across files — was guarded here by making those modules
  // mutually dependent. That guard is gone, and its absence is deliberate.
  //
  // It defended against splitting one symbol between a retained module and a
  // recomputed one. The execution model makes that impossible: declarations
  // are recomputed for EVERY module on every update, because symbol identity
  // is formed across the whole revision. Only references and bindings are ever
  // retained. So there is no interleaving in which half a symbol survives.
  //
  // A mutation removing the guard survived, which is what prompted checking.
  // The honest options were an unkillable rule in the plan or no rule, and
  // dead defensive code is worse than none: it reads as protection, so the
  // next person adds a case rather than asking whether the hazard exists.
  //
  // If a later optimization retains declarations too, this comes back — with a
  // test that fails without it.

  return { byModule, universal };
}

/**
 * Decides what an incremental update may keep.
 *
 * A module is retained only when all of the following hold:
 *
 * ```
 * it was successfully indexed at H1
 * its content is byte-identical at H2
 * it holds no unresolved references
 * nothing it binds into was added, modified, or removed
 * ```
 *
 * The third and fourth conditions are the ones that matter. Content equality
 * alone is the intuitive rule and is wrong: a module whose own bytes did not
 * change still records *bindings*, and a binding is a fact about two modules.
 * Rename a function in `store.ts` and every unchanged file that calls it now
 * holds a stale declaration id.
 *
 * The first condition — `coverage === "indexed"` — exists because a module
 * that failed to parse at H1 has incomplete facts by construction, and
 * carrying incomplete facts forward would make an indexing failure permanent
 * for as long as nobody edits the file.
 */
export function planIncrementalUpdate(
  previous: RepositoryIndex,
  manifest: ChangeManifest,
): IncrementalIndexPlan {
  const touched = new Set([
    ...manifest.added,
    ...manifest.modified,
    ...manifest.removed,
  ]);

  const { byModule, universal } = dependenciesOf(previous);

  const retained: string[] = [];
  const recomputed: ModuleDecision[] = [];
  const deleted = [...manifest.removed].sort();
  const removedSet = new Set(manifest.removed);

  for (const module of previous.modules) {
    if (removedSet.has(module.moduleId)) continue;

    const decide = (): RecomputeReason | undefined => {
      if (manifest.modified.includes(module.moduleId)) return "modified";
      if (module.coverage !== "indexed") return "not_indexed_previously";
      if (universal.has(module.moduleId)) {
        return "unresolved_reference_present";
      }
      const dependencies = byModule.get(module.moduleId);
      if (dependencies !== undefined) {
        for (const dependency of dependencies) {
          if (touched.has(dependency)) return "references_changed_module";
        }
      }
      return undefined;
    };

    const reason = decide();
    if (reason === undefined) retained.push(module.moduleId);
    else recomputed.push({ moduleId: module.moduleId, reason });
  }

  for (const path of manifest.added) {
    recomputed.push({ moduleId: path, reason: "added" });
  }

  return {
    previousRevision: manifest.previousRevision,
    nextRevision: manifest.nextRevision,
    retained: retained.sort(),
    recomputed: recomputed.sort((a, b) =>
      a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0,
    ),
    deleted,
  };
}
