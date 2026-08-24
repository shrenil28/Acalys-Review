/**
 * P1-M.3.5 — proposing at the boundary the capability is named for.
 *
 * M.3.4 published claims reading "reachable through `<declaring module>`" while
 * its verifier adjudicated at the declared public entry point. Two stages, two
 * different semantic objects. Epoch 3 found both consequences:
 *
 * ```
 * a manifest withdraws a subpath, no source file changes
 *      -> no module export-set delta -> nothing proposed
 *
 * one edit loses a name at BOTH the entry and the declaring module
 *      -> two candidates raced, the module-local one won, and only the
 *         other described what a consumer experiences
 * ```
 *
 * # What changed
 *
 * ```
 * OLD   for each changed FILE: compare its export set
 * NEW   for each declared BOUNDARY: compare what a consumer can reach
 * ```
 *
 * The unit of identity moves with it. A candidate is keyed by the thing that
 * was lost — boundary, name, namespace — so the several observations that
 * witness one loss aggregate beneath a single finding instead of competing to
 * be it.
 *
 * # Order must not decide anything
 *
 * Evidence is sorted canonically before it reaches a candidate, and identity
 * never mentions a source path. This project has been bitten twice by
 * order-dependent selection — base and head context items colliding on a
 * dedupe key, and then module evidence displacing entry-point evidence — so
 * the witness asserts both discovery orders produce the same finding.
 */

import type { AnalysisResult, CandidateFinding } from "../finding.js";
import type { AsyncAnalyzerInput } from "./async-completion.js";
import {
  boundarySurface,
  declaredBoundaries,
  type PublicBoundarySurface,
  type ReachableName,
} from "./boundary-surface.js";

export const BOUNDARY_REACHABILITY_RULE_ID =
  "acalys.correctness/public-boundary-reachability-loss";

/**
 * The two revisions, as file maps.
 *
 * Head comes from the supplied context; base is head with the changed files
 * replaced by their base text. An unchanged file is identical in both
 * revisions, which is what makes a boundary-only edit observable at all: the
 * manifest differs and every source file is shared.
 *
 * Only complete source text and configuration are admitted. Instruction and
 * coverage items travel under a source file's own path, and comparing a real
 * file against prose once concluded that every export had been deleted.
 */
function revisionFiles(input: AsyncAnalyzerInput): {
  readonly baseFiles: ReadonlyMap<string, string>;
  readonly headFiles: ReadonlyMap<string, string>;
  readonly abstentions: readonly { path: string; because: string }[];
} {
  const head = new Map<string, string>();
  const base = new Map<string, string>();
  const abstentions: { path: string; because: string }[] = [];

  for (const item of input.context.items) {
    const usable =
      (item.kind === "source_file" && item.representation === "full") ||
      item.kind === "configuration";
    if (!usable) continue;
    if (!head.has(item.path)) head.set(item.path, item.suppliedContent);
  }

  for (const [path, content] of head) base.set(path, content);

  for (const item of input.context.items) {
    if (item.kind !== "base_revision") continue;
    const provenance = item.provenance;
    if (provenance?.source !== "base_revision_facts") continue;

    if (provenance.resolution === "present") {
      base.set(item.path, item.suppliedContent);
    } else if (provenance.resolution === "absent") {
      // The file is new at head, so it existed in neither the base surface nor
      // any boundary the base declared.
      base.delete(item.path);
    } else {
      abstentions.push({
        path: item.path,
        because: `the base revision is ${provenance.resolution}, so no boundary surface can be established from it`,
      });
    }
  }

  return { baseFiles: base, headFiles: head, abstentions };
}

/** Canonical key for one consumer-visible loss. */
const lossKey = (boundary: string, name: ReachableName): string =>
  `${boundary}|${name.name}|${name.namespace}`;

interface Observation {
  readonly kind: "boundary_withdrawn" | "name_no_longer_reachable";
  readonly detail: string;
  readonly path: string;
}

export function analyzeBoundaryReachability(
  input: AsyncAnalyzerInput,
): AnalysisResult {
  const clusterId = input.clusterId ?? "cluster:unscoped";
  const { baseFiles, headFiles, abstentions } = revisionFiles(input);
  const degradations = [...abstentions];

  const headBoundaries = new Map(
    declaredBoundaries(headFiles).map((entry) => [entry.identity, entry]),
  );

  const losses = new Map<
    string,
    {
      boundary: string;
      lost: ReachableName;
      observations: Observation[];
    }
  >();

  for (const boundary of declaredBoundaries(baseFiles)) {
    const before = boundarySurface(baseFiles, boundary);
    if (before.completeness.kind !== "established") {
      // Cannot say what used to be reachable, so cannot say anything was lost.
      degradations.push({
        path: before.consumerEntry ?? boundary.identity,
        because: `the base surface of ${boundary.identity} is ${before.completeness.kind}: ${describe(before)}`,
      });
      continue;
    }

    const headBoundary = headBoundaries.get(boundary.identity);
    const after: PublicBoundarySurface | undefined =
      headBoundary === undefined
        ? undefined
        : boundarySurface(headFiles, headBoundary);

    if (after !== undefined && after.completeness.kind !== "established") {
      // The head surface is the one an absence claim rests on. A partial or
      // unreadable head surface makes every name look missing, and reporting
      // that would be concluding from our own blindness — M.3.0's rule, one
      // layer up.
      degradations.push({
        path: after.consumerEntry ?? boundary.identity,
        because: `the head surface of ${boundary.identity} is ${after.completeness.kind}: ${describe(after)}`,
      });
      continue;
    }

    const stillReachable = new Set(
      (after?.reachableNames ?? []).map(
        (entry) => `${entry.name}|${entry.namespace}`,
      ),
    );

    for (const name of before.reachableNames) {
      if (stillReachable.has(`${name.name}|${name.namespace}`)) continue;

      const key = lossKey(boundary.identity, name);
      const existing = losses.get(key) ?? {
        boundary: boundary.identity,
        lost: name,
        observations: [],
      };

      existing.observations.push(
        after === undefined
          ? {
              kind: "boundary_withdrawn",
              detail: `${boundary.identity} is no longer declared`,
              path:
                manifestFor(headFiles, boundary.identity) ?? boundary.identity,
            }
          : {
              kind: "name_no_longer_reachable",
              detail: `${boundary.identity} no longer reaches \`${name.name}\``,
              path: after.consumerEntry ?? boundary.identity,
            },
      );
      losses.set(key, existing);
    }
  }

  const findings: CandidateFinding[] = [...losses.keys()].sort().map((key) => {
    const loss = losses.get(key);
    if (loss === undefined) throw new Error("unreachable");
    return candidateFor(loss, baseFiles, clusterId);
  });

  return {
    findings,
    suppressions: [],
    degradations: degradations.map((entry) => ({
      clusterId,
      reason: `${entry.path}: ${entry.because}`,
    })),
  };
}

