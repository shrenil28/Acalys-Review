/**
 * Pure precedence and trust algebra over established applicability facts.
 *
 * This module does not discover artifacts, decide applicability, or select a
 * winner. It preserves every input fact and describes pairwise relationships
 * so ties, incomparability, provenance, and lower-precedence instructions stay
 * visible to later policy.
 */

import type {
  InstructionApplicability,
  InstructionApplicabilityReason,
} from "./instruction-model.js";

export type ApplicableInstructionClass =
  "repository_policy" | "directory_scoped_policy" | "tool_instruction";

/** An applicability fact with its class made explicit for inspection. */
export interface InstructionPrecedenceTrustFact {
  readonly instructionClass: ApplicableInstructionClass;
  readonly applicability: InstructionApplicability;
}

export type InstructionPrecedenceRelationship =
  | {
      readonly relationship: "precedes";
      readonly higherPrecedenceArtifactPath: string;
      readonly lowerPrecedenceArtifactPath: string;
      readonly basis: "scope_specificity" | "declared_priority";
    }
  | {
      readonly relationship: "tied";
      readonly artifactPaths: readonly [string, string];
      readonly basis: "equal_precedence_facts";
    }
  | {
      readonly relationship: "incomparable";
      readonly artifactPaths: readonly [string, string];
      readonly reason:
        "different_targets" | "declared_priority_not_jointly_present";
    };

export type InstructionTrustRelationship =
  | {
      readonly relationship: "more_trusted";
      readonly higherTrustArtifactPath: string;
      readonly lowerTrustArtifactPath: string;
      readonly basis: "declared_trust";
    }
  | {
      readonly relationship: "equally_trusted";
      readonly artifactPaths: readonly [string, string];
      readonly basis: "declared_trust";
    };

export interface InstructionPrecedenceTrustAnalysis {
  /** Every input fact, in canonical presentation order only. */
  readonly facts: readonly InstructionPrecedenceTrustFact[];
  /** Pairwise semantic precedence; this is intentionally not a winner. */
  readonly precedenceRelationships: readonly InstructionPrecedenceRelationship[];
  /** Pairwise trust, kept independent from semantic precedence. */
  readonly trustRelationships: readonly InstructionTrustRelationship[];
}

/**
 * Analyze every pair of applicable instructions without mutating the input.
 *
 * Precedence is scope specificity first. Declared priority is comparable only
 * for facts about the same target, when scope specificity is equal, and when
 * both artifacts explicitly declare a priority. Two absent priorities tie;
 * one absent priority is incomparable to one present priority, so absence is
 * never treated as zero.
 *
 * Canonical artifact path stabilizes presentation and pair orientation only.
 * It never resolves a semantic tie or incomparability.
 */
export function analyzeInstructionPrecedenceAndTrust(
  applicability: readonly InstructionApplicability[],
): InstructionPrecedenceTrustAnalysis {
  const facts = applicability
    .map((fact): InstructionPrecedenceTrustFact => ({
      instructionClass: instructionClassFor(fact.reason),
      applicability: fact,
    }))
    .sort(compareFactsForPresentation);

  const precedenceRelationships: InstructionPrecedenceRelationship[] = [];
  const trustRelationships: InstructionTrustRelationship[] = [];

  for (let leftIndex = 0; leftIndex < facts.length; leftIndex += 1) {
    const left = facts[leftIndex];
    if (left === undefined) continue;

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < facts.length;
      rightIndex += 1
    ) {
      const right = facts[rightIndex];
      if (right === undefined) continue;

      precedenceRelationships.push(comparePrecedence(left, right));
      trustRelationships.push(compareTrust(left, right));
    }
  }

  return { facts, precedenceRelationships, trustRelationships };
}

