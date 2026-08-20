/**
 * P1-L.2 — mechanism witness for references and bindings.
 *
 * The claim under test:
 *
 * > For repository references within supported TypeScript coverage, Acalys can
 * > represent the exact checker binding from a reference to its symbol and
 * > declaration set, and explicitly represent cases where that binding cannot
 * > be established.
 *
 * # Why the fixture is shaped the way it is
 *
 * Invariant 7 in its ideal form. Removing the precision mechanism must not
 * merely produce *nothing* — a plausible wrong answer has to be sitting there
 * waiting to be chosen:
 *
 * ```ts
 * import { save } from "./store.js";
 *
 * export function run(save: () => number): number {
 *   return save();          // the PARAMETER
 * }
 *
 * export function outer(): number {
 *   return save();          // the IMPORT
 * }
 * ```
 *
 * Two calls, spelled identically, binding to different symbols. A name-based
 * resolver answers "the imported `save`" for both, and is wrong for the first
 * — not wrong in a way that errors, but wrong in a way that hands a reviewer a
 * real declaration from a real file to read and believe.
 *
 * Every test below asserts its premises before its conclusion, so a later
 * fixture edit that removes the temptation fails here rather than silently
 * making the assertions vacuous.
 */

import { describe, expect, it } from "vitest";
import { gitObjectId } from "@acalys/contracts/domain";

import {
  bindingOf,
  buildRepositoryIndex,
  extractFile,
  generateCandidates,
  isUsable,
  citeBinding,
  indexDigest,
  indexIdentity,
  referenceAt,
  referencesIn,
  resolvedDeclarations,
  symbolById,
  type ContextCandidate,
  type RepositoryIndex,
} from "../src/index.js";

const REVISION = "d".repeat(40);

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

const SHADOWED = {
  "store.ts": ["export function save(): number {", "  return 1;", "}"].join(
    "\n",
  ),
  "run.ts": [
    'import { save } from "./store.js";',
    "",
    "export function run(save: () => number): number {",
    "  return save();",
    "}",
    "",
    "export function outer(): number {",
    "  return save();",
    "}",
  ].join("\n"),
};

// ---------------------------------------------------------------------------

describe("the shadowing fixture is genuinely adversarial", () => {
  const index = build(SHADOWED);

  it("has an imported save and a parameter save, as distinct symbols", () => {
    const imported = index.symbols.find(
      (symbol) => symbol.name === "save" && symbol.moduleId === "store.ts",
    );
    expect(imported).toBeDefined();

    // The parameter is not a declaration the index records as a symbol — it is
    // a binding target. What matters is that the checker keeps them apart, and
    // the binding assertions below are where that shows.
    const declarationsNamedSave = index.declarations.filter((record) => {
      const symbol = symbolById(index, record.symbolId);
      return symbol?.name === "save";
    });
    expect(declarationsNamedSave).toHaveLength(1);
    expect(declarationsNamedSave[0]?.moduleId).toBe("store.ts");
  });

  it("records both call references, spelled identically", () => {
    const calls = referencesIn(index, "run.ts").filter(
      (record) => record.kind === "call" && record.name === "save",
    );

    // The premise that makes the next test meaningful: two uses of one name,
    // so a name-based resolver has no way to tell them apart.
    expect(calls).toHaveLength(2);
    expect(calls.map((record) => record.line).sort((a, b) => a - b)).toEqual([
      4, 8,
    ]);
  });
});

