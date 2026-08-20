/**
 * P1-L.3 — the equivalence oracle.
 *
 * One equation, and everything else here serves it:
 *
 * ```
 * canonical(full(H2)) == canonical(incremental(full(H1), H1 -> H2))
 * ```
 *
 * Not approximately. Not "the same number of records". Not "the same answers
 * to the queries our fixtures happen to ask". The same canonical factual
 * index, byte for byte in the digest preimage.
 *
 * # Why the change table is semantic rather than "edit a file"
 *
 * Under-invalidation does not usually delete a fact — it *keeps* one. So a
 * fixture whose failure mode is "no record found" tests the easy direction.
 * The cases below are chosen so that a stale H1 fact would remain plausible:
 * a retargeted import still resolves, to the wrong module; a removed shadow
 * still binds, to the wrong symbol. Inadequate invalidation produces a
 * confidently wrong answer rather than an absence, which is the failure worth
 * catching (invariant 7).
 */

import { describe, expect, it } from "vitest";
import { gitObjectId } from "@acalys/contracts/domain";

import {
  buildRepositoryIndex,
  canonicalSerialization,
  deriveChangeManifest,
  indexDigest,
  indexIdentity,
  planIncrementalUpdate,
  unavailableIndex,
  updateFromSnapshot,
  updateRepositoryIndex,
  validateIndexConsistency,
  type RepositoryIndex,
  type RepositoryIndexIdentity,
} from "../src/index.js";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

function identityFor(revision: string): RepositoryIndexIdentity {
  return indexIdentity({
    tenant: { kind: "tenant", tenantId: "tenant-1" },
    provider: "github",
    repositoryId: "repo-1",
    revision: gitObjectId(revision),
  });
}

const full = (files: Record<string, string>, revision: string) =>
  buildRepositoryIndex({
    identity: identityFor(revision),
    snapshot: new Map(Object.entries(files)),
  });

/**
 * The whole oracle, applied to one edit.
 *
 * Digest equality is the assertion; the canonical serialization is compared
 * too so a failure says *which line* differs rather than only that two hashes
 * do. A digest alone cannot be debugged.
 */
function assertEquivalent(
  before: Record<string, string>,
  after: Record<string, string>,
): {
  readonly incremental: RepositoryIndex;
  readonly retained: number;
  readonly succeeded: boolean;
} {
  const h1 = full(before, H1);
  const expected = full(after, H2);

  const outcome = updateFromSnapshot(
    h1,
    gitObjectId(H2),
    new Map(Object.entries(after)),
  );

  // Asserted BEFORE equivalence, because equivalence is trivially true when
  // the incremental path quietly falls back to a full rebuild. Without this
  // line every test below would keep passing after the optimization stopped
  // existing — the oracle would be measuring the thing it replaced.
  expect(
    outcome.stats.succeeded,
    `fell back to a full rebuild: ${outcome.stats.fallbackReason ?? "?"} — ${outcome.stats.fallbackDetail ?? ""}`,
  ).toBe(true);

  expect(canonicalSerialization(outcome.index)).toBe(
    canonicalSerialization(expected),
  );
  expect(indexDigest(outcome.index)).toBe(indexDigest(expected));

  return {
    incremental: outcome.index,
    retained: outcome.stats.modulesRetained,
    succeeded: outcome.stats.succeeded,
  };
}

// ---------------------------------------------------------------------------
// The semantic change table
// ---------------------------------------------------------------------------

const BASE = {
  "store.ts": [
    "export function save(value: number): number {",
    "  return value + 1;",
    "}",
    "export function load(): number {",
    "  return 0;",
    "}",
  ].join("\n"),
  "other.ts": [
    "export function save(value: number): number {",
    "  return value + 2;",
    "}",
  ].join("\n"),
  "run.ts": [
    'import { save } from "./store.js";',
    "",
    "export function run(value: number): number {",
    "  return save(value);",
    "}",
  ].join("\n"),
  "quiet.ts": ["export const NOTHING = 1;"].join("\n"),
};

