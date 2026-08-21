import { describe, expect, it } from "vitest";

import { VERIFIER_CHALLENGES } from "@acalys/review-engine/eval";

import {
  M1_CAPABILITY_FAMILIES,
  M1_CAPABILITY_TAXONOMY,
  M1_CORPUS_VERSION,
  M1_DEVELOPMENT_CASES,
  M1_HISTORICAL_BASELINE,
  M1_HOLDOUT_CASES,
  M1_HOLDOUT_DIGEST,
  M1_L5_BASELINE_COMMIT,
  M1_MISS_ATTRIBUTIONS,
  M1_NATURAL_FALSE_POSITIVES,
  corpusDigest,
  type M1CapabilityCase,
} from "../src/eval/m1-corpus.js";

describe("the frozen P1-M.1 premises", () => {
  it("keeps the accepted P1-L result as an immutable historical baseline", () => {
    expect(M1_CORPUS_VERSION).toBe("p1-m1-corpus/2026-08-21.v1");
    expect(M1_L5_BASELINE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(M1_HISTORICAL_BASELINE.sourceCommit).toBe(M1_L5_BASELINE_COMMIT);
    expect(M1_HISTORICAL_BASELINE.caseIds).toHaveLength(12);
    expect(new Set(M1_HISTORICAL_BASELINE.caseIds).size).toBe(12);
    expect(M1_HISTORICAL_BASELINE).toMatchObject({
      planted: 12,
      candidates: 2,
      publishedTruePositives: 2,
      publishedFalsePositives: 0,
      publishedFalseNegatives: 10,
      publishedPrecision: 1,
      publishedRecall: 2 / 12,
    });
  });

  it("attributes every historical miss to the stage where it actually died", () => {
    expect(M1_MISS_ATTRIBUTIONS).toHaveLength(10);
    expect(new Set(M1_MISS_ATTRIBUTIONS.map((row) => row.caseId)).size).toBe(
      10,
    );
    expect(
      M1_MISS_ATTRIBUTIONS.every(
        (row) =>
          row.analyzer === "absent" &&
          row.verifier === "not_run" &&
          row.policy === "not_run" &&
          row.rootCause === "analyzer_capability" &&
          row.requiredEvidenceAvailable &&
          row.selectedFactFamilies.length > 0,
      ),
    ).toBe(true);
  });

  it("ranks only families supported by the ten observed misses", () => {
    expect(M1_CAPABILITY_TAXONOMY.map((row) => row.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(M1_CAPABILITY_TAXONOMY.map((row) => row.family)).toEqual(
      M1_CAPABILITY_FAMILIES,
    );
    expect(
      M1_CAPABILITY_TAXONOMY.reduce(
        (total, row) => total + row.historicalMisses,
        0,
      ),
    ).toBe(10);

    const attributedByFamily = new Map(
      M1_CAPABILITY_FAMILIES.map((family) => [
        family,
        M1_MISS_ATTRIBUTIONS.filter(
          (attribution) => attribution.capabilityFamily === family,
        ).map((attribution) => attribution.caseId),
      ]),
    );
    for (const row of M1_CAPABILITY_TAXONOMY) {
      expect([...row.historicalCaseIds].sort()).toEqual(
        [...(attributedByFamily.get(row.family) ?? [])].sort(),
      );
    }
  });

  it("separates visible development cases from the sealed holdout", () => {
    expect(M1_DEVELOPMENT_CASES).toHaveLength(8);
    expect(M1_HOLDOUT_CASES).toHaveLength(8);
    expect(
      M1_DEVELOPMENT_CASES.every((entry) => entry.split === "development"),
    ).toBe(true);
    expect(M1_HOLDOUT_CASES.every((entry) => entry.split === "holdout")).toBe(
      true,
    );

    const developmentIds = new Set(
      M1_DEVELOPMENT_CASES.map((entry) => entry.id),
    );
    expect(M1_HOLDOUT_CASES.some((entry) => developmentIds.has(entry.id))).toBe(
      false,
    );
    expect(
      new Set(M1_DEVELOPMENT_CASES.map((entry) => entry.capabilityFamily)),
    ).toEqual(new Set(M1_CAPABILITY_FAMILIES));
    expect(
      new Set(M1_HOLDOUT_CASES.map((entry) => entry.capabilityFamily)),
    ).toEqual(new Set(M1_CAPABILITY_FAMILIES));
  });

  it("seals holdout content independently of development changes", () => {
    expect(M1_HOLDOUT_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(corpusDigest(M1_HOLDOUT_CASES)).toBe(M1_HOLDOUT_DIGEST);
    expect(Object.isFrozen(M1_HOLDOUT_CASES)).toBe(true);
    expect(Object.isFrozen(M1_HOLDOUT_CASES[0]?.headFiles)).toBe(true);
  });

  it("orders the seal by codepoint, never by machine locale", () => {
    // `localeCompare` stood here and is a determinism defect in a seal: key
    // ordering would depend on ICU data, so two correct machines could
    // disagree about the digest of identical content.
    //
    // The first version of this test could not detect it. It compared two
    // digests computed by the SAME function, which is self-consistent under
    // any comparator — the wrong answer and the right answer agreed. Pinning
    // the digest to a constant is what makes the comparator observable.
    //
    // These keys are ordered differently by the two comparators:
    //
    //   codepoint      Alpha, _under, alpha
    //   localeCompare  _under, alpha, Alpha
    //
    // so reverting the sort changes this constant and fails here.
    const ORDERING_PROBE: M1CapabilityCase = {
      id: "ordering-probe",
      split: "development",
      capabilityFamily: "configuration_sensitive_type_safety",
      baseFiles: { _under: "a", Alpha: "b", alpha: "c" },
      headFiles: { _under: "a", Alpha: "b", alpha: "d" },
      changed: [{ path: "alpha", changedLines: [1] }],
      expectedFindings: [],
      because:
        "fixed input whose canonical key order distinguishes comparators",
    };

    expect(corpusDigest([ORDERING_PROBE])).toBe(
      "eaa29dc61ce81141c0224183e7f913e69efb413cdd22ef09ff848b8ea4bdb760",
    );

    // And the premise: the two comparators genuinely disagree on these keys.
    // If they ever agreed, the constant above would prove nothing.
    const keys = ["_under", "Alpha", "alpha"];
    const codepoint = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const locale = [...keys].sort((a, b) => a.localeCompare(b));
    expect(codepoint).not.toEqual(locale);
  });

  it("keeps natural false positives observed rather than manufactured", () => {
    expect(M1_NATURAL_FALSE_POSITIVES).toHaveLength(1);
    const historicalChallenges = new Set(
      VERIFIER_CHALLENGES.filter(
        (challenge) =>
          challenge.source === "injected_historical_regression" &&
          challenge.gold === "should_reject",
      ).map((challenge) => challenge.id),
    );
    for (const entry of M1_NATURAL_FALSE_POSITIVES) {
      expect(entry.analyzerBehavior).toBe("historically_produced_candidate");
      expect(entry.gold).toBe("must_not_publish");
      expect(historicalChallenges.has(entry.replayChallengeId)).toBe(true);
    }
  });

  it("gives every authored case one exact changed-source finding", () => {
    for (const entry of [...M1_DEVELOPMENT_CASES, ...M1_HOLDOUT_CASES]) {
      expect(entry.expectedFindings).toHaveLength(1);
      expect(entry.changed).toHaveLength(1);
      const [finding] = entry.expectedFindings;
      const [changed] = entry.changed;
      expect(finding?.path).toBe(changed?.path);
      expect(entry.baseFiles[changed?.path ?? ""]).toBeDefined();
      expect(entry.headFiles[changed?.path ?? ""]).toBeDefined();
      expect(entry.baseFiles[changed?.path ?? ""]).not.toBe(
        entry.headFiles[changed?.path ?? ""],
      );
    }
  });
});
