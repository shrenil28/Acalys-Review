/**
 * The factual model for instruction governance: states first, discovery later.
 *
 * Nothing here reads repository files or decides which filenames are special.
 * Discovery may eventually establish that an artifact exists; this module only
 * records what kind of artifact it is, whether it applies to a source path,
 * what precedence facts it carries, and how complete that answer is.
 *
 * Four dimensions stay separate on purpose:
 *
 * ```
 * InstructionArtifact       what the repository contains
 * InstructionApplicability  whether and why it applies to a source
 * InstructionPrecedence     facts a later conflict policy may order by
 * InstructionTrust          whether its text may direct analysis
 * ```
 *
 * In particular, scope proximity is not authority. A deeper tool instruction
 * can be more scope-specific while remaining less trusted than a root policy.
 */

export const INSTRUCTION_CLASSES = [
  "repository_policy",
  "directory_scoped_policy",
  "tool_instruction",
  "documentation",
  "ordinary_text",
] as const;

export type InstructionClass = (typeof INSTRUCTION_CLASSES)[number];

export const INSTRUCTION_TRUST = [
  "authoritative",
  "advisory",
  "informational",
  "untrusted",
] as const;

export type InstructionTrust = (typeof INSTRUCTION_TRUST)[number];

export interface InstructionProvenance {
  readonly source: "repository_artifact" | "tool_configuration";
  readonly path: string;
  readonly revision: string;
  readonly extractorVersion: string;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
}

interface AvailableArtifactBase {
  readonly artifactPath: string;
  readonly availability: { readonly kind: "available" };
  readonly content: string;
  readonly provenance: InstructionProvenance;
}

interface ScopedInstructionBase extends AvailableArtifactBase {
  readonly scopeRoot: string;
  /** Author-declared priority, if the format actually supplies one. */
  readonly declaredPriority?: number | undefined;
}

export type AvailableInstructionArtifact =
  | (ScopedInstructionBase & {
      readonly instructionClass: "repository_policy";
      readonly trust: "authoritative";
      /** Repository policy is repository-wide by construction. */
      readonly scopeRoot: ".";
    })
  | (ScopedInstructionBase & {
      readonly instructionClass: "directory_scoped_policy";
      readonly trust: "authoritative";
    })
  | (ScopedInstructionBase & {
      readonly instructionClass: "tool_instruction";
      readonly trust: "authoritative" | "advisory";
    })
  | (AvailableArtifactBase & {
      readonly instructionClass: "documentation";
      readonly trust: "informational";
      readonly scopeRoot: string;
    })
  | (AvailableArtifactBase & {
      readonly instructionClass: "ordinary_text";
      readonly trust: "untrusted";
      readonly scopeRoot: string;
    });

export const INSTRUCTION_FAILURES = [
  "artifact_unreadable",
  "artifact_malformed",
  "artifact_not_evaluated",
] as const;

export type InstructionFailure = (typeof INSTRUCTION_FAILURES)[number];

/** A discovered instruction candidate whose meaning could not be evaluated. */
export interface UnavailableInstructionArtifact {
  readonly artifactPath: string;
  readonly scopeRoot: string;
  readonly availability: {
    readonly kind: "unavailable";
    readonly failure: InstructionFailure;
    readonly detail: string;
  };
}

export type InstructionArtifact =
  AvailableInstructionArtifact | UnavailableInstructionArtifact;

export const INSTRUCTION_APPLICABILITY_REASONS = [
  "repository_scope",
  "directory_scope",
  "declared_tool_scope",
] as const;

export type InstructionApplicabilityReason =
  (typeof INSTRUCTION_APPLICABILITY_REASONS)[number];

/**
 * Inputs to a later precedence policy, not a winner selected by this model.
 *
 * `scopeSpecificity` is the number of path segments in the explicit scope.
 * `declaredPriority` remains optional: absence is a fact and must not be
 * silently replaced by discovery order or a filename convention.
 */
export interface InstructionPrecedence {
  readonly scopeSpecificity: number;
  readonly declaredPriority?: number | undefined;
}

/** One positive, provenance-bearing applicability fact. */
export interface InstructionApplicability {
  readonly artifactPath: string;
  readonly scopeRoot: string;
  readonly targetPath: string;
  readonly reason: InstructionApplicabilityReason;
  readonly precedence: InstructionPrecedence;
  readonly trust: "authoritative" | "advisory";
  readonly provenance: InstructionProvenance;
}

export interface InstructionCoverage {
  readonly discovery:
    | { readonly status: "complete" }
    | { readonly status: "incomplete"; readonly why: string };
  /** Applicable-scope candidates whose class and contents were evaluated. */
  readonly evaluated: readonly string[];
  /** Applicable-scope candidates that could not be evaluated. */
  readonly unevaluable: readonly UnavailableInstructionArtifact[];
}

export function isInstructionCoverageComplete(
  coverage: InstructionCoverage,
): boolean {
  return (
    coverage.discovery.status === "complete" &&
    coverage.unevaluable.length === 0
  );
}

export interface NoApplicableInstructionEvidence {
  readonly reason: "no_evaluated_artifact_applies";
  readonly detail: string;
}

