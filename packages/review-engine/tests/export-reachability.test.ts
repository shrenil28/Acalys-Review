/**
 * P1-M.3.4 verifier mechanism, plus the supersession it owes M.3.1.
 *
 * Retiring a capability is only legitimate if the replacement subsumes every
 * result the old one defended. Gate condition 5 guards the two L.5 baseline
 * true positives and nothing else, so each M.3.1 result is re-proved here by
 * name rather than left to aggregate recall.
 */

import { describe, expect, it } from "vitest";

import {
  EXPORT_REACHABILITY_CODES,
  resolvePublicBoundary,
  verifyExportReachability,
} from "../src/verification/export-reachability.js";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const MODULE = "src/codec.ts";
const DECODE =
  "export function decode(raw: string): string {\n  return raw;\n}";

const check = (
  base: Record<string, string>,
  head: Record<string, string>,
  namespace: "value" | "type" = "value",
) =>
  verifyExportReachability(
    { declarationPath: MODULE, exportName: "decode", namespace },
    { baseFiles: files(base), headFiles: files(head) },
  );

describe("the removals M.3.1 could not detect", () => {
  it("VERIFIES a name simply gone from the module", () => {
    // The defect the old capability was named for and did not find: no head
    // statement mentions `decode` at all.
    expect(
      check(
        { [MODULE]: DECODE },
        { [MODULE]: "export function other(): void {}" },
      ).kind,
    ).toBe("verified");
  });

  it("VERIFIES a name dropped from an export list", () => {
    expect(
      check(
        {
          [MODULE]:
            "function decode(r: string): string {\n  return r;\n}\nfunction encode(r: string): string {\n  return r;\n}\nexport { decode, encode };",
        },
        {
          [MODULE]:
            "function decode(r: string): string {\n  return r;\n}\nfunction encode(r: string): string {\n  return r;\n}\nexport { encode };",
        },
      ).kind,
    ).toBe("verified");
  });
});

describe("supersession — every M.3.1 result still holds", () => {
  it("still VERIFIES the alias rename it was built for", () => {
    // The historical case. Losing this to retire M.3.1 would trade one defect
    // for another.
    expect(
      check(
        { [MODULE]: DECODE },
        {
          [MODULE]:
            "function decode(raw: string): string {\n  return raw;\n}\nexport { decode as decodeInternal };",
        },
      ).kind,
    ).toBe("verified");
  });

  it("still REJECTS a declaration moved behind a named re-export", () => {
    expect(
      check(
        { [MODULE]: DECODE },
        { [MODULE]: 'export { decode } from "./impl";', "src/impl.ts": DECODE },
      ).kind,
    ).toBe("rejected");
  });

  it("still REJECTS a declaration moved behind `export *`", () => {
    expect(
      check(
        { [MODULE]: DECODE },
        { [MODULE]: 'export * from "./impl";', "src/impl.ts": DECODE },
      ).kind,
    ).toBe("rejected");
  });

  it("still REJECTS an internal rename behind a public alias", () => {
    expect(
      check(
        { [MODULE]: DECODE },
        {
          [MODULE]:
            "function decodeImpl(raw: string): string {\n  return raw;\n}\nexport { decodeImpl as decode };",
        },
      ).kind,
    ).toBe("rejected");
  });

  it("still does not fabricate a removal for a reachable type export", () => {
    const TYPES = "src/types.ts";
    expect(
      verifyExportReachability(
        { declarationPath: TYPES, exportName: "Config", namespace: "type" },
        {
          baseFiles: files({ [TYPES]: "export type Config = { a: string };" }),
          headFiles: files({
            [TYPES]: "export type Config = { a: string; b?: number };",
          }),
        },
      ).kind,
    ).toBe("rejected");
  });

  it("still requires the base probe to be valid", () => {
    expect(
      check(
        { [MODULE]: "export function other(): void {}" },
        { [MODULE]: "export function other(): void {}" },
      ).kind,
    ).toBe("inconclusive");
  });
});