describe("full and incremental agree across semantic changes", () => {
  it("1. a function body changes", () => {
    assertEquivalent(BASE, {
      ...BASE,
      "store.ts": BASE["store.ts"].replace("value + 1", "value + 41"),
    });
  });

  it("2. a declaration is renamed", () => {
    assertEquivalent(BASE, {
      ...BASE,
      "store.ts": BASE["store.ts"].replace(
        "export function load()",
        "export function reload()",
      ),
    });
  });

  it("3. a declaration moves within its file", () => {
    assertEquivalent(BASE, {
      ...BASE,
      "store.ts": [
        "export function load(): number {",
        "  return 0;",
        "}",
        "export function save(value: number): number {",
        "  return value + 1;",
        "}",
      ].join("\n"),
    });
  });

  it("4. a declaration moves to another module", () => {
    assertEquivalent(BASE, {
      ...BASE,
      "store.ts": [
        "export function save(value: number): number {",
        "  return value + 1;",
        "}",
      ].join("\n"),
      "moved.ts": ["export function load(): number {", "  return 0;", "}"].join(
        "\n",
      ),
    });
  });

  it("5. a declaration is deleted", () => {
    assertEquivalent(BASE, {
      ...BASE,
      "store.ts": [
        "export function save(value: number): number {",
        "  return value + 1;",
        "}",
      ].join("\n"),
    });
  });

  it("6. a declaration is added", () => {
    assertEquivalent(BASE, {
      ...BASE,
      "store.ts": `${BASE["store.ts"]}\nexport function extra(): void {}`,
    });
  });

  it("7. exported becomes non-exported", () => {
    assertEquivalent(BASE, {
      ...BASE,
      "store.ts": BASE["store.ts"].replace(
        "export function load()",
        "function load()",
      ),
    });
  });

  it("8. an import gains an alias", () => {
    assertEquivalent(BASE, {
      ...BASE,
      "run.ts": BASE["run.ts"]
        .replace("import { save }", "import { save as persist }")
        .replace("return save(value)", "return persist(value)"),
    });
  });

  it("9. an import is retargeted to another module", () => {
    // The stale fact is plausible: `save` still resolves, to the wrong module.
    // Under-invalidation here does not lose a binding, it keeps a wrong one.
    const after = {
      ...BASE,
      "run.ts": BASE["run.ts"].replace('"./store.js"', '"./other.js"'),
    };
    const { incremental } = assertEquivalent(BASE, after);

    const target = incremental.bindings
      .filter((edge) => edge.declarationIds.length > 0)
      .flatMap((edge) =>
        edge.declarationIds.map(
          (id) =>
            incremental.declarations.find(
              (record) => record.declarationId === id,
            )?.moduleId,
        ),
      );
    expect(target).toContain("other.ts");
    expect(target).not.toContain("store.ts");
  });

  it("10. local shadowing is introduced", () => {
    // The H1 binding pointed at store.ts and remains a real declaration. A
    // stale answer is confidently wrong rather than absent.
    assertEquivalent(BASE, {
      ...BASE,
      "run.ts": [
        'import { save } from "./store.js";',
        "",
        "export function run(save: (v: number) => number): number {",
        "  return save(value(1));",
        "}",
        "function value(v: number): number {",
        "  return v;",
        "}",
      ].join("\n"),
    });
  });

  it("11. local shadowing is removed", () => {
    const shadowed = {
      ...BASE,
      "run.ts": [
        'import { save } from "./store.js";',
        "",
        "export function run(save: (v: number) => number): number {",
        "  return save(1);",
        "}",
      ].join("\n"),
    };
    assertEquivalent(shadowed, BASE);
  });

  it("12. a merged interface gains a declaration", () => {
    const before = {
      ...BASE,
      "shapes.ts": ["export interface Shape {", "  a: number;", "}"].join("\n"),
    };
    assertEquivalent(before, {
      ...before,
      "shapes.ts": [
        "export interface Shape {",
        "  a: number;",
        "}",
        "export interface Shape {",
        "  b: number;",
        "}",
      ].join("\n"),
    });
  });

  it("13. a merged interface loses a declaration", () => {
    const before = {
      ...BASE,
      "shapes.ts": [
        "export interface Shape {",
        "  a: number;",
        "}",
        "export interface Shape {",
        "  b: number;",
        "}",
      ].join("\n"),
    };
    assertEquivalent(before, {
      ...before,
      "shapes.ts": ["export interface Shape {", "  a: number;", "}"].join("\n"),
    });
  });

  it("14. a source file is deleted", () => {
    const after = { ...BASE };
    delete (after as Record<string, string>)["other.ts"];
    assertEquivalent(BASE, after);
  });

  it("15. a source file is added", () => {
    assertEquivalent(BASE, {
      ...BASE,
      "fresh.ts": "export function fresh(): void {}",
    });
  });

  it("16. an unindexable module becomes valid", () => {
    const before = { ...BASE, "broken.ts": "export function oops( {" };
    assertEquivalent(before, {
      ...before,
      "broken.ts": "export function oops(): void {}",
    });
  });

  it("17. a valid module becomes unindexable", () => {
    const before = { ...BASE, "fine.ts": "export function fine(): void {}" };
    assertEquivalent(before, {
      ...before,
      "fine.ts": "export function fine( {",
    });
  });

  it("18. an unsupported file appears beside the source", () => {
    assertEquivalent(BASE, { ...BASE, "notes.md": "# hello" });
  });

  it("19. nothing changes at all", () => {
    // The identity case, and the one where retention should be maximal. Note
    // the digests still differ between H1 and H2 because the revision is part
    // of the identity — which is L.1's rule, restated where it would be most
    // tempting to break it.
    const { retained, succeeded } = assertEquivalent(BASE, BASE);
    expect(succeeded).toBe(true);
    expect(retained).toBeGreaterThan(0);
    expect(indexDigest(full(BASE, H1))).not.toBe(indexDigest(full(BASE, H2)));
  });
});

