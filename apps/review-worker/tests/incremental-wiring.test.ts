/**
 * P1-L.3 — production wiring witness for incremental indexing.
 *
 * A real review sequence, not an API demonstration:
 *
 * ```
 * review H1        -> index H1
 * push H2          -> change manifest
 *                  -> incremental index path
 *                  -> the BINDING changes
 *                  -> context planner sees the H2 binding
 *                  -> production consumer receives the H2 fact
 * ```
 *
 * # The fixture is built so that staleness is tempting
 *
 * At H1 the call binds to `store.save`. At H2 the import is retargeted and it
 * binds to `other.save`. Both are real, exported, identically named functions.
 * Inadequate invalidation does not lose the binding — it keeps a plausible
 * wrong one, and the reviewer is shown a function the changed code no longer
 * calls.
 *
 * That is the failure worth catching. A fixture whose stale outcome is "no
 * record found" would test the easy direction.
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import {
  bindingOf,
  referenceAt,
  type ItemProvenance,
  type RepositoryIndex,
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

const REPO = "0192f8a1-0000-7000-8000-0000000000cc";
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

const AT_H1 = {
  "src/store.ts": [
    "export function save(value: number): number {",
    "  return value + 1;",
    "}",
  ].join("\n"),
  "src/other.ts": [
    "export function save(value: number): number {",
    "  return value + 2;",
    "}",
  ].join("\n"),
  "src/run.ts": [
    'import { save } from "./store.js";',
    "",
    "export function run(value: number): number {",
    "  return save(value);",
    "}",
  ].join("\n"),
};

const AT_H2 = {
  ...AT_H1,
  "src/run.ts": AT_H1["src/run.ts"].replace('"./store.js"', '"./other.js"'),
};

const CHANGED = [{ path: "src/run.ts", changedLines: [4] }];

const review = (
  files: Record<string, string>,
  headSha: string,
  previousIndex?: RepositoryIndex,
) =>
  runRealAnalysis({
    repositoryId: REPO,
    headSha,
    tenantId: "tenant-1",
    source: fixtureSource(files, CHANGED),
    ...(previousIndex === undefined ? {} : { previousIndex }),
  });

/** Which module the analyzer was shown as the callee, via index provenance. */
function calleeModules(
  index: RepositoryIndex,
  items: readonly { readonly provenance?: ItemProvenance | undefined }[],
): readonly string[] {
  const bindings = new Map(
    index.bindings.map((edge) => [edge.bindingId, edge]),
  );
  const declarations = new Map(
    index.declarations.map((record) => [record.declarationId, record]),
  );

  return items.flatMap((item) => {
    if (item.provenance?.source !== "repository_index") return [];
    const edge = bindings.get(item.provenance.recordId);
    if (edge === undefined) return [];
    return edge.declarationIds.flatMap((id) => {
      const record = declarations.get(id);
      return record === undefined ? [] : [record.moduleId];
    });
  });
}

describe("a second review updates the index rather than trusting the first", () => {
  it("binds the call to store.ts at H1", async () => {
    // Premise. If this ever stops holding, the H2 assertions below stop
    // meaning anything — there would be no stale answer to be tempted by.
    const first = await review(AT_H1, SHA1);

    const reference = referenceAt(first.index, "src/run.ts", 4, "save");
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    const lookup = bindingOf(first.index, reference);
    expect(lookup.kind).toBe("bound");
    if (lookup.kind !== "bound") return;

    expect(
      lookup.binding.declarationIds
        .map(
          (id) =>
            first.index.declarations.find(
              (record) => record.declarationId === id,
            )?.moduleId,
        )
        .filter((module) => module !== undefined),
    ).toEqual(["src/store.ts"]);
  });

  it("takes the incremental path when a previous index is supplied", async () => {
    const first = await review(AT_H1, SHA1);
    const second = await review(AT_H2, SHA2, first.index);

    // Asserted before the correctness claims, because a silent fallback to a
    // full rebuild would make every one of them true for the wrong reason.
    expect(second.indexStats?.attempted).toBe(true);
    expect(
      second.indexStats?.succeeded,
      `fell back: ${second.indexStats?.fallbackReason ?? "?"}`,
    ).toBe(true);
    expect(second.index.identity.revision.value).toBe(SHA2);
  });

  it("rebinds the call to other.ts at H2", async () => {
    const first = await review(AT_H1, SHA1);
    const second = await review(AT_H2, SHA2, first.index);

    const reference = referenceAt(second.index, "src/run.ts", 4, "save");
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    const lookup = bindingOf(second.index, reference);
    if (lookup.kind !== "bound") throw new Error("call did not bind at H2");

    const modules = lookup.binding.declarationIds
      .map(
        (id) =>
          second.index.declarations.find(
            (record) => record.declarationId === id,
          )?.moduleId,
      )
      .filter((module) => module !== undefined);

    // The stale H1 answer — src/store.ts — is still a real, exported,
    // identically named function. Keeping it would be a confident wrong
    // answer, not a gap.
    expect(modules).toEqual(["src/other.ts"]);
  });

  it("shows the analyzer the H2 callee, not the H1 one", async () => {
    const first = await review(AT_H1, SHA1);
    const second = await review(AT_H2, SHA2, first.index);

    const shown = calleeModules(second.index, second.context.items);

    // The end of the chain: entry -> incremental seam -> changed fact ->
    // consumer. Not "an incremental API exists" but "the thing the analyzer
    // was handed changed because the binding did".
    expect(shown).toContain("src/other.ts");
    expect(shown).not.toContain("src/store.ts");
  });

  it("carries no H1 revision stamp into the H2 index", async () => {
    const first = await review(AT_H1, SHA1);
    const second = await review(AT_H2, SHA2, first.index);

    for (const record of second.index.declarations) {
      expect(record.provenance.revision).toBe(SHA2);
    }
    for (const record of second.index.references) {
      expect(record.provenance.revision).toBe(SHA2);
    }
    for (const edge of second.index.bindings) {
      expect(edge.provenance.revision).toBe(SHA2);
    }
  });

  it("builds from scratch when no previous index is held", async () => {
    // A first review has no previous revision, and that is not a degraded
    // state. `indexStats` is absent rather than reporting a failed update.
    const first = await review(AT_H1, SHA1);
    expect(first.indexStats).toBeUndefined();
    expect(first.index.availability.kind).toBe("built");
  });
});

