/**
 * P1-L.3 — the production commit barrier.
 *
 * These exist because a read-only trace disproved an earlier justification in
 * this codebase. `incremental.ts` said its consistency check needed no direct
 * coverage since "the equivalence oracle would fail first and more loudly".
 * That is true in tests and false in production:
 *
 * ```
 * canonicalSerialization / indexDigest   called from NO production path
 * validateIndexConsistency               the only production check
 * ```
 *
 * So the oracle and the validator answer different questions, and the
 * validator's rules need proof that does not depend on the oracle running.
 *
 * # One rule per fixture
 *
 * Every fixture below is a real, valid index with exactly one field changed.
 * A fixture that broke three rules would let mutations in two validators
 * survive behind whichever fired first — the validator's version of the
 * vacuity this project keeps finding. Each test asserts the specific `rule`,
 * never merely that *something* was rejected.
 */

import { describe, expect, it } from "vitest";
import { gitObjectId } from "@acalys/contracts/domain";

import {
  buildRepositoryIndex,
  indexIdentity,
  validateIndexConsistency,
  type BindingEdge,
  type RepositoryIndex,
} from "../src/index.js";

const REVISION = "3".repeat(40);

const SOURCE = {
  "store.ts": ["export function save(): number {", "  return 1;", "}"].join(
    "\n",
  ),
  "run.ts": [
    'import { save } from "./store.js";',
    // A bare specifier this index does not materialize, so the reference
    // through it classifies `external`. Without it the fixture holds no
    // external binding at all and three of the rules below have nothing to
    // deviate from — which the premise test caught rather than letting the
    // assertions pass on a shape that was never there.
    'import { helper } from "some-package";',
    "",
    "export function run(): number {",
    "  return save() + helper();",
    "}",
  ].join("\n"),
};

/** A genuinely valid index — the baseline every fixture deviates from by one field. */
function validIndex(): RepositoryIndex {
  return buildRepositoryIndex({
    identity: indexIdentity({
      tenant: { kind: "tenant", tenantId: "tenant-1" },
      provider: "github",
      repositoryId: "repo-1",
      revision: gitObjectId(REVISION),
    }),
    snapshot: new Map(Object.entries(SOURCE)),
  });
}

/** Replaces one binding, leaving everything else exactly as built. */
function withBinding(
  index: RepositoryIndex,
  find: (edge: BindingEdge) => boolean,
  patch: (edge: BindingEdge) => BindingEdge,
): RepositoryIndex {
  const target = index.bindings.find(find);
  if (target === undefined) throw new Error("fixture has no such binding");
  return {
    ...index,
    bindings: index.bindings.map((edge) =>
      edge.bindingId === target.bindingId ? patch(edge) : edge,
    ),
  };
}

const anExactBinding = (edge: BindingEdge) =>
  edge.resolution === "exact" && edge.symbolId !== undefined;

describe("the baseline fixture is genuinely valid", () => {
  it("accepts a freshly built index", () => {
    // The premise for all of it. If the baseline were already invalid, every
    // rejection below could be the baseline's fault rather than the fixture's.
    expect(validateIndexConsistency(validIndex())).toBeUndefined();
  });

  it("contains the record shapes the rules are about", () => {
    const index = validIndex();
    expect(index.bindings.some(anExactBinding)).toBe(true);
    expect(index.bindings.some((edge) => edge.resolution === "external")).toBe(
      true,
    );
    expect(index.declarations.length).toBeGreaterThan(0);
    expect(index.references.length).toBeGreaterThan(0);
  });
});

