/**
 * P1-L.1 — mechanism witness.
 *
 * These prove the facts are correct. They do not prove anything is integrated:
 * that is `apps/review-worker/tests/index-wiring.test.ts`, and the two are
 * separate on purpose. P1-K closed once on a central claim that was false
 * while its `lib/` layer had 52 green tests, because "the mechanism works" and
 * "production uses it" were never distinguished.
 */

import { describe, expect, it } from "vitest";

import {
  buildRepositoryIndex,
  canonicalSerialization,
  citeDeclaration,
  declarationAt,
  declarationsIn,
  indexDigest,
  indexIdentity,
  isUsable,
  moduleAt,
  sameIndex,
  symbolNamed,
  unavailableIndex,
  type RepositoryIndex,
  type RepositoryIndexIdentity,
} from "../src/index.js";
import { gitObjectId } from "@acalys/contracts/domain";

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);

function identityFor(revision: string): RepositoryIndexIdentity {
  return indexIdentity({
    tenantId: "tenant-1",
    provider: "github",
    repositoryId: "repo-1",
    revision: gitObjectId(revision),
  });
}

function build(
  files: Record<string, string>,
  revision = REVISION_A,
): RepositoryIndex {
  return buildRepositoryIndex({
    identity: identityFor(revision),
    snapshot: new Map(Object.entries(files)),
  });
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("index identity", () => {
  it("carries the revision, so two revisions are two indexes", () => {
    const a = identityFor(REVISION_A);
    const b = identityFor(REVISION_B);

    expect(a.revision.value).toBe(REVISION_A);
    expect(sameIndex(a, b)).toBe(false);
  });

  it("carries the schema and extractor versions", () => {
    const identity = identityFor(REVISION_A);
    expect(identity.indexSchemaVersion).toBe("acalys.repository-index.v1");
    expect(identity.extractorVersion).toBe("acalys.extractor.typescript.v1");
  });

  it("distinguishes indexes built by different extractors", () => {
    const identity = identityFor(REVISION_A);
    // A cached artifact from an older extractor is not the index today's code
    // would build, and must not be able to answer for it.
    expect(
      sameIndex(identity, {
        ...identity,
        extractorVersion: "acalys.extractor.typescript.v0",
      }),
    ).toBe(false);
    expect(
      sameIndex(identity, {
        ...identity,
        indexSchemaVersion: "acalys.repository-index.v0",
      }),
    ).toBe(false);
  });

  it("distinguishes two tenants indexing the same public revision", () => {
    const identity = identityFor(REVISION_A);
    expect(sameIndex(identity, { ...identity, tenantId: "tenant-2" })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The adversarial fixture — the reason a checker is used at all
// ---------------------------------------------------------------------------

describe("same name, different declarations", () => {
  const files = {
    "a.ts": [
      "export function save(): Promise<void> {",
      "  return Promise.resolve();",
      "}",
    ].join("\n"),
    "b.ts": [
      "function save(): number {",
      "  return 1;",
      "}",
      "export function useLocal(): number {",
      "  return save();",
      "}",
    ].join("\n"),
  };

  it("records two distinct symbols, not one merged by name", () => {
    const index = build(files);
    const named = index.symbols.filter((symbol) => symbol.name === "save");

    expect(named).toHaveLength(2);
    // Distinct identities, and distinct modules. A name-matching extractor
    // produces one record here, and every downstream fact about "save" then
    // describes a function that may not be the one under review.
    expect(new Set(named.map((symbol) => symbol.symbolId)).size).toBe(2);
    expect(named.map((symbol) => symbol.moduleId).sort()).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("keeps the exported and the local one apart", () => {
    const index = build(files);
    const exported = index.symbols.find(
      (symbol) => symbol.name === "save" && symbol.moduleId === "a.ts",
    );
    const local = index.symbols.find(
      (symbol) => symbol.name === "save" && symbol.moduleId === "b.ts",
    );

    expect(exported?.exported).toBe(true);
    expect(local?.exported).toBe(false);
  });

  it("answers 'which save is at this line' per module", () => {
    const index = build(files);

    const inA = declarationAt(index, "a.ts", 2);
    const inB = declarationAt(index, "b.ts", 2);

    expect(inA?.moduleId).toBe("a.ts");
    expect(inB?.moduleId).toBe("b.ts");
    expect(inA?.declarationId).not.toBe(inB?.declarationId);
  });

  it("picks the innermost declaration when they nest", () => {
    const index = build({
      "n.ts": [
        "export class Outer {",
        "  inner(): number {",
        "    return 1;",
        "  }",
        "}",
      ].join("\n"),
    });

    const found = declarationAt(index, "n.ts", 3);
    // Both the class and the method contain line 3. The method is the one a
    // reviewer needs; the class is the file.
    expect(found?.kind).toBe("method");
  });
});

// ---------------------------------------------------------------------------
// Resolution semantics
// ---------------------------------------------------------------------------

describe("resolution does not collapse", () => {
  it("marks an unambiguous local declaration exact", () => {
    const index = build({
      "x.ts": "export function only(): void {}",
    });
    expect(declarationsIn(index, "x.ts")[0]?.resolution).toBe("exact");
  });

  it("marks a merged declaration ambiguous rather than picking one", () => {
    const index = build({
      "m.ts": [
        "export interface Shape {",
        "  a: number;",
        "}",
        "export interface Shape {",
        "  b: number;",
        "}",
      ].join("\n"),
    });

    const resolutions = declarationsIn(index, "m.ts")
      .filter((record) => record.kind === "interface")
      .map((record) => record.resolution);

    // Two declarations of one symbol. Reporting either as `exact` would claim
    // a single site for a fact that has two.
    expect(resolutions).toEqual(["ambiguous", "ambiguous"]);
  });

  it("never reports an unresolvable declaration as absent", () => {
    // `Missing` is imported from a module that is not in the snapshot. The
    // declaration that uses it is still a real declaration.
    const index = build({
      "u.ts": [
        'import type { Missing } from "./nowhere.js";',
        "export type Alias = Missing;",
      ].join("\n"),
    });

    const alias = symbolNamed(index, "u.ts", "Alias");
    expect(alias.kind).toBe("found");
    // The distinction the vocabulary exists for: we could not resolve the
    // import, which is not the same claim as "there is no such type".
    expect([
      ...new Set(index.declarations.map((d) => d.resolution)),
    ]).not.toContain(undefined);
  });
});

// ---------------------------------------------------------------------------
// Coverage: absence is a claim
// ---------------------------------------------------------------------------

describe("indexing failure never masquerades as factual absence", () => {
  const broken = {
    "good.ts": "export function fine(): void {}",
    "broken.ts": "export function oops( {",
  };

  it("records a parse failure as coverage, not as an empty module", () => {
    const index = build(broken);
    const record = moduleAt(index, "broken.ts");

    expect(record?.coverage).toBe("parse_failed");
    expect(record?.coverageDetail).toContain("incomplete");
  });

  it("answers not_indexed, never absent, for a module that failed", () => {
    const index = build(broken);
    const lookup = symbolNamed(index, "broken.ts", "oops");

    expect(lookup.kind).toBe("not_indexed");
    if (lookup.kind === "not_indexed") {
      expect(lookup.coverage).toBe("parse_failed");
    }
  });

  it("answers absent for a module that WAS indexed and lacks the symbol", () => {
    const index = build(broken);
    const lookup = symbolNamed(index, "good.ts", "notThere");

    // The other half of the same distinction. If both answers were `absent`,
    // a caller could not tell a real absence from our own outage; if both were
    // `not_indexed`, the index could never support a negative claim at all.
    expect(lookup.kind).toBe("absent");
  });

  it("answers not_indexed for a module nobody ever offered", () => {
    const index = build(broken);
    expect(symbolNamed(index, "never-seen.ts", "x").kind).toBe("not_indexed");
  });

  it("classifies an unsupported language rather than skipping it", () => {
    const index = build({
      "a.ts": "export function fine(): void {}",
      "script.py": "def fine(): pass",
    });

    const python = moduleAt(index, "script.py");
    expect(python?.coverage).toBe("unsupported_language");
    // Supported means correct; unsupported means explicit. A Python file that
    // simply vanished would leave the index quietly claiming the repository is
    // all TypeScript.
    expect(index.coverage.modulesUnsupported).toBe(1);
  });

  it("distinguishes an unavailable index from an empty one", () => {
    const empty = build({});
    const unavailable = unavailableIndex(identityFor(REVISION_A), {
      kind: "unavailable",
      why: "clone failed",
    });

    expect(empty.modules).toHaveLength(0);
    expect(unavailable.modules).toHaveLength(0);
    // Identical by record count, and they must not be identical to a caller.
    expect(isUsable(empty)).toBe(true);
    expect(isUsable(unavailable)).toBe(false);
    expect(indexDigest(empty)).not.toBe(indexDigest(unavailable));
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("module role is a fact, not a verdict", () => {
  it("separates production, test, configuration and generated", () => {
    const index = build({
      "src/thing.ts": "export function thing(): void {}",
      "tests/thing.test.ts": "export function spec(): void {}",
      "vite.config.ts": "export default {};",
      "src/gen.ts": "// @generated\nexport const x = 1;",
    });

    const roles = Object.fromEntries(
      index.modules.map((module) => [module.path, module.role]),
    );

    expect(roles["src/thing.ts"]).toBe("production");
    expect(roles["tests/thing.test.ts"]).toBe("test");
    expect(roles["vite.config.ts"]).toBe("configuration");
    expect(roles["src/gen.ts"]).toBe("generated");
  });

  it("indexes production-looking code even where nothing reaches it", () => {
    // `indexed != production reachable`. If the index silently dropped
    // unreachable code, the index and the reachability census could hide each
    // other's defects — one would have no record to contradict the other.
    const index = build({
      "src/orphan.ts": "export function nobodyCalls(): void {}",
    });

    expect(moduleAt(index, "src/orphan.ts")?.coverage).toBe("indexed");
    expect(moduleAt(index, "src/orphan.ts")?.role).toBe("production");
    expect(symbolNamed(index, "src/orphan.ts", "nobodyCalls").kind).toBe(
      "found",
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism and the digest
// ---------------------------------------------------------------------------

describe("the full rebuild is deterministic", () => {
  const files = {
    "z.ts": "export function z(): void {}",
    "a.ts": "export function a(): void {}",
    "m.ts": "export class M {\n  go(): void {}\n}",
  };

  it("produces identical records on repeated builds", () => {
    expect(build(files)).toEqual(build(files));
  });

  it("digests identically regardless of snapshot insertion order", () => {
    const forward = new Map(Object.entries(files));
    const reversed = new Map([...Object.entries(files)].reverse());

    const a = buildRepositoryIndex({
      identity: identityFor(REVISION_A),
      snapshot: forward,
    });
    const b = buildRepositoryIndex({
      identity: identityFor(REVISION_A),
      snapshot: reversed,
    });

    // Weak on its own — see the next test. The builder walks a sorted key
    // list, so this would hold even with every canonical sort deleted.
    expect(indexDigest(a)).toBe(indexDigest(b));
    expect(canonicalSerialization(a)).toBe(canonicalSerialization(b));
  });

  it("digests a record SET, not the array order it arrived in", () => {
    const index = build(files);
    const scrambled: RepositoryIndex = {
      ...index,
      modules: [...index.modules].reverse(),
      symbols: [...index.symbols].reverse(),
      declarations: [...index.declarations].reverse(),
    };

    // The assertion the previous test cannot make. Feeding the same records in
    // a different array order is the only way to observe whether canonical
    // form is actually being applied: the builder happens to walk a sorted key
    // list, so a build-order test passes with every sort deleted.
    //
    // This is the property L.3 needs. An incremental build will produce
    // records in whatever order invalidation visited them, and if the digest
    // followed that order the equivalence oracle would report a mismatch on
    // two indexes that are equal.
    expect(indexDigest(scrambled)).toBe(indexDigest(index));
    expect(canonicalSerialization(scrambled)).toBe(
      canonicalSerialization(index),
    );
  });

  it("never lets two different field splits share a preimage", () => {
    // A boundary shift, not merely two different strings: `moduleId`/`path` of
    // ("ab", "c") against ("a", "bc"). Concatenated with no separator both
    // render "abc", so the two indexes would digest equal.
    //
    // The builder cannot currently produce a record whose moduleId and path
    // differ, so this is stated over the record type directly — which is the
    // right level anyway. The digest's contract is over records, and L.3's
    // incremental builder and any future deserializer are other sources of
    // them.
    const base = build({});
    const shape = (moduleId: string, path: string): RepositoryIndex => ({
      ...base,
      modules: [
        {
          moduleId,
          path,
          language: "typescript",
          role: "production",
          coverage: "indexed",
          contentDigest: "0".repeat(64),
        },
      ],
    });

    expect(indexDigest(shape("ab", "c"))).not.toBe(
      indexDigest(shape("a", "bc")),
    );
  });

  it("digests differently when the revision differs", () => {
    // Same content, different revision. The identity is in the preimage, so
    // an index for H1 cannot silently satisfy a question about H2.
    expect(indexDigest(build(files, REVISION_A))).not.toBe(
      indexDigest(build(files, REVISION_B)),
    );
  });

  it("digests differently when the extractor version differs", () => {
    const index = build(files);
    const restamped: RepositoryIndex = {
      ...index,
      identity: { ...index.identity, extractorVersion: "acalys.extractor.v0" },
    };
    expect(indexDigest(index)).not.toBe(indexDigest(restamped));
  });

  it("digests differently when a single fact changes", () => {
    const changed = indexDigest(
      build({
        ...files,
        "a.ts": "export function a(): number {\n  return 1;\n}",
      }),
    );
    expect(changed).not.toBe(indexDigest(build(files)));
  });

  it("distinguishes an absent optional field from an empty one", () => {
    const index = build(files);
    const [first, ...rest] = index.symbols;
    expect(first).toBeDefined();
    if (first === undefined) return;

    const withEmptyContainer: RepositoryIndex = {
      ...index,
      symbols: [{ ...first, container: "" }, ...rest],
    };

    // `container: undefined` and `container: ""` are different facts. A
    // serialization that wrote both as nothing would call two different
    // indexes equal.
    expect(indexDigest(index)).not.toBe(indexDigest(withEmptyContainer));
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("provenance is part of the fact", () => {
  it("names the revision, span, source and extractor", () => {
    const index = build({ "p.ts": "export function p(): void {}" });
    const declaration = declarationsIn(index, "p.ts")[0];

    expect(declaration).toBeDefined();
    if (declaration === undefined) return;

    expect(declaration.provenance).toMatchObject({
      source: "typescript_checker",
      path: "p.ts",
      revision: REVISION_A,
      extractorVersion: "acalys.extractor.typescript.v1",
    });
  });

  it("renders a citation that can be checked by hand", () => {
    const index = build({ "p.ts": "export function p(): void {}" });
    const declaration = declarationsIn(index, "p.ts")[0];
    if (declaration === undefined) throw new Error("no declaration");

    const citation = citeDeclaration(declaration);
    // Everything needed to go and look, so downstream evidence never reduces
    // to "the index says so".
    expect(citation).toContain("p.ts:1-1");
    expect(citation).toContain("typescript_checker");
    expect(citation).toContain(REVISION_A.slice(0, 12));
  });
});

// ---------------------------------------------------------------------------
// The boundary the index must not cross
// ---------------------------------------------------------------------------

describe("the index holds facts, never verdicts", () => {
  it("stores no analysis conclusion on any record", () => {
    const index = build({
      "s.ts": [
        "export async function risky(): Promise<void> {",
        "  return;",
        "}",
      ].join("\n"),
    });

    const forbidden = [
      "isBuggy",
      "riskScore",
      "likelyAsyncBug",
      "importantSymbol",
      "severity",
      "shouldFlag",
      "confidence",
    ];

    // Structural rather than a promise in a comment. If the analyzer and the
    // verifier could both ask the index to settle the contested question,
    // their two independent opinions would become one opinion consulted twice.
    const keys = new Set<string>();
    for (const record of [
      ...index.modules,
      ...index.symbols,
      ...index.declarations,
    ]) {
      for (const key of Object.keys(record)) keys.add(key);
    }

    for (const name of forbidden) {
      expect([...keys], `index records must not carry ${name}`).not.toContain(
        name,
      );
    }
  });
});