// ---------------------------------------------------------------------------
// The planner, on its own
// ---------------------------------------------------------------------------

describe("the invalidation plan is conservative in the safe direction", () => {
  const h1 = full(BASE, H1);

  const planFor = (after: Record<string, string>) =>
    planIncrementalUpdate(
      h1,
      deriveChangeManifest(h1, gitObjectId(H2), new Map(Object.entries(after))),
    );

  it("recomputes a module that binds into a changed one", () => {
    // run.ts is byte-identical. Content equality is the intuitive retention
    // rule and is wrong: run.ts records a BINDING into store.ts, and a binding
    // is a fact about two modules.
    const plan = planFor({
      ...BASE,
      "store.ts": BASE["store.ts"].replace("value + 1", "value + 41"),
    });

    expect(plan.retained).not.toContain("run.ts");
    expect(
      plan.recomputed.find((entry) => entry.moduleId === "run.ts")?.reason,
    ).toBe("references_changed_module");
  });

  it("retains a module that depends on nothing that moved", () => {
    const plan = planFor({
      ...BASE,
      "store.ts": BASE["store.ts"].replace("value + 1", "value + 41"),
    });

    expect(plan.retained).toContain("quiet.ts");
  });

  it("derives the manifest from content, not from a caller's word", () => {
    const manifest = deriveChangeManifest(
      h1,
      gitObjectId(H2),
      new Map(
        Object.entries({
          ...BASE,
          "store.ts": BASE["store.ts"].replace("value + 1", "value + 41"),
        }),
      ),
    );

    expect(manifest.modified).toEqual(["store.ts"]);
    expect(manifest.added).toEqual([]);
    expect(manifest.removed).toEqual([]);
  });

  it("never retains a module that failed to parse at H1", () => {
    const withBroken = full(
      { ...BASE, "broken.ts": "export function x( {" },
      H1,
    );
    const plan = planIncrementalUpdate(
      withBroken,
      deriveChangeManifest(
        withBroken,
        gitObjectId(H2),
        new Map(
          Object.entries({ ...BASE, "broken.ts": "export function x( {" }),
        ),
      ),
    );

    // Its facts are incomplete by construction. Carrying them forward would
    // make an indexing failure permanent until somebody happened to edit the
    // file.
    expect(plan.retained).not.toContain("broken.ts");
    expect(
      plan.recomputed.find((entry) => entry.moduleId === "broken.ts")?.reason,
    ).toBe("not_indexed_previously");
  });
});

