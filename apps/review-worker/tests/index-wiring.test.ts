/**
 * P1-L.1 — production wiring witness.
 *
 * `repository-index.test.ts` proves the facts are correct. This proves a real
 * review path *uses* them, which is a different claim and was the one P1-K got
 * wrong: 52 green tests over a sound `lib/` layer, and a central claim that was
 * false because nothing tested the code that called it.
 *
 * The chain under test, end to end through production code:
 *
 * ```
 * runRealAnalysis            the production entry
 *   -> gitObjectId(headSha)  the revision, resolved
 *   -> buildRepositoryIndex  the seam
 *   -> planContext(index)    the fact enters planning
 *   -> AssembledContext      the fact survives scoring and the budget
 *   -> buildClusters         the fact reaches what the analyzer is handed
 * ```
 *
 * # Why this cannot pass with the seam bypassed
 *
 * The planner keeps its syntactic path: a `containing_symbol` candidate is
 * produced whether or not an index exists. So "an item covering the changed
 * function is present" would stay true with the index removed entirely — a
 * vacuous assertion, and exactly the shape that let P1-K's seams sit call-site
 * inert behind passing tests.
 *
 * Three independent things are asserted instead, and each fails on its own if
 * the index is bypassed:
 *
 * ```
 * the item's provenance names repository_index, not direct_source
 * its recordId resolves to a declaration record in the returned index
 * its identity string carries the revision under review
 * ```
 */

import { describe, expect, it } from "vitest";

import { runRealAnalysis, type AnalysisSource } from "../src/index.js";
import { buildClusters } from "@acalys/review-engine";
import { declarationsIn, type ItemProvenance } from "@acalys/code-intelligence";

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

const REPO = "0192f8a1-0000-7000-8000-0000000000aa";
const SHA = "c".repeat(40);

/**
 * Two functions called `save`, in two modules, with different shapes.
 *
 * The fixture is adversarial on purpose: a name-matching extractor merges
 * these, and every fact it then reports about "save" may describe the function
 * that is not under review.
 */
const FILES = {
  "src/store.ts": [
    "export async function save(value: number): Promise<void> {",
    "  await Promise.resolve(value);",
    "}",
  ].join("\n"),
  "src/local.ts": [
    "function save(value: number): number {",
    "  return value + 1;",
    "}",
    "",
    "export function run(value: number): number {",
    "  return save(value);",
    "}",
  ].join("\n"),
};

const CHANGED = [{ path: "src/local.ts", changedLines: [6] }];

const run = () =>
  runRealAnalysis({
    repositoryId: REPO,
    headSha: SHA,
    tenantId: "tenant-1",
    source: fixtureSource(FILES, CHANGED),
  });

/** Items the planner says came from the index. */
function indexDerived(
  items: readonly { readonly provenance?: ItemProvenance | undefined }[],
): readonly (ItemProvenance & { source: "repository_index" })[] {
  return items.flatMap((item) =>
    item.provenance?.source === "repository_index" ? [item.provenance] : [],
  );
}

