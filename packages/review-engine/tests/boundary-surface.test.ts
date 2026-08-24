/**
 * The public boundary surface, tested as a fact.
 *
 * Deliberately no proposal logic here. Epoch 3 exposed a capability whose
 * verifier reasoned at the boundary while its analyzer reasoned about modules,
 * and the repair is only real if the boundary is a thing that exists on its
 * own — extractable, comparable, and honest about what it could not establish
 * — rather than a step inside a detector.
 */

import { describe, expect, it } from "vitest";

import {
  boundarySurface,
  declaredBoundaries,
} from "../src/correctness/boundary-surface.js";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const DECODE =
  "export function decode(raw: string): string {\n  return raw;\n}";
const ENCODE =
  "export function encode(raw: string): string {\n  return raw;\n}";

const surfaceOf = (entries: Record<string, string>, identity: string) => {
  const map = files(entries);
  const boundary = declaredBoundaries(map).find(
    (entry) => entry.identity === identity,
  );
  if (boundary === undefined) throw new Error(`no boundary ${identity}`);
  return boundarySurface(map, boundary);
};

const reachable = (entries: Record<string, string>, identity: string) =>
  surfaceOf(entries, identity)
    .reachableNames.map((entry) => entry.name)
    .sort();

describe("boundaries a repository declares", () => {
  it("finds one per subpath in an exports map", () => {
    const found = declaredBoundaries(
      files({
        "package.json": JSON.stringify({
          name: "pkg",
          exports: { ".": "./src/index.ts", "./codec": "./src/codec.ts" },
        }),
        "src/index.ts": "",
        "src/codec.ts": "",
      }),
    );

    expect(found.map((entry) => entry.identity)).toEqual(["pkg", "pkg/codec"]);
  });

  it("falls back to main when no exports map is declared", () => {
    const found = declaredBoundaries(
      files({
        "package.json": JSON.stringify({ name: "pkg", main: "./src/index.ts" }),
        "src/index.ts": "",
      }),
    );

    expect(found).toEqual([{ identity: "pkg", entry: "src/index.ts" }]);
  });

  it("ignores an unparseable manifest rather than inventing a boundary", () => {
    expect(declaredBoundaries(files({ "package.json": "{ not json" }))).toEqual(
      [],
    );
  });
});

describe("what a consumer can reach", () => {
  const MANIFEST = JSON.stringify({ name: "pkg", exports: "./src/index.ts" });

  it("counts names declared at the entry itself", () => {
    expect(
      reachable({ "package.json": MANIFEST, "src/index.ts": DECODE }, "pkg"),
    ).toEqual(["decode"]);
  });

  it("follows a named re-export to another file", () => {
    expect(
      reachable(
        {
          "package.json": MANIFEST,
          "src/index.ts": 'export { decode } from "./codec.js";',
          "src/codec.ts": DECODE,
        },
        "pkg",
      ),
    ).toEqual(["decode"]);
  });

  it("follows `export *` and records how the name arrived", () => {
    const surface = surfaceOf(
      {
        "package.json": MANIFEST,
        "src/index.ts": 'export * from "./codec.js";',
        "src/codec.ts": `${DECODE}\n${ENCODE}`,
      },
      "pkg",
    );

    expect(surface.reachableNames.map((entry) => entry.name)).toEqual([
      "decode",
      "encode",
    ]);
    expect(
      surface.reachableNames.every(
        (entry) => entry.provenance === "wholesale_reexport",
      ),
    ).toBe(true);
  });

  it("does not reach a module the entry never exposes", () => {
    // The distinction the whole capability rests on: existing in the
    // repository is not being reachable through the boundary.
    expect(
      reachable(
        {
          "package.json": MANIFEST,
          "src/index.ts": "export const version = 1;",
          "src/codec.ts": DECODE,
        },
        "pkg",
      ),
    ).toEqual(["version"]);
  });

  it("keeps subpaths separate", () => {
    const entries = {
      "package.json": JSON.stringify({
        name: "pkg",
        exports: { ".": "./src/index.ts", "./codec": "./src/codec.ts" },
      }),
      "src/index.ts": "export const version = 1;",
      "src/codec.ts": DECODE,
    };

    expect(reachable(entries, "pkg")).toEqual(["version"]);
    expect(reachable(entries, "pkg/codec")).toEqual(["decode"]);
  });
});

