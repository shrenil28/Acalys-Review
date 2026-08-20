/**
 * P1-L.4.1 — CODE to TEST relationships, derived from bindings.
 *
 * The claim:
 *
 * > For supported TypeScript, the index can say which tests reference which
 * > symbols, on the checker's account rather than on filenames, and can
 * > distinguish "no test references this" from "we could not look".
 *
 * # The fixture that decides it
 *
 * ```
 * a.ts  export function save()
 * b.ts  export function save()
 *
 * a.test.ts  imports save from "./a.js"
 * b.test.ts  imports save from "./b.js"
 * ```
 *
 * A filename-matching associator — which is what `isTestFor` does — pairs both
 * tests with both symbols. Every claim built on that is then true of a symbol
 * nobody tested. Removing the binding-derived association must produce a
 * *wrong* association rather than none, which is what makes this fixture worth
 * having (invariant 7).
 */

import { describe, expect, it } from "vitest";
import { gitObjectId } from "@acalys/contracts/domain";

import {
  buildRepositoryIndex,
  citeTestRelationship,
  indexIdentity,
  modulesReferencing,
  symbolNamed,
  testCoverageEvidence,
  testRelationships,
  testsForSymbol,
  unavailableIndex,
  type RepositoryIndex,
} from "../src/index.js";

const REVISION = "4".repeat(40);

function build(files: Record<string, string>): RepositoryIndex {
  return buildRepositoryIndex({
    identity: indexIdentity({
      tenant: { kind: "tenant", tenantId: "tenant-1" },
      provider: "github",
      repositoryId: "repo-1",
      revision: gitObjectId(REVISION),
    }),
    snapshot: new Map(Object.entries(files)),
  });
}

const TWO_SAVES = {
  "src/a.ts": ["export function save(): number {", "  return 1;", "}"].join(
    "\n",
  ),
  "src/b.ts": ["export function save(): number {", "  return 2;", "}"].join(
    "\n",
  ),
  "tests/a.test.ts": [
    'import { save } from "../src/a.js";',
    "export function checkA(): number {",
    "  return save();",
    "}",
  ].join("\n"),
  "tests/b.test.ts": [
    'import { save } from "../src/b.js";',
    "export function checkB(): number {",
    "  return save();",
    "}",
  ].join("\n"),
};

const symbolIn = (index: RepositoryIndex, module: string, name: string) => {
  const lookup = symbolNamed(index, module, name);
  if (lookup.kind !== "found")
    throw new Error(`${name} not found in ${module}`);
  return lookup.symbol.symbolId;
};

describe("the fixture is genuinely adversarial", () => {
  const index = build(TWO_SAVES);

  it("holds two distinct symbols with the same name", () => {
    // Premise. Without two, a name-matching associator would be right by
    // accident and nothing below could tell the two procedures apart.
    const a = symbolIn(index, "src/a.ts", "save");
    const b = symbolIn(index, "src/b.ts", "save");
    expect(a).not.toBe(b);
  });

  it("classifies both test files as tests", () => {
    // The other premise: the association walks bindings whose reference lives
    // in a module classified `test`, so a misclassification would silently
    // produce zero relationships and every assertion would pass vacuously.
    const roles = Object.fromEntries(
      index.modules.map((module) => [module.moduleId, module.role]),
    );
    expect(roles["tests/a.test.ts"]).toBe("test");
    expect(roles["tests/b.test.ts"]).toBe("test");
    expect(roles["src/a.ts"]).toBe("production");
  });
});

