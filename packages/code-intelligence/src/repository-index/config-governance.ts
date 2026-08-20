/**
 * P1-L.4.2 — the governance algebra: state model in, no compiler in sight.
 *
 * `config-model.ts` fixes the states. This file is the pure arithmetic over
 * them: given what discovery found, what each project's config admits, and a
 * source path, decide `governed` / `not_governed` / `undetermined`, and derive
 * the two edges that are not governance at all.
 *
 * Nothing here reads a file or calls the compiler. `admittedFiles`,
 * `extendsPath`, and `referencedProjects` arrive already established —
 * TypeScript's own project parsing is what may establish them, and that
 * happens elsewhere. This module only has to get the arithmetic right, which
 * is exactly why it can be driven by hand-built facts a happy-path extractor
 * would never produce: an unavailable project sitting next to two available
 * ones that both admit the same file, an extends chain three deep, a
 * reference that must not leak into governance. None of that needs a real
 * tsconfig on disk.
 *
 * # The seam
 *
 * `ProjectDiscovery` and `ProjectConfigFact` below are declared locally
 * rather than imported from `config-discovery.js` / `config-projects.js`.
 * Those modules belong to other agents building in parallel and may not
 * exist yet in this worktree; TypeScript's structural typing means the real
 * ones will satisfy these shapes at integration without this file importing
 * either.
 *
 * One deliberate departure from the shape the brief describes:
 * `ProjectConfigFact` here carries a `provenance`. Every fact this module
 * emits (`SourceGovernance`, `OptionInheritance`, `ProjectReference`) is
 * required by the frozen contract to carry a {@link FactProvenance}, and this
 * module is barred from calling the compiler to manufacture one — a
 * placeholder line number would be exactly the kind of invented fact rule 5
 * forbids. The honest source of that citation is wherever the project's own
 * config was read and parsed, which is a fact the *extractor* holds, not the
 * algebra. So the input contract must carry it in. This is a gap in the
 * contract as described, not a decision this file was free to make silently;
 * it is reported alongside this delivery rather than worked around.
 */

import type {
  ConfigCoverage,
  ConfigGovernanceResult,
  GovernanceFailure,
  GovernanceReason,
  GovernanceUnavailable,
  NonGovernanceEvidence,
  OptionInheritance,
  ProjectReference,
  SourceGovernance,
} from "./config-model.js";
import type { FactProvenance } from "./records.js";

// ---------------------------------------------------------------------------
// The seam: locally declared, structurally compatible with Agent A and
// Agent B's real modules. Import nothing from either.
// ---------------------------------------------------------------------------

export interface ProjectDiscovery {
  readonly discovered: readonly string[];
  readonly coverage:
    | { readonly status: "complete" }
    | { readonly status: "incomplete"; readonly why: string };
}

export interface ProjectConfigFact {
  readonly configPath: string;
  readonly availability:
    | { readonly kind: "available" }
    | {
        readonly kind: "unavailable";
        readonly failure: GovernanceFailure;
        readonly detail: string;
      };
  readonly admittedFiles: readonly string[];
  readonly namedInFiles: readonly string[];
  readonly extendsPath?: string | undefined;
  readonly referencedProjects: readonly string[];
  readonly coverage?: {
    readonly membership: "complete" | "incomplete";
    readonly optionInheritance: "complete" | "incomplete";
  };
  /**
   * Where this project's own config was read and parsed. Cited by every
   * edge this file derives from the project — see the module comment.
   */
  readonly provenance: FactProvenance;
}

// ---------------------------------------------------------------------------
// governanceFor
// ---------------------------------------------------------------------------

/**
 * Which project(s) admit `sourcePath`, and how much of the project set that
 * answer actually covers.
 *
 * Coverage is computed once, up front, from the full `projects` list — every
 * available project's path goes in `evaluated`, every unavailable one goes in
 * `unevaluable`, regardless of whether it turns out to matter for this
 * source path. That coverage snapshot is then attached to whichever status
 * the relationship search produces.
 *
 * The order of the two checks below is the entire point of this function.
 * Governance is decided *before* coverage is asked whether it is complete:
 * a positive fact, once established by an available project, is never put
 * back in question by a different project's outage.
 */