describe("a reference binds to the symbol the checker chose", () => {
  const index = build(SHADOWED);

  it("binds the shadowed call to the parameter, not the import", () => {
    const reference = referenceAt(index, "run.ts", 4, "save");
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    const lookup = bindingOf(index, reference);
    expect(lookup.kind).toBe("bound");
    if (lookup.kind !== "bound") return;

    // The parameter is local to `run` and is not a declaration this index
    // records, so the binding is `external` to the index's declaration set
    // while still being exactly resolved by the checker.
    //
    // What matters is the negative: it does NOT point at store.ts. A
    // name-matching resolver would.
    const declarations = resolvedDeclarations(index, reference);
    expect(declarations.map((record) => record.moduleId)).not.toContain(
      "store.ts",
    );
  });

  it("binds the unshadowed call through the import to store.ts", () => {
    const reference = referenceAt(index, "run.ts", 8, "save");
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    const lookup = bindingOf(index, reference);
    expect(lookup.kind).toBe("bound");
    if (lookup.kind !== "bound") return;

    expect(lookup.binding.resolution).toBe("exact");
    // Followed through the import alias to the declaration, not stopped at the
    // import specifier — "where is save declared?" answered with "on the
    // import line" is true and useless.
    expect(lookup.binding.viaAlias).toBe(true);

    const declarations = resolvedDeclarations(index, reference);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.moduleId).toBe("store.ts");
    expect(declarations[0]?.startLine).toBe(1);
  });

  it("gives the two identically spelled calls different bindings", () => {
    const shadowed = referenceAt(index, "run.ts", 4, "save");
    const direct = referenceAt(index, "run.ts", 8, "save");
    if (shadowed === undefined || direct === undefined) {
      throw new Error("fixture no longer holds both calls");
    }

    const a = bindingOf(index, shadowed);
    const b = bindingOf(index, direct);
    if (a.kind !== "bound" || b.kind !== "bound") {
      throw new Error("both calls must bind");
    }

    // The single assertion that a name-based resolver cannot satisfy.
    expect(a.binding.symbolId).not.toBe(b.binding.symbolId);
    expect(a.binding.declarationIds).not.toEqual(b.binding.declarationIds);
  });
});

describe("bindings that cannot be established say so", () => {
  it("records `external` for a reference into an unindexed dependency", () => {
    const index = build({
      "u.ts": [
        'import { helper } from "some-package";',
        "export function use(): number {",
        "  return helper();",
        "}",
      ].join("\n"),
    });

    const reference = referenceAt(index, "u.ts", 3, "helper");
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    const lookup = bindingOf(index, reference);
    if (lookup.kind !== "bound") throw new Error("expected an edge");

    // `external`, precisely — not "one of external or unresolved". The first
    // version of this assertion accepted either, and a mutation collapsing
    // `external` into `unresolved` survived it: an assertion that accepts both
    // sides of a distinction cannot defend the distinction.
    //
    // The two are different claims. `external` says the checker bound the
    // reference and nothing in this index declares the target — a dependency,
    // and fine. `unresolved` says it could not be bound at all. A reviewer
    // told the second about the first would go looking for a bug.
    expect(lookup.binding.resolution).toBe("external");
    expect(lookup.binding.declarationIds).toEqual([]);
    expect(lookup.binding.symbolId).toBeUndefined();
  });

  it("records `unresolved` for a name nothing declares anywhere", () => {
    const index = build({
      "v.ts": [
        "export function use(): unknown {",
        "  return missing;",
        "}",
      ].join("\n"),
    });

    const reference = referenceAt(index, "v.ts", 2, "missing");
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    const lookup = bindingOf(index, reference);
    if (lookup.kind !== "bound") throw new Error("expected an edge");

    // The other half of the distinction the previous test defends. If these
    // two tests ever agree on a resolution value, the vocabulary has collapsed.
    expect(lookup.binding.resolution).toBe("unresolved");
  });

  it("emits an edge for every reference, including unresolvable ones", () => {
    const index = build({
      "v.ts": [
        "export function use(): unknown {",
        "  return missing;",
        "}",
      ].join("\n"),
    });

    const references = referencesIn(index, "v.ts");
    expect(references.length).toBeGreaterThan(0);

    // An unresolved reference is a fact about the revision. Omitting it would
    // leave a caller to infer that nothing uses the name — a different and
    // stronger claim than "we could not tell".
    for (const reference of references) {
      expect(bindingOf(index, reference).kind).toBe("bound");
    }
  });

  it("answers not_indexed for a reference in a module that failed to parse", () => {
    const index = build({
      "good.ts": "export function fine(): void {}",
      "broken.ts": "export function oops( {",
    });

    // Constructed rather than looked up: the broken module yields no
    // references, so this asks the question a caller would ask about one.
    const phantom = {
      referenceId: "x",
      moduleId: "broken.ts",
      name: "oops",
      line: 1,
      kind: "call" as const,
      provenance: {
        source: "typescript_checker" as const,
        path: "broken.ts",
        startLine: 1,
        endLine: 1,
        extractorVersion: "acalys.extractor.typescript.v1",
        revision: REVISION,
      },
    };

    const lookup = bindingOf(index, phantom);
    expect(lookup.kind).toBe("not_indexed");
    if (lookup.kind === "not_indexed") {
      expect(lookup.coverage).toBe("parse_failed");
    }
  });
});