describe("completeness, because absence must be earned", () => {
  const MANIFEST = JSON.stringify({ name: "pkg", exports: "./src/index.ts" });

  it("is established when every path was followed", () => {
    expect(
      surfaceOf(
        {
          "package.json": MANIFEST,
          "src/index.ts": 'export * from "./codec.js";',
          "src/codec.ts": DECODE,
        },
        "pkg",
      ).completeness.kind,
    ).toBe("established");
  });

  it("is PARTIAL when an `export *` target was not supplied", () => {
    // The trail ran out. Whatever that file exports is unknown, so a name
    // missing from this surface has not been shown to be missing at all.
    const surface = surfaceOf(
      {
        "package.json": MANIFEST,
        "src/index.ts": 'export * from "./codec.js";',
      },
      "pkg",
    );

    expect(surface.completeness.kind).toBe("partial");
    expect(surface.reachableNames).toEqual([]);
  });

  it("is UNAVAILABLE when the entry file itself is absent", () => {
    const map = files({
      "package.json": JSON.stringify({ name: "pkg", exports: "./src/gone.ts" }),
    });
    const surface = boundarySurface(map, {
      identity: "pkg",
      entry: undefined,
    });

    expect(surface.completeness.kind).toBe("unavailable");
    expect(surface.reachableNames).toEqual([]);
  });

  it("does not confuse an empty surface with an unreadable one", () => {
    // Both have zero reachable names and they mean opposite things. One says
    // the boundary exposes nothing; the other says we could not find out.
    const empty = surfaceOf(
      { "package.json": MANIFEST, "src/index.ts": "const internal = 1;" },
      "pkg",
    );
    const unreadable = surfaceOf(
      {
        "package.json": MANIFEST,
        "src/index.ts": 'export * from "./missing.js";',
      },
      "pkg",
    );

    expect(empty.reachableNames).toEqual([]);
    expect(unreadable.reachableNames).toEqual([]);
    expect(empty.completeness.kind).toBe("empty");
    expect(unreadable.completeness.kind).toBe("partial");
  });

  it("degrades on a re-export cycle rather than reporting completeness", () => {
    // The walk stops, and stopping is not finishing. A cycle that returned
    // quietly would report an established surface built from a traversal that
    // gave up.
    const surface = surfaceOf(
      {
        "package.json": MANIFEST,
        "src/index.ts": 'export * from "./a.js";',
        "src/a.ts": 'export * from "./b.js";',
        "src/b.ts": 'export * from "./a.js";\nexport const shared = 1;',
      },
      "pkg",
    );

    expect(surface.completeness.kind).toBe("partial");
    // What it did establish is kept, not discarded.
    expect(surface.reachableNames.map((entry) => entry.name)).toContain(
      "shared",
    );
  });
});

describe("the case M.3.4 could not see", () => {
  it("loses a name when only the manifest changes", () => {
    // No source file differs between these two revisions. A module export-set
    // delta is empty by construction, which is exactly why the predecessor
    // proposed nothing.
    const source = {
      "src/codec.ts": DECODE,
      "src/index.ts": "export const version = 1;",
    };
    const base = {
      ...source,
      "package.json": JSON.stringify({
        name: "pkg",
        exports: { ".": "./src/index.ts", "./codec": "./src/codec.ts" },
      }),
    };
    const head = {
      ...source,
      "package.json": JSON.stringify({
        name: "pkg",
        exports: { ".": "./src/index.ts" },
      }),
    };

    expect(declaredBoundaries(files(base)).map((b) => b.identity)).toEqual([
      "pkg",
      "pkg/codec",
    ]);
    expect(declaredBoundaries(files(head)).map((b) => b.identity)).toEqual([
      "pkg",
    ]);

    // The boundary `pkg/codec` exposed `decode` and no longer exists at all.
    expect(reachable(base, "pkg/codec")).toEqual(["decode"]);
    expect(
      declaredBoundaries(files(head)).some((b) => b.identity === "pkg/codec"),
    ).toBe(false);
  });
});