export function governanceFor(
  discovery: ProjectDiscovery,
  projects: readonly ProjectConfigFact[],
  sourcePath: string,
): ConfigGovernanceResult {
  const evaluated: string[] = [];
  const unevaluable: GovernanceUnavailable[] = [];
  for (const project of projects) {
    if (project.availability.kind === "available") {
      evaluated.push(project.configPath);
      if (project.coverage?.membership === "incomplete") {
        unevaluable.push({
          failure: "extends_unresolvable",
          configPath: project.configPath,
          detail: `${project.configPath} has incomplete membership because its base configuration could not be resolved`,
        });
      }
    } else {
      unevaluable.push({
        failure: project.availability.failure,
        configPath: project.configPath,
        detail: project.availability.detail,
      });
    }
  }
  const coverage: ConfigCoverage = { evaluated, unevaluable };

  const relationships: SourceGovernance[] = [];
  for (const project of projects) {
    if (project.availability.kind !== "available") continue;
    if (!project.admittedFiles.includes(sourcePath)) continue;

    const reason: GovernanceReason = project.namedInFiles.includes(sourcePath)
      ? "included_by_files"
      : "included_by_include";

    relationships.push({
      sourcePath,
      projectPath: project.configPath,
      reason,
      provenance: project.provenance,
    });
  }
  relationships.sort((a, b) => compare(a.projectPath, b.projectPath));

  // A positive fact, once found, is reported regardless of what else in the
  // project set is broken — coverage travels alongside it, but never erases
  // it. This is the case the model was corrected for.
  if (relationships.length > 0) {
    return { status: "governed", relationships, coverage };
  }

  const discoveryComplete = discovery.coverage.status === "complete";
  const evaluationComplete = unevaluable.length === 0;

  // `not_governed` asserts a repository fact — nothing admits this file —
  // and that assertion is only earned when both dimensions of "did we
  // actually look" are complete: every project TypeScript could tell us
  // about was discovered, and every discovered project's config was read.
  if (discoveryComplete && evaluationComplete) {
    return {
      status: "not_governed",
      evidence: [
        {
          reason: "no_project_admits_it",
          detail: `No discovered project's rules admit ${sourcePath}.`,
        } satisfies NonGovernanceEvidence,
      ],
      coverage,
    };
  }

  return {
    status: "undetermined",
    coverage,
    why: describeGap(discovery, unevaluable.length),
  };
}

function describeGap(
  discovery: ProjectDiscovery,
  unevaluableCount: number,
): string {
  const gaps: string[] = [];
  if (discovery.coverage.status === "incomplete") {
    gaps.push(`project discovery is incomplete: ${discovery.coverage.why}`);
  }
  if (unevaluableCount > 0) {
    gaps.push(
      `${String(unevaluableCount)} project config${unevaluableCount === 1 ? "" : "s"} could not be evaluated`,
    );
  }
  return gaps.join("; ");
}

// ---------------------------------------------------------------------------
// optionInheritance
// ---------------------------------------------------------------------------

/**
 * Where each project's compiler options come from — never a governance
 * edge, see `config-model.ts`.
 *
 * Only available projects contribute: `extendsPath` on an unavailable
 * project is not a fact this module can trust, because "unavailable" means
 * the config could not be read or parsed, and a config that was not parsed
 * has no `extends` we are entitled to report. The same restraint applies
 * while walking a chain — the walk stops the moment it reaches a project
 * this call cannot vouch for.
 *
 * A chain of length N produces N edges from the origin project — one direct,
 * N-1 transitive — never a single edge flattened to the root. See the
 * `directness` doc on `OptionInheritance` for why that matters to a caller.
 */
export function optionInheritance(
  projects: readonly ProjectConfigFact[],
): readonly OptionInheritance[] {
  const byPath = new Map(
    projects.map((project) => [project.configPath, project]),
  );
  const edges: OptionInheritance[] = [];

  for (const project of projects) {
    if (project.availability.kind !== "available") continue;
    if (project.extendsPath === undefined) continue;

    edges.push({
      projectPath: project.configPath,
      inheritsFrom: project.extendsPath,
      directness: "direct",
      depth: 1,
      provenance: project.provenance,
    });

    // Walk the chain. Each further hop is a fact stated by the config one
    // link back — `next` is the file whose own `extends` names the file
    // this edge points at — so `next`'s provenance is what is cited, even
    // though the edge's `projectPath` stays the origin throughout.
    const visited = new Set<string>([project.configPath, project.extendsPath]);
    let depth = 1;
    let cursor = byPath.get(project.extendsPath);
    while (
      cursor !== undefined &&
      cursor.availability.kind === "available" &&
      cursor.extendsPath !== undefined &&
      !visited.has(cursor.extendsPath)
    ) {
      depth += 1;
      edges.push({
        projectPath: project.configPath,
        inheritsFrom: cursor.extendsPath,
        directness: "transitive",
        depth,
        provenance: cursor.provenance,
      });
      visited.add(cursor.extendsPath);
      cursor = byPath.get(cursor.extendsPath);
    }
  }

  edges.sort(
    (a, b) => compare(a.projectPath, b.projectPath) || a.depth - b.depth,
  );
  return edges;
}

// ---------------------------------------------------------------------------
// projectReferences
// ---------------------------------------------------------------------------

/**
 * Project-to-project dependencies — never a governance edge either. A
 * project referencing another does not put a single file of its own under
 * the referenced project's rules; see `config-model.ts`.
 *
 * Restricted to available projects for the same reason as `optionInheritance`:
 * `referencedProjects` on a config that could not be parsed is not a fact
 * this module has grounds to assert.
 */
export function projectReferences(
  projects: readonly ProjectConfigFact[],
): readonly ProjectReference[] {
  const edges: ProjectReference[] = [];
  for (const project of projects) {
    if (project.availability.kind !== "available") continue;
    for (const referencesProject of project.referencedProjects) {
      edges.push({
        projectPath: project.configPath,
        referencesProject,
        provenance: project.provenance,
      });
    }
  }
  edges.sort(
    (a, b) =>
      compare(a.projectPath, b.projectPath) ||
      compare(a.referencesProject, b.referencesProject),
  );
  return edges;
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
