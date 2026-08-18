import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  CORRECTNESS_CHECK_ID,
  DEFAULT_PREMERGE_CONFIG,
  blocksMerge,
  evaluatePreMerge,
  type EnforceableFinding,
} from "../src/index.js";
import { DEFAULT_PUBLICATION_CONFIG, planPublication } from "../src/index.js";
import type { FindingSeverity } from "@acalys/contracts/domain";

const finding = (
  id: string,
  severity: FindingSeverity = "high",
  path = "src/a.ts",
): EnforceableFinding => ({
  findingId: id,
  severity,
  category: "correctness",
  path,
});

describe("Pre-merge enforcement is decided from findings alone", () => {
  it("passes a change with nothing verified", () => {
    // `passed`, not `skipped`. A review that found nothing actionable has
    // satisfied the policy; recording it as skipped would make a clean change
    // indistinguishable from one the platform never evaluated.
    const [check] = evaluatePreMerge([]);
    expect(check?.status).toBe("passed");
    expect(check?.checkId).toBe(CORRECTNESS_CHECK_ID);
    expect(check?.explanation).toBeUndefined();
  });

  it("fails, with a reason, once a finding reaches the blocking severity", () => {
    const [check] = evaluatePreMerge([finding("f1", "high")], {
      blockingSeverity: "high",
      blocking: true,
    });
    expect(check?.status).toBe("failed");
    // A developer shown a red check with no reason cannot act on it.
    expect(check?.explanation).toContain("1 verified finding(s)");
    expect(blocksMerge([check as never])).toBe(true);
  });

  it("reports without blocking by default", () => {
    // A reviewer that starts blocking merges on the day it is installed is a
    // reviewer that gets uninstalled.
    expect(DEFAULT_PREMERGE_CONFIG.blocking).toBe(false);
    const checks = evaluatePreMerge([finding("f1", "critical")]);
    expect(checks[0]?.status).toBe("failed");
    expect(blocksMerge(checks)).toBe(false);
  });

  it("carries a status and never a severity", () => {
    // §44. Expressing "three high findings" as a check with a severity makes
    // severity start to mean "blocking", and policy then gets tuned by
    // re-grading defects.
    const [check] = evaluatePreMerge([finding("f1", "critical")]);
    expect(check).not.toHaveProperty("severity");
  });

  it("is deterministic", () => {
    const findings = [finding("f1", "high"), finding("f2", "low")];
    expect(evaluatePreMerge(findings)).toEqual(evaluatePreMerge(findings));
  });

  it("does not soften when the same findings are withheld from comments", () => {
    // ── The separation, stated as a property ────────────────────────────────
    //
    // Publication config varies across the whole space; enforcement does not
    // move. Written as a property rather than an example because the coupling
    // this guards against would not be introduced deliberately — it would
    // arrive as "block on what we commented on", which is correct for most
    // inputs and wrong exactly when the comment budget or a path exclusion is
    // what silenced a real defect.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 8 }),
            severity: fc.constantFrom<FindingSeverity>(
              "info",
              "low",
              "medium",
              "high",
              "critical",
            ),
            path: fc.constantFrom("src/a.ts", "vendor/b.ts", "test/c.ts"),
          }),
          { maxLength: 12 },
        ),
        fc.integer({ min: 0, max: 12 }),
        (raw, budget) => {
          const findings = raw.map((entry, index) =>
            finding(`${entry.id}-${String(index)}`, entry.severity, entry.path),
          );

          const enforcement = evaluatePreMerge(findings, {
            blockingSeverity: "high",
            blocking: true,
          });

          // The same findings, run through a publication policy that suppresses
          // an arbitrary amount of them.
          const plan = planPublication(
            findings.map((entry) => ({
              findingId: entry.findingId,
              fingerprint: entry.findingId,
              severity: entry.severity,
              category: entry.category,
              path: entry.path,
            })),
            {
              ...DEFAULT_PUBLICATION_CONFIG,
              excludedPaths: ["vendor/"],
              maxComments: budget,
            },
          );

          const anyBlocking = findings.some(
            (entry) =>
              entry.severity === "high" || entry.severity === "critical",
          );

          // Enforcement depends on the findings and on nothing the plan did.
          expect(blocksMerge(enforcement)).toBe(anyBlocking);

          // And the case that makes it matter actually occurs in this space:
          // everything suppressed while the merge is still blocked.
          if (anyBlocking && plan.noActionableFindings) {
            expect(blocksMerge(enforcement)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
