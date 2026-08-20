import { describe, expect, it } from "vitest";

import {
  canonicalInstructionFactsSerialization,
  instructionFactsDigest,
  type AvailableInstructionArtifact,
  type InstructionFacts,
} from "../src/index.js";

const REVISION = "9".repeat(40);

function policy(
  artifactPath: string,
  scopeRoot: string,
  content: string,
): AvailableInstructionArtifact {
  return scopeRoot === "."
    ? {
        artifactPath,
        availability: { kind: "available" },
        instructionClass: "repository_policy",
        trust: "authoritative",
        scopeRoot,
        content,
        provenance: {
          source: "repository_artifact",
          path: artifactPath,
          revision: REVISION,
          extractorVersion: "instruction-discovery/v1",
        },
      }
    : {
        artifactPath,
        availability: { kind: "available" },
        instructionClass: "directory_scoped_policy",
        trust: "authoritative",
        scopeRoot,
        content,
        provenance: {
          source: "repository_artifact",
          path: artifactPath,
          revision: REVISION,
          extractorVersion: "instruction-discovery/v1",
        },
      };
}

const root = policy("AGENTS.md", ".", "Repository policy");
const nested = policy("packages/api/AGENTS.md", "packages/api", "API policy");

describe("canonical instruction-facts identity", () => {
  it("is independent of traversal order", () => {
    const left: InstructionFacts = {
      artifacts: [root, nested],
      discovery: { status: "complete" },
    };
    const right: InstructionFacts = {
      artifacts: [nested, root],
      discovery: { status: "complete" },
    };

    expect(canonicalInstructionFactsSerialization(left)).toBe(
      canonicalInstructionFactsSerialization(right),
    );
    expect(instructionFactsDigest(left)).toBe(instructionFactsDigest(right));
  });

  it("changes for content, provenance, and coverage changes", () => {
    const baseline: InstructionFacts = {
      artifacts: [root],
      discovery: { status: "complete" },
    };
    const changedContent: InstructionFacts = {
      ...baseline,
      artifacts: [policy("AGENTS.md", ".", "Changed policy")],
    };
    const changedProvenance: InstructionFacts = {
      ...baseline,
      artifacts: [
        {
          ...root,
          provenance: { ...root.provenance, revision: "8".repeat(40) },
        },
      ],
    };
    const incomplete: InstructionFacts = {
      ...baseline,
      discovery: { status: "incomplete", why: "tree walk failed" },
    };

    expect(instructionFactsDigest(changedContent)).not.toBe(
      instructionFactsDigest(baseline),
    );
    expect(instructionFactsDigest(changedProvenance)).not.toBe(
      instructionFactsDigest(baseline),
    );
    expect(instructionFactsDigest(incomplete)).not.toBe(
      instructionFactsDigest(baseline),
    );
  });

  it("identifies unavailable candidate state and discovered provenance", () => {
    const unavailable: InstructionFacts = {
      artifacts: [
        {
          artifactPath: "packages/api/AGENTS.md",
          availability: {
            kind: "unavailable",
            failure: "artifact_unreadable",
            detail: "permission denied",
          },
          instructionClass: "directory_scoped_policy",
          trust: "authoritative",
          scopeRoot: "packages/api",
          provenance: {
            source: "repository_artifact",
            path: "packages/api/AGENTS.md",
            revision: REVISION,
            extractorVersion: "instruction-discovery/v1",
          },
        },
      ],
      discovery: { status: "complete" },
    };
    const changedFailure: InstructionFacts = {
      ...unavailable,
      artifacts: [
        {
          ...unavailable.artifacts[0]!,
          availability: {
            kind: "unavailable",
            failure: "artifact_malformed",
            detail: "invalid encoding",
          },
        },
      ],
    };

    expect(instructionFactsDigest(unavailable)).toMatch(/^[0-9a-f]{64}$/);
    expect(instructionFactsDigest(changedFailure)).not.toBe(
      instructionFactsDigest(unavailable),
    );
  });
});