describe("binding facts stay canonical and citable", () => {
  it("digests references and bindings, so they cannot drift silently", () => {
    const withCall = build(SHADOWED);
    const withoutCall = build({
      ...SHADOWED,
      "run.ts": SHADOWED["run.ts"].replace(
        "  return save();\n}",
        "  return 0;\n}",
      ),
    });

    expect(indexDigest(withCall)).not.toBe(indexDigest(withoutCall));
  });

  it("digests a record set, not the array order it arrived in", () => {
    const index = build(SHADOWED);
    const scrambled: RepositoryIndex = {
      ...index,
      references: [...index.references].reverse(),
      bindings: [...index.bindings].reverse(),
    };

    expect(indexDigest(scrambled)).toBe(indexDigest(index));
  });

  it("renders a citation naming the reference and how it resolved", () => {
    const index = build(SHADOWED);
    const reference = referenceAt(index, "run.ts", 8, "save");
    if (reference === undefined) throw new Error("no reference");
    const lookup = bindingOf(index, reference);
    if (lookup.kind !== "bound") throw new Error("no binding");

    const citation = citeBinding(reference, lookup.binding);
    expect(citation).toContain("run.ts:8");
    expect(citation).toContain("call `save`");
    expect(citation).toContain("exact");
    expect(citation).toContain("via import");
  });
});

// ---------------------------------------------------------------------------
// The usability guard, on the binding path
// ---------------------------------------------------------------------------

describe("bound callees are not offered from an unusable index", () => {
  const plannerInput = (index?: RepositoryIndex) => ({
    changed: [
      {
        path: "run.ts",
        content: SHADOWED["run.ts"],
        changedLines: [4],
      },
    ],
    repository: Object.entries(SHADOWED).map(([path, source]) =>
      extractFile(path, source),
    ),
    sources: new Map(Object.entries(SHADOWED)),
    ...(index === undefined ? {} : { index }),
  });

  const indexDerived = (candidates: readonly ContextCandidate[]) =>
    candidates.filter(
      (candidate) => candidate.provenance?.source === "repository_index",
    );

  it("offers them from a usable index", () => {
    // Premise. Without this the next test could pass because nothing was ever
    // offered — the vacuity that let the L.1 availability mutation survive.
    const offered = indexDerived(
      generateCandidates(plannerInput(build(SHADOWED))),
    ).filter((candidate) => candidate.reason === "referenced_symbol");

    expect(offered.length).toBeGreaterThan(0);
  });

  it("withholds them when the index failed its invariants", () => {
    const populated = build(SHADOWED);

    // Premise: the tempting facts are present and would be offered.
    expect(populated.bindings.length).toBeGreaterThan(0);
    expect(
      populated.bindings.some((edge) => edge.declarationIds.length > 0),
    ).toBe(true);

    const failed: RepositoryIndex = {
      ...populated,
      availability: {
        kind: "invariant_failed",
        why: "binding edges referenced declarations not in the index",
      },
    };

    // Premise: the guard says they must not be used, and the records are
    // still there unchanged.
    expect(isUsable(failed)).toBe(false);
    expect(failed.bindings).toEqual(populated.bindings);

    // Conclusion.
    const offered = indexDerived(generateCandidates(plannerInput(failed)));
    expect(offered).toHaveLength(0);
  });
});