describe("the production review path reaches the repository index", () => {
  it("builds an index for the revision under review", async () => {
    const outcome = await run();

    expect(outcome.index.availability.kind).toBe("built");
    // Not a branch, not "latest": the exact object the review is about.
    expect(outcome.index.identity.revision.value).toBe(SHA);
    expect(outcome.index.identity.repositoryId).toBe(REPO);
    expect(outcome.index.identity.tenant).toEqual({
      kind: "tenant",
      tenantId: "tenant-1",
    });
  });

  it("puts an index-derived fact into the assembled context", async () => {
    const outcome = await run();
    const derived = indexDerived(outcome.context.items);

    expect(derived.length).toBeGreaterThan(0);
  });

  it("carries a record id that resolves in the index it names", async () => {
    const outcome = await run();
    const [provenance] = indexDerived(outcome.context.items);

    expect(provenance).toBeDefined();
    if (provenance === undefined) return;

    // The assertion that makes the provenance more than a label. A string
    // saying "repository_index" costs nothing to fake; a record id that has to
    // resolve inside the index this run actually built does not.
    const record = outcome.index.declarations.find(
      (declaration) => declaration.declarationId === provenance.recordId,
    );
    expect(record).toBeDefined();
    expect(record?.provenance.revision).toBe(SHA);
  });

  it("names the revision and extractor in the item's identity", async () => {
    const outcome = await run();
    const [provenance] = indexDerived(outcome.context.items);
    if (provenance === undefined) throw new Error("no index-derived item");

    expect(provenance.indexIdentity).toContain(SHA);
    expect(provenance.indexIdentity).toContain(
      "acalys.extractor.typescript.v1",
    );
    expect(provenance.citation).toContain("src/local.ts");
  });

  it("resolves the changed hunk to the RIGHT save", async () => {
    const outcome = await run();
    const [provenance] = indexDerived(outcome.context.items);
    if (provenance === undefined) throw new Error("no index-derived item");

    const record = outcome.index.declarations.find(
      (declaration) => declaration.declarationId === provenance.recordId,
    );

    // Line 6 is inside `run`, in src/local.ts — not inside either `save`, and
    // certainly not inside the exported one in src/store.ts. An extractor that
    // matched on names could land in the wrong module entirely.
    expect(record?.moduleId).toBe("src/local.ts");
    const symbol = outcome.index.symbols.find(
      (candidate) => candidate.symbolId === record?.symbolId,
    );
    expect(symbol?.name).toBe("run");
  });

  it("keeps both saves apart in the index the run used", async () => {
    const outcome = await run();

    const saves = outcome.index.symbols.filter(
      (symbol) => symbol.name === "save",
    );
    expect(saves).toHaveLength(2);
    expect(new Set(saves.map((symbol) => symbol.moduleId))).toEqual(
      new Set(["src/local.ts", "src/store.ts"]),
    );
  });

  it("delivers the fact all the way to what the analyzer is handed", async () => {
    const outcome = await run();

    // The last hop, through the same production function the analysis path
    // uses: assembled items become cluster context, and cluster context is
    // literally `input.context.items` inside the analyzer.
    const clusters = buildClusters(
      CHANGED.map((entry) => ({
        path: entry.path,
        changedLines: entry.changedLines,
      })),
      outcome.context.items,
    );

    const seenByAnalyzer = clusters.flatMap((cluster) => cluster.context);
    expect(indexDerived(seenByAnalyzer).length).toBeGreaterThan(0);
  });

  it("agrees with the index about the span it cut", async () => {
    const outcome = await run();
    const item = outcome.context.items.find(
      (candidate) => candidate.provenance?.source === "repository_index",
    );
    const provenance = item?.provenance;
    if (item === undefined || provenance?.source !== "repository_index") {
      throw new Error("no index-derived item");
    }

    const record = declarationsIn(outcome.index, "src/local.ts").find(
      (declaration) => declaration.declarationId === provenance.recordId,
    );

    // The content was cut using the index's span, not re-derived. If these
    // disagreed, the item would be labelled with a record it does not contain.
    expect(item.startLine).toBe(record?.startLine);
    expect(item.endLine).toBe(record?.endLine);
  });

  it("still produces a usable context when nothing is index-derived", async () => {
    // Degradation, not collapse. An index that failed must cost the extra
    // facts, never the review — the syntactic path is still there.
    const outcome = await runRealAnalysis({
      repositoryId: REPO,
      headSha: SHA,
      source: fixtureSource({ "notes.md": "# not typescript" }, [
        { path: "notes.md", changedLines: [1] },
      ]),
    });

    expect(outcome.index.availability.kind).toBe("built");
    expect(outcome.index.coverage.modulesUnsupported).toBe(1);
    expect(indexDerived(outcome.context.items)).toHaveLength(0);
    expect(outcome.context.items.length).toBeGreaterThan(0);
  });
});
