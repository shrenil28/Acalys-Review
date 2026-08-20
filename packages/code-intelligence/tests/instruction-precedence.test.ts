import { describe, expect, it } from "vitest";

import {
  analyzeInstructionPrecedenceAndTrust,
  type InstructionPrecedenceRelationship,
} from "../src/repository-index/instruction-precedence.js";
import type {
  InstructionApplicability,
  InstructionApplicabilityReason,
  InstructionProvenance,
} from "../src/repository-index/instruction-model.js";

function applicability(options: {
  artifactPath: string;
  scopeRoot?: string;
  scopeSpecificity?: number;
  declaredPriority?: number;
  trust?: InstructionApplicability["trust"];
  reason?: InstructionApplicabilityReason;
  provenance?: InstructionProvenance;
}): InstructionApplicability {
  const scopeRoot = options.scopeRoot ?? ".";
  return {
    artifactPath: options.artifactPath,
    scopeRoot,
    targetPath: "packages/api/src/router.ts",
    reason: options.reason ?? "repository_scope",
    precedence: {
      scopeSpecificity: options.scopeSpecificity ?? 0,
      ...(options.declaredPriority === undefined
        ? {}
        : { declaredPriority: options.declaredPriority }),
    },
    trust: options.trust ?? "authoritative",
    provenance:
      options.provenance ??
      provenance(options.artifactPath, "repository_artifact"),
  };
}

function provenance(
  path: string,
  source: InstructionProvenance["source"],
): InstructionProvenance {
  return {
    source,
    path,
    revision: "1".repeat(40),
    extractorVersion: "precedence-fixture",
    startLine: 3,
    endLine: 7,
  };
}

function precedenceBetween(
  relationships: readonly InstructionPrecedenceRelationship[],
  firstPath: string,
  secondPath: string,
): InstructionPrecedenceRelationship | undefined {
  return relationships.find((relationship) => {
    if (relationship.relationship === "precedes") {
      return (
        (relationship.higherPrecedenceArtifactPath === firstPath &&
          relationship.lowerPrecedenceArtifactPath === secondPath) ||
        (relationship.higherPrecedenceArtifactPath === secondPath &&
          relationship.lowerPrecedenceArtifactPath === firstPath)
      );
    }
    return (
      relationship.artifactPaths.includes(firstPath) &&
      relationship.artifactPaths.includes(secondPath)
    );
  });
}