describe("association follows the binding, not the filename", () => {
  const index = build(TWO_SAVES);

  it("pairs each test with only the symbol it imports", () => {
    const a = symbolIn(index, "src/a.ts", "save");
    const b = symbolIn(index, "src/b.ts", "save");

    expect(testsForSymbol(index, a).map((r) => r.testModuleId)).toEqual([
      "tests/a.test.ts",
    ]);
    expect(testsForSymbol(index, b).map((r) => r.testModuleId)).toEqual([
      "tests/b.test.ts",
    ]);
  });

  it("records the strength as a reference, never as coverage", () => {
    const a = symbolIn(index, "src/a.ts", "save");
    const [relationship] = testsForSymbol(index, a);

    expect(relationship).toBeDefined();
    // Structural association is not runtime coverage. The vocabulary says so,
    // because a reviewer told "covered" would conclude a change is safe.
    expect(relationship?.strength).toBe("direct_symbol_reference");
  });

  it("cites the reference that establishes it", () => {
    const a = symbolIn(index, "src/a.ts", "save");
    const [relationship] = testsForSymbol(index, a);
    if (relationship === undefined) throw new Error("no relationship");

    // A relationship without a citable site would be an assertion the index
    // makes about itself.
    expect(relationship.viaReferenceId).toBeDefined();
    expect(citeTestRelationship(relationship, index)).toContain(
      "tests/a.test.ts:",
    );
  });

  it("does not associate a test with a namesake it never imports", () => {
    // `save.test.ts` sitting beside `save.ts`, importing something else
    // entirely. Filename proximity says yes; the bindings say no.
    const index = build({
      "src/save.ts": "export function save(): number {\n  return 1;\n}",
      "src/other.ts": "export function other(): number {\n  return 2;\n}",
      "src/save.test.ts": [
        'import { other } from "./other.js";',
        "export function check(): number {",
        "  return other();",
        "}",
      ].join("\n"),
    });

    const save = symbolIn(index, "src/save.ts", "save");
    const other = symbolIn(index, "src/other.ts", "other");

    expect(testsForSymbol(index, save)).toEqual([]);
    expect(testsForSymbol(index, other).map((r) => r.testModuleId)).toEqual([
      "src/save.test.ts",
    ]);
  });

  it("follows an alias rather than the local name", () => {
    const index = build({
      "src/a.ts": "export function save(): number {\n  return 1;\n}",
      "tests/aliased.test.ts": [
        'import { save as persist } from "../src/a.js";',
        "export function check(): number {",
        "  return persist();",
        "}",
      ].join("\n"),
    });

    const save = symbolIn(index, "src/a.ts", "save");
    expect(testsForSymbol(index, save).map((r) => r.testModuleId)).toEqual([
      "tests/aliased.test.ts",
    ]);
  });

  it("ignores references from production modules", () => {
    // A production caller is not a test. The role classification is what keeps
    // "who exercises this?" from becoming "who mentions this?".
    const index = build({
      "src/a.ts": "export function save(): number {\n  return 1;\n}",
      "src/caller.ts": [
        'import { save } from "./a.js";',
        "export function run(): number {",
        "  return save();",
        "}",
      ].join("\n"),
    });

    const save = symbolIn(index, "src/a.ts", "save");
    expect(testsForSymbol(index, save)).toEqual([]);
  });
});

describe("absence of test references is a claim with standing", () => {
  it("reports no_test_references when every test module was read", () => {
    const index = build({
      "src/lonely.ts": "export function lonely(): number {\n  return 1;\n}",
      "tests/other.test.ts":
        "export function check(): number {\n  return 1;\n}",
    });

    const lonely = symbolIn(index, "src/lonely.ts", "lonely");
    expect(testCoverageEvidence(index, lonely).kind).toBe("no_test_references");
  });

  it("refuses to claim absence when a test module could not be read", () => {
    // The distinction that matters. A test file that failed to parse
    // contributes no references, and its silence is an outage rather than
    // evidence — "nothing tests this" would be inferred from our own failure
    // to look.
    const index = build({
      "src/lonely.ts": "export function lonely(): number {\n  return 1;\n}",
      "tests/broken.test.ts": "export function check( {",
    });

    const lonely = symbolIn(index, "src/lonely.ts", "lonely");
    const evidence = testCoverageEvidence(index, lonely);

    expect(evidence.kind).toBe("not_indexed");
    if (evidence.kind === "not_indexed") {
      expect(evidence.why).toContain("tests/broken.test.ts");
    }
  });

  it("still reports found references when an unrelated test is broken", () => {
    // The blind spot only withholds a NEGATIVE claim. Positive evidence is
    // still positive — a reference that exists was not imagined because some
    // other file failed to parse.
    const index = build({
      ...TWO_SAVES,
      "tests/broken.test.ts": "export function check( {",
    });

    const a = symbolIn(index, "src/a.ts", "save");
    expect(testCoverageEvidence(index, a).kind).toBe("referenced_by_tests");
  });

  it("reports not_indexed for a symbol this index never saw", () => {
    const index = build(TWO_SAVES);
    expect(testCoverageEvidence(index, "no-such-symbol").kind).toBe(
      "not_indexed",
    );
  });
});

