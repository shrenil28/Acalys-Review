/**
 * P1-M.3.0 — the guards that keep base revision out of the L.5 baseline.
 *
 * `f7b49af` is the immutable P1-L quality baseline. It measured a reviewer
 * that had no base revision input at all. The danger is not that a base-aware
 * run would score worse — it is that it would score in the SAME vocabulary and
 * be compared as though the two runs measured the same thing.
 *
 * These are cheap tests for an expensive mistake: a silently incomparable
 * comparison is not visible in any number it produces.
 */

import { describe, expect, it } from "vitest";

import {
  assertPlannerFamilyNamesRemainCompatible,
  checkFamilyCompatibility,
  plannerAvailabilityForMode,
} from "../src/eval/l5-production.js";
import { L5_MODES } from "../src/eval/l5-run.js";
import {
  InvalidL5ContextObservationError,
  factFamilyFor,
} from "@acalys/code-intelligence/eval";

describe("every L.5 mode pins base revision off", () => {
  it.each(Object.values(L5_MODES).map((mode) => [mode.id, mode] as const))(
    "%s",
    (_id, mode) => {
      expect(plannerAvailabilityForMode(mode).base_revision).toBe(false);
    },
  );

  it("includes the full-treatment mode, which is the one that would drift", () => {
    // TREATMENT is the mode every ablation is measured against. If a new fact
    // family switched on here, every L.5 ablation delta would be computed
    // against a treatment the frozen baseline never ran.
    expect(plannerAvailabilityForMode(L5_MODES.TREATMENT).base_revision).toBe(
      false,
    );
  });
});

describe("the L.5 fact-family vocabulary refuses base revision", () => {
  it("throws rather than mapping it into a frozen family", () => {
    expect(() => factFamilyFor("base_revision", "base_revision_facts")).toThrow(
      InvalidL5ContextObservationError,
    );
  });

  it("says why, naming the baseline", () => {
    expect(() => factFamilyFor("base_revision", "base_revision_facts")).toThrow(
      /f7b49af/,
    );
  });

  it("refuses the provenance even under a familiar reason", () => {
    // The dangerous shape is a base revision wearing a reason L.5 recognises.
    expect(() => factFamilyFor("changed_hunk", "base_revision_facts")).toThrow(
      InvalidL5ContextObservationError,
    );
  });

  it("still maps the families the baseline did have", () => {
    // The guard must not have broken the vocabulary it is protecting.
    expect(factFamilyFor("configuration", "configuration_facts")).toBe(
      "config_governance",
    );
    expect(factFamilyFor("indexed_declaration", "repository_index")).toBe(
      "structural_index",
    );
    expect(factFamilyFor("changed_hunk", "direct_source")).toBe("none");
  });
});

describe("the planner/L.5 family containment guard", () => {
  const BASELINE = ["structural_index", "binding"];

  it("accepts a production family that is declared with a reason", () => {
    expect(() =>
      checkFamilyCompatibility([...BASELINE, "base_revision"], BASELINE, {
        base_revision: "the frozen baseline had no base input",
      }),
    ).not.toThrow();
  });

  it("rejects a production family nobody wrote a reason for", () => {
    // Containment alone would pass this. The whole point of the exclusion
    // list is that gaining a family is a decision someone recorded, not a
    // default that happens one family at a time until the planner no longer
    // resembles the one the baseline measured.
    expect(() =>
      checkFamilyCompatibility([...BASELINE, "some_new_family"], BASELINE, {}),
    ).toThrow(/no recorded reason/);
  });

  it("names the undeclared family so the message is actionable", () => {
    expect(() =>
      checkFamilyCompatibility([...BASELINE, "some_new_family"], BASELINE, {}),
    ).toThrow(/some_new_family/);
  });

  it("rejects losing a family the baseline ablated, in the other direction", () => {
    // The asymmetry is the design. Production may gain; the baseline may not
    // lose, because the frozen numbers would then cite an ablation of
    // something this tree can no longer produce.
    expect(() =>
      checkFamilyCompatibility(["structural_index"], BASELINE, {
        binding: "declared, but that must not help here",
      }),
    ).toThrow(/no longer has/);
  });

  it("holds for the real constants this tree ships", () => {
    expect(() => assertPlannerFamilyNamesRemainCompatible()).not.toThrow();
  });
});
