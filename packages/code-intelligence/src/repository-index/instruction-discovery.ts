/**
 * Conservative discovery of repository instruction candidates.
 *
 * This module answers only three questions:
 *
 * 1. Which explicitly recognized artifact paths were observed?
 * 2. What class and trust does the path convention establish?
 * 3. Were traversal and candidate evaluation complete?
 *
 * It does not decide whether an artifact applies to a target, compare
 * precedence, inspect prose for imperative language, or treat Markdown in
 * general as instructions. All I/O is supplied by an abstract revision
 * snapshot so callers and tests can represent failures without converting
 * them into absence.
 */

import {
  isRepositoryPath,
  pathBasename,
  pathDirname,
} from "@acalys/contracts/domain";

import type {
  AvailableInstructionArtifact,
  InstructionFacts,
  InstructionFailure,
  InstructionProvenance,
  UnavailableInstructionArtifact,
} from "./instruction-model.js";

export type InstructionCandidateClassification =
  | {
      readonly instructionClass: "repository_policy";
      readonly trust: "authoritative";
      readonly scopeRoot: ".";
    }
  | {
      readonly instructionClass: "directory_scoped_policy";
      readonly trust: "authoritative";
      readonly scopeRoot: string;
    }
  | {
      readonly instructionClass: "documentation";
      readonly trust: "informational";
      readonly scopeRoot: string;
    };

type DirectiveInstructionCandidateClassification = Exclude<
  InstructionCandidateClassification,
  { readonly instructionClass: "documentation" }
>;

export type InstructionTraversal =
  | {
      readonly status: "complete";
      readonly paths: readonly string[];
    }
  | {
      readonly status: "incomplete";
      /** Every path established before or despite the traversal gap. */
      readonly paths: readonly string[];
      readonly why: string;
    };

export type InstructionArtifactRead =
  | { readonly status: "available"; readonly content: string }
  | { readonly status: "unreadable"; readonly detail: string }
  | { readonly status: "malformed"; readonly detail: string }
  | { readonly status: "unsupported"; readonly detail: string };

/**
 * Revision-bound input for discovery. Implementations may use a Git tree,
 * archive, or in-memory fixture; failures are values rather than exceptions.
 */
export interface InstructionRevisionSnapshot {
  readonly revision: string;
  readonly listPaths: () => InstructionTraversal;
  readonly readArtifact: (path: string) => InstructionArtifactRead;
}

/** An unavailable candidate with the classification its path established. */
export type DiscoveredUnavailableInstructionArtifact =
  UnavailableInstructionArtifact &
    DirectiveInstructionCandidateClassification & {
      readonly provenance: InstructionProvenance;
    };

type DiscoveredAvailableInstructionArtifact = Extract<
  AvailableInstructionArtifact,
  {
    readonly instructionClass: "repository_policy" | "directory_scoped_policy";
  }
>;

export type DiscoveredInstructionArtifact =
  | DiscoveredAvailableInstructionArtifact
  | DiscoveredUnavailableInstructionArtifact;

export type InstructionEvaluationCoverage =
  | { readonly status: "complete" }
  | {
      readonly status: "incomplete";
      readonly why: string;
    };

/**
 * Structurally compatible with InstructionFacts for downstream factual
 * algebra, while retaining evaluation completeness at the discovery boundary.
 */
export interface InstructionDiscoveryResult extends InstructionFacts {
  readonly artifacts: readonly DiscoveredInstructionArtifact[];
  readonly evaluation: InstructionEvaluationCoverage;
}

const EXTRACTOR_VERSION = "instruction-discovery/v1";

/** Codepoint ordering, independent of locale and traversal order. */
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Exact path-name allowlist. No content is consulted here.
 *
 * `AGENTS.md` is the sole supported policy convention in this first slice.
 * `README.md` is retained as informational documentation so its non-authority
 * is explicit. Every other filename, including every other Markdown file, is
 * outside the candidate set.
 */
