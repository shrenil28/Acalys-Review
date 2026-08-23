/**
 * P1-M.3.0 — base revision through the production path.
 *
 * Two properties here are correctness rather than plumbing:
 *
 *   1. one head against two bases must not share a cache key
 *   2. a snapshot that declares a base must account for EVERY changed file,
 *      including the ones its source never mentioned
 *
 * The first is a bug that only appears after a rebase, on a pull request that
 * looks reviewed. The second is how a comparison capability ends up reporting
 * a clean review it never performed.
 */

import { describe, expect, it } from "vitest";

import {
  analyzerCacheKey,
  runRealAnalysis,
  type AnalysisSource,
} from "../src/index.js";
import { buildClusters } from "@acalys/review-engine";

const REPO = "0192f8a1-0000-7000-8000-0000000000ba";
const HEAD_SHA = "e".repeat(40);

const HEAD = [
  "export function format(id: string, region: string): string {",
  "  return `${region}:${id}`;",
  "}",
].join("\n");
const BASE = [
  "export function format(id: string): string {",
  "  return id;",
  "}",
].join("\n");

function source(options: {
  readonly base?: { kind: "present"; content: string } | { kind: "absent" };
  readonly baseSha?: string;
  readonly extraChanged?: boolean;
}): AnalysisSource {
  const files: Record<string, string> = { "src/format.ts": HEAD };
  if (options.extraChanged === true) files["src/other.ts"] = HEAD;

  return {
    read: () =>
      Promise.resolve({
        changed: [
          {
            path: "src/format.ts",
            content: HEAD,
            changedLines: [1, 2],
            ...(options.base === undefined ? {} : { base: options.base }),
          },
          ...(options.extraChanged === true
            ? [{ path: "src/other.ts", content: HEAD, changedLines: [1] }]
            : []),
        ],
        repository: new Map(Object.entries(files)),
        ...(options.baseSha === undefined ? {} : { baseSha: options.baseSha }),
      }),
  };
}

const run = (s: AnalysisSource) =>
  runRealAnalysis({
    repositoryId: REPO,
    headSha: HEAD_SHA,
    tenantId: "tenant-1",
    source: s,
  });

const baseItems = (
  items: readonly { kind: string; path: string; provenance?: unknown }[],
) => items.filter((item) => item.kind === "base_revision");

describe("the cache key separates two bases at one head", () => {
  it("produces different keys for the same head against different bases", () => {
    const at = (baseSha: string) =>
      analyzerCacheKey({
        repositoryId: REPO,
        headSha: HEAD_SHA,
        comparisonIdentity: baseSha,
        contextDigest: "identical-context",
      });

    // Identical context on purpose. Base is only OFFERED to the planner, so
    // two reviews against different bases can assemble byte-identical context
    // and would otherwise collide on every entry in the key.
    expect(at("base-one")).not.toBe(at("base-two"));
  });

  it("distinguishes no base at all from a base that exists", () => {
    const withoutBase = analyzerCacheKey({
      repositoryId: REPO,
      headSha: HEAD_SHA,
      contextDigest: "identical-context",
    });
    const withBase = analyzerCacheKey({
      repositoryId: REPO,
      headSha: HEAD_SHA,
      comparisonIdentity: "base-one",
      contextDigest: "identical-context",
    });

    expect(withoutBase).not.toBe(withBase);
  });

  it("is stable when the base is the same", () => {
    const key = () =>
      analyzerCacheKey({
        repositoryId: REPO,
        headSha: HEAD_SHA,
        comparisonIdentity: "base-one",
        contextDigest: "identical-context",
      });

    expect(key()).toBe(key());
  });
});

describe("comparison identity through the production path", () => {
  const keyFor = async (baseSha: string, content: string) =>
    (await run(source({ baseSha, base: { kind: "present", content } })))
      .cacheKey;

  it("differs when the compared revision differs", async () => {
    expect(await keyFor("base-one", BASE)).not.toBe(
      await keyFor("base-two", BASE),
    );
  });

  it("differs when the compared CONTENT differs at the same commit", async () => {
    // The commit name alone is not the semantic input. A port that returns
    // the wrong text for the right sha must not be served the other one's
    // findings, and the mistake must stay investigable afterwards.
    expect(await keyFor("base-one", BASE)).not.toBe(
      await keyFor("base-one", BASE.replace("return id;", "return `${id}`;")),
    );
  });

  it("is identical when the semantic inputs are identical", async () => {
    // The converse, and it is not ceremony: without it, a key that mixed in
    // run time or a counter would pass every assertion above while making the
    // cache useless. Entropy is not identity.
    expect(await keyFor("base-one", BASE)).toBe(await keyFor("base-one", BASE));
  });

  it("differs from the same head reviewed against nothing", async () => {
    const compared = await keyFor("base-one", BASE);
    const headOnly = (await run(source({}))).cacheKey;

    expect(compared).not.toBe(headOnly);
  });
});

describe("a snapshot that declares a base accounts for every changed file", () => {
  it("synthesizes not_indexed for a changed path the source never mentioned", async () => {
    const outcome = await run(
      source({
        baseSha: "base-one",
        base: { kind: "present", content: BASE },
        extraChanged: true,
      }),
    );

    const items = baseItems(outcome.context.items);
    const byPath = new Map(items.map((item) => [item.path, item.provenance]));

    expect(byPath.get("src/format.ts")).toMatchObject({
      resolution: "present",
    });
    // The source said nothing about this file. That must not read as "no
    // base change" — it reads as "nobody looked".
    expect(byPath.get("src/other.ts")).toMatchObject({
      resolution: "not_indexed",
    });
  });
});

describe("a head-only snapshot stays head-only", () => {
  it("produces no base context when no base sha is declared", async () => {
    const outcome = await run(
      source({ base: { kind: "present", content: BASE } }),
    );

    // The per-file base is present but the snapshot never declared a base
    // commit. "We did not look" is not the same claim as "we looked and
    // failed", and inventing base context here would let the pipeline report
    // a comparison it has no commit for.
    expect(baseItems(outcome.context.items)).toEqual([]);
  });
});

describe("base context reaches the cluster of the file it is the base of", () => {
  it("is routed by path, without needing a broadcast rule", async () => {
    const outcome = await run(
      source({ baseSha: "base-one", base: { kind: "present", content: BASE } }),
    );

    expect(baseItems(outcome.context.items)).toHaveLength(1);

    // Routed because a base revision carries the HEAD path, which is already
    // in its cluster's neighbourhood. Asserted rather than assumed: if that
    // ever stops being true, base context silently stops reaching the only
    // analyzer that can use it, and every comparison finding disappears with
    // no test failing anywhere near the cause.
    const clusters = buildClusters(
      [{ path: "src/format.ts", changedLines: [1, 2] }],
      outcome.context.items,
    );

    expect(
      clusters.some((cluster) =>
        cluster.context.some(
          (item) =>
            item.kind === "base_revision" && item.path === "src/format.ts",
        ),
      ),
    ).toBe(true);
  });

  it("does not deliver a base revision to a cluster for another file", async () => {
    const outcome = await run(
      source({
        baseSha: "base-one",
        base: { kind: "present", content: BASE },
        extraChanged: true,
      }),
    );

    const clusters = buildClusters(
      [{ path: "src/other.ts", changedLines: [1] }],
      outcome.context.items.filter((item) => item.path === "src/format.ts"),
    );

    expect(
      clusters.some((cluster) =>
        cluster.context.some((item) => item.kind === "base_revision"),
      ),
    ).toBe(false);
  });
});
