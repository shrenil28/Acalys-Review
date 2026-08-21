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

import { plannerAvailabilityForMode } from "../src/eval/l5-production.js";
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