export function classifyInstructionCandidate(
  artifactPath: string,
): InstructionCandidateClassification | undefined {
  if (!isRepositoryPath(artifactPath)) return undefined;

  const filename = pathBasename(artifactPath);
  const parent = pathDirname(artifactPath) ?? ".";

  if (filename === "AGENTS.md") {
    if (parent === ".") {
      return {
        instructionClass: "repository_policy",
        trust: "authoritative",
        scopeRoot: ".",
      };
    }

    return {
      instructionClass: "directory_scoped_policy",
      trust: "authoritative",
      scopeRoot: parent,
    };
  }

  if (filename === "README.md") {
    return {
      instructionClass: "documentation",
      trust: "informational",
      scopeRoot: parent,
    };
  }

  return undefined;
}

/** Discover and classify candidates without computing applicability. */
export function discoverInstructionArtifacts(
  snapshot: InstructionRevisionSnapshot,
): InstructionDiscoveryResult {
  const traversal = snapshot.listPaths();
  const candidatePaths = [...new Set(traversal.paths)]
    .filter((path) => {
      const classification = classifyInstructionCandidate(path);
      return (
        classification !== undefined &&
        classification.instructionClass !== "documentation"
      );
    })
    .sort(compareText);
  const artifacts: DiscoveredInstructionArtifact[] = [];
  const evaluationGaps: string[] = [];

  for (const artifactPath of candidatePaths) {
    const classification = classifyInstructionCandidate(artifactPath);
    if (
      classification === undefined ||
      classification.instructionClass === "documentation"
    ) {
      continue;
    }

    const provenance: InstructionProvenance = {
      source: "repository_artifact",
      path: artifactPath,
      revision: snapshot.revision,
      extractorVersion: EXTRACTOR_VERSION,
    };
    const read = snapshot.readArtifact(artifactPath);

    if (read.status === "available") {
      artifacts.push(
        availableArtifact(
          artifactPath,
          read.content,
          classification,
          provenance,
        ),
      );
      continue;
    }

    const failure = instructionFailureFor(read.status);
    artifacts.push(
      unavailableArtifact(
        artifactPath,
        classification,
        failure,
        read.detail,
        provenance,
      ),
    );
    evaluationGaps.push(`${artifactPath}: ${read.detail}`);
  }

  const discovery: InstructionFacts["discovery"] =
    traversal.status === "complete"
      ? { status: "complete" }
      : { status: "incomplete", why: traversal.why };
  const evaluation: InstructionEvaluationCoverage =
    evaluationGaps.length === 0
      ? { status: "complete" }
      : {
          status: "incomplete",
          why: evaluationGaps.sort(compareText).join("; "),
        };

  return { artifacts, discovery, evaluation };
}

function availableArtifact(
  artifactPath: string,
  content: string,
  classification: DirectiveInstructionCandidateClassification,
  provenance: InstructionProvenance,
): DiscoveredAvailableInstructionArtifact {
  const base = {
    artifactPath,
    availability: { kind: "available" } as const,
    content,
    provenance,
  };

  switch (classification.instructionClass) {
    case "repository_policy":
      return { ...base, ...classification };
    case "directory_scoped_policy":
      return { ...base, ...classification };
  }
}

function unavailableArtifact(
  artifactPath: string,
  classification: DirectiveInstructionCandidateClassification,
  failure: InstructionFailure,
  detail: string,
  provenance: InstructionProvenance,
): DiscoveredUnavailableInstructionArtifact {
  const base = {
    artifactPath,
    availability: {
      kind: "unavailable" as const,
      failure,
      detail,
    },
    provenance,
  };

  switch (classification.instructionClass) {
    case "repository_policy":
      return { ...base, ...classification };
    case "directory_scoped_policy":
      return { ...base, ...classification };
  }
}

function instructionFailureFor(
  status: Exclude<
    InstructionArtifactRead,
    { readonly status: "available" }
  >["status"],
): InstructionFailure {
  switch (status) {
    case "unreadable":
      return "artifact_unreadable";
    case "malformed":
      return "artifact_malformed";
    case "unsupported":
      return "artifact_not_evaluated";
  }
}
