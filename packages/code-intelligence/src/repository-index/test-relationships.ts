/**
 * Which tests exercise which code — derived from bindings, never from names.
 *
 * # What this replaces, and why
 *
 * `isTestFor(testPath, subjectPath)` compares file names: `save.test.ts` is
 * held to test `save.ts`. That is a naming convention, not a fact about the
 * repository, and it is wrong in both directions — a test named after one
 * module while exercising another, or a well-named test that imports nothing
 * from its namesake. L.2 recorded what each reference actually binds to, so
 * the association can be a consequence of the code rather than of the
 * filenames somebody chose.
 *
 * The adversarial case is the same one L.2 was built for:
 *
 * ```
 * a.ts  export function save()
 * b.ts  export function save()
 *
 * a.test.ts  imports { save } from "./a.js"
 * b.test.ts  imports { save } from "./b.js"
 * ```
 *
 * Name matching associates both tests with both symbols. Every downstream
 * claim built on that — "this symbol is tested", "show the reviewer its
 * tests" — is then true of a symbol nobody tested.
 *
 * # Strength is a claim about evidence, not about coverage
 *
 * ```
 * direct_symbol_reference      the test binds to this symbol
 * module_dependency            the test imports the module, not this symbol
 * indirect_module_dependency   the test reaches the module through another
 * unknown                      no evidence either way
 * ```
 *
 * None of these means "this test covers this line". Structural association is
 * not runtime coverage, and calling it so would let a reviewer conclude a
 * change is safe because a file that imports it exists. When real coverage
 * evidence arrives it gets its own vocabulary; until then the honest words are
 * the ones above.
 *
 * # Derived, not stored
 *
 * These are a pure function of an already-built index rather than records
 * inside it. Two consequences, both deliberate: the canonical digest and L.3's
 * equivalence oracle are untouched, and a relationship can never drift from
 * the bindings it is computed from — there is no second copy to go stale.
 */

import type {
  BindingEdge,
  ReferenceRecord,
  RepositoryIndex,
  SymbolRecord,
} from "./records.js";
import { EXTRACTOR_VERSION } from "./identity.js";

/**
 * How firmly a test is associated with the code under test.
 *
 * Ordered strongest first. `unknown` is a member rather than an absence
 * because a caller asking "how is this test related?" needs an answer that
 * distinguishes "not related" from "we did not look".
 */
export const TEST_RELATIONSHIP_STRENGTHS = [
  "direct_symbol_reference",
  "module_dependency",
  "indirect_module_dependency",
  "unknown",
] as const;

export type TestRelationshipStrength =
  (typeof TEST_RELATIONSHIP_STRENGTHS)[number];

export interface TestRelationship {
  readonly testModuleId: string;
  readonly targetModuleId: string;
  readonly strength: TestRelationshipStrength;
  /** Present only for `direct_symbol_reference`. */
  readonly symbolId?: string | undefined;
  /**
   * The reference that establishes this, so the claim can be checked.
   *
   * A relationship without one would be an assertion the index makes about
   * itself. With it, "this test exercises that symbol" is answerable by going
   * to a line and reading it.
   */
  readonly viaReferenceId?: string | undefined;
  readonly extractorVersion: string;
}

interface Edge {
  readonly reference: ReferenceRecord;
  readonly binding: BindingEdge;
}

/** Bindings whose reference lives in a module classified `test`. */
function testEdges(index: RepositoryIndex): readonly Edge[] {
  const testModules = new Set(
    index.modules
      .filter((module) => module.role === "test")
      .map((module) => module.moduleId),
  );

  const references = new Map(
    index.references.map((record) => [record.referenceId, record]),
  );

  return index.bindings.flatMap((binding) => {
    const reference = references.get(binding.referenceId);
    if (reference === undefined) return [];
    if (!testModules.has(reference.moduleId)) return [];
    return [{ reference, binding }];
  });
}

/**
 * Every test relationship the index supports, in canonical order.
 *
 * Deduplicated by (test, target, symbol): a test calling one function ten
 * times is one relationship, and reporting ten would make "how many tests
 * touch this?" answer a question about call sites.
 */
