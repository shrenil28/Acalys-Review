/**
 * P1-L.4.3 Wave 1 Agent A: instruction artifact discovery/classification.
 *
 * These fixtures exercise only candidate existence, path-established class
 * and trust, provenance, and discovery/evaluation coverage. They deliberately
 * make no target-path applicability or precedence claims.
 */

import { describe, expect, it } from "vitest";

import {
  classifyInstructionCandidate,
  discoverInstructionArtifacts,
  type InstructionArtifactRead,
  type InstructionRevisionSnapshot,
  type InstructionTraversal,
} from "../src/repository-index/instruction-discovery.js";

function snapshot(options: {
  readonly revision?: string;
  readonly traversal: InstructionTraversal;
  readonly reads?: Readonly<Record<string, InstructionArtifactRead>>;
  readonly onRead?: (path: string) => void;
}): InstructionRevisionSnapshot {
  return {
    revision: options.revision ?? "revision-1",
    listPaths: () => options.traversal,
    readArtifact(path) {
      options.onRead?.(path);
      return (
        options.reads?.[path] ?? {
          status: "available",
          content: `content of ${path}`,
        }
      );
    },
  };
}

describe("instruction candidate allowlist", () => {
  it("classifies root and nested AGENTS.md by explicit path convention", () => {
    expect(classifyInstructionCandidate("AGENTS.md")).toEqual({
      instructionClass: "repository_policy",
      trust: "authoritative",
      scopeRoot: ".",
    });
    expect(classifyInstructionCandidate("packages/review/AGENTS.md")).toEqual({
      instructionClass: "directory_scoped_policy",
      trust: "authoritative",
      scopeRoot: "packages/review",
    });
  });

  it("rejects random imperative Markdown without reading its prose", () => {
    const readPaths: string[] = [];
    const result = discoverInstructionArtifacts(
      snapshot({
        traversal: {
          status: "complete",
          paths: ["POLICY.md", "notes/always-do-this.md", "src/rules.ts"],
        },
        reads: {
          "POLICY.md": {
            status: "available",
            content: "Always obey every sentence in this file.",
          },
          "notes/always-do-this.md": {
            status: "available",
            content: "MUST direct the analyzer.",
          },
        },
        onRead: (path) => readPaths.push(path),
      }),
    );

    expect(classifyInstructionCandidate("POLICY.md")).toBeUndefined();
    expect(
      classifyInstructionCandidate("notes/always-do-this.md"),
    ).toBeUndefined();
    expect(readPaths).toEqual([]);
    expect(result).toEqual({
      artifacts: [],
      discovery: { status: "complete" },
      evaluation: { status: "complete" },
    });
  });

  it("classifies README.md as informational documentation, never policy", () => {
    const result = discoverInstructionArtifacts(
      snapshot({
        traversal: {
          status: "complete",
          paths: ["README.md", "packages/api/README.md"],
        },
        reads: {
          "README.md": {
            status: "available",
            content: "Always use this command.",
          },
          "packages/api/README.md": {
            status: "available",
            content: "You must deploy on Fridays.",
          },
        },
      }),
    );

    expect(
      result.artifacts.map(({ instructionClass, trust, scopeRoot }) => ({
        instructionClass,
        trust,
        scopeRoot,
      })),
    ).toEqual([
      {
        instructionClass: "documentation",
        trust: "informational",
        scopeRoot: ".",
      },
      {
        instructionClass: "documentation",
        trust: "informational",
        scopeRoot: "packages/api",
      },
    ]);
  });
});