describe("the relationship set is canonical", () => {
  it("is deduplicated by test, target and symbol", () => {
    // Ten calls to one function are one relationship. Reporting ten would make
    // "how many tests touch this?" answer a question about call sites.
    const index = build({
      "src/a.ts": "export function save(): number {\n  return 1;\n}",
      "tests/many.test.ts": [
        'import { save } from "../src/a.js";',
        "export function check(): number {",
        "  return save() + save() + save();",
        "}",
      ].join("\n"),
    });

    const save = symbolIn(index, "src/a.ts", "save");
    expect(testsForSymbol(index, save)).toHaveLength(1);
  });

  it("produces the same set on repeated derivation", () => {
    const index = build(TWO_SAVES);
    expect(testRelationships(index)).toEqual(testRelationships(index));
  });

  it("never relates a test module to itself", () => {
    const index = build({
      "tests/self.test.ts": [
        "function helper(): number {",
        "  return 1;",
        "}",
        "export function check(): number {",
        "  return helper();",
        "}",
      ].join("\n"),
    });

    for (const relationship of testRelationships(index)) {
      if (relationship.strength === "direct_symbol_reference") {
        expect(relationship.targetModuleId).not.toBe(relationship.testModuleId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The reverse lookup
// ---------------------------------------------------------------------------

describe("modulesReferencing reads binding edges backwards", () => {
  const files = {
    "src/a.ts": "export function save(): number {\n  return 1;\n}",
    "src/b.ts": "export function save(): number {\n  return 2;\n}",
    "src/uses-a.ts": [
      'import { save } from "./a.js";',
      "export function run(): number {",
      "  return save();",
      "}",
    ].join("\n"),
    "src/uses-b.ts": [
      'import { save } from "./b.js";',
      "export function run(): number {",
      "  return save();",
      "}",
    ].join("\n"),
  };

  it("names only the modules that actually bind into the target", () => {
    // Both dependants reference a symbol called `save`. A name-matching
    // reverse lookup returns both for either target, and a reviewer changing
    // src/a.ts would be told src/uses-b.ts depends on it.
    const index = build(files);

    expect(
      modulesReferencing(index, "src/a.ts").map((entry) => entry.moduleId),
    ).toEqual(["src/uses-a.ts"]);
    expect(
      modulesReferencing(index, "src/b.ts").map((entry) => entry.moduleId),
    ).toEqual(["src/uses-b.ts"]);
  });

  it("returns one entry per module, not per call site", () => {
    const index = build({
      "src/a.ts": "export function save(): number {\n  return 1;\n}",
      "src/many.ts": [
        'import { save } from "./a.js";',
        "export function run(): number {",
        "  return save() + save() + save();",
        "}",
      ].join("\n"),
    });

    // "Who depends on this?" is a question about modules. Ten call sites in
    // one file are one dependant.
    expect(modulesReferencing(index, "src/a.ts")).toHaveLength(1);
  });

  it("refuses to answer from an index that is not usable", () => {
    // Reachable only by a direct caller: the planner checks usability before
    // calling this, so the guard is unreachable through production and a
    // mutation removing it survived. `modulesReferencing` is exported, so a
    // caller other than the planner can and eventually will pass an unusable
    // index — and "no index" must never read as "nothing depends on this".
    const unusable = unavailableIndex(
      indexIdentity({
        tenant: { kind: "tenant", tenantId: "tenant-1" },
        provider: "github",
        repositoryId: "repo-1",
        revision: gitObjectId(REVISION),
      }),
      { kind: "unavailable", why: "clone failed" },
    );

    expect(modulesReferencing(unusable, "src/a.ts")).toEqual([]);
  });

  it("refuses even when the unusable index still carries records", () => {
    // The version that can actually observe the guard. An index with records
    // and `availability: invariant_failed` would otherwise answer from facts
    // it has already declared untrustworthy — and an empty-record fixture
    // cannot tell the guarded path from the unguarded one.
    const populated = build(files);
    expect(populated.bindings.length).toBeGreaterThan(0);

    const failed: RepositoryIndex = {
      ...populated,
      availability: {
        kind: "invariant_failed",
        why: "binding edges referenced declarations not in the index",
      },
    };

    expect(modulesReferencing(failed, "src/a.ts")).toEqual([]);
  });
});