export type InstructionApplicabilityResult =
  | {
      readonly status: "applicable";
      /** Every established relationship. Positive facts are never collapsed. */
      readonly relationships: readonly InstructionApplicability[];
      /** May be incomplete: an outage cannot erase a known positive. */
      readonly coverage: InstructionCoverage;
    }
  | {
      readonly status: "no_applicable_instructions";
      readonly evidence: readonly NoApplicableInstructionEvidence[];
      /** Complete by construction. */
      readonly coverage: InstructionCoverage;
    }
  | {
      readonly status: "undetermined";
      /** Incomplete by construction. */
      readonly coverage: InstructionCoverage;
      readonly why: string;
    }
  | {
      readonly status: "not_indexed";
      readonly targetPath: string;
      readonly why: string;
    };

export interface InstructionFacts {
  readonly artifacts: readonly InstructionArtifact[];
  readonly discovery: InstructionCoverage["discovery"];
}

/** An empty, successfully-computed set of instruction facts. */
export const NO_INSTRUCTION_FACTS: InstructionFacts = {
  artifacts: [],
  discovery: { status: "complete" },
};

/** Whether an evaluated artifact is allowed to direct analysis. */
export function isInstructionArtifact(
  artifact: AvailableInstructionArtifact,
): artifact is Extract<
  AvailableInstructionArtifact,
  {
    readonly instructionClass:
      "repository_policy" | "directory_scoped_policy" | "tool_instruction";
  }
> {
  return (
    artifact.instructionClass === "repository_policy" ||
    artifact.instructionClass === "directory_scoped_policy" ||
    artifact.instructionClass === "tool_instruction"
  );
}

/**
 * Derive plural applicability from already-discovered, already-classified
 * facts. This is scope algebra only; it performs no I/O and chooses no winner.
 */
export function instructionApplicabilityFor(
  facts: InstructionFacts,
  targetPath: string,
): InstructionApplicabilityResult {
  const evaluated: string[] = [];
  const unevaluable: UnavailableInstructionArtifact[] = [];
  const relationships: InstructionApplicability[] = [];

  for (const artifact of facts.artifacts) {
    if (!isWithinScope(targetPath, artifact.scopeRoot)) continue;

    if (isUnavailableInstructionArtifact(artifact)) {
      unevaluable.push(artifact);
      continue;
    }

    evaluated.push(artifact.artifactPath);
    if (!isInstructionArtifact(artifact)) continue;

    relationships.push({
      artifactPath: artifact.artifactPath,
      scopeRoot: artifact.scopeRoot,
      targetPath,
      reason: applicabilityReason(artifact.instructionClass),
      precedence: {
        scopeSpecificity: scopeSpecificity(artifact.scopeRoot),
        ...(artifact.declaredPriority === undefined
          ? {}
          : { declaredPriority: artifact.declaredPriority }),
      },
      trust: artifact.trust,
      provenance: artifact.provenance,
    });
  }

  evaluated.sort(compareText);
  unevaluable.sort((left, right) =>
    compareText(left.artifactPath, right.artifactPath),
  );
  // Canonical presentation order is deliberately not precedence order.
  relationships.sort((left, right) =>
    compareText(left.artifactPath, right.artifactPath),
  );

  const coverage: InstructionCoverage = {
    discovery: facts.discovery,
    evaluated,
    unevaluable,
  };

  if (relationships.length > 0) {
    return { status: "applicable", relationships, coverage };
  }

  if (isInstructionCoverageComplete(coverage)) {
    return {
      status: "no_applicable_instructions",
      evidence: [
        {
          reason: "no_evaluated_artifact_applies",
          detail: `No evaluated instruction artifact applies to ${targetPath}.`,
        },
      ],
      coverage,
    };
  }

  return {
    status: "undetermined",
    coverage,
    why: describeCoverageGap(coverage),
  };
}

function isUnavailableInstructionArtifact(
  artifact: InstructionArtifact,
): artifact is UnavailableInstructionArtifact {
  return artifact.availability.kind === "unavailable";
}

function applicabilityReason(
  instructionClass:
    "repository_policy" | "directory_scoped_policy" | "tool_instruction",
): InstructionApplicabilityReason {
  switch (instructionClass) {
    case "repository_policy":
      return "repository_scope";
    case "directory_scoped_policy":
      return "directory_scope";
    case "tool_instruction":
      return "declared_tool_scope";
  }
}

function isWithinScope(targetPath: string, scopeRoot: string): boolean {
  return (
    scopeRoot === "." ||
    targetPath === scopeRoot ||
    targetPath.startsWith(`${scopeRoot}/`)
  );
}

function scopeSpecificity(scopeRoot: string): number {
  return scopeRoot === "."
    ? 0
    : scopeRoot.split("/").filter((segment) => segment.length > 0).length;
}

function describeCoverageGap(coverage: InstructionCoverage): string {
  const gaps: string[] = [];
  if (coverage.discovery.status === "incomplete") {
    gaps.push(`instruction discovery is incomplete: ${coverage.discovery.why}`);
  }
  if (coverage.unevaluable.length > 0) {
    gaps.push(
      `${String(coverage.unevaluable.length)} applicable instruction artifact${coverage.unevaluable.length === 1 ? "" : "s"} could not be evaluated`,
    );
  }
  return gaps.join("; ");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