describe("analyzeInstructionPrecedenceAndTrust", () => {
  it("is identical when discovery input order is reversed", () => {
    const facts = [
      applicability({
        artifactPath: "packages/api/AGENTS.md",
        scopeRoot: "packages/api",
        scopeSpecificity: 2,
        reason: "directory_scope",
      }),
      applicability({ artifactPath: "AGENTS.md" }),
      applicability({
        artifactPath: "packages/api/.review-tool",
        scopeRoot: "packages/api",
        scopeSpecificity: 2,
        declaredPriority: 4,
        reason: "declared_tool_scope",
        trust: "advisory",
      }),
    ];

    expect(analyzeInstructionPrecedenceAndTrust(facts)).toEqual(
      analyzeInstructionPrecedenceAndTrust([...facts].reverse()),
    );
  });

  it("keeps deeper advisory scope precedence separate from root authority", () => {
    const root = applicability({ artifactPath: "a-root-policy" });
    const nestedAdvisory = applicability({
      artifactPath: "z-nested-tool",
      scopeRoot: "packages/api",
      scopeSpecificity: 2,
      declaredPriority: 50,
      reason: "declared_tool_scope",
      trust: "advisory",
      provenance: provenance("z-nested-tool", "tool_configuration"),
    });

    const result = analyzeInstructionPrecedenceAndTrust([nestedAdvisory, root]);

    expect(result.facts.map((fact) => fact.applicability.artifactPath)).toEqual(
      ["a-root-policy", "z-nested-tool"],
    );
    expect(result.precedenceRelationships).toEqual([
      {
        relationship: "precedes",
        higherPrecedenceArtifactPath: "z-nested-tool",
        lowerPrecedenceArtifactPath: "a-root-policy",
        basis: "scope_specificity",
      },
    ]);
    expect(result.trustRelationships).toEqual([
      {
        relationship: "more_trusted",
        higherTrustArtifactPath: "a-root-policy",
        lowerTrustArtifactPath: "z-nested-tool",
        basis: "declared_trust",
      },
    ]);
    expect(result.facts.map((fact) => fact.instructionClass)).toEqual([
      "repository_policy",
      "tool_instruction",
    ]);
  });

  it("retains every lower-precedence fact and every pairwise relationship", () => {
    const root = applicability({ artifactPath: "AGENTS.md" });
    const packagePolicy = applicability({
      artifactPath: "packages/AGENTS.md",
      scopeRoot: "packages",
      scopeSpecificity: 1,
      reason: "directory_scope",
    });
    const directoryPolicy = applicability({
      artifactPath: "packages/api/AGENTS.md",
      scopeRoot: "packages/api",
      scopeSpecificity: 2,
      reason: "directory_scope",
    });

    const result = analyzeInstructionPrecedenceAndTrust([
      directoryPolicy,
      root,
      packagePolicy,
    ]);

    expect(result.facts.map((fact) => fact.applicability)).toEqual([
      root,
      packagePolicy,
      directoryPolicy,
    ]);
    expect(result.precedenceRelationships).toHaveLength(3);
    expect(result.trustRelationships).toHaveLength(3);
  });

  it("uses declared priority only when specificity is equal and both declare it", () => {
    const rootHighPriority = applicability({
      artifactPath: "root-high-priority",
      declaredPriority: 100,
    });
    const nestedLowPriority = applicability({
      artifactPath: "nested-low-priority",
      scopeRoot: "packages/api",
      scopeSpecificity: 2,
      declaredPriority: -100,
      reason: "directory_scope",
    });
    const equalScopeLow = applicability({
      artifactPath: "equal-scope-low",
      scopeRoot: "packages/api",
      scopeSpecificity: 2,
      declaredPriority: 1,
      reason: "directory_scope",
    });
    const equalScopeHigh = applicability({
      artifactPath: "equal-scope-high",
      scopeRoot: "packages/web",
      scopeSpecificity: 2,
      declaredPriority: 10,
      reason: "directory_scope",
    });

    const result = analyzeInstructionPrecedenceAndTrust([
      rootHighPriority,
      nestedLowPriority,
      equalScopeLow,
      equalScopeHigh,
    ]);

    expect(
      precedenceBetween(
        result.precedenceRelationships,
        rootHighPriority.artifactPath,
        nestedLowPriority.artifactPath,
      ),
    ).toEqual({
      relationship: "precedes",
      higherPrecedenceArtifactPath: nestedLowPriority.artifactPath,
      lowerPrecedenceArtifactPath: rootHighPriority.artifactPath,
      basis: "scope_specificity",
    });
    expect(
      precedenceBetween(
        result.precedenceRelationships,
        equalScopeLow.artifactPath,
        equalScopeHigh.artifactPath,
      ),
    ).toEqual({
      relationship: "precedes",
      higherPrecedenceArtifactPath: equalScopeHigh.artifactPath,
      lowerPrecedenceArtifactPath: equalScopeLow.artifactPath,
      basis: "declared_priority",
    });
  });

  it("does not treat a missing priority as explicit zero", () => {
    const missing = applicability({ artifactPath: "missing-priority" });
    const explicitZero = applicability({
      artifactPath: "explicit-zero",
      declaredPriority: 0,
    });

    const result = analyzeInstructionPrecedenceAndTrust([
      missing,
      explicitZero,
    ]);

    expect(result.precedenceRelationships).toEqual([
      {
        relationship: "incomparable",
        artifactPaths: ["explicit-zero", "missing-priority"],
        reason: "declared_priority_not_jointly_present",
      },
    ]);
    expect(result.facts[1]?.applicability.precedence).toEqual({
      scopeSpecificity: 0,
    });
  });

  it("does not compare precedence facts established for different targets", () => {
    const first = applicability({
      artifactPath: "first-target-policy",
      declaredPriority: 1,
    });
    const second: InstructionApplicability = {
      ...applicability({
        artifactPath: "second-target-policy",
        declaredPriority: 100,
      }),
      targetPath: "packages/web/src/page.ts",
    };

    const result = analyzeInstructionPrecedenceAndTrust([second, first]);

    expect(result.precedenceRelationships).toEqual([
      {
        relationship: "incomparable",
        artifactPaths: ["first-target-policy", "second-target-policy"],
        reason: "different_targets",
      },
    ]);
  });

  it("retains both semantic ties and incomparability", () => {
    const equalA = applicability({
      artifactPath: "equal-a",
      declaredPriority: 7,
    });
    const equalB = applicability({
      artifactPath: "equal-b",
      declaredPriority: 7,
    });
    const absent = applicability({ artifactPath: "priority-absent" });

    const result = analyzeInstructionPrecedenceAndTrust([
      equalB,
      absent,
      equalA,
    ]);

    expect(
      precedenceBetween(
        result.precedenceRelationships,
        equalA.artifactPath,
        equalB.artifactPath,
      ),
    ).toEqual({
      relationship: "tied",
      artifactPaths: ["equal-a", "equal-b"],
      basis: "equal_precedence_facts",
    });
    expect(
      precedenceBetween(
        result.precedenceRelationships,
        equalA.artifactPath,
        absent.artifactPath,
      ),
    ).toEqual({
      relationship: "incomparable",
      artifactPaths: ["equal-a", "priority-absent"],
      reason: "declared_priority_not_jointly_present",
    });
    expect(result.facts).toHaveLength(3);
  });

  it("preserves provenance without using it as precedence", () => {
    const explicitProvenance = provenance(
      "packages/api/.review-tool",
      "tool_configuration",
    );
    const fact = applicability({
      artifactPath: "packages/api/.review-tool",
      scopeRoot: "packages/api",
      scopeSpecificity: 2,
      reason: "declared_tool_scope",
      trust: "advisory",
      provenance: explicitProvenance,
    });

    const result = analyzeInstructionPrecedenceAndTrust([fact]);

    expect(result.facts).toEqual([
      {
        instructionClass: "tool_instruction",
        applicability: fact,
      },
    ]);
    expect(result.facts[0]?.applicability.provenance).toBe(explicitProvenance);
    expect(result.precedenceRelationships).toEqual([]);
    expect(result.trustRelationships).toEqual([]);
  });
});
