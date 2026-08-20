/**
 * P1-L.4.2 — the governance algebra, exercised on hand-built facts.
 *
 * Every fixture here is constructed by hand rather than pulled from a real
 * `tsconfig.json`, on purpose: the states this algebra must get right —
 * `governed` surviving a sibling's outage, `undetermined` refusing to be
 * mistaken for `not_governed`, a reference or an extends edge staying out of
 * governance — are states a happy-path extractor over a working repository
 * would rarely if ever produce. The point of keeping `config-governance.ts`
 * free of `typescript` is exactly that it lets this file manufacture them.
 *
 * Negative assertions (`not.toContain`, length-0 checks) are only worth
 * anything if the fixture could have produced the rejected answer under a
 * plausible wrong implementation. Each one below is built so a specific,
 * describable bug — the ones `config-model.ts` names by name — would have
 * been caught, not so the assertion holds over an empty possibility space.
 */

import { describe, expect, it } from "vitest";

import {
  governanceFor,
  optionInheritance,
  projectReferences,
  type ProjectConfigFact,
  type ProjectDiscovery,
} from "../src/repository-index/config-governance.js";
import type { GovernanceFailure } from "../src/repository-index/config-model.js";
import type { FactProvenance } from "../src/repository-index/records.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function provenance(configPath: string): FactProvenance {
  return {
    source: "typescript_syntax",
    path: configPath,
    startLine: 1,
    endLine: 1,
    extractorVersion: "fixture",
    revision: "0".repeat(40),
  };
}

interface AvailableProjectInput {
  readonly configPath: string;
  readonly admittedFiles?: readonly string[];
  readonly namedInFiles?: readonly string[];
  readonly extendsPath?: string;
  readonly referencedProjects?: readonly string[];
}

function availableProject(input: AvailableProjectInput): ProjectConfigFact {
  return {
    configPath: input.configPath,
    availability: { kind: "available" },
    admittedFiles: input.admittedFiles ?? [],
    namedInFiles: input.namedInFiles ?? [],
    ...(input.extendsPath === undefined
      ? {}
      : { extendsPath: input.extendsPath }),
    referencedProjects: input.referencedProjects ?? [],
    provenance: provenance(input.configPath),
  };
}

function unavailableProject(
  configPath: string,
  failure: GovernanceFailure,
  detail: string,
): ProjectConfigFact {
  return {
    configPath,
    availability: { kind: "unavailable", failure, detail },
    admittedFiles: [],
    namedInFiles: [],
    referencedProjects: [],
    provenance: provenance(configPath),
  };
}

function completeDiscovery(discovered: readonly string[]): ProjectDiscovery {
  return { discovered, coverage: { status: "complete" } };
}

function incompleteDiscovery(
  discovered: readonly string[],
  why: string,
): ProjectDiscovery {
  return { discovered, coverage: { status: "incomplete", why } };
}

const projectPaths = (
  relationships: readonly { readonly projectPath: string }[],
): readonly string[] => relationships.map((r) => r.projectPath).sort();

// ---------------------------------------------------------------------------
// 1. Plural governance
// ---------------------------------------------------------------------------