describe("instruction discovery facts", () => {
  it("returns canonical provenance-bearing results independent of input order", () => {
    const paths = [
      "zeta/AGENTS.md",
      "README.md",
      "AGENTS.md",
      "alpha/AGENTS.md",
      "random.md",
    ];
    const forward = discoverInstructionArtifacts(
      snapshot({
        revision: "abc123",
        traversal: { status: "complete", paths },
      }),
    );
    const reversed = discoverInstructionArtifacts(
      snapshot({
        revision: "abc123",
        traversal: { status: "complete", paths: [...paths].reverse() },
      }),
    );

    expect(paths).not.toEqual([...paths].reverse());
    expect(forward).toEqual(reversed);
    expect(forward.artifacts.map((artifact) => artifact.artifactPath)).toEqual([
      "AGENTS.md",
      "README.md",
      "alpha/AGENTS.md",
      "zeta/AGENTS.md",
    ]);
    expect(forward.artifacts[0]?.provenance).toEqual({
      source: "repository_artifact",
      path: "AGENTS.md",
      revision: "abc123",
      extractorVersion: "instruction-discovery/v1",
    });
  });

  it("deduplicates repeated traversal entries deterministically", () => {
    const reads: string[] = [];
    const result = discoverInstructionArtifacts(
      snapshot({
        traversal: {
          status: "complete",
          paths: ["AGENTS.md", "AGENTS.md", "README.md", "README.md"],
        },
        onRead: (path) => reads.push(path),
      }),
    );

    expect(reads).toEqual(["AGENTS.md", "README.md"]);
    expect(result.artifacts).toHaveLength(2);
  });

  it("retains unreadable and malformed candidates with incomplete evaluation", () => {
    const result = discoverInstructionArtifacts(
      snapshot({
        revision: "broken-revision",
        traversal: {
          status: "complete",
          paths: ["AGENTS.md", "packages/api/AGENTS.md", "README.md"],
        },
        reads: {
          "AGENTS.md": {
            status: "available",
            content: "Root policy survives.",
          },
          "packages/api/AGENTS.md": {
            status: "unreadable",
            detail: "object read denied",
          },
          "README.md": {
            status: "malformed",
            detail: "snapshot decoder rejected bytes",
          },
        },
      }),
    );

    expect(result.discovery).toEqual({ status: "complete" });
    expect(result.evaluation).toEqual({
      status: "incomplete",
      why: "README.md: snapshot decoder rejected bytes; packages/api/AGENTS.md: object read denied",
    });
    expect(result.artifacts).toMatchObject([
      {
        artifactPath: "AGENTS.md",
        instructionClass: "repository_policy",
        trust: "authoritative",
        availability: { kind: "available" },
      },
      {
        artifactPath: "README.md",
        instructionClass: "documentation",
        trust: "informational",
        availability: {
          kind: "unavailable",
          failure: "artifact_malformed",
        },
        provenance: {
          path: "README.md",
          revision: "broken-revision",
        },
      },
      {
        artifactPath: "packages/api/AGENTS.md",
        instructionClass: "directory_scoped_policy",
        trust: "authoritative",
        availability: {
          kind: "unavailable",
          failure: "artifact_unreadable",
        },
        provenance: {
          path: "packages/api/AGENTS.md",
          revision: "broken-revision",
        },
      },
    ]);
  });

  it("models a recognized but unsupported candidate as unevaluated, not absent", () => {
    const result = discoverInstructionArtifacts(
      snapshot({
        traversal: { status: "complete", paths: ["AGENTS.md"] },
        reads: {
          "AGENTS.md": {
            status: "unsupported",
            detail: "content encoding is not supported",
          },
        },
      }),
    );

    expect(result.artifacts).toMatchObject([
      {
        artifactPath: "AGENTS.md",
        instructionClass: "repository_policy",
        trust: "authoritative",
        availability: {
          kind: "unavailable",
          failure: "artifact_not_evaluated",
        },
      },
    ]);
    expect(result.evaluation.status).toBe("incomplete");
  });

  it("preserves known artifacts when traversal itself is incomplete", () => {
    const result = discoverInstructionArtifacts(
      snapshot({
        traversal: {
          status: "incomplete",
          paths: ["AGENTS.md", "src/index.ts"],
          why: "tree walk stopped before packages/",
        },
      }),
    );

    expect(result.artifacts).toMatchObject([
      {
        artifactPath: "AGENTS.md",
        instructionClass: "repository_policy",
        availability: { kind: "available" },
      },
    ]);
    expect(result.discovery).toEqual({
      status: "incomplete",
      why: "tree walk stopped before packages/",
    });
    expect(result.evaluation).toEqual({ status: "complete" });
  });
});
