/**
 * Pure scope extraction over instruction artifacts established elsewhere.
 *
 * This module neither discovers artifacts nor converts its answer into an
 * {@link InstructionApplicabilityResult}. It supplies the narrower factual
 * seam needed by that frozen result algebra: every positive relationship,
 * every evaluated in-scope candidate, and every relevant evaluation gap.
 *
 * Array order is canonical presentation order by artifact path. It is not a
 * precedence order and must never be used to select an effective instruction.
 */

import {
  isInstructionArtifact,
  type InstructionApplicability,
  type InstructionApplicabilityReason,
  type InstructionArtifact,
  type UnavailableInstructionArtifact,
} from "./instruction-model.js";

export interface InstructionScopeEvaluation {
  /** All established relationships; no closest-scope winner is selected. */
  readonly relationships: readonly InstructionApplicability[];
  /** In-scope candidates whose classification and contents were evaluated. */
  readonly evaluated: readonly string[];
  /** In-scope candidates whose applicability could not be fully evaluated. */
  readonly unevaluable: readonly UnavailableInstructionArtifact[];
}

/**
 * Evaluate explicit artifact scopes against one repository-relative target.
 *
 * Scope containment is segment-aware: `packages/api` contains
 * `packages/api/src/router.ts`, but not `packages/api-client/src/index.ts`.
 * Inputs are already-discovered facts, so this function performs no I/O and
 * does not infer scope from an artifact's filename or directory.
 */
export function evaluateInstructionScopes(
  artifacts: readonly InstructionArtifact[],
  targetPath: string,
): InstructionScopeEvaluation {
  const relationships: InstructionApplicability[] = [];
  const evaluated: string[] = [];
  const unevaluable: UnavailableInstructionArtifact[] = [];

  for (const artifact of artifacts) {
    if (!isPathWithinScope(targetPath, artifact.scopeRoot)) continue;

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
      reason: reasonFor(artifact.instructionClass),
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
  relationships.sort((left, right) =>
    compareText(left.artifactPath, right.artifactPath),
  );

  return { relationships, evaluated, unevaluable };
}

function isUnavailableInstructionArtifact(
  artifact: InstructionArtifact,
): artifact is UnavailableInstructionArtifact {
  return artifact.availability.kind === "unavailable";
}

function isPathWithinScope(targetPath: string, scopeRoot: string): boolean {
  if (scopeRoot === ".") return true;

  const targetSegments = targetPath.split("/");
  const scopeSegments = scopeRoot.split("/");
  if (scopeSegments.length > targetSegments.length) return false;

  return scopeSegments.every(
    (scopeSegment, index) => scopeSegment === targetSegments[index],
  );
}

function reasonFor(
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

function scopeSpecificity(scopeRoot: string): number {
  return scopeRoot === "." ? 0 : scopeRoot.split("/").length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
