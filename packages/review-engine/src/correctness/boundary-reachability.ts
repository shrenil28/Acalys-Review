/**
 * P1-M.3.5 — proposing at the boundary the capability is named for.
 *
 * M.3.4 published claims reading "reachable through `<declaring module>`" while
 * its verifier adjudicated at the declared public entry point. Two stages, two
 * different semantic objects, and Epoch 3 found both consequences: a manifest
 * withdrawing a subpath proposed nothing, and when one edit lost a name at both
 * the entry and the declaring module, the module-local candidate won the race.
 *
 * # This consumes facts; it does not derive them
 *
 * The surfaces arrive as `boundary_surface` context items, built upstream from
 * the authoritative revision. Deriving them here would derive them from
 * whatever the planner selected, and a surface that lost a budget contest is
 * indistinguishable from a narrowed one — the mistake the verifier already
 * made once by compiling `context.items` instead of the revision.
 *
 * So this file knows nothing about manifests, barrels or `export *`. It
 * compares two surfaces and reports what a consumer lost.
 *
 * # Absence must be earned
 *
 * ```
 * HEAD established, name reachable   -> nothing
 * HEAD established, name absent      -> candidate
 * HEAD boundary absent entirely      -> candidate
 * HEAD empty (established, no names) -> candidate
 * HEAD partial or unavailable        -> NO conclusion, recorded
 * ```
 *
 * The last line is the whole discipline. A surface we could not finish reading
 * makes every name look missing, and reporting that would be concluding from
 * our own blindness.
 */

import type { AnalysisResult, CandidateFinding } from "../finding.js";
import type { AsyncAnalyzerInput } from "./async-completion.js";

export const BOUNDARY_REACHABILITY_RULE_ID =
  "acalys.correctness/public-boundary-reachability-loss";

interface DeliveredSurface {
  readonly boundaryIdentity: string;
  readonly consumerEntry: string | undefined;
  readonly reachableNames: readonly {
    readonly name: string;
    readonly namespace: "value" | "type";
    readonly provenance: string;
    readonly establishedIn: string;
  }[];
  readonly completeness: { readonly kind: string; readonly because?: string };
}

/** The surfaces the planner delivered, split by revision. */
function deliveredSurfaces(input: AsyncAnalyzerInput): {
  readonly base: ReadonlyMap<string, DeliveredSurface>;
  readonly head: ReadonlyMap<string, DeliveredSurface>;
} {
  const base = new Map<string, DeliveredSurface>();
  const head = new Map<string, DeliveredSurface>();

  for (const item of input.context.items) {
    if (item.kind !== "boundary_surface") continue;
    const provenance = item.provenance;
    if (provenance?.source !== "boundary_surface_facts") continue;

    let surface: DeliveredSurface;
    try {
      surface = JSON.parse(item.suppliedContent) as DeliveredSurface;
    } catch {
      continue;
    }

    const into = provenance.revision === "base" ? base : head;
    if (!into.has(surface.boundaryIdentity)) {
      into.set(surface.boundaryIdentity, surface);
    }
  }

  return { base, head };
}

interface Observation {
  readonly kind: "boundary_withdrawn" | "name_no_longer_reachable";
  readonly detail: string;
  readonly path: string;
}

interface Loss {
  readonly boundary: string;
  readonly name: string;
  readonly namespace: "value" | "type";
  readonly establishedIn: string;
  readonly provenance: string;
  readonly observations: Observation[];
}

