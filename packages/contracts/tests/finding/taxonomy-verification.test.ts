import { describe, expect, it } from "vitest";
import {
  FINDING_CATEGORIES,
  FINDING_CONFIDENCE_LEVELS,
  FINDING_SEVERITIES,
  compareSeverity,
  confidenceLevelForScore,
  findingConfidence,
  findingConfidenceSchema,
  highestSeverity,
  isActionableConfidence,
  isMoreSevere,
} from "../../src/domain/finding/taxonomy.js";
import {
  VERIFICATION_DECISIONS,
  VERIFICATION_REASON_CODES,
  isConfirmingReason,
  permitsPublication,
  verificationResultSchema,
} from "../../src/domain/finding/verification.js";
import { EvidenceIdOps } from "../../src/domain/identity/ids.js";
import { namespacedId } from "../../src/domain/primitives/namespaced-id.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";

const EVIDENCE = EvidenceIdOps.parse("0192f8a1-0000-7000-8000-000000000011");
const AT = timestamp("2026-08-16T10:00:00.000Z");

describe("Finding taxonomy (P0.txt §24, §25, §26)", () => {
  it("has no duplicates in any vocabulary", () => {
    expect(new Set(FINDING_CATEGORIES).size).toBe(FINDING_CATEGORIES.length);
    expect(new Set(FINDING_SEVERITIES).size).toBe(FINDING_SEVERITIES.length);
    expect(new Set(FINDING_CONFIDENCE_LEVELS).size).toBe(
      FINDING_CONFIDENCE_LEVELS.length,
    );
  });

  describe("severity ordering is explicit, never lexical (§25)", () => {
    it("sorts most severe first", () => {
      const shuffled = ["low", "critical", "info", "high", "medium"] as const;
      expect([...shuffled].sort(compareSeverity)).toEqual([
        "critical",
        "high",
        "medium",
        "low",
        "info",
      ]);
    });

    it("disagrees with string sort, which is why the helper exists", () => {
      // Lexically: critical < high < info < low < medium — which would rank
      // 'info' above 'low' and put 'medium' last.
      const lexical = [...FINDING_SEVERITIES].sort();
      const semantic = [...FINDING_SEVERITIES].sort(compareSeverity);
      expect(lexical).not.toEqual(semantic);
      expect(lexical.indexOf("info")).toBeLessThan(lexical.indexOf("low"));
      expect(semantic.indexOf("info")).toBeGreaterThan(semantic.indexOf("low"));
    });

    it("compares pairs", () => {
      expect(isMoreSevere("critical", "high")).toBe(true);
      expect(isMoreSevere("info", "low")).toBe(false);
      expect(isMoreSevere("medium", "medium")).toBe(false);
    });

    it("finds the highest in a set", () => {
      expect(highestSeverity(["low", "critical", "medium"])).toBe("critical");
      expect(highestSeverity(["info"])).toBe("info");
      expect(highestSeverity([])).toBeUndefined();
    });
  });

  describe("confidence carries score and band, and they cannot disagree", () => {
    it("derives the band from the score", () => {
      expect(findingConfidence(0.95).level).toBe("very_high");
      expect(findingConfidence(0.75).level).toBe("high");
      expect(findingConfidence(0.5).level).toBe("medium");
      expect(findingConfidence(0.1).level).toBe("low");
    });

    it("bands at the exact thresholds", () => {
      expect(confidenceLevelForScore(0.9)).toBe("very_high");
      expect(confidenceLevelForScore(0.8999)).toBe("high");
      expect(confidenceLevelForScore(0.7)).toBe("high");
      expect(confidenceLevelForScore(0.6999)).toBe("medium");
      expect(confidenceLevelForScore(0.4)).toBe("medium");
      expect(confidenceLevelForScore(0.3999)).toBe("low");
      expect(confidenceLevelForScore(0)).toBe("low");
      expect(confidenceLevelForScore(1)).toBe("very_high");
    });

    it("rejects a band that contradicts its score (§C18)", () => {
      const result = findingConfidenceSchema.safeParse({
        score: 0.05,
        level: "very_high",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("contradicts score");
      }
    });

    it("rejects a score outside [0, 1]", () => {
      expect(
        findingConfidenceSchema.safeParse({ score: 1.5, level: "very_high" })
          .success,
      ).toBe(false);
      expect(
        findingConfidenceSchema.safeParse({ score: -0.1, level: "low" })
          .success,
      ).toBe(false);
    });

    it("rejects NaN, which would serialize to null", () => {
      expect(() => findingConfidence(Number.NaN)).toThrow();
    });

    it("only very_high is actionable automatically", () => {
      expect(isActionableConfidence(findingConfidence(0.95))).toBe(true);
      expect(isActionableConfidence(findingConfidence(0.85))).toBe(false);
    });
  });

  it("severity and confidence are independent axes (§25)", () => {
    // A critical issue may be under investigation with low confidence, and a
    // cosmetic one may be certain. Neither constrains the other.
    const criticalButUnsure = {
      severity: "critical" as const,
      confidence: findingConfidence(0.2),
    };
    const trivialButCertain = {
      severity: "info" as const,
      confidence: findingConfidence(0.99),
    };

    expect(criticalButUnsure.confidence.level).toBe("low");
    expect(trivialButCertain.confidence.level).toBe("very_high");
    expect(
      isMoreSevere(criticalButUnsure.severity, trivialButCertain.severity),
    ).toBe(true);
  });
});

describe("Verification (P0.txt §32)", () => {
  const base = {
    evidence: [{ evidenceId: EVIDENCE }],
    confidence: findingConfidence(0.9),
    verifiedBy: { kind: "agent" as const, agentType: "verifier" as const },
    verifiedAt: AT,
  };

  it("has no duplicates in either vocabulary", () => {
    expect(new Set(VERIFICATION_DECISIONS).size).toBe(
      VERIFICATION_DECISIONS.length,
    );
    expect(new Set(VERIFICATION_REASON_CODES).size).toBe(
      VERIFICATION_REASON_CODES.length,
    );
  });

  describe("all three decisions", () => {
    it("verified, with a confirming reason and evidence", () => {
      const parsed = verificationResultSchema.parse({
        ...base,
        decision: "verified",
        reasonCodes: ["confirmed_by_test"],
      });
      expect(permitsPublication(parsed)).toBe(true);
    });

    it("rejected, with a rejecting reason", () => {
      const parsed = verificationResultSchema.parse({
        ...base,
        decision: "rejected",
        reasonCodes: ["false_positive", "not_reachable"],
        evidence: [],
      });
      expect(permitsPublication(parsed)).toBe(false);
    });

    it("inconclusive, which is why the third value exists", () => {
      // Without it, a verifier that could not decide must lie in one
      // direction: rejecting hides real bugs, accepting publishes noise.
      const parsed = verificationResultSchema.parse({
        ...base,
        decision: "inconclusive",
        reasonCodes: ["insufficient_evidence"],
        evidence: [],
      });
      expect(permitsPublication(parsed)).toBe(false);
    });
  });

  describe("it is never a boolean (§32)", () => {
    it("requires at least one machine-readable reason", () => {
      expect(
        verificationResultSchema.safeParse({
          ...base,
          decision: "verified",
          reasonCodes: [],
        }).success,
      ).toBe(false);
    });

    it("rejects a free-form reason string", () => {
      expect(
        verificationResultSchema.safeParse({
          ...base,
          decision: "rejected",
          reasonCodes: ["it looked wrong to me"],
        }).success,
      ).toBe(false);
    });

    it("treats summary as supplementary, never as the decision", () => {
      const withSummary = verificationResultSchema.parse({
        ...base,
        decision: "verified",
        reasonCodes: ["confirmed_by_static_trace"],
        summary: "Taint analysis reaches the sink from an unsanitized source.",
      });
      const withoutSummary = verificationResultSchema.parse({
        ...base,
        decision: "verified",
        reasonCodes: ["confirmed_by_static_trace"],
      });

      // Removing the prose changes nothing about the machine outcome.
      expect(withSummary.decision).toBe(withoutSummary.decision);
      expect(withSummary.reasonCodes).toEqual(withoutSummary.reasonCodes);
      expect(permitsPublication(withoutSummary)).toBe(true);
    });

    it("stores no chain of thought (§32, §120)", () => {
      const keys = Object.keys(verificationResultSchema.shape);
      for (const forbidden of [
        "reasoning",
        "thoughts",
        "trace",
        "rationale",
        "chainOfThought",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  describe("decision and reason cannot contradict (§C18)", () => {
    it("a confirming reason cannot accompany a rejection", () => {
      const result = verificationResultSchema.safeParse({
        ...base,
        decision: "rejected",
        reasonCodes: ["confirmed_by_test"],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "cannot accompany a 'rejected' decision",
        );
      }
    });

    it("a verified decision must say how it was confirmed", () => {
      expect(
        verificationResultSchema.safeParse({
          ...base,
          decision: "verified",
          reasonCodes: ["duplicate"],
        }).success,
      ).toBe(false);
    });

    it("a verified decision must cite evidence", () => {
      // "Verified" means established by evidence, not asserted by a model.
      expect(
        verificationResultSchema.safeParse({
          ...base,
          decision: "verified",
          reasonCodes: ["confirmed_by_test"],
          evidence: [],
        }).success,
      ).toBe(false);
    });

    it("rejects duplicate reason codes, which would skew analytics", () => {
      expect(
        verificationResultSchema.safeParse({
          ...base,
          decision: "rejected",
          reasonCodes: ["false_positive", "false_positive"],
          evidence: [],
        }).success,
      ).toBe(false);
    });

    it("classifies confirming vs non-confirming reasons", () => {
      const confirming = VERIFICATION_REASON_CODES.filter(isConfirmingReason);
      expect([...confirming].sort()).toEqual([
        "confirmed_by_contract",
        "confirmed_by_runtime",
        "confirmed_by_static_trace",
        "confirmed_by_test",
      ]);
    });
  });

  describe("verification is independent of generation (§32)", () => {
    it("records who verified, separately from who generated", () => {
      const byTool = verificationResultSchema.parse({
        ...base,
        decision: "verified",
        reasonCodes: ["confirmed_by_contract"],
        verifiedBy: {
          kind: "tool",
          tool: { id: namespacedId("acalys.compiler.typescript") },
        },
      });
      // A compiler proof and a model opinion warrant different trust, and the
      // union keeps them structurally distinguishable.
      expect(byTool.verifiedBy.kind).toBe("tool");
    });

    it("only an agent or a tool can decide", () => {
      // Repository content and external documents are evidence a verifier
      // weighs, never verifiers themselves.
      expect(
        verificationResultSchema.safeParse({
          ...base,
          decision: "inconclusive",
          reasonCodes: ["insufficient_evidence"],
          evidence: [],
          verifiedBy: { kind: "repository" },
        }).success,
      ).toBe(false);
    });
  });
});