function comparePrecedence(
  left: InstructionPrecedenceTrustFact,
  right: InstructionPrecedenceTrustFact,
): InstructionPrecedenceRelationship {
  const leftApplicability = left.applicability;
  const rightApplicability = right.applicability;
  const artifactPaths = pairPaths(left, right);

  if (leftApplicability.targetPath !== rightApplicability.targetPath) {
    return {
      relationship: "incomparable",
      artifactPaths,
      reason: "different_targets",
    };
  }

  const leftSpecificity = leftApplicability.precedence.scopeSpecificity;
  const rightSpecificity = rightApplicability.precedence.scopeSpecificity;

  if (leftSpecificity !== rightSpecificity) {
    return precedenceRelationship(
      leftSpecificity > rightSpecificity ? left : right,
      leftSpecificity > rightSpecificity ? right : left,
      "scope_specificity",
    );
  }

  const leftPriority = leftApplicability.precedence.declaredPriority;
  const rightPriority = rightApplicability.precedence.declaredPriority;

  if (leftPriority === undefined || rightPriority === undefined) {
    if (leftPriority === undefined && rightPriority === undefined) {
      return {
        relationship: "tied",
        artifactPaths,
        basis: "equal_precedence_facts",
      };
    }

    return {
      relationship: "incomparable",
      artifactPaths,
      reason: "declared_priority_not_jointly_present",
    };
  }

  if (leftPriority === rightPriority) {
    return {
      relationship: "tied",
      artifactPaths,
      basis: "equal_precedence_facts",
    };
  }

  return precedenceRelationship(
    leftPriority > rightPriority ? left : right,
    leftPriority > rightPriority ? right : left,
    "declared_priority",
  );
}

function precedenceRelationship(
  higher: InstructionPrecedenceTrustFact,
  lower: InstructionPrecedenceTrustFact,
  basis: "scope_specificity" | "declared_priority",
): InstructionPrecedenceRelationship {
  return {
    relationship: "precedes",
    higherPrecedenceArtifactPath: higher.applicability.artifactPath,
    lowerPrecedenceArtifactPath: lower.applicability.artifactPath,
    basis,
  };
}

function compareTrust(
  left: InstructionPrecedenceTrustFact,
  right: InstructionPrecedenceTrustFact,
): InstructionTrustRelationship {
  const artifactPaths = pairPaths(left, right);
  if (left.applicability.trust === right.applicability.trust) {
    return {
      relationship: "equally_trusted",
      artifactPaths,
      basis: "declared_trust",
    };
  }

  const higher = left.applicability.trust === "authoritative" ? left : right;
  const lower = higher === left ? right : left;
  return {
    relationship: "more_trusted",
    higherTrustArtifactPath: higher.applicability.artifactPath,
    lowerTrustArtifactPath: lower.applicability.artifactPath,
    basis: "declared_trust",
  };
}

function pairPaths(
  left: InstructionPrecedenceTrustFact,
  right: InstructionPrecedenceTrustFact,
): readonly [string, string] {
  return [left.applicability.artifactPath, right.applicability.artifactPath];
}

function instructionClassFor(
  reason: InstructionApplicabilityReason,
): ApplicableInstructionClass {
  switch (reason) {
    case "repository_scope":
      return "repository_policy";
    case "directory_scope":
      return "directory_scoped_policy";
    case "declared_tool_scope":
      return "tool_instruction";
  }
}

function compareFactsForPresentation(
  left: InstructionPrecedenceTrustFact,
  right: InstructionPrecedenceTrustFact,
): number {
  const leftFact = left.applicability;
  const rightFact = right.applicability;
  return (
    compareText(leftFact.artifactPath, rightFact.artifactPath) ||
    compareText(leftFact.targetPath, rightFact.targetPath) ||
    compareText(leftFact.scopeRoot, rightFact.scopeRoot) ||
    compareText(leftFact.reason, rightFact.reason) ||
    compareNumber(
      leftFact.precedence.scopeSpecificity,
      rightFact.precedence.scopeSpecificity,
    ) ||
    compareOptionalNumberForPresentation(
      leftFact.precedence.declaredPriority,
      rightFact.precedence.declaredPriority,
    ) ||
    compareText(leftFact.trust, rightFact.trust) ||
    compareText(leftFact.provenance.source, rightFact.provenance.source) ||
    compareText(leftFact.provenance.path, rightFact.provenance.path) ||
    compareText(leftFact.provenance.revision, rightFact.provenance.revision) ||
    compareText(
      leftFact.provenance.extractorVersion,
      rightFact.provenance.extractorVersion,
    ) ||
    compareOptionalNumberForPresentation(
      leftFact.provenance.startLine,
      rightFact.provenance.startLine,
    ) ||
    compareOptionalNumberForPresentation(
      leftFact.provenance.endLine,
      rightFact.provenance.endLine,
    )
  );
}

function compareOptionalNumberForPresentation(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareNumber(left, right);
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
