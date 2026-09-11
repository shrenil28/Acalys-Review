import { describe, expect, it } from "vitest";
import { REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES } from "@acalys/database";
import { createPreloadedAnalysisCache, decodeAnalysisCachePayload } from "../src/analysis-cache.js";

const FP = "a".repeat(64);
const EMPTY = { findings: [], suppressions: [], degradations: [] } as const;

describe("durable analysis cache decoding", () => {
  it("accepts a valid AnalysisResult payload", () => {
    expect(decodeAnalysisCachePayload(EMPTY)).toEqual(EMPTY);
  });

  it("treats malformed and oversized payloads as cache misses", () => {
    expect(decodeAnalysisCachePayload({ findings: "nope", suppressions: [], degradations: [] })).toBeUndefined();
    expect(decodeAnalysisCachePayload({ findings: [], suppressions: [{ reason: "bogus", ruleId: "r", clusterId: "c", detail: "d" }], degradations: [] })).toBeUndefined();
    expect(decodeAnalysisCachePayload({ findings: [], suppressions: [], degradations: [{ clusterId: "c", reason: "x".repeat(REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES + 1) }] })).toBeUndefined();
  });

  it("ignores malformed fingerprints and tracks only real hits/writes", () => {
    const loaded = createPreloadedAnalysisCache([
      { fingerprint: "bad", payload: EMPTY },
      { fingerprint: FP, payload: EMPTY },
    ]);
    expect(loaded.cache.get("bad")).toBeUndefined();
    expect(loaded.cache.get(FP)).toEqual(EMPTY);
    expect([...loaded.hits]).toEqual([FP]);
    loaded.cache.set("b".repeat(64), EMPTY);
    expect([...loaded.writes.keys()]).toEqual(["b".repeat(64)]);
  });
});
