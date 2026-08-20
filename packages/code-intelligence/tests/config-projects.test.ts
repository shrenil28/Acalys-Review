/**
 * P1-L.4.2 (Agent B) — compiler-backed project facts.
 *
 * The claim under test:
 *
 * > For a tsconfig path and a revision snapshot, `readProjectConfigs` reports
 * > exactly what `ts.parseJsonConfigFileContent` establishes — which files a
 * > project admits, which are literally named in `files`, its own direct
 * > `extends` target, and its `references` — and reports "could not
 * > determine" rather than an invented answer when the compiler itself
 * > cannot say.
 *
 * # Why these fixtures, not simpler ones
 *
 * Invariant 7: a fixture is only worth having if a broken implementation
 * would produce a *plausible wrong answer*, not silence. Three places here
 * are shaped for that specifically:
 *
 * - the `include` fixture puts a real, indexed file outside the pattern
 *   rather than nothing at all, so "not admitted" is a claim about a file
 *   that exists, not an artifact of an empty snapshot;
 * - the two-level `extends` chain (`pkg -> base-a -> base-b`) is worthless
 *   at one level — any implementation reports the direct parent correctly
 *   when there is nothing else to confuse it with. Two levels is the
 *   smallest fixture where "direct parent" and "root of the chain" disagree;
 * - the malformed-config fixture is asserted by discriminant
 *   (`availability.kind`), not by array length, because a broken
 *   implementation that returns `{ kind: "available", admittedFiles: [] }`
 *   would pass a length-only assertion while reporting an invented fact
 *   about a config nobody could read (invariant 10).
 */

import { describe, expect, it } from "vitest";

import {
  readProjectConfigs,
  type ProjectConfigFact,
} from "../src/repository-index/config-projects.js";
import type { RevisionSnapshot } from "../src/repository-index/build.js";

function snapshotOf(files: Record<string, string>): RevisionSnapshot {
  return new Map(Object.entries(files));
}

function factFor(
  facts: readonly ProjectConfigFact[],
  configPath: string,
): ProjectConfigFact {
  const fact = facts.find((candidate) => candidate.configPath === configPath);
  if (fact === undefined) {
    throw new Error(`no fact produced for ${configPath}`);
  }
  return fact;
}

describe("readProjectConfigs — include/exclude membership", () => {
  const snapshot = snapshotOf({
    "pkg/tsconfig.json": JSON.stringify({
      include: ["src/**/*.ts"],
      exclude: ["src/excluded/**"],
    }),
    "pkg/src/admitted.ts": "export const admitted = 1;",
    "pkg/src/excluded/skipped.ts": "export const skipped = 1;",
    "pkg/other/outside.ts": "export const outside = 1;",
  });

  it("admits the matching file and not the others — which are real, indexed input", () => {
    // Premise: the files this project must NOT admit actually exist in the
    // snapshot. If they were simply absent, "not admitted" would be a fact
    // about an empty input rather than about the compiler's `include` rule.
    expect(snapshot.has("pkg/src/excluded/skipped.ts")).toBe(true);
    expect(snapshot.has("pkg/other/outside.ts")).toBe(true);

    const [fact] = readProjectConfigs(snapshot, ["pkg/tsconfig.json"], "rev");
    expect(fact?.availability.kind).toBe("available");
    expect(fact?.admittedFiles).toContain("pkg/src/admitted.ts");
    expect(fact?.admittedFiles).not.toContain("pkg/src/excluded/skipped.ts");
    expect(fact?.admittedFiles).not.toContain("pkg/other/outside.ts");
  });
});

describe("readProjectConfigs — files vs admittedFiles", () => {
  const snapshot = snapshotOf({
    "pkg/tsconfig.json": JSON.stringify({
      files: ["src/a.ts", "src/b.ts"],
    }),
    "pkg/src/a.ts": "export const a = 1;",
    "pkg/src/b.ts": "export const b = 1;",
  });

  it("reports namedInFiles exactly, resolved relative to the config", () => {
    const [fact] = readProjectConfigs(snapshot, ["pkg/tsconfig.json"], "rev");
    expect(fact?.availability.kind).toBe("available");
    expect(fact?.namedInFiles).toEqual(["pkg/src/a.ts", "pkg/src/b.ts"]);
    // files entries are always part of what the project admits — the two
    // fields answer different questions about an overlapping set, not
    // disjoint ones.
    expect(fact?.admittedFiles).toEqual(
      expect.arrayContaining([...(fact?.namedInFiles ?? [])]),
    );
  });
});

describe("readProjectConfigs — a malformed config is unavailable, not empty", () => {
  const snapshot = snapshotOf({
    "pkg/tsconfig.json": "{ this is not valid JSON",
  });

  it("reports unavailable by discriminant, not by an empty admittedFiles", () => {
    const [fact] = readProjectConfigs(snapshot, ["pkg/tsconfig.json"], "rev");
    // The discriminant is the assertion that actually distinguishes this
    // from a working project admitting nothing. A broken implementation
    // that swallowed the parse failure and returned
    // `{ kind: "available", admittedFiles: [] }` fails here, not on some
    // later check of array contents.
    expect(fact?.availability.kind).toBe("unavailable");
    if (fact?.availability.kind === "unavailable") {
      expect(fact.availability.failure).toBe("config_unparsable");
    }
    expect(fact?.admittedFiles).toEqual([]);
  });
});

