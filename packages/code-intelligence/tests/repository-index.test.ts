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
  isPersistable,
  isUsable,
  moduleAt,
  sameIndex,
  symbolNamed,
  extractFile,
  generateCandidates,
  scoreCandidates,
  unavailableIndex,
  type ContextCandidate,
  type RepositoryIndex,
  type RepositoryIndexIdentity,
} from "../src/index.js";
import { gitObjectId } from "@acalys/contracts/domain";

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);

function identityFor(revision: string): RepositoryIndexIdentity {
  return indexIdentity({
    tenant: { kind: "tenant", tenantId: "tenant-1" },
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

/**
 * An index holding one module record with the given identity fields.
 *
 * Stated over the record type rather than built from source: the builder
 * cannot currently produce a record whose `moduleId` and `path` differ, and
 * the digest's contract is over records anyway — L.3's incremental builder and
 * any future deserializer are other sources of them.
 */
function shaped(moduleId: string, path: string): RepositoryIndex {
  return {
    ...buildRepositoryIndex({
      identity: identityFor(REVISION_A),
      snapshot: new Map(),
    }),
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
  };
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
    expect(
      sameIndex(identity, {
        ...identity,
        tenant: { kind: "tenant", tenantId: "tenant-2" },
      }),
    ).toBe(false);
  });

  it("refuses to call an unscoped index persistable", () => {
    const scoped = identityFor(REVISION_A);
    const unscoped: RepositoryIndexIdentity = {
      ...scoped,
      tenant: { kind: "unscoped", why: "no caller supplied a tenant" },
    };

    expect(isPersistable(scoped)).toBe(true);
    expect(isPersistable(unscoped)).toBe(false);
  });

  it("shows why unscoped must never become a cache key", () => {
    // Two different tenants, everything else about the identity equal. Under
    // `unscoped` the tenant component distinguishes nothing, so these compare
    // equal — which is exactly the collision `"unknown"` as a tenant id would
    // have hidden behind a value that LOOKED like an identity.
    const base = identityFor(REVISION_A);
    const tenantA: RepositoryIndexIdentity = {
      ...base,
      tenant: { kind: "unscoped", why: "caller A supplied nothing" },
    };
    const tenantB: RepositoryIndexIdentity = {
      ...base,
      tenant: { kind: "unscoped", why: "caller B supplied nothing" },
    };

    expect(sameIndex(tenantA, tenantB)).toBe(true);
    // The collision is real; `isPersistable` is what stops it being acted on.
    expect(isPersistable(tenantA)).toBe(false);
  });

  it("separates a scoped identity from an unscoped one", () => {
    const scoped = identityFor(REVISION_A);
    expect(
      sameIndex(scoped, {
        ...scoped,
        tenant: { kind: "unscoped", why: "none" },
      }),
    ).toBe(false);
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

  it("treats merged interfaces as ONE exact symbol with two declarations", () => {
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

    const shapes = index.symbols.filter((symbol) => symbol.name === "Shape");
    const declarations = declarationsIn(index, "m.ts").filter(
      (record) => record.kind === "interface",
    );

    // TypeScript's declaration merging is ordinary, not uncertain. The checker
    // knows precisely which symbol this is; there are simply two places it was
    // written. Recording two symbols would invent one that nobody declared.
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.declarationCount).toBe(2);
    expect(declarations).toHaveLength(2);
    expect(new Set(declarations.map((record) => record.symbolId)).size).toBe(1);

    // And crucially NOT `ambiguous`. Spending that word on declaration
    // multiplicity would leave nothing to say when a reference genuinely
    // cannot be narrowed to one symbol — which is L.2's subject.
    expect(declarations.map((record) => record.resolution)).toEqual([
      "exact",
      "exact",
    ]);
  });

  it("counts a single declaration as one, not as merged", () => {
    const index = build({ "s.ts": "export interface Solo {\n  a: number;\n}" });
    expect(
      index.symbols.find((symbol) => symbol.name === "Solo")?.declarationCount,
    ).toBe(1);
  });

  it("keeps two same-named symbols in different scopes apart", () => {
    // The mirror of the merging case. These are two symbols the checker
    // distinguishes, and a name-and-module key would fuse them exactly as a
    // span key would split the merged interfaces above.
    const index = build({
      "scopes.ts": [
        "export function outer(): number {",
        "  function helper(): number {",
        "    return 1;",
        "  }",
        "  return helper();",
        "}",
        "export function other(): number {",
        "  function helper(): number {",
        "    return 2;",
        "  }",
        "  return helper();",
        "}",
      ].join("\n"),
    });

    const helpers = index.symbols.filter((symbol) => symbol.name === "helper");
    expect(helpers).toHaveLength(2);
    expect(new Set(helpers.map((symbol) => symbol.symbolId)).size).toBe(2);
    expect(helpers.every((symbol) => symbol.declarationCount === 1)).toBe(true);
  });

  it("does not reach `ambiguous` at a declaration site", () => {
    // Declared unreachable rather than left as a claim in prose. `ambiguous`
    // belongs to reference resolution — a reference that could denote more
    // than one symbol — and L.1 records no references. If L.2 makes this fail,
    // that is the vocabulary being used correctly, and this test is the place
    // to notice.
    const index = build({
      "a.ts": "export function f(): void {}",
      "b.ts": [
        "export interface Merged {",
        "  x: number;",
        "}",
        "export interface Merged {",
        "  y: number;",
        "}",
        'import type { Gone } from "./nowhere.js";',
        "export type Alias = Gone;",
      ].join("\n"),
    });

    expect(index.declarations.map((record) => record.resolution)).not.toContain(
      "ambiguous",
    );
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

  it("digests differently when the revision differs", () => {
    // Same content, different revision. The identity is in the preimage, so an
    // index for H1 cannot silently satisfy a question about H2.
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

  it("digests differently when the schema version differs", () => {
    const index = build(files);
    const restamped: RepositoryIndex = {
      ...index,
      identity: { ...index.identity, indexSchemaVersion: "v0" },
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
    if (first === undefined) throw new Error("no symbol");

    const withEmptyContainer: RepositoryIndex = {
      ...index,
      symbols: [{ ...first, container: "" }, ...rest],
    };

    // `container: undefined` and `container: ""` are different facts. A
    // serialization that wrote both as nothing would call two different
    // indexes equal.
    expect(indexDigest(index)).not.toBe(indexDigest(withEmptyContainer));
  });

  it("never lets two different field splits share a preimage", () => {
    // A boundary shift, not merely two different strings: `moduleId`/`path` of
    // ("ab", "c") against ("a", "bc"). Concatenated with no boundary marker
    // both render "abc", so the two indexes would digest equal.
    expect(indexDigest(shaped("ab", "c"))).not.toBe(
      indexDigest(shaped("a", "bc")),
    );
  });

  it("is unambiguous for values containing the encoding's own delimiter", () => {
    // Length prefixing rather than a separator, so a value holding `:` — or a
    // value that looks exactly like an encoded field — changes nothing. A
    // delimiter scheme is a bet that no input ever contains the delimiter, and
    // these fields hold paths, symbol names, and compiler diagnostic text.
    expect(indexDigest(shaped("a:b", "c"))).not.toBe(
      indexDigest(shaped("a", "b:c")),
    );
    expect(indexDigest(shaped("3:xyz", "q"))).not.toBe(
      indexDigest(shaped("3", ":xyzq")),
    );
  });

  it("distinguishes an absent optional field from one holding the sentinel", () => {
    // Absence is written outside the value alphabet. A printable sentinel
    // would mean a `container` whose literal text equals the sentinel digests
    // as no container at all — the same bug one level down.
    const base = build({ "c.ts": "export function c(): void {}" });
    const [symbol, ...rest] = base.symbols;
    if (symbol === undefined) throw new Error("no symbol");

    const absent: RepositoryIndex = { ...base, symbols: [symbol, ...rest] };
    const sentinel: RepositoryIndex = {
      ...base,
      symbols: [{ ...symbol, container: "-:" }, ...rest],
    };
    const tilde: RepositoryIndex = {
      ...base,
      symbols: [{ ...symbol, container: "~" }, ...rest],
    };

    expect(symbol.container).toBeUndefined();
    expect(indexDigest(absent)).not.toBe(indexDigest(sentinel));
    expect(indexDigest(absent)).not.toBe(indexDigest(tilde));
    expect(indexDigest(sentinel)).not.toBe(indexDigest(tilde));
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

// ---------------------------------------------------------------------------
// Representation precedence
// ---------------------------------------------------------------------------

describe("an indexed representation dominates an equivalent syntactic one", () => {
  const files = {
    "src/local.ts": [
      "export function run(value: number): number {",
      "  return value + 1;",
      "}",
    ].join("\n"),
  };
  const changed = [{ path: "src/local.ts", changedLines: [2] }];

  const plannerInput = (index?: RepositoryIndex) => ({
    changed: changed.map((entry) => ({
      path: entry.path,
      content: files[entry.path as keyof typeof files],
      changedLines: entry.changedLines,
    })),
    repository: Object.entries(files).map(([path, source]) =>
      extractFile(path, source),
    ),
    sources: new Map(Object.entries(files)),
    ...(index === undefined ? {} : { index }),
  });

  /** Every representation offered for one source span. */
  const forSpan = (candidates: readonly ContextCandidate[]) =>
    candidates.filter(
      (candidate) =>
        candidate.path === "src/local.ts" && candidate.startLine === 1,
    );

  it("offers both representations before scoring decides", () => {
    // Generation stays generous; precedence is a scoring rule, applied in one
    // place. If generation quietly dropped one, the rule below would be
    // untestable and a traversal change could reverse it unnoticed.
    const offered = forSpan(generateCandidates(plannerInput(build(files))));

    expect(offered.map((candidate) => candidate.reason).sort()).toEqual([
      "containing_symbol",
      "indexed_declaration",
    ]);
  });

  it("keeps the indexed one when it is generated second", () => {
    const kept = forSpan(
      scoreCandidates(generateCandidates(plannerInput(build(files)))),
    );

    expect(kept).toHaveLength(1);
    expect(kept[0]?.provenance?.source).toBe("repository_index");
  });

  it("keeps the indexed one when it is generated first", () => {
    // The same candidates, reversed. Precedence must be a property of the
    // rule, not of the order the planner happened to emit them in — otherwise
    // a refactor of traversal silently flips which fact reaches the analyzer.
    const reversed = [
      ...generateCandidates(plannerInput(build(files))),
    ].reverse();
    const kept = forSpan(scoreCandidates(reversed));

    expect(kept).toHaveLength(1);
    expect(kept[0]?.provenance?.source).toBe("repository_index");
  });

  it("keeps the syntactic one when there is no index at all", () => {
    const kept = forSpan(scoreCandidates(generateCandidates(plannerInput())));

    expect(kept).toHaveLength(1);
    expect(kept[0]?.reason).toBe("containing_symbol");
  });

  it("keeps the syntactic one when the index is unavailable", () => {
    // An incomplete index must cost the richer fact, never the context. The
    // rule is "indexed dominates when positively established" — not "whenever
    // an index object exists".
    const kept = forSpan(
      scoreCandidates(
        generateCandidates(
          plannerInput(
            unavailableIndex(identityFor(REVISION_A), {
              kind: "unavailable",
              why: "clone failed",
            }),
          ),
        ),
      ),
    );

    expect(kept).toHaveLength(1);
    expect(kept[0]?.reason).toBe("containing_symbol");
  });

  it("ignores records carried by an index that failed its invariants", () => {
    // The previous test cannot make this assertion, and a surviving mutation
    // said so: `unavailableIndex` holds no records, so `declarationAt` returns
    // nothing whether or not availability is consulted. Deleting the
    // usability check was therefore invisible.
    //
    // This is the state that distinguishes them — records present, and the
    // index declared unusable. It is reachable: a build can populate records
    // and then fail a consistency check, and `IndexAvailability` exists
    // precisely so that outcome has somewhere to be recorded.
    const populated = build(files);
    expect(populated.declarations.length).toBeGreaterThan(0);

    const failed: RepositoryIndex = {
      ...populated,
      availability: {
        kind: "invariant_failed",
        why: "declaration spans disagreed with module content digests",
      },
    };

    const kept = forSpan(
      scoreCandidates(generateCandidates(plannerInput(failed))),
    );

    expect(kept).toHaveLength(1);
    // Facts from an index that failed its own invariants must not be presented
    // to the analyzer as though they were established.
    expect(kept[0]?.reason).toBe("containing_symbol");
    expect(kept[0]?.provenance?.source).toBe("direct_source");
  });

  it("keeps the syntactic one when the module failed to parse", () => {
    // `not_indexed`, one level up. The index is usable, this module is not,
    // and the planner must still hand the analyzer the function.
    const brokenIndex = build({
      ...files,
      "src/other.ts": "export function oops( {",
    });
    const withBrokenModule = buildRepositoryIndex({
      identity: identityFor(REVISION_A),
      snapshot: new Map([["src/local.ts", "export function run( {"]]),
    });

    expect(moduleAt(withBrokenModule, "src/local.ts")?.coverage).toBe(
      "parse_failed",
    );
    expect(isUsable(brokenIndex)).toBe(true);

    const kept = forSpan(
      scoreCandidates(generateCandidates(plannerInput(withBrokenModule))),
    );

    expect(kept).toHaveLength(1);
    expect(kept[0]?.reason).toBe("containing_symbol");
  });
});