// ---------------------------------------------------------------------------
// Cases the first change table could not reach
// ---------------------------------------------------------------------------
//
// Each of these was added because a mutation survived: the table exercised the
// code but not the decision. Recorded rather than quietly folded in, because
// "the mutation found a missing test" is the gate working.

describe("invalidation covers the cases a plain edit does not reach", () => {
  it("recomputes a module whose unresolved reference becomes resolvable", () => {
    // At H1 `helper` binds to nothing. At H2 a file declares it, and the
    // reference resolves — without the module itself changing a byte.
    //
    // This is the purest under-invalidation trap in the set: retention rules
    // keyed on content equality and on outgoing dependencies both say "retain",
    // because an unresolved reference has no dependency to point at. The stale
    // fact that survives is "nothing declares this", which reads as a finding.
    const before = {
      "uses.ts": [
        "export function use(): number {",
        "  return helper();",
        "}",
      ].join("\n"),
    };
    // A GLOBAL declaration, not an exported one. The first version of this
    // fixture added `export function helper()` in a new module — and under
    // ESM every file is its own scope, so `helper` in uses.ts stayed
    // unresolved at H2. The fact never changed, so nothing could detect a
    // mutation that retained the module. A script file (no import, no export)
    // declares into the global scope, which is what actually makes the
    // reference resolve.
    const after = {
      ...before,
      "helper.d.ts": "declare function helper(): number;",
    };

    assertEquivalent(before, after);
  });

  it("recomputes together the modules that share one merged symbol", () => {
    // Ambient declarations merge across files, so one symbol can be declared
    // in two modules. Retaining one while recomputing the other splits it into
    // halves carrying different revision-stamped identities.
    const before = {
      "a.d.ts": [
        "declare global {",
        "  interface Registry {",
        "    a: number;",
        "  }",
        "}",
        "export {};",
      ].join("\n"),
      "b.d.ts": [
        "declare global {",
        "  interface Registry {",
        "    b: number;",
        "  }",
        "}",
        "export {};",
      ].join("\n"),
      "quiet.ts": "export const X = 1;",
    };

    assertEquivalent(before, {
      ...before,
      "a.d.ts": before["a.d.ts"].replace("a: number;", "a: string;"),
    });
  });
});

describe("the incremental path refuses rather than guesses", () => {
  const h1 = full(BASE, H1);

  it("falls back when the previous index is not usable", () => {
    // An index that failed to build describes an outage, not a repository. Its
    // emptiness must never be read as "nothing was there to change".
    const broken = unavailableIndex(identityFor(H1), {
      kind: "unavailable",
      why: "clone failed",
    });

    const outcome = updateRepositoryIndex({
      previous: broken,
      nextIdentity: identityFor(H2),
      snapshot: new Map(Object.entries(BASE)),
    });

    expect(outcome.stats.succeeded).toBe(false);
    expect(outcome.stats.fallbackReason).toBe("previous_index_unusable");
    // And the fallback still produces the right answer — incremental is an
    // optimization, so refusing it costs time and never correctness.
    expect(indexDigest(outcome.index)).toBe(indexDigest(full(BASE, H2)));
  });

  it("falls back when the manifest spans different revisions", () => {
    const outcome = updateRepositoryIndex({
      previous: h1,
      nextIdentity: identityFor(H2),
      snapshot: new Map(Object.entries(BASE)),
      manifest: {
        previousRevision: gitObjectId("9".repeat(40)),
        nextRevision: gitObjectId(H2),
        added: [],
        removed: [],
        modified: [],
      },
    });

    expect(outcome.stats.succeeded).toBe(false);
    expect(outcome.stats.fallbackReason).toBe("revision_mismatch");
    expect(indexDigest(outcome.index)).toBe(indexDigest(full(BASE, H2)));
  });

  it("never reports a fallback as an incremental success", () => {
    // The economics question — does this save work? — is unanswerable if a
    // full rebuild can be recorded as a win. `attempted` and `succeeded` are
    // separate fields precisely so the answer cannot drift.
    const outcome = updateRepositoryIndex({
      previous: unavailableIndex(identityFor(H1), {
        kind: "unavailable",
        why: "clone failed",
      }),
      nextIdentity: identityFor(H2),
      snapshot: new Map(Object.entries(BASE)),
    });

    expect(outcome.stats.attempted).toBe(true);
    expect(outcome.stats.succeeded).toBe(false);
    expect(outcome.stats.modulesRetained).toBe(0);
  });
});

