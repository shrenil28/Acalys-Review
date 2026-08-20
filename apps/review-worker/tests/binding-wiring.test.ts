/**
 * P1-L.2 — production wiring witness for bindings.
 *
 * L.1's witness proved a production path builds the index and consumes a
 * declaration fact. This proves a production path consumes a **binding** — the
 * answer to "what does this call actually denote" — and that removing the
 * checker-backed resolution leaves a plausible wrong answer available rather
 * than nothing.
 *
 * ```
 * runRealAnalysis            the production entry
 *   -> buildRepositoryIndex  references and bindings for the revision
 *   -> planContext(index)    bound callees enter planning
 *   -> AssembledContext      the fact survives scoring and the budget
 *   -> buildClusters         it reaches what the analyzer is handed
 * ```
 *
 * The fixture shadows an import with a parameter, so a name-matching resolver
 * offers the reviewer a real declaration from a real file that the changed code
 * never calls.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import { buildClusters } from "@acalys/review-engine";
import {
  bindingOf,
  referenceAt,
  type ItemProvenance,
} from "@acalys/code-intelligence";

function fixtureSource(
  files: Record<string, string>,
  changed: readonly { path: string; changedLines: readonly number[] }[],
): AnalysisSource {
  return {
    read: () =>
      Promise.resolve({
        changed: changed.map((entry) => ({
          path: entry.path,
          content: files[entry.path] ?? "",
          changedLines: entry.changedLines,
        })),
        repository: new Map(Object.entries(files)),
      }),
  };
}

const REPO = "0192f8a1-0000-7000-8000-0000000000bb";
const SHA = "e".repeat(40);

const FILES = {
  "src/store.ts": ["export function save(): number {", "  return 1;", "}"].join(
    "\n",
  ),
  "src/run.ts": [
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

const CHANGED = [{ path: "src/run.ts", changedLines: [4] }];

const run = () =>
  runRealAnalysis({
    repositoryId: REPO,
    headSha: SHA,
    tenantId: "tenant-1",
    source: fixtureSource(FILES, CHANGED),
  });

function indexDerived(
  items: readonly { readonly provenance?: ItemProvenance | undefined }[],
): readonly (ItemProvenance & { source: "repository_index" })[] {
  return items.flatMap((item) =>
    item.provenance?.source === "repository_index" ? [item.provenance] : [],
  );
}

describe("the production review path consumes checker bindings", () => {
  it("records both calls and binds them differently", async () => {
    const outcome = await run();

    // Premise: the trap exists in the index this run actually built. Two calls
    // spelled `save`, binding to different things. Without this, every
    // assertion below could hold for a fixture with nothing to get wrong.
    const shadowed = referenceAt(outcome.index, "src/run.ts", 4, "save");
    const direct = referenceAt(outcome.index, "src/run.ts", 8, "save");
    expect(shadowed).toBeDefined();
    expect(direct).toBeDefined();
    if (shadowed === undefined || direct === undefined) return;

    const a = bindingOf(outcome.index, shadowed);
    const b = bindingOf(outcome.index, direct);
    expect(a.kind).toBe("bound");
    expect(b.kind).toBe("bound");
    if (a.kind !== "bound" || b.kind !== "bound") return;

    expect(a.binding.symbolId).not.toBe(b.binding.symbolId);
  });

  it("carries a binding record id into the assembled context", async () => {
    const outcome = await run();

    const bindingIds = new Set(
      outcome.index.bindings.map((edge) => edge.bindingId),
    );
    const fromBinding = indexDerived(outcome.context.items).filter(
      (provenance) => bindingIds.has(provenance.recordId),
    );

    // Not merely "an index-derived item exists" — L.1 already guarantees that
    // via declaration facts. This asserts a BINDING reached the context.
    expect(fromBinding.length).toBeGreaterThan(0);
    expect(fromBinding[0]?.citation).toContain("call `save`");
  });

  it("does not offer the shadowed import as the changed call's callee", async () => {
    const outcome = await run();

    const shadowed = referenceAt(outcome.index, "src/run.ts", 4, "save");
    if (shadowed === undefined)
      throw new Error("fixture lost the shadowed call");

    const lookup = bindingOf(outcome.index, shadowed);
    if (lookup.kind !== "bound") throw new Error("shadowed call did not bind");

    // The parameter is not a declaration this index records, so the binding
    // carries no declarations — and therefore contributes no context item.
    // The wrong answer is the one that WOULD have been offered by a
    // name-matching resolver: store.ts's `save`.
    expect(lookup.binding.declarationIds).toEqual([]);
  });

  it("delivers a binding-derived fact to what the analyzer is handed", async () => {
    const outcome = await run();

    const clusters = buildClusters(
      CHANGED.map((entry) => ({
        path: entry.path,
        changedLines: entry.changedLines,
      })),
      outcome.context.items,
    );

    const bindingIds = new Set(
      outcome.index.bindings.map((edge) => edge.bindingId),
    );
    const seenByAnalyzer = clusters.flatMap((cluster) => cluster.context);

    expect(
      indexDerived(seenByAnalyzer).filter((provenance) =>
        bindingIds.has(provenance.recordId),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("records references and bindings for the revision under review", async () => {
    const outcome = await run();

    expect(outcome.index.references.length).toBeGreaterThan(0);
    expect(outcome.index.bindings).toHaveLength(
      outcome.index.references.length,
    );
    for (const binding of outcome.index.bindings) {
      expect(binding.provenance.revision).toBe(SHA);
    }
  });
});