describe("reachability is judged at the declared entry point", () => {
  const MANIFEST = '{"name":"pkg","exports":"./src/index.ts"}';
  const ENTRY = "src/index.ts";

  it("resolves the boundary from a package manifest", () => {
    expect(
      resolvePublicBoundary(
        files({ "package.json": MANIFEST, [ENTRY]: "", [MODULE]: "" }),
        MODULE,
      ),
    ).toBe(ENTRY);
  });

  it("falls back to the module when nothing declares an entry", () => {
    expect(resolvePublicBoundary(files({ [MODULE]: "" }), MODULE)).toBe(MODULE);
  });

  it("VERIFIES when the entry stops exposing a name the module still exports", () => {
    // Epoch 2's warning, as a test. The declaration survives and `src/codec.ts`
    // still exports it — but consumers import the entry point, and it no
    // longer passes the name through.
    expect(
      check(
        {
          "package.json": MANIFEST,
          [ENTRY]: 'export { decode } from "./codec.js";',
          [MODULE]: DECODE,
        },
        {
          "package.json": MANIFEST,
          [ENTRY]: "export const version = 1;",
          [MODULE]: DECODE,
        },
      ).kind,
    ).toBe("verified");
  });

  it("REJECTS when the entry still passes the name through", () => {
    // The converse, so the assertion above cannot pass by ignoring entries.
    expect(
      check(
        {
          "package.json": MANIFEST,
          [ENTRY]: 'export { decode } from "./codec.js";',
          [MODULE]: DECODE,
        },
        {
          "package.json": MANIFEST,
          [ENTRY]: 'export * from "./codec.js";',
          [MODULE]: DECODE,
        },
      ).kind,
    ).toBe("rejected");
  });

  it("ignores an unparseable manifest rather than guessing an entry", () => {
    expect(
      resolvePublicBoundary(
        files({ "package.json": "{ not json", [MODULE]: "" }),
        MODULE,
      ),
    ).toBe(MODULE);
  });
});

describe("what cannot be established is not decided", () => {
  it("is INCONCLUSIVE when the boundary is absent from the head snapshot", () => {
    expect(check({ [MODULE]: DECODE }, {}).kind).toBe("inconclusive");
  });
});

describe("the recognised diagnostics, pinned", () => {
  it("includes TS2724, the suggestion variant M.3.1 never encountered", () => {
    // A name dropped from an export list beside its siblings produces 2724,
    // not 2305, because TypeScript offers the sibling as a suggestion. M.3.1
    // could not detect that shape at all, so its empirical premise never met
    // the code — the gap only appeared once the capability could reach the
    // case.
    expect([...EXPORT_REACHABILITY_CODES].sort()).toEqual([
      2305, 2459, 2460, 2724,
    ]);
  });

  it("still excludes TS2307 and TS2693", () => {
    // Unchanged reasoning: an absent module is indistinguishable from an
    // incomplete snapshot, and a value probe against a type-only export
    // reports a fact about the probe.
    expect(EXPORT_REACHABILITY_CODES.has(2307)).toBe(false);
    expect(EXPORT_REACHABILITY_CODES.has(2693)).toBe(false);
  });
});

describe("only probe-local, recognised diagnostics establish anything", () => {
  // Migrated with the capability when `removed_export` retired. The property
  // is unchanged: HEAD may be broken in ways that have nothing to do with this
  // claim, and a verifier that read any diagnostic — or counted them — would
  // report a compatibility break every time the branch happened to be red.

  it("ignores an unrelated error elsewhere in the head revision", () => {
    expect(
      check(
        { [MODULE]: DECODE },
        {
          [MODULE]: DECODE,
          "src/unrelated.ts": 'export const broken: number = "not a number";',
        },
      ).kind,
    ).toBe("rejected");
  });

  it("ignores an unrelated error inside the boundary itself", () => {
    expect(
      check(
        { [MODULE]: DECODE },
        { [MODULE]: `${DECODE}\nexport const wrong: number = "no";` },
      ).kind,
    ).toBe("rejected");
  });

  it("does not treat an unrecognised probe diagnostic as a loss", () => {
    // A value export that became type-only. The base-shaped value probe now
    // produces TS2693 — a real diagnostic, at the probe, of a code this
    // capability does not recognise. The name is still exported, so value/type
    // migration is a different proposition with its own evidence, and it stays
    // a frozen exclusion rather than something the diagnostic filter widens
    // into.
    expect(
      verifyExportReachability(
        { declarationPath: MODULE, exportName: "Config", namespace: "value" },
        {
          baseFiles: files({ [MODULE]: "export const Config = { a: 1 };" }),
          headFiles: files({ [MODULE]: "export type Config = { a: number };" }),
        },
      ).kind,
    ).toBe("rejected");
  });
});
