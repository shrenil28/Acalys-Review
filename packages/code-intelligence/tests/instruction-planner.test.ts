import { describe, expect, it } from "vitest";

import {
  isInstruction,
  plannerTrustForInstruction,
  scoreCandidates,
  type ContextCandidate,
  type InstructionProvenance,
  type ItemProvenance,
} from "../src/index.js";

const artifactProvenance: InstructionProvenance = {
  source: "repository_artifact",
  path: "AGENTS.md",
  revision: "7".repeat(40),
  extractorVersion: "instruction-discovery/v1",
};

const weaker: ContextCandidate = {
  kind: "instruction",
  path: "AGENTS.md",
  reason: "repository_instruction",
  trust: "tenant_instruction",
  content: "Review repository policy",
  provenance: { source: "direct_source" },
};

const factualProvenance: Extract<
  ItemProvenance,
  { readonly source: "instruction_facts" }
> = {
  source: "instruction_facts",
  factIdentity: "f".repeat(64),
  citation: "AGENTS.md applies to src/app.ts",
  artifactProvenance,
  applicability: [
    {
      artifactPath: "AGENTS.md",
      scopeRoot: ".",
      targetPath: "src/app.ts",
      reason: "repository_scope",
      precedence: { scopeSpecificity: 0 },
      trust: "authoritative",
      provenance: artifactProvenance,
    },
  ],
  analyses: [
    {
      targetPath: "src/app.ts",
      precedenceRelationships: [],
      trustRelationships: [],
    },
  ],
};

const factual: ContextCandidate = {
  ...weaker,
  trust: "repository_instruction",
  provenance: factualProvenance,
};

const precedenceRelationship = {
  relationship: "precedes" as const,
  higherPrecedenceArtifactPath: "packages/api/AGENTS.md",
  lowerPrecedenceArtifactPath: "AGENTS.md",
  basis: "scope_specificity" as const,
};

const rootWithPrecedence: ContextCandidate = {
  ...factual,
  provenance: {
    ...factualProvenance,
    analyses: [
      {
        targetPath: "packages/api/src/router.ts",
        precedenceRelationships: [precedenceRelationship],
        trustRelationships: [],
      },
    ],
  },
};

const nestedWithPrecedence: ContextCandidate = {
  ...rootWithPrecedence,
  path: "packages/api/AGENTS.md",
  reason: "path_instruction",
  provenance: {
    ...factualProvenance,
    artifactProvenance: {
      ...artifactProvenance,
      path: "packages/api/AGENTS.md",
    },
    analyses: [
      {
        targetPath: "packages/api/src/router.ts",
        precedenceRelationships: [precedenceRelationship],
        trustRelationships: [],
      },
    ],
  },
};

describe("factual instruction planner standing", () => {
  it("maps authoritative and advisory instruction trust without conflating them", () => {
    const authoritative = plannerTrustForInstruction("authoritative");
    const advisory = plannerTrustForInstruction("advisory");

    expect(authoritative).toBe("repository_instruction");
    expect(isInstruction(authoritative)).toBe(true);
    expect(advisory).toBe("advisory_instruction");
    expect(isInstruction(advisory)).toBe(false);
  });

  it.each([
    [weaker, factual],
    [factual, weaker],
  ])(
    "retains factual provenance for same-location duplicates in either input order",
    (first, second) => {
      const scored = scoreCandidates([first, second]);

      expect(scored).toHaveLength(1);
      expect(scored[0]?.provenance?.source).toBe("instruction_facts");
      expect(scored[0]?.trust).toBe("repository_instruction");
    },
  );

  it.each([
    [rootWithPrecedence, nestedWithPrecedence],
    [nestedWithPrecedence, rootWithPrecedence],
  ])(
    "orders retained factual instructions by computed precedence in either input order",
    (first, second) => {
      const scored = scoreCandidates([first, second]);

      expect(scored.map((candidate) => candidate.path)).toEqual([
        "packages/api/AGENTS.md",
        "AGENTS.md",
      ]);
      expect(scored).toHaveLength(2);
      expect(
        scored.every(
          (candidate) => candidate.trust === "repository_instruction",
        ),
      ).toBe(true);
    },
  );
});