// ---------------------------------------------------------------------------
// The dependent-module case
// ---------------------------------------------------------------------------

describe("a caller is re-indexed when its callee moves beneath it", () => {
  // The scenario above cannot reach this: there, `run.ts` itself changed, so
  // it was recomputed as `modified` and dependency-driven invalidation never
  // ran. A mutation disabling that rule survived the whole suite.
  //
  // Here `run.ts` is byte-identical at H2. Only `store.ts` changes, and only
  // by gaining a line above `save` — so `save` still exists, still exports,
  // still has the same name, and sits two lines lower. The stale H1 binding
  // points at a declaration span that no longer holds that function.
  //
  // Content equality says retain. It is wrong, because a binding is a fact
  // about two modules.
  const CALLEE_MOVED = {
    ...AT_H1,
    "src/store.ts": [
      "// a comment that did not exist before",
      "",
      "export function save(value: number): number {",
      "  return value + 1;",
      "}",
    ].join("\n"),
  };

  it("keeps run.ts byte-identical across the two revisions", () => {
    // Premise. If an edit ever touches run.ts, this scenario silently becomes
    // the previous one and stops testing what it names.
    expect(CALLEE_MOVED["src/run.ts"]).toBe(AT_H1["src/run.ts"]);
    expect(CALLEE_MOVED["src/store.ts"]).not.toBe(AT_H1["src/store.ts"]);
  });

  it("moves the callee's declaration to a new span", () => {
    // The other premise: the declaration genuinely relocated, so a retained
    // binding would point somewhere stale rather than somewhere identical.
    expect(
      AT_H1["src/store.ts"]
        .split("\n")
        .indexOf("export function save(value: number): number {"),
    ).toBe(0);
    expect(
      CALLEE_MOVED["src/store.ts"]
        .split("\n")
        .indexOf("export function save(value: number): number {"),
    ).toBe(2);
  });

  it("re-indexes run.ts and binds to the callee's new location", async () => {
    const first = await review(AT_H1, SHA1);
    const second = await review(CALLEE_MOVED, SHA2, first.index);

    expect(second.indexStats?.succeeded).toBe(true);

    const reference = referenceAt(second.index, "src/run.ts", 4, "save");
    if (reference === undefined) throw new Error("call reference lost");

    const lookup = bindingOf(second.index, reference);
    if (lookup.kind !== "bound") throw new Error("call did not bind at H2");

    const declarations = lookup.binding.declarationIds.map((id) =>
      second.index.declarations.find((record) => record.declarationId === id),
    );

    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.moduleId).toBe("src/store.ts");
    // The line the function actually occupies at H2, not the one it held at H1.
    expect(declarations[0]?.startLine).toBe(3);
  });

  it("shows the analyzer the callee at its new span", async () => {
    const first = await review(AT_H1, SHA1);
    const second = await review(CALLEE_MOVED, SHA2, first.index);

    const items = second.context.items.filter(
      (item) => item.provenance?.source === "repository_index",
    );
    const spans = items.flatMap((item) => {
      const provenance = item.provenance;
      if (provenance?.source !== "repository_index") return [];
      const edge = second.index.bindings.find(
        (candidate) => candidate.bindingId === provenance.recordId,
      );
      if (edge === undefined) return [];
      return edge.declarationIds.flatMap((id) => {
        const record = second.index.declarations.find(
          (candidate) => candidate.declarationId === id,
        );
        return record === undefined
          ? []
          : [`${record.moduleId}:${String(record.startLine)}`];
      });
    });

    expect(spans).toContain("src/store.ts:3");
    expect(spans).not.toContain("src/store.ts:1");
  });
});
