/**
 * P1-L.4.2 (Agent A) — project discovery.
 *
 * The claim under test: `discoverProjects` answers "which config paths exist"
 * and "how sure are we that is all of them" as two independent facts, and the
 * second is never reported `complete` merely because iteration finished.
 *
 * Two mechanisms are exercised, not one:
 *
 * ```
 * name convention    tsconfig(.variant)?.json, matched directly
 * reference graph     a known project's `references` names another, whatever
 *                      its filename — followed until nothing new turns up
 * ```
 *
 * Several fixtures below prove a premise before the conclusion that depends on
 * it (invariant 7): a "missing reference" test first proves the target really
 * is absent from the snapshot, and a "non-conventional name" test first proves
 * name-matching alone would have missed the file, so the mechanism that finds
 * it afterward is shown to be doing something rather than reaching a state
 * that was already true.
 */

import { describe, expect, it } from "vitest";

import { discoverProjects } from "../src/repository-index/config-discovery.js";

function snapshot(files: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(files));
}

describe("discoverProjects — name convention", () => {
  it("discovers exactly two configs, in canonical order", () => {
    const result = discoverProjects(
      snapshot({
        "tsconfig.json": JSON.stringify({ include: ["src"] }),
        "packages/pkg-a/tsconfig.json": JSON.stringify({ include: ["src"] }),
        "src/a.ts": "export const x = 1;\n",
      }),
    );

    expect(result.discovered).toEqual([
      "packages/pkg-a/tsconfig.json",
      "tsconfig.json",
    ]);
    expect(result.coverage).toEqual({ status: "complete" });
  });

  it("discovers none, and reports that as complete", () => {
    const result = discoverProjects(
      snapshot({
        "src/a.ts": "export const x = 1;\n",
        "src/b.ts": "export const y = 2;\n",
      }),
    );

    expect(result.discovered).toEqual([]);
    expect(result.coverage).toEqual({ status: "complete" });
  });

  it("does not treat a vendored tsconfig as a project, and stays complete", () => {
    // Premise: a tsconfig-shaped path really is present in the snapshot, so
    // "not discovered" below is a deliberate exclusion, not an absent input.
    const files = {
      "src/a.ts": "export const x = 1;\n",
      "node_modules/some-pkg/tsconfig.json": JSON.stringify({
        include: ["src"],
      }),
    };
    expect(Object.keys(files)).toContain("node_modules/some-pkg/tsconfig.json");

    const result = discoverProjects(snapshot(files));

    expect(result.discovered).toEqual([]);
    expect(result.coverage).toEqual({ status: "complete" });
  });
});