describe("the resolution matrix is enforced", () => {
  it("rejects an exact binding that names no symbol", () => {
    // The shape incremental assembly can actually produce: `symbolId` is
    // recomputed from mapped declarations while the resolution rides along
    // from H1 untouched.
    const index = withBinding(validIndex(), anExactBinding, (edge) => {
      const { symbolId: _dropped, ...rest } = edge;
      return rest;
    });

    expect(validateIndexConsistency(index)?.rule).toBe("exact_without_symbol");
  });

  it("rejects an exact binding that points at no declaration", () => {
    const index = withBinding(validIndex(), anExactBinding, (edge) => ({
      ...edge,
      declarationIds: [],
    }));

    expect(validateIndexConsistency(index)?.rule).toBe(
      "exact_without_declarations",
    );
  });

  it("rejects a declaration that belongs to a different symbol", () => {
    const index = validIndex();
    const target = index.bindings.find(anExactBinding);
    if (target === undefined) throw new Error("no exact binding");

    // A real declaration id, owned by some other symbol. Present and valid on
    // its own — wrong only as this binding's target.
    const foreign = index.declarations.find(
      (record) => record.symbolId !== target.symbolId,
    );
    if (foreign === undefined) throw new Error("fixture has one symbol only");

    const patched = withBinding(index, anExactBinding, (edge) => ({
      ...edge,
      declarationIds: [foreign.declarationId],
    }));

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "declaration_not_owned_by_symbol",
    );
  });

  it("rejects an external binding that names an internal symbol", () => {
    const index = validIndex();
    const symbolId = index.symbols[0]?.symbolId;
    expect(symbolId).toBeDefined();
    if (symbolId === undefined) return;

    const patched = withBinding(
      index,
      (edge) => edge.resolution === "external",
      (edge) => ({ ...edge, symbolId }),
    );

    // "Bound, and outside our world" cannot also name something inside it.
    expect(validateIndexConsistency(patched)?.rule).toBe(
      "external_with_symbol",
    );
  });

  it("rejects an external binding that points at internal declarations", () => {
    const index = validIndex();
    const declarationId = index.declarations[0]?.declarationId;
    if (declarationId === undefined) throw new Error("no declaration");

    const patched = withBinding(
      index,
      (edge) => edge.resolution === "external",
      (edge) => ({ ...edge, declarationIds: [declarationId] }),
    );

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "external_with_declarations",
    );
  });

  it("rejects an unresolved binding that names a symbol", () => {
    const index = validIndex();
    const symbolId = index.symbols[0]?.symbolId;
    if (symbolId === undefined) throw new Error("no symbol");

    const patched = withBinding(index, anExactBinding, (edge) => ({
      ...edge,
      resolution: "unresolved",
      symbolId,
      declarationIds: [],
    }));

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "unresolved_with_symbol",
    );
  });

  it("rejects an unresolved binding that points at declarations", () => {
    const index = validIndex();
    const patched = withBinding(index, anExactBinding, (edge) => {
      const { symbolId: _dropped, ...rest } = edge;
      return { ...rest, resolution: "unresolved" as const };
    });

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "unresolved_with_declarations",
    );
  });

  it("rejects an ambiguous binding that names exactly one symbol", () => {
    // Nothing produces `ambiguous` today — L.1 and L.2 both assert it is
    // unreachable. The rule exists so that if L.4 makes it reachable, it
    // cannot arrive claiming a unique answer while declaring uncertainty.
    const index = validIndex();
    const symbolId = index.symbols[0]?.symbolId;
    if (symbolId === undefined) throw new Error("no symbol");

    const patched = withBinding(index, anExactBinding, (edge) => ({
      ...edge,
      resolution: "ambiguous",
      symbolId,
      declarationIds: [],
    }));

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "ambiguous_with_symbol",
    );
  });
});

describe("referential integrity is enforced", () => {
  it("rejects a declaration naming an absent symbol", () => {
    const index = validIndex();
    const patched: RepositoryIndex = {
      ...index,
      declarations: index.declarations.map((record, position) =>
        position === 0 ? { ...record, symbolId: "no-such-symbol" } : record,
      ),
    };

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "declaration_symbol_missing",
    );
  });

  it("rejects a binding naming an absent reference", () => {
    const patched = withBinding(validIndex(), anExactBinding, (edge) => ({
      ...edge,
      referenceId: "no-such-reference",
    }));

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "binding_reference_missing",
    );
  });

  it("rejects a binding pointing at an absent declaration", () => {
    const patched = withBinding(validIndex(), anExactBinding, (edge) => ({
      ...edge,
      declarationIds: ["no-such-declaration"],
    }));

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "binding_declaration_missing",
    );
  });

  it("rejects a binding naming an absent symbol", () => {
    const patched = withBinding(validIndex(), anExactBinding, (edge) => ({
      ...edge,
      symbolId: "no-such-symbol",
    }));

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "binding_symbol_missing",
    );
  });

  it("rejects two bindings for one reference", () => {
    const index = validIndex();
    const target = index.bindings.find(anExactBinding);
    if (target === undefined) throw new Error("no exact binding");

    const patched: RepositoryIndex = {
      ...index,
      bindings: [...index.bindings, { ...target, bindingId: "a-second-edge" }],
    };

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "binding_duplicate_for_reference",
    );
  });

  it("rejects a reference with no binding at all", () => {
    const index = validIndex();
    const dropped = index.bindings[0];
    if (dropped === undefined) throw new Error("no binding");

    const patched: RepositoryIndex = {
      ...index,
      bindings: index.bindings.filter(
        (edge) => edge.bindingId !== dropped.bindingId,
      ),
    };

    // A reference without an edge would let a caller infer "nothing binds
    // here", which is a claim rather than an absence of one.
    expect(validateIndexConsistency(patched)?.rule).toBe(
      "reference_without_binding",
    );
  });
});

describe("every record must name this revision", () => {
  it("rejects a declaration stamped with another revision", () => {
    const index = validIndex();
    const patched: RepositoryIndex = {
      ...index,
      declarations: index.declarations.map((record, position) =>
        position === 0
          ? {
              ...record,
              provenance: { ...record.provenance, revision: "9".repeat(40) },
            }
          : record,
      ),
    };

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "declaration_revision_mismatch",
    );
  });

  it("rejects a reference stamped with another revision", () => {
    const index = validIndex();
    const patched: RepositoryIndex = {
      ...index,
      references: index.references.map((record, position) =>
        position === 0
          ? {
              ...record,
              provenance: { ...record.provenance, revision: "9".repeat(40) },
            }
          : record,
      ),
    };

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "reference_revision_mismatch",
    );
  });

  it("rejects a binding stamped with another revision", () => {
    const patched = withBinding(validIndex(), anExactBinding, (edge) => ({
      ...edge,
      provenance: { ...edge.provenance, revision: "9".repeat(40) },
    }));

    expect(validateIndexConsistency(patched)?.rule).toBe(
      "binding_revision_mismatch",
    );
  });
});