const describe = (surface: PublicBoundarySurface): string =>
  "because" in surface.completeness
    ? surface.completeness.because
    : surface.completeness.kind;

/** The manifest that declared a boundary, for anchoring a withdrawal. */
function manifestFor(
  files: ReadonlyMap<string, string>,
  identity: string,
): string | undefined {
  const packageName = identity.split("/")[0];
  for (const path of [...files.keys()].sort()) {
    if (!path.endsWith("package.json")) continue;
    try {
      const parsed: unknown = JSON.parse(files.get(path) ?? "");
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>)["name"] === packageName
      ) {
        return path;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function candidateFor(
  loss: { boundary: string; lost: ReachableName; observations: Observation[] },
  baseFiles: ReadonlyMap<string, string>,
  clusterId: string,
): CandidateFinding {
  // Canonical, so discovery order cannot change the finding. Two runs that
  // observed the entry point and the declaring module in opposite orders must
  // produce the same candidate, byte for byte.
  const observations = [...loss.observations].sort((left, right) =>
    `${left.kind}|${left.path}|${left.detail}` <
    `${right.kind}|${right.path}|${right.detail}`
      ? -1
      : 1,
  );

  const anchorPath = loss.lost.establishedIn;
  const anchorLine = exposingLineIn(baseFiles.get(anchorPath), loss.lost.name);
  const location = {
    path: anchorPath,
    startLine: anchorLine,
    endLine: anchorLine,
    // The name was reachable at base and is not at head, so the syntax that
    // established it lives in the base revision.
    side: "base" as const,
  };

  return {
    ruleId: BOUNDARY_REACHABILITY_RULE_ID,
    category: "correctness",
    family: "api_contract",
    claim:
      `\`${loss.lost.name}\` was reachable through \`${loss.boundary}\` at the base revision and is no ` +
      `longer reachable through that boundary, so consumers importing it stop compiling.`,
    causal: {
      anchor: location,
      steps: [
        `\`${loss.boundary}\` exposed \`${loss.lost.name}\` in its public ${loss.lost.namespace} surface at the base revision.`,
        ...observations.map((entry) => entry.detail),
      ],
      trigger: `importing \`${loss.lost.name}\` from \`${loss.boundary}\``,
      consequence:
        "consumers written against the previous public surface no longer compile",
    },
    remediation: `Keep \`${loss.lost.name}\` reachable through \`${loss.boundary}\`, or record the withdrawal as an intentional breaking change.`,
    counterfactual: {
      existsWithoutChange: false,
      because: "the name was reachable through this boundary at base",
    },
    proposedSeverity: "medium",
    confidenceScore: 0.55,
    location,
    evidence: [
      {
        type: "static_analysis",
        strength: "supporting",
        observation: `\`${loss.boundary}\` reached \`${loss.lost.name}\` at the base revision, established by ${loss.lost.provenance.replace(/_/g, " ")} in ${loss.lost.establishedIn}.`,
        location,
      },
      ...observations.map((entry) => ({
        type: "static_analysis" as const,
        strength: "supporting" as const,
        observation: `${entry.detail}.`,
        location: { path: entry.path, startLine: 1, endLine: 1 },
      })),
    ],
    // Keyed by what a consumer lost. Deliberately free of any source path, so
    // the entry point and the declaring module cannot become two findings for
    // one break.
    identityHint: `${loss.boundary}:${loss.lost.name}:${loss.lost.namespace}:boundary-reachability-loss`,
    clusterId,
  };
}

/** The line of the statement exposing a name, read from the base revision. */
function exposingLineIn(content: string | undefined, name: string): number {
  if (content === undefined) return 1;
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (
      new RegExp(
        `export\\s+(?:type\\s+)?(?:\\{[^}]*\\b${name}\\b|(?:function|const|let|var|class|interface|type|enum)\\s+${name}\\b)`,
      ).test(line)
    ) {
      return index + 1;
    }
  }
  return 1;
}
