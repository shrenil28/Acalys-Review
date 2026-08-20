/**
 * P1-L.4.3 Integration 1: independently-built factual components composed on
 * one source tree. No planner or analyzer-input identity wiring belongs here.
 */

import { describe, expect, it } from "vitest";

import { evaluateInstructionScopes } from "../src/repository-index/instruction-applicability.js";
import {
  discoverInstructionArtifacts,
  type InstructionArtifactRead,
  type InstructionRevisionSnapshot,
  type InstructionTraversal,
} from "../src/repository-index/instruction-discovery.js";
import { instructionApplicabilityFor } from "../src/repository-index/instruction-model.js";
import { analyzeInstructionPrecedenceAndTrust } from "../src/repository-index/instruction-precedence.js";

function snapshot(options: {
  readonly traversal: InstructionTraversal;
  readonly reads?: Readonly<Record<string, InstructionArtifactRead>>;
  readonly onRead?: (path: string) => void;
}): InstructionRevisionSnapshot {
  return {
    revision: "integration-revision",
    listPaths: () => options.traversal,
    readArtifact(path) {
      options.onRead?.(path);
      return (
        options.reads?.[path] ?? {
          status: "available",
          content: `policy from ${path}`,
        }
      );
    },
  };
}

describe("P1-L.4.3 Wave 1 composition", () => {
  it("preserves plural root and nested facts through precedence analysis", () => {
    const targetPath = "packages/api/src/router.ts";
    const paths = [
      "packages/web/AGENTS.md",
      "packages/api/AGENTS.md",
      "README.md",
      "AGENTS.md",
    ];
    const reads: string[] = [];
    const discovery = discoverInstructionArtifacts(
      snapshot({
        traversal: { status: "complete", paths },
        onRead: (path) => reads.push(path),
      }),
    );

    const scopes = evaluateInstructionScopes(discovery.artifacts, targetPath);
    const result = instructionApplicabilityFor(discovery, targetPath);

    expect(reads).toEqual([
      "AGENTS.md",
      "packages/api/AGENTS.md",
      "packages/web/AGENTS.md",
    ]);
    expect(reads).not.toContain("README.md");
    expect(scopes.relationships.map((fact) => fact.artifactPath)).toEqual([
      "AGENTS.md",
      "packages/api/AGENTS.md",
    ]);
    expect(scopes.unevaluable).toEqual([]);
    expect(result.status).toBe("applicable");
    if (result.status !== "applicable") throw new Error("unreachable");
    expect(result.relationships).toEqual(scopes.relationships);

    const analysis = analyzeInstructionPrecedenceAndTrust(result.relationships);
    expect(analysis.facts).toHaveLength(2);
    expect(analysis.precedenceRelationships).toEqual([
      {
        relationship: "precedes",
        higherPrecedenceArtifactPath: "packages/api/AGENTS.md",
        lowerPrecedenceArtifactPath: "AGENTS.md",
        basis: "scope_specificity",
      },
    ]);
    expect(analysis.trustRelationships).toEqual([
      {
        relationship: "equally_trusted",
        artifactPaths: ["AGENTS.md", "packages/api/AGENTS.md"],
        basis: "declared_trust",
      },
    ]);
  });

  it("keeps a valid root fact when a relevant nested candidate is unreadable", () => {
    const targetPath = "packages/api/src/router.ts";
    const discovery = discoverInstructionArtifacts(
      snapshot({
        traversal: {
          status: "complete",
          paths: ["packages/api/AGENTS.md", "AGENTS.md"],
        },
        reads: {
          "AGENTS.md": { status: "available", content: "root survives" },
          "packages/api/AGENTS.md": {
            status: "unreadable",
            detail: "object read denied",
          },
        },
      }),
    );

    const scopes = evaluateInstructionScopes(discovery.artifacts, targetPath);
    const result = instructionApplicabilityFor(discovery, targetPath);

    expect(scopes.relationships.map((fact) => fact.artifactPath)).toEqual([
      "AGENTS.md",
    ]);
    expect(scopes.unevaluable).toHaveLength(1);
    expect(result.status).toBe("applicable");
    if (result.status !== "applicable") throw new Error("unreachable");
    expect(result.relationships).toEqual(scopes.relationships);
    expect(result.coverage.unevaluable).toEqual(scopes.unevaluable);
  });

  it("turns an unreadable sole candidate into undetermined, never absence", () => {
    const targetPath = "packages/api/src/router.ts";
    const discovery = discoverInstructionArtifacts(
      snapshot({
        traversal: {
          status: "complete",
          paths: ["packages/api/AGENTS.md"],
        },
        reads: {
          "packages/api/AGENTS.md": {
            status: "malformed",
            detail: "fatal UTF-8 decode failed",
          },
        },
      }),
    );

    const scopes = evaluateInstructionScopes(discovery.artifacts, targetPath);
    const result = instructionApplicabilityFor(discovery, targetPath);

    expect(scopes.relationships).toEqual([]);
    expect(scopes.unevaluable).toHaveLength(1);
    expect(result.status).toBe("undetermined");
    expect(result.status).not.toBe("no_applicable_instructions");
  });

  it("is deterministic when discovery traversal order is reversed", () => {
    const paths = [
      "packages/api/AGENTS.md",
      "AGENTS.md",
      "packages/web/AGENTS.md",
      "README.md",
    ];
    const forward = discoverInstructionArtifacts(
      snapshot({ traversal: { status: "complete", paths } }),
    );
    const reversed = discoverInstructionArtifacts(
      snapshot({
        traversal: { status: "complete", paths: [...paths].reverse() },
      }),
    );
    const targetPath = "packages/api/src/router.ts";

    expect(reversed).toEqual(forward);
    expect(evaluateInstructionScopes(reversed.artifacts, targetPath)).toEqual(
      evaluateInstructionScopes(forward.artifacts, targetPath),
    );
    expect(instructionApplicabilityFor(reversed, targetPath)).toEqual(
      instructionApplicabilityFor(forward, targetPath),
    );
  });
});