describe("discoverProjects — reference graph", () => {
  it("misses a non-conventionally named config when nothing references it", () => {
    // The premise the next test's conclusion depends on: name matching alone
    // does not find "ts.config.json" — it does not match the tsconfig
    // convention, and nothing points at it yet.
    const result = discoverProjects(
      snapshot({
        "packages/pkg-b/ts.config.json": JSON.stringify({ include: ["src"] }),
      }),
    );

    expect(result.discovered).toEqual([]);
  });

  it("finds that same config once something references it, whatever its name", () => {
    const result = discoverProjects(
      snapshot({
        "tsconfig.json": JSON.stringify({
          references: [{ path: "./packages/pkg-b/ts.config.json" }],
        }),
        "packages/pkg-b/ts.config.json": JSON.stringify({ include: ["src"] }),
      }),
    );

    expect(result.discovered).toEqual([
      "packages/pkg-b/ts.config.json",
      "tsconfig.json",
    ]);
    expect(result.coverage).toEqual({ status: "complete" });
  });

  it("is incomplete when a reference names a project absent from the snapshot", () => {
    const files = {
      "tsconfig.json": JSON.stringify({
        references: [{ path: "../missing-pkg" }],
      }),
    };
    // Premise: the referenced project really is absent — "incomplete" below
    // is not asserted over a fixture where it happens to be present.
    expect(Object.keys(files)).not.toContain("missing-pkg/tsconfig.json");
    expect(Object.keys(files)).not.toContain("../missing-pkg/tsconfig.json");

    const result = discoverProjects(snapshot(files));

    expect(result.coverage.status).toBe("incomplete");
    expect(result.coverage).toMatchObject({
      why: expect.stringContaining("../missing-pkg/tsconfig.json"),
    });
    // The gap must not erase the positive fact discovery already established:
    // tsconfig.json itself was found, and stays found.
    expect(result.discovered).toContain("tsconfig.json");
  });

  it("does not treat a reference into a vendored tree as a missing project", () => {
    const result = discoverProjects(
      snapshot({
        "tsconfig.json": JSON.stringify({
          references: [{ path: "./node_modules/some-pkg" }],
        }),
      }),
    );

    expect(result.discovered).toEqual(["tsconfig.json"]);
    expect(result.coverage).toEqual({ status: "complete" });
  });

  it("marks discovery incomplete when references is not an array", () => {
    const result = discoverProjects(
      snapshot({
        "tsconfig.json": JSON.stringify({ references: 42 }),
      }),
    );

    expect(result.discovered).toEqual(["tsconfig.json"]);
    expect(result.coverage).toMatchObject({
      status: "incomplete",
      why: expect.stringContaining("invalid references field"),
    });
  });

  it("preserves a valid reference beside an invalid entry and marks the graph incomplete", () => {
    const result = discoverProjects(
      snapshot({
        "tsconfig.json": JSON.stringify({
          references: [{ path: "./custom.json" }, { path: 42 }],
        }),
        "custom.json": JSON.stringify({ files: [] }),
      }),
    );

    expect(result.discovered).toEqual(["custom.json", "tsconfig.json"]);
    expect(result.coverage).toMatchObject({
      status: "incomplete",
      why: expect.stringContaining("invalid project references"),
    });
  });

  it("marks discovery incomplete when a reference entry has no path", () => {
    const result = discoverProjects(
      snapshot({
        "tsconfig.json": JSON.stringify({ references: [{}] }),
      }),
    );

    expect(result.coverage.status).toBe("incomplete");
  });
});

describe("discoverProjects — determinism", () => {
  it("is unaffected by Map insertion order", () => {
    // "b-project/custom.json" is reachable only through z-project's
    // reference, under a non-conventional name — so it is discovered by the
    // worklist walk, not by the up-front name filter. Its final position
    // depends on the output actually being sorted rather than inheriting
    // whatever order the walk happened to visit things in, which is the
    // specific way L.1's determinism test passed with its sort deleted: a
    // list built from an already-sorted source stayed sorted by accident,
    // not because anything downstream enforced it.
    const entries: readonly [string, string][] = [
      [
        "z-project/tsconfig.json",
        JSON.stringify({
          references: [{ path: "../b-project/custom.json" }],
        }),
      ],
      ["a-project/tsconfig.json", JSON.stringify({ include: ["src"] })],
      [
        "m-project/tsconfig.json",
        JSON.stringify({ references: [{ path: "../a-project" }] }),
      ],
      ["b-project/custom.json", JSON.stringify({ include: ["src"] })],
    ];

    // Premise: the two builds really do insert in different orders, so a
    // result that relied on Map iteration order (rather than an explicit
    // sort) would have somewhere to disagree.
    const forward = new Map(entries);
    const reversed = new Map([...entries].reverse());
    expect([...forward.keys()]).not.toEqual([...reversed.keys()]);

    const resultForward = discoverProjects(forward);
    const resultReversed = discoverProjects(reversed);

    expect(resultForward).toEqual(resultReversed);
    expect(resultForward.discovered).toEqual([
      "a-project/tsconfig.json",
      "b-project/custom.json",
      "m-project/tsconfig.json",
      "z-project/tsconfig.json",
    ]);
  });
});
