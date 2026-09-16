import { describe, expect, it } from "vitest";

import { modelAnalyzerInputDigest } from "../src/analysis.js";

const baseChangedFile = {
  path: "src/a.ts",
  content: "export const a = 1;",
  changedLines: [1],
} as const;

const base = {
  repositoryId: "repo",
  baseSha: "base",
  mergeBaseSha: "merge",
  headSha: "head",
  changed: [baseChangedFile],
  configFactsDigest: "c".repeat(64),
  instructionFactsDigest: "i".repeat(64),
  contextDigest: "x".repeat(64),
  analyzerId: "acalys.correctness.llm",
  analyzerVersion: "1",
  model: {
    provider: "openai",
    modelId: "configured-model",
    tier: "strong",
    routingPolicyVersion: "route-v1",
    promptTemplateVersion: "prompt-v1",
  },
} as const;

describe("model analyzer input identity", () => {
  it("changes when the prompt template changes while the head stays the same", () => {
    const first = modelAnalyzerInputDigest(base);
    const second = modelAnalyzerInputDigest({
      ...base,
      model: { ...base.model, promptTemplateVersion: "prompt-v2" },
    });
    expect(second).not.toBe(first);
  });

  it("changes when resolved instructions or merge base changes", () => {
    const first = modelAnalyzerInputDigest(base);
    expect(
      modelAnalyzerInputDigest({
        ...base,
        instructionFactsDigest: "j".repeat(64),
      }),
    ).not.toBe(first);
    expect(
      modelAnalyzerInputDigest({ ...base, mergeBaseSha: "other" }),
    ).not.toBe(first);
  });
  it("changes when base-side content changes while the SHAs stay the same", () => {
    const withBase = {
      ...base,
      changed: [
        {
          ...baseChangedFile,
          base: { kind: "present" as const, content: "export const a = 0;" },
        },
      ],
    };
    const changedBase = {
      ...withBase,
      changed: [
        {
          ...baseChangedFile,
          base: { kind: "present" as const, content: "export const a = -1;" },
        },
      ],
    };

    expect(modelAnalyzerInputDigest(changedBase)).not.toBe(
      modelAnalyzerInputDigest(withBase),
    );
  });
});
