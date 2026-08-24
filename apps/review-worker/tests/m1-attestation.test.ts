/**
 * Conditions 8 and 9 become derivable instead of relayed.
 *
 * Epoch 4 passed condition 8 for a capability with zero mutations targeting its
 * source. Nothing was falsified — the number simply arrived as prose someone
 * had assembled, and no machinery could contradict it. These tests read the
 * real mutation manifest and check the attestations against it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { M1_CAPABILITY_ATTESTATIONS } from "../src/eval/m1-attestation.js";
import { attestationsForGate, evaluateM1Gate } from "../src/eval/m1-gate.js";

const ROOT = join(import.meta.dirname, "../../..");
const MANIFEST = readFileSync(join(ROOT, "scripts/mutate-p1i.mjs"), "utf8");

/** Every mutation in the shipped manifest, as id -> target file. */
function manifestTargets(): ReadonlyMap<number, string> {
  const targets = new Map<number, string>();
  for (const match of MANIFEST.matchAll(/\n {4}id: (\d+),/g)) {
    const start = match.index;
    const block = MANIFEST.slice(start, MANIFEST.indexOf("\n  },", start));
    const file = /file:\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
    if (file !== undefined) targets.set(Number(match[1]), file);
  }
  return targets;
}

const TARGETS = manifestTargets();

describe("the manifest is readable at all", () => {
  it("parses a plausible number of mutations", () => {
    // Without this every assertion below could pass vacuously against an empty
    // map — the shape of failure invariant 11 exists for.
    expect(TARGETS.size).toBeGreaterThan(200);
  });
});

describe.each(
  M1_CAPABILITY_ATTESTATIONS.map((entry) => [entry.capability, entry] as const),
)("%s", (_name, attestation) => {
  it("declares a production witness that exists", () => {
    expect(() =>
      readFileSync(join(ROOT, attestation.productionWitness), "utf8"),
    ).not.toThrow();
  });

  it("declares source files that exist", () => {
    for (const file of attestation.sourceFiles) {
      expect(() => readFileSync(join(ROOT, file), "utf8")).not.toThrow();
    }
  });

  it("names only mutations the manifest actually contains", () => {
    const missing = attestation.semanticMutationIds.filter(
      (id) => !TARGETS.has(id),
    );
    expect(missing).toEqual([]);
  });

  it("declares registration mutations against the production registry", () => {
    // A different guarantee from the capability's semantics, kept in its own
    // field so it cannot pad the count that condition 8 reads.
    for (const id of attestation.registrationMutationIds) {
      expect(TARGETS.get(id)).toBe("apps/review-worker/src/analysis.ts");
    }
  });

  it("names only mutations that target its own source", () => {
    // The check that would have caught Epoch 4's relay. A capability cannot
    // borrow another's mutations to satisfy condition 8.
    const foreign = attestation.semanticMutationIds.filter((id) => {
      const target = TARGETS.get(id);
      return target === undefined || !attestation.sourceFiles.includes(target);
    });
    expect(foreign).toEqual([]);
  });
});

describe("condition 8, derived rather than asserted", () => {
  it("reports which capabilities have no mutation coverage", () => {
    const uncovered = M1_CAPABILITY_ATTESTATIONS.filter(
      (entry) => entry.semanticMutationIds.length === 0,
    ).map((entry) => entry.capability);

    // Pinned as a known, recorded gap rather than hidden. Epoch 4 exposed it:
    // M.3.5's proposal layer shipped with a hardcoded line-1 anchor and no
    // mutation targeting the module that contains it. When that is repaired
    // this list shrinks, and the change is visible in a diff instead of in
    // someone's summary.
    expect(uncovered).toEqual(["public_boundary_reachability_proposal"]);
  });

  it("every other capability carries at least three", () => {
    for (const entry of M1_CAPABILITY_ATTESTATIONS) {
      if (entry.semanticMutationIds.length === 0) continue;
      expect(entry.semanticMutationIds.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("the gate reads the record rather than a supplied number", () => {
  it("fails condition 8 for the capability with no mutation coverage", () => {
    // The end-to-end point of this file. Epoch 4 reported condition 8 as PASS
    // while `public_boundary_reachability_proposal` had zero mutations; built
    // from the record, the same condition fails and names it.
    const verdict = evaluateM1Gate({
      historical: {
        planted: 12,
        publishedTruePositives: 6,
        publishedFalsePositives: 0,
      },
      development: {
        planted: 8,
        publishedTruePositives: 3,
        publishedFalsePositives: 0,
      },
      holdout: {
        planted: 8,
        publishedTruePositives: 1,
        publishedFalsePositives: 1,
      },
      historicalTruePositiveIds: [
        "binding-floating-reservation",
        "interaction-binding-and-test-delivery",
      ],
      naturalFalsePositivesReplayed: 1,
      naturalFalsePositivesPublished: 0,
      verifier: { expectedDefectOutcomes: [], inconclusive: 3, unavailable: 0 },
      capabilities: attestationsForGate(M1_CAPABILITY_ATTESTATIONS),
    });

    expect(verdict.failing).toContain(8);
    expect(
      verdict.conditions.find((condition) => condition.id === 8)?.observed,
    ).toContain("public_boundary_reachability_proposal");
  });
});
