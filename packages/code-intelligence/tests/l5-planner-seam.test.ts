import { gitObjectId } from "@acalys/contracts/domain";
import { describe, expect, it } from "vitest";

import {
  PLANNER_FACT_FAMILIES,
  analyzeInstructionPrecedenceAndTrust,
  buildRepositoryIndex,
  extractFile,
  indexIdentity,
  instructionApplicabilityFor,
  planContext,
  planContextWithTrace,
  type AvailableInstructionArtifact,
  type ContextCandidate,
  type PlannerFactFamily,
  type PlannerFactFamilyAvailability,
  type PlannerInput,
} from "../src/index.js";

const REVISION = "6".repeat(40);

const FILES = {
  "AGENTS.md": "Review service contract regressions.",
  "tsconfig.json": '{"files":["src/service.ts"]}',
  "src/service.ts": [
    "export function work(value: string): string {",
    "  return value.trim();",
    "}",
  ].join("\n"),
  "src/client.ts": [
    'import { work } from "./service.js";',
    'export const call = (): string => work(" value ");',
  ].join("\n"),
  "tests/contract.spec.ts": [
    'import { work } from "../src/service.js";',
    'export const observed = work(" value ");',
  ].join("\n"),
} as const;

const ALL_ENABLED: PlannerFactFamilyAvailability = {
  structural_index: true,
  binding: true,
  test_relationship: true,
  config_governance: true,
  instruction_governance: true,
};

function plannerInput(): PlannerInput {
  const snapshot = new Map(Object.entries(FILES));
  const provenance = {
    source: "typescript_syntax" as const,
    path: "tsconfig.json",
    startLine: 1,
    endLine: 1,
    extractorVersion: "l5-planner-seam-fixture",
    revision: REVISION,
  };
  const instructionProvenance = {
    source: "repository_artifact" as const,
    path: "AGENTS.md",
    startLine: 1,
    endLine: 1,
    extractorVersion: "l5-planner-seam-fixture",
    revision: REVISION,
  };
  const artifact: AvailableInstructionArtifact = {
    artifactPath: "AGENTS.md",
    availability: { kind: "available" },
    instructionClass: "repository_policy",
    trust: "authoritative",
    scopeRoot: ".",
    content: FILES["AGENTS.md"],
    provenance: instructionProvenance,
  };
  const instructionFacts = {
    artifacts: [artifact],
    discovery: { status: "complete" as const },
  };
  const applicability = instructionApplicabilityFor(
    instructionFacts,
    "src/service.ts",
  );
  if (applicability.status !== "applicable") {
    throw new Error("instruction fixture must apply");
  }

  return {
    changed: [
      {
        path: "src/service.ts",
        content: FILES["src/service.ts"],
        changedLines: [1, 2],
      },
    ],
    repository: Object.entries(FILES).map(([path, source]) =>
      extractFile(path, source),
    ),
    sources: snapshot,
    index: buildRepositoryIndex({
      identity: indexIdentity({
        tenant: { kind: "tenant", tenantId: "tenant-l5" },
        provider: "github",
        repositoryId: "repository-l5",
        revision: gitObjectId(REVISION),
      }),
      snapshot,
    }),
    configFacts: {
      projects: ["tsconfig.json"],
      governance: [
        {
          sourcePath: "src/service.ts",
          projectPath: "tsconfig.json",
          reason: "included_by_files",
          provenance,
        },
      ],
      inheritance: [],
      references: [],
      failures: [],
    },
    configFactsIdentity: "c".repeat(64),
    instructionFacts: {
      facts: instructionFacts,
      factIdentity: "i".repeat(64),
      targets: [
        {
          targetPath: "src/service.ts",
          applicability,
          precedenceAndTrust: analyzeInstructionPrecedenceAndTrust(
            applicability.relationships,
          ),
        },
      ],
    },
  };
}

function familyOf(candidate: ContextCandidate): PlannerFactFamily | undefined {
  const source = candidate.provenance?.source;
  if (source === "repository_index") {
    if (candidate.reason === "indexed_declaration") return "structural_index";
    if (candidate.reason === "associated_test") return "test_relationship";
    if (
      candidate.reason === "referenced_symbol" ||
      candidate.reason === "caller"
    ) {
      return "binding";
    }
  }
  if (source === "configuration_facts") return "config_governance";
  if (source === "instruction_facts" || source === "instruction_coverage") {
    return "instruction_governance";
  }
  return undefined;
}

function candidateKey(candidate: ContextCandidate): string {
  return JSON.stringify([
    candidate.path,
    candidate.reason,
    candidate.startLine ?? null,
    candidate.endLine ?? null,
    candidate.provenance?.source ?? null,
    candidate.provenance?.source === "repository_index"
      ? candidate.provenance.recordId
      : null,
  ]);
}

describe("the P1-L.5 planner fact-family seam", () => {
  it("preserves ordinary production planning when availability is omitted", () => {
    const input = plannerInput();

    expect(planContext(input, 10_000)).toEqual(
      planContext({ ...input, factFamilyAvailability: ALL_ENABLED }, 10_000),
    );
    const trace = planContextWithTrace(input, 10_000);
    expect(trace.context).toEqual(planContext(input, 10_000));
    expect(trace.offered.length).toBeGreaterThan(trace.scored.length);
  });

  it("removes exactly one factual family before scoring", () => {
    const input = plannerInput();
    const full = planContextWithTrace(
      { ...input, factFamilyAvailability: ALL_ENABLED },
      10_000,
    );
    const fullByFamily = new Map(
      PLANNER_FACT_FAMILIES.map((family) => [
        family,
        full.offered.filter((candidate) => familyOf(candidate) === family),
      ]),
    );

    for (const family of PLANNER_FACT_FAMILIES) {
      expect(fullByFamily.get(family)?.length, family).toBeGreaterThan(0);
      const availability = { ...ALL_ENABLED, [family]: false };
      const ablated = planContextWithTrace(
        { ...input, factFamilyAvailability: availability },
        10_000,
      );

      expect(
        ablated.offered.filter((candidate) => familyOf(candidate) === family),
        family,
      ).toEqual([]);
      for (const retainedFamily of PLANNER_FACT_FAMILIES) {
        if (retainedFamily === family) continue;
        expect(
          ablated.offered
            .filter((candidate) => familyOf(candidate) === retainedFamily)
            .map(candidateKey)
            .sort(),
          `${family} must not alter ${retainedFamily}`,
        ).toEqual(
          (fullByFamily.get(retainedFamily) ?? []).map(candidateKey).sort(),
        );
      }
    }
  });

  it("exposes a deterministic pre-intelligence baseline and syntactic fallback", () => {
    const input = plannerInput();
    const directKeys = (availability: PlannerFactFamilyAvailability) =>
      planContextWithTrace(
        { ...input, factFamilyAvailability: availability },
        10_000,
      )
        .offered.filter((candidate) => familyOf(candidate) === undefined)
        .map(candidateKey)
        .sort();
    const control = Object.fromEntries(
      PLANNER_FACT_FAMILIES.map((family) => [family, false]),
    ) as unknown as PlannerFactFamilyAvailability;

    const baseline = directKeys(control);
    expect(baseline).toEqual(directKeys(control));
    expect(baseline.some((key) => key.includes('"caller"'))).toBe(true);
    expect(baseline.some((key) => key.includes('"associated_test"'))).toBe(
      true,
    );
    expect(
      directKeys({ ...ALL_ENABLED, binding: false }).some((key) =>
        key.includes('"caller"'),
      ),
    ).toBe(true);
  });
});