describe("the stats describe the work that was actually skipped", () => {
  it("does not count a deleted module as retained", () => {
    // Retention is what the economics report will read as "work avoided". A
    // module that no longer exists was not retained — nothing was carried
    // forward — and counting it would overstate the saving with a number
    // nobody would think to check.
    const h1 = full(BASE, H1);
    const after = { ...BASE };
    delete (after as Record<string, string>)["other.ts"];

    const outcome = updateFromSnapshot(
      h1,
      gitObjectId(H2),
      new Map(Object.entries(after)),
    );

    expect(outcome.stats.succeeded).toBe(true);
    expect(outcome.stats.modulesDeleted).toBe(1);
    expect(outcome.plan?.retained).not.toContain("other.ts");
    expect(outcome.stats.modulesRetained).toBe(
      outcome.plan?.retained.length ?? -1,
    );
  });
});

// ---------------------------------------------------------------------------
// The commit barrier, from the production path
// ---------------------------------------------------------------------------

describe("no H2 index escapes before its candidate is validated", () => {
  it("refuses a corrupt candidate and leaves H1 untouched", () => {
    // The invariant this exists for:
    //
    //   an index carrying revision H2 is never observable before the entire
    //   H2 candidate has passed consistency validation.
    //
    // Driven through `updateRepositoryIndex` rather than by calling the
    // validator, because the question is whether the PRODUCTION path refuses —
    // validator unit tests are in index-consistency.test.ts and prove a
    // different thing.
    //
    // The corruption is introduced where a real planner defect would put it:
    // a previous index whose retained binding claims `exact` while naming a
    // declaration that will not exist at H2.
    const h1 = full(BASE, H1);
    const target = h1.bindings.find(
      (edge) => edge.resolution === "exact" && edge.declarationIds.length > 0,
    );
    expect(target).toBeDefined();
    if (target === undefined) return;

    const corrupted: RepositoryIndex = {
      ...h1,
      bindings: h1.bindings.map((edge) =>
        edge.bindingId === target.bindingId
          ? { ...edge, declarationIds: ["a-declaration-that-never-existed"] }
          : edge,
      ),
    };

    const before = indexDigest(corrupted);

    const outcome = updateRepositoryIndex({
      previous: corrupted,
      nextIdentity: identityFor(H2),
      snapshot: new Map(Object.entries(BASE)),
    });

    // H1 is not mutated. The updater builds a fresh candidate and never writes
    // into what it was given.
    expect(indexDigest(corrupted)).toBe(before);

    // And whatever comes back is a complete, correct H2 — either the candidate
    // passed, or the fallback rebuilt it. What must never come back is a
    // half-H1 half-H2 object wearing an H2 label.
    expect(outcome.index.identity.revision.value).toBe(H2);
    expect(indexDigest(outcome.index)).toBe(indexDigest(full(BASE, H2)));
    expect(validateIndexConsistency(outcome.index)).toBeUndefined();
  });

  it("names the violated rule when it falls back on validation", () => {
    // A caller that only learns "it failed" cannot tell a planner bug from a
    // corrupt input. The rule name travels with the fallback.
    const h1 = full(BASE, H1);
    const reference = h1.references[0];
    if (reference === undefined) throw new Error("no reference");

    // Drop one binding, leaving its reference unbound — a violation the
    // assembly carries forward rather than repairing.
    const corrupted: RepositoryIndex = {
      ...h1,
      bindings: h1.bindings.filter(
        (edge) => edge.referenceId !== reference.referenceId,
      ),
    };

    const outcome = updateRepositoryIndex({
      previous: corrupted,
      nextIdentity: identityFor(H2),
      snapshot: new Map(Object.entries(BASE)),
    });

    if (outcome.stats.succeeded) {
      // The assembly repaired it, which is also a legitimate outcome — but
      // then the result must be genuinely correct rather than merely accepted.
      expect(indexDigest(outcome.index)).toBe(indexDigest(full(BASE, H2)));
      return;
    }

    expect(outcome.stats.fallbackReason).toBe("candidate_failed_validation");
    expect(outcome.stats.fallbackDetail).toMatch(/^[a-z_]+: /);
  });
});