export function analyzeBoundaryReachability(
  input: AsyncAnalyzerInput,
): AnalysisResult {
  const clusterId = input.clusterId ?? "cluster:unscoped";
  const { base, head } = deliveredSurfaces(input);
  const degradations: { path: string; because: string }[] = [];
  const losses = new Map<string, Loss>();

  for (const [identity, before] of base) {
    if (before.completeness.kind === "partial" || before.completeness.kind === "unavailable") {
      degradations.push({
        path: before.consumerEntry ?? identity,
        because:
          `the base surface of ${identity} is ${before.completeness.kind}` +
          `${before.completeness.because === undefined ? "" : `: ${before.completeness.because}`}` +
          ", so what used to be reachable cannot be established",
      });
      continue;
    }

    const after = head.get(identity);

    if (
      after !== undefined &&
      (after.completeness.kind === "partial" ||
        after.completeness.kind === "unavailable")
    ) {
      // The claim rests on the head surface. A surface we could not finish
      // reading makes every name look missing.
      degradations.push({
        path: after.consumerEntry ?? identity,
        because:
          `the head surface of ${identity} is ${after.completeness.kind}` +
          `${after.completeness.because === undefined ? "" : `: ${after.completeness.because}`}` +
          ", so no name can be said to have become unreachable",
      });
      continue;
    }

    const stillReachable = new Set(
      (after?.reachableNames ?? []).map(
        (entry) => `${entry.name}|${entry.namespace}`,
      ),
    );

    for (const lost of before.reachableNames) {
      if (stillReachable.has(`${lost.name}|${lost.namespace}`)) continue;

      // Keyed by what a consumer lost, deliberately free of any source path.
      // The entry point and the declaring module witness one break; they must
      // not become two findings, and neither may win a race to be it.
      const key = `${identity}|${lost.name}|${lost.namespace}`;
      const existing: Loss = losses.get(key) ?? {
        boundary: identity,
        name: lost.name,
        namespace: lost.namespace,
        establishedIn: lost.establishedIn,
        provenance: lost.provenance,
        observations: [],
      };

      existing.observations.push(
        after === undefined
          ? {
              kind: "boundary_withdrawn",
              detail: `\`${identity}\` is no longer declared`,
              path: before.consumerEntry ?? identity,
            }
          : {
              kind: "name_no_longer_reachable",
              detail: `\`${identity}\` no longer reaches \`${lost.name}\``,
              path: after.consumerEntry ?? identity,
            },
      );
      losses.set(key, existing);
    }
  }

  const findings: CandidateFinding[] = [...losses.keys()]
    .sort()
    .map((key) => {
      const loss = losses.get(key);
      /* c8 ignore next */
      if (loss === undefined) throw new Error("unreachable");
      return candidateFor(loss, clusterId);
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

function candidateFor(loss: Loss, clusterId: string): CandidateFinding {
  // Canonical, so discovery order cannot change the finding. Two runs that saw
  // the manifest and the entry file in opposite orders must produce the same
  // candidate byte for byte, not merely the same count.
  const observations = [...loss.observations].sort((left, right) => {
    const a = `${left.kind}|${left.path}|${left.detail}`;
    const b = `${right.kind}|${right.path}|${right.detail}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // The syntax that established reachability lives in the base revision: the
  // name was reachable there and is not here.
  const location = {
    path: loss.establishedIn,
    startLine: 1,
    endLine: 1,
    side: "base" as const,
  };

  return {
    ruleId: BOUNDARY_REACHABILITY_RULE_ID,
    category: "correctness",
    family: "api_contract",
    claim:
      `\`${loss.name}\` was reachable through \`${loss.boundary}\` at the base revision and is no longer ` +
      `reachable through that boundary, so consumers importing it stop compiling.`,
    causal: {
      anchor: location,
      steps: [
        `\`${loss.boundary}\` reached \`${loss.name}\` in its public ${loss.namespace} surface at the base revision.`,
        ...observations.map((entry) => entry.detail),
      ],
      trigger: `importing \`${loss.name}\` from \`${loss.boundary}\``,
      consequence:
        "consumers written against the previous public surface no longer compile",
    },
    remediation: `Keep \`${loss.name}\` reachable through \`${loss.boundary}\`, or record the withdrawal as an intentional breaking change.`,
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
        observation: `\`${loss.boundary}\` reached \`${loss.name}\` at the base revision, established by ${loss.provenance.replace(/_/g, " ")} in ${loss.establishedIn}.`,
        location,
      },
      ...observations.map((entry) => ({
        type: "static_analysis" as const,
        strength: "supporting" as const,
        observation: `${entry.detail}.`,
        location: { path: entry.path, startLine: 1, endLine: 1 },
      })),
    ],
    identityHint: `${loss.boundary}:${loss.name}:${loss.namespace}:boundary-reachability-loss`,
    clusterId,
  };
}