describe("readProjectConfigs — a config absent from the snapshot", () => {
  const snapshot = snapshotOf({});

  it("reports unavailable with config_absent, distinct from a parse failure", () => {
    const [fact] = readProjectConfigs(snapshot, ["pkg/tsconfig.json"], "rev");
    expect(fact?.availability.kind).toBe("unavailable");
    if (fact?.availability.kind === "unavailable") {
      expect(fact.availability.failure).toBe("config_absent");
    }
  });
});

describe("readProjectConfigs — extends reports the direct parent only", () => {
  const snapshot = snapshotOf({
    "pkg/tsconfig.json": JSON.stringify({
      extends: "../base-a/tsconfig.json",
      include: ["src/**/*.ts"],
    }),
    "base-a/tsconfig.json": JSON.stringify({
      extends: "../base-b/tsconfig.json",
    }),
    "base-b/tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true },
    }),
    "pkg/src/a.ts": "export const a = 1;",
  });

  it("for a two-level chain, extendsPath is base-a, never base-b", () => {
    const facts = readProjectConfigs(
      snapshot,
      ["pkg/tsconfig.json", "base-a/tsconfig.json", "base-b/tsconfig.json"],
      "rev",
    );

    // Premise: both bases in the chain are themselves readable configs, so
    // "direct parent only" is a claim this test can actually distinguish
    // from "the chain broke partway and we only saw one link".
    expect(factFor(facts, "base-a/tsconfig.json").availability.kind).toBe(
      "available",
    );
    expect(factFor(facts, "base-b/tsconfig.json").availability.kind).toBe(
      "available",
    );

    const pkg = factFor(facts, "pkg/tsconfig.json");
    expect(pkg.availability.kind).toBe("available");
    expect(pkg.extendsPath).toBe("base-a/tsconfig.json");
    expect(pkg.extendsPath).not.toBe("base-b/tsconfig.json");
  });
});

describe("readProjectConfigs — references are not extends", () => {
  const snapshot = snapshotOf({
    "pkg/tsconfig.json": JSON.stringify({
      extends: "../base/tsconfig.json",
      references: [{ path: "../other" }],
      include: ["src/**/*.ts"],
    }),
    "base/tsconfig.json": JSON.stringify({}),
    "other/tsconfig.json": JSON.stringify({}),
    "pkg/src/a.ts": "export const a = 1;",
  });

  it("reports the reference and keeps it out of extendsPath", () => {
    const [fact] = readProjectConfigs(snapshot, ["pkg/tsconfig.json"], "rev");
    expect(fact?.availability.kind).toBe("available");
    expect(fact?.extendsPath).toBe("base/tsconfig.json");
    expect(fact?.referencedProjects).toEqual(["other/tsconfig.json"]);
    // The edge this checkpoint exists to keep separate: a project reference
    // must never be readable back out of the extends field, or vice versa.
    expect(fact?.referencedProjects).not.toContain(fact?.extendsPath);
  });
});

describe("readProjectConfigs — unresolved extends preserves qualified membership", () => {
  it("keeps explicit files membership while marking inherited options incomplete", () => {
    const snapshot = snapshotOf({
      "pkg/tsconfig.json": JSON.stringify({
        extends: "./missing-base.json",
        files: ["src/a.ts"],
      }),
      "pkg/src/a.ts": "export const a = 1;",
    });

    const [fact] = readProjectConfigs(snapshot, ["pkg/tsconfig.json"], "rev");

    expect(fact?.availability.kind).toBe("available");
    expect(fact?.admittedFiles).toContain("pkg/src/a.ts");
    expect(fact?.coverage).toEqual({
      membership: "complete",
      optionInheritance: "incomplete",
    });
    expect(fact?.extendsPath).toBeUndefined();
  });

  it("keeps explicit include membership while marking inherited options incomplete", () => {
    const snapshot = snapshotOf({
      "pkg/tsconfig.json": JSON.stringify({
        extends: "./missing-base.json",
        include: ["src/**/*.ts"],
      }),
      "pkg/src/a.ts": "export const a = 1;",
    });

    const [fact] = readProjectConfigs(snapshot, ["pkg/tsconfig.json"], "rev");

    expect(fact?.availability.kind).toBe("available");
    expect(fact?.admittedFiles).toContain("pkg/src/a.ts");
    expect(fact?.coverage?.membership).toBe("complete");
    expect(fact?.coverage?.optionInheritance).toBe("incomplete");
  });

  it("does not claim complete membership when selectors may come from the missing base", () => {
    const snapshot = snapshotOf({
      "pkg/tsconfig.json": JSON.stringify({
        extends: "./missing-base.json",
      }),
      "pkg/src/a.ts": "export const a = 1;",
    });

    const [fact] = readProjectConfigs(snapshot, ["pkg/tsconfig.json"], "rev");

    expect(fact?.availability.kind).toBe("available");
    expect(fact?.coverage).toEqual({
      membership: "incomplete",
      optionInheritance: "incomplete",
    });
  });
});
