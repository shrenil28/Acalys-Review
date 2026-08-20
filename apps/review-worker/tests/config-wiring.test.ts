import { describe, expect, it } from "vitest";

import { canonicalSerialization, indexDigest } from "@acalys/code-intelligence";
import { runRealAnalysis, type AnalysisSource } from "../src/index.js";

const REPOSITORY_ID = "0192f8a1-0000-7000-8000-0000000000aa";
const HEAD_SHA = "e".repeat(40);
const FOO = [
  "export function foo(value: number): number {",
  "  return value + 1;",
  "}",
].join("\n");

function source(files: Record<string, string>): AnalysisSource {
  return {
    read: () =>
      Promise.resolve({
        changed: [{ path: "src/foo.ts", content: FOO, changedLines: [2] }],
        repository: new Map(Object.entries(files)),
      }),
  };
}

function run(files: Record<string, string>) {
  return runRealAnalysis({
    repositoryId: REPOSITORY_ID,
    headSha: HEAD_SHA,
    tenantId: "tenant-1",
    source: source(files),
  });
}

const H1 = {
  "src/foo.ts": FOO,
  "tsconfig.json": JSON.stringify({ include: ["src/foo.ts"] }),
};

const H2 = {
  "src/foo.ts": FOO,
  "tsconfig.json": JSON.stringify({ include: ["src/other.ts"] }),
};

describe("Wave 2 production configuration witness", () => {
  it("keeps code-index identity stable while config changes analyzer input", async () => {
    const [h1, h2] = await Promise.all([run(H1), run(H2)]);

    // Premise: the code under review is byte-identical at both heads.
    expect(H1["src/foo.ts"]).toBe(H2["src/foo.ts"]);

    expect(canonicalSerialization(h1.index)).toBe(
      canonicalSerialization(h2.index),
    );
    expect(indexDigest(h1.index)).toBe(indexDigest(h2.index));

    expect(h1.configFactsDigest).not.toBe(h2.configFactsDigest);
    expect(h1.configGovernance[0]?.status).toBe("governed");
    expect(h2.configGovernance[0]?.status).toBe("not_governed");

    const h1Config = h1.context.items.filter(
      (item) => item.reason === "configuration",
    );
    const h2Config = h2.context.items.filter(
      (item) => item.reason === "configuration",
    );
    expect(h1Config.map((item) => item.path)).toEqual(["tsconfig.json"]);
    expect(h2Config).toHaveLength(0);

    expect(h1.contextDigest).not.toBe(h2.contextDigest);
    expect(h1.cacheKey).not.toBe(h2.cacheKey);
  });

  it("keeps positive governance visible through a partial outage", async () => {
    const outcome = await run({
      ...H1,
      "broken/tsconfig.json": "{ invalid",
    });

    const governance = outcome.configGovernance[0];
    expect(governance?.status).toBe("governed");
    if (governance?.status !== "governed") throw new Error("unreachable");
    expect(governance.relationships.map((item) => item.projectPath)).toEqual([
      "tsconfig.json",
    ]);
    expect(governance.coverage.unevaluable).toEqual([
      expect.objectContaining({
        configPath: "broken/tsconfig.json",
        failure: "config_unparsable",
      }),
    ]);
    expect(
      outcome.context.items.some(
        (item) =>
          item.reason === "configuration" && item.path === "tsconfig.json",
      ),
    ).toBe(true);
  });

  it("distinguishes complete negative from incomplete undetermined", async () => {
    const completeNegative = await run(H2);
    expect(completeNegative.configGovernance[0]?.status).toBe("not_governed");

    const incompleteNegative = await run({
      ...H2,
      "broken/tsconfig.json": "{ invalid",
    });
    expect(incompleteNegative.configGovernance[0]?.status).toBe("undetermined");
    expect(incompleteNegative.configGovernance[0]?.status).not.toBe(
      "not_governed",
    );
  });
});