describe("governanceFor — plural governance", () => {
  it("reports BOTH projects when two independently admit one file", () => {
    const file = "pkg/src/shared.ts";
    const root = availableProject({
      configPath: "tsconfig.json",
      admittedFiles: [file],
    });
    const pkg = availableProject({
      configPath: "pkg/tsconfig.json",
      admittedFiles: [file],
    });

    // Premise: both fixtures genuinely admit the file, independently of each
    // other's config. A test that skipped this could pass by accident if one
    // fixture were wired wrong.
    expect(root.admittedFiles).toContain(file);
    expect(pkg.admittedFiles).toContain(file);

    const result = governanceFor(
      completeDiscovery([root.configPath, pkg.configPath]),
      [root, pkg],
      file,
    );

    expect(result.status).toBe("governed");
    if (result.status !== "governed") throw new Error("unreachable");
    expect(result.relationships).toHaveLength(2);
    expect(projectPaths(result.relationships)).toEqual(
      [root.configPath, pkg.configPath].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The case the model was corrected for
// ---------------------------------------------------------------------------

describe("governanceFor — an outage cannot erase an established fact", () => {
  it("stays governed, with the gap named in coverage, when an unrelated project is unavailable", () => {
    const file = "pkg/src/index.ts";
    const pkg = availableProject({
      configPath: "pkg/tsconfig.json",
      admittedFiles: [file],
    });
    const broken = unavailableProject(
      "other/tsconfig.json",
      "config_unparsable",
      "trailing comma at line 4",
    );

    // Premise: the broken project is genuinely unrelated — it does not
    // admit the file in question, so its outage has nothing to do with
    // whether `pkg` governs it.
    expect(broken.admittedFiles).not.toContain(file);

    const result = governanceFor(
      completeDiscovery([pkg.configPath, broken.configPath]),
      [pkg, broken],
      file,
    );

    expect(result.status).toBe("governed");
    if (result.status !== "governed") throw new Error("unreachable");
    expect(projectPaths(result.relationships)).toEqual([pkg.configPath]);
    expect(result.coverage.unevaluable).toHaveLength(1);
    expect(result.coverage.unevaluable[0]?.configPath).toBe(broken.configPath);
    expect(result.coverage.unevaluable[0]?.failure).toBe("config_unparsable");
  });

  it("cannot be pushed to undetermined no matter how many other projects are broken", () => {
    const file = "pkg/src/index.ts";
    const pkg = availableProject({
      configPath: "pkg/tsconfig.json",
      admittedFiles: [file],
    });
    const brokenA = unavailableProject(
      "a/tsconfig.json",
      "config_absent",
      "no tsconfig.json found",
    );
    const brokenB = unavailableProject(
      "b/tsconfig.json",
      "extends_unresolvable",
      "../missing-base.json does not exist",
    );

    const result = governanceFor(
      completeDiscovery([
        pkg.configPath,
        brokenA.configPath,
        brokenB.configPath,
      ]),
      [pkg, brokenA, brokenB],
      file,
    );

    expect(result.status).toBe("governed");
    expect(result.status).not.toBe("undetermined");
  });
});

// ---------------------------------------------------------------------------
// 3–5. not_governed vs undetermined
// ---------------------------------------------------------------------------

describe("governanceFor — not_governed requires complete discovery AND complete evaluation", () => {
  it("is not_governed when no project admits the file, discovery is complete, and every project is available", () => {
    const file = "pkg/src/orphan.ts";
    const root = availableProject({
      configPath: "tsconfig.json",
      admittedFiles: ["tools/build.ts"],
    });
    const pkg = availableProject({
      configPath: "pkg/tsconfig.json",
      admittedFiles: ["pkg/src/other.ts"],
    });

    // Premise: genuinely nobody admits it.
    expect(root.admittedFiles).not.toContain(file);
    expect(pkg.admittedFiles).not.toContain(file);

    const result = governanceFor(
      completeDiscovery([root.configPath, pkg.configPath]),
      [root, pkg],
      file,
    );

    expect(result.status).toBe("not_governed");
    if (result.status !== "not_governed") throw new Error("unreachable");
    expect(result.evidence).toEqual([
      {
        reason: "no_project_admits_it",
        detail: expect.stringContaining(file),
      },
    ]);
    expect(result.coverage.unevaluable).toHaveLength(0);
  });

  it("is undetermined, NOT not_governed, when no project admits the file but one is unavailable", () => {
    const file = "pkg/src/orphan.ts";
    const pkg = availableProject({
      configPath: "pkg/tsconfig.json",
      admittedFiles: ["pkg/src/other.ts"],
    });
    const broken = unavailableProject(
      "other/tsconfig.json",
      "config_unparsable",
      "unexpected token",
    );

    const result = governanceFor(
      completeDiscovery([pkg.configPath, broken.configPath]),
      [pkg, broken],
      file,
    );

    expect(result.status).toBe("undetermined");
    expect(result.status).not.toBe("not_governed");
    if (result.status !== "undetermined") throw new Error("unreachable");
    expect(result.why).toContain("could not be evaluated");
  });

  it("is undetermined, NOT not_governed, when no project admits the file and discovery itself is incomplete", () => {
    const file = "pkg/src/orphan.ts";
    const pkg = availableProject({
      configPath: "pkg/tsconfig.json",
      admittedFiles: ["pkg/src/other.ts"],
    });

    const result = governanceFor(
      incompleteDiscovery(
        [pkg.configPath],
        "directory walk timed out under node_modules",
      ),
      [pkg],
      file,
    );

    expect(result.status).toBe("undetermined");
    expect(result.status).not.toBe("not_governed");
    if (result.status !== "undetermined") throw new Error("unreachable");
    expect(result.why).toContain("directory walk timed out");
  });
});

// ---------------------------------------------------------------------------
// 6. included_by_files vs included_by_include
// ---------------------------------------------------------------------------

describe("governanceFor — reason classification", () => {
  it("distinguishes included_by_files from included_by_include in a fixture carrying both", () => {
    const named = "pkg/src/explicit.ts";
    const patterned = "pkg/src/implicit.ts";
    const pkg = availableProject({
      configPath: "pkg/tsconfig.json",
      admittedFiles: [named, patterned],
      namedInFiles: [named],
    });

    // Premise: the fixture actually carries both kinds — a fixture with
    // only one would make the "distinguish" claim untestable in one
    // direction.
    expect(pkg.namedInFiles).toContain(named);
    expect(pkg.namedInFiles).not.toContain(patterned);
    expect(pkg.admittedFiles).toContain(patterned);

    const discovery = completeDiscovery([pkg.configPath]);

    const namedResult = governanceFor(discovery, [pkg], named);
    const patternedResult = governanceFor(discovery, [pkg], patterned);

    if (
      namedResult.status !== "governed" ||
      patternedResult.status !== "governed"
    ) {
      throw new Error("unreachable");
    }
    expect(namedResult.relationships[0]?.reason).toBe("included_by_files");
    expect(patternedResult.relationships[0]?.reason).toBe(
      "included_by_include",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. extends never becomes SourceGovernance
// ---------------------------------------------------------------------------

describe("optionInheritance vs governanceFor — extends is not governance", () => {
  it("extends produces an OptionInheritance edge, and the base project never governs the child's files", () => {
    const childFile = "pkg/src/index.ts";
    const base = availableProject({
      // The base config admits nothing of its own — a bare options file.
      // If a buggy implementation flattened `extends` into governance, this
      // is the project that would wrongly appear below.
      configPath: "tsconfig.base.json",
      admittedFiles: [],
    });
    const pkg = availableProject({
      configPath: "pkg/tsconfig.json",
      admittedFiles: [childFile],
      extendsPath: base.configPath,
    });

    const inheritance = optionInheritance([base, pkg]);
    expect(inheritance).toEqual([
      expect.objectContaining({
        projectPath: pkg.configPath,
        inheritsFrom: base.configPath,
        directness: "direct",
        depth: 1,
      }),
    ]);

    const result = governanceFor(
      completeDiscovery([base.configPath, pkg.configPath]),
      [base, pkg],
      childFile,
    );
    expect(result.status).toBe("governed");
    if (result.status !== "governed") throw new Error("unreachable");
    expect(projectPaths(result.relationships)).toEqual([pkg.configPath]);
    expect(projectPaths(result.relationships)).not.toContain(base.configPath);
  });
});

// ---------------------------------------------------------------------------
// 8. project reference never becomes SourceGovernance
// ---------------------------------------------------------------------------

describe("projectReferences vs governanceFor — a reference is not governance", () => {
  it("a project reference produces a ProjectReference edge, and the referenced project never governs the referencing project's files", () => {
    const referencingFile = "app/src/main.ts";
    // `lib` is a real, available project in its own right — present so a
    // buggy implementation that unions governance across `referencedProjects`
    // has something to wrongly pull in. It deliberately does not admit
    // `app`'s file.
    const lib = availableProject({
      configPath: "lib/tsconfig.json",
      admittedFiles: ["lib/src/index.ts"],
    });
    const app = availableProject({
      configPath: "app/tsconfig.json",
      admittedFiles: [referencingFile],
      referencedProjects: [lib.configPath],
    });

    expect(lib.admittedFiles).not.toContain(referencingFile);

    const refs = projectReferences([lib, app]);
    expect(refs).toEqual([
      expect.objectContaining({
        projectPath: app.configPath,
        referencesProject: lib.configPath,
      }),
    ]);

    const result = governanceFor(
      completeDiscovery([lib.configPath, app.configPath]),
      [lib, app],
      referencingFile,
    );
    expect(result.status).toBe("governed");
    if (result.status !== "governed") throw new Error("unreachable");
    expect(projectPaths(result.relationships)).toEqual([app.configPath]);
    expect(projectPaths(result.relationships)).not.toContain(lib.configPath);
  });
});

// ---------------------------------------------------------------------------
// 9. Extends chains are not flattened
// ---------------------------------------------------------------------------

describe("optionInheritance — chains", () => {
  it("a three-level extends chain yields direct and transitive edges, not one flattened edge", () => {
    const baseB = availableProject({ configPath: "base-b.json" });
    const baseA = availableProject({
      configPath: "base-a.json",
      extendsPath: baseB.configPath,
    });
    const pkg = availableProject({
      configPath: "pkg/tsconfig.json",
      extendsPath: baseA.configPath,
    });

    const edges = optionInheritance([pkg, baseA, baseB]);

    // Premise: three configs, two extends links.
    expect(
      [pkg, baseA, baseB].filter((p) => p.extendsPath !== undefined),
    ).toHaveLength(2);

    // A flattening bug would produce exactly one edge from pkg, straight to
    // base-b, and nothing from base-a. Reject that by requiring all three.
    expect(edges).toHaveLength(3);

    expect(edges).toContainEqual(
      expect.objectContaining({
        projectPath: pkg.configPath,
        inheritsFrom: baseA.configPath,
        directness: "direct",
        depth: 1,
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        projectPath: pkg.configPath,
        inheritsFrom: baseB.configPath,
        directness: "transitive",
        depth: 2,
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        projectPath: baseA.configPath,
        inheritsFrom: baseB.configPath,
        directness: "direct",
        depth: 1,
      }),
    );

    // The direct edge from pkg to its own immediate base must survive
    // alongside the transitive one — a caller wanting "just the project's
    // own extends" must still be able to get it.
    const pkgEdges = edges.filter((e) => e.projectPath === pkg.configPath);
    expect(pkgEdges).toHaveLength(2);
    expect(pkgEdges.map((e) => e.directness).sort()).toEqual([
      "direct",
      "transitive",
    ]);
  });
});