export function testRelationships(
  index: RepositoryIndex,
): readonly TestRelationship[] {
  const declarationModule = new Map(
    index.declarations.map((record) => [record.declarationId, record.moduleId]),
  );
  const declarationSymbol = new Map(
    index.declarations.map((record) => [record.declarationId, record.symbolId]),
  );

  const found = new Map<string, TestRelationship>();

  for (const { reference, binding } of testEdges(index)) {
    // `external` and `unresolved` bindings carry no declarations, so they
    // contribute nothing — correctly. A test importing a third-party package
    // is a real fact and not a relationship to code in this repository.
    for (const declarationId of binding.declarationIds) {
      const targetModuleId = declarationModule.get(declarationId);
      const symbolId = declarationSymbol.get(declarationId);
      if (targetModuleId === undefined || symbolId === undefined) continue;
      if (targetModuleId === reference.moduleId) continue;

      const key = `${reference.moduleId}|${targetModuleId}|${symbolId}`;
      if (found.has(key)) continue;

      found.set(key, {
        testModuleId: reference.moduleId,
        targetModuleId,
        // The test's own reference resolved to this symbol's declaration.
        // Nothing about naming entered into it.
        strength: "direct_symbol_reference",
        symbolId,
        viaReferenceId: reference.referenceId,
        extractorVersion: EXTRACTOR_VERSION,
      });
    }
  }

  // Module-level dependency, for tests that import a module without binding to
  // a symbol this index declares — a side-effect import, or a name that
  // resolved externally. Weaker, and recorded as weaker.
  for (const { reference, binding } of testEdges(index)) {
    if (reference.kind !== "import") continue;
    if (binding.declarationIds.length > 0) continue;

    const key = `${reference.moduleId}|module|${reference.name}`;
    if (found.has(key)) continue;

    found.set(key, {
      testModuleId: reference.moduleId,
      targetModuleId: reference.moduleId,
      strength: "module_dependency",
      viaReferenceId: reference.referenceId,
      extractorVersion: EXTRACTOR_VERSION,
    });
  }

  return [...found.values()].sort(
    (a, b) =>
      compare(a.testModuleId, b.testModuleId) ||
      compare(a.targetModuleId, b.targetModuleId) ||
      compare(a.symbolId ?? "", b.symbolId ?? "") ||
      compare(a.strength, b.strength),
  );
}

/**
 * The tests that reference a symbol, by the checker's account.
 *
 * Returns an empty list for a symbol nothing tests AND for a symbol in a
 * module that was never indexed, which is why this is not the function to ask
 * "is this tested?" with. {@link testCoverageEvidence} is.
 */
export function testsForSymbol(
  index: RepositoryIndex,
  symbolId: string,
): readonly TestRelationship[] {
  return testRelationships(index).filter(
    (relationship) => relationship.symbolId === symbolId,
  );
}

/**
 * What the index can say about whether a symbol is exercised by tests.
 *
 * Three outcomes, for the reason every other lookup in this index has three:
 * a caller must not be able to read "we could not look" as "nothing tests it".
 * The word is `evidence` rather than `coverage` throughout, because coverage
 * is a runtime property and this is a structural one.
 */
export type TestEvidence =
  | {
      readonly kind: "referenced_by_tests";
      readonly relationships: readonly TestRelationship[];
    }
  | { readonly kind: "no_test_references"; readonly symbolId: string }
  | {
      readonly kind: "not_indexed";
      readonly symbolId: string;
      readonly why: string;
    };

export function testCoverageEvidence(
  index: RepositoryIndex,
  symbolId: string,
): TestEvidence {
  const symbol: SymbolRecord | undefined = index.symbols.find(
    (record) => record.symbolId === symbolId,
  );
  if (symbol === undefined) {
    return {
      kind: "not_indexed",
      symbolId,
      why: `no symbol ${symbolId} in this index`,
    };
  }

  const module = index.modules.find(
    (record) => record.moduleId === symbol.moduleId,
  );
  if (module === undefined || module.coverage !== "indexed") {
    return {
      kind: "not_indexed",
      symbolId,
      why: `${symbol.moduleId} was not successfully indexed`,
    };
  }

  // A test module that failed to parse contributes no references, so its
  // silence is an outage rather than evidence. If any test module is
  // unindexed, "nothing references this" is not a claim this index can make.
  const blindSpot = index.modules.find(
    (record) => record.role === "test" && record.coverage !== "indexed",
  );

  const relationships = testsForSymbol(index, symbolId);
  if (relationships.length > 0) {
    return { kind: "referenced_by_tests", relationships };
  }

  if (blindSpot !== undefined) {
    return {
      kind: "not_indexed",
      symbolId,
      why: `no test references found, but ${blindSpot.moduleId} (${blindSpot.coverage}) could not be read`,
    };
  }

  return { kind: "no_test_references", symbolId };
}

/** A one-line citation, checkable by hand. */
export function citeTestRelationship(
  relationship: TestRelationship,
  index: RepositoryIndex,
): string {
  const reference = index.references.find(
    (record) => record.referenceId === relationship.viaReferenceId,
  );
  const site =
    reference === undefined
      ? relationship.testModuleId
      : `${reference.moduleId}:${String(reference.line)}`;
  return (
    `${site} ${relationship.strength} -> ${relationship.targetModuleId}` +
    (relationship.symbolId === undefined ? "" : ` (${relationship.symbolId})`)
  );
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