describe("the statistics describe what executed", () => {
  it("reports recompute reasons rather than two counters that must add up", () => {
    const h1 = full(BASE, H1);
    const outcome = updateFromSnapshot(
      h1,
      gitObjectId(H2),
      new Map(
        Object.entries({
          ...BASE,
          "store.ts": BASE["store.ts"].replace("value + 1", "value + 41"),
        }),
      ),
    );

    expect(outcome.stats.succeeded).toBe(true);
    // store.ts changed directly; run.ts because it binds into store.ts. Two
    // different reasons, reported as reasons rather than forced into
    // categories that have to sum to a total.
    expect(outcome.stats.recomputeReasons["modified"]).toBe(1);
    expect(outcome.stats.recomputeReasons["references_changed_module"]).toBe(1);
  });

  it("counts references and bindings actually re-extracted, not planned", () => {
    const h1 = full(BASE, H1);
    const outcome = updateFromSnapshot(
      h1,
      gitObjectId(H2),
      new Map(Object.entries(BASE)),
    );

    expect(outcome.stats.succeeded).toBe(true);
    // Nothing changed, so nothing was re-extracted and everything was carried.
    // If these were derived from the plan they could not show that.
    expect(outcome.stats.referencesRecomputed).toBe(0);
    expect(outcome.stats.bindingsRecomputed).toBe(0);
    expect(outcome.stats.referencesRetained).toBe(h1.references.length);
    expect(outcome.stats.bindingsRetained).toBe(h1.bindings.length);
  });

  it("counts extraction work, not the module count or the result size", () => {
    // The case the test above cannot make. There, every plausible wrong
    // formula — recomputed module count, zero, the plan's length — is also 0,
    // so a mutation swapping one for another survived it.
    //
    // Here the three numbers are pairwise different, which is what lets an
    // assertion tell them apart at all.
    const h1 = full(BASE, H1);
    const outcome = updateFromSnapshot(
      h1,
      gitObjectId(H2),
      new Map(
        Object.entries({
          ...BASE,
          "store.ts": BASE["store.ts"].replace("value + 1", "value + 41"),
        }),
      ),
    );

    expect(outcome.stats.succeeded).toBe(true);

    const recomputedModules = outcome.stats.modulesRecomputed;
    const resultTotal = outcome.index.references.length;
    const work = outcome.stats.referencesRecomputed;

    // Work performed is neither "how many modules" nor "how many records
    // exist". A counter reporting either would be lying about what the
    // optimization saved, and the lie would read as a plausible number.
    expect(work).toBeGreaterThan(0);
    expect(work).not.toBe(recomputedModules);
    expect(work).not.toBe(resultTotal);

    // And the result is the sum of what was re-extracted and what was carried,
    // which is the identity that makes `work` interpretable at all.
    expect(work + outcome.stats.referencesRetained).toBe(resultTotal);
    expect(
      outcome.stats.bindingsRecomputed + outcome.stats.bindingsRetained,
    ).toBe(outcome.index.bindings.length);
  });

  it("reports no saving when it fell back", () => {
    const outcome = updateRepositoryIndex({
      previous: unavailableIndex(identityFor(H1), {
        kind: "unavailable",
        why: "clone failed",
      }),
      nextIdentity: identityFor(H2),
      snapshot: new Map(Object.entries(BASE)),
    });

    expect(outcome.stats.succeeded).toBe(false);
    expect(outcome.stats.referencesRetained).toBe(0);
    expect(outcome.stats.bindingsRetained).toBe(0);
  });
});
