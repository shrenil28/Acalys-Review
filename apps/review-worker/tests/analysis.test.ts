import { describe, expect, it } from "vitest";

import {
  analyzerCacheKey,
  contextSnapshotDigest,
  runRealAnalysis,
  type AnalysisSource,
} from "../src/index.js";

/**
 * The production analysis path, beside the deterministic stub rather than
 * replacing it — the crash-recovery proofs need the stub to stay a pure
 * function of the change.
 */

/** The port the repository package will implement. */
function fixtureSource(
  files: Record<string, string>,
  changed: readonly { path: string; changedLines: readonly number[] }[],
): AnalysisSource {
  return {
    read: () =>
      Promise.resolve({
        changed: changed.map((entry) => ({
          path: entry.path,
          content: files[entry.path] ?? "",
          changedLines: entry.changedLines,
        })),
        repository: new Map(Object.entries(files)),
      }),
  };
}

const REPO = "0192f8a1-0000-7000-8000-0000000000aa";
const SHA = "a".repeat(40);

describe("The real analysis path", () => {
  const files = {
    "src/caller.ts": [
      'import { save } from "./store.js";',
      "export function run(): void {",
      "  save(1);",
      "}",
    ].join("\n"),
    "src/store.ts":
      "export async function save(v: number): Promise<void> {\n  return;\n}",
  };
  const changed = [{ path: "src/caller.ts", changedLines: [3] }];

  const run = () =>
    runRealAnalysis({
      repositoryId: REPO,
      headSha: SHA,
      source: fixtureSource(files, changed),
    });

  it("produces a persistable row carrying the causal chain and the repair", async () => {
    const outcome = await run();
    expect(outcome.candidates).toHaveLength(1);

    const candidate = outcome.candidates[0];
    expect(candidate?.category).toBe("correctness");
    expect(candidate?.path).toBe("src/caller.ts");
    // Everything the reader needs survives to the row. Anything dropped here
    // is work the reviewer did that nobody benefits from.
    expect(candidate?.explanation).toContain("Happens when:");
    expect(candidate?.explanation).toContain("Consequence:");
    expect(candidate?.explanation).toContain("Remediation:");
    expect(candidate?.fingerprintValue).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: the same change replays to identical rows", async () => {
    // The property the whole lifecycle proof rests on. A real analyzer that is
    // not deterministic would make every convergence test unattributable.
    const [first, second] = [await run(), await run()];
    expect(second.candidates).toEqual(first.candidates);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(second.contextDigest).toBe(first.contextDigest);
  });

  it("keeps the fingerprint stable when the defect moves within a file", async () => {
    const moved = {
      ...files,
      "src/caller.ts": `${"// pad\n".repeat(20)}${files["src/caller.ts"]}`,
    };
    const outcome = await runRealAnalysis({
      repositoryId: REPO,
      headSha: SHA,
      source: fixtureSource(moved, [
        { path: "src/caller.ts", changedLines: [23] },
      ]),
    });

    const base = await run();
    expect(outcome.candidates[0]?.fingerprintValue).toBe(
      base.candidates[0]?.fingerprintValue,
    );
  });

  it("reports a complete review as complete", async () => {
    const outcome = await run();
    expect(outcome.report.complete).toBe(true);
    expect(outcome.report.degradations).toEqual([]);
  });

  it("produces nothing, and reports success, for clean code", async () => {
    const clean = {
      "src/caller.ts": [
        'import { save } from "./store.js";',
        "export async function run(): Promise<void> {",
        "  await save(1);",
        "}",
      ].join("\n"),
      "src/store.ts": files["src/store.ts"],
    };

    const outcome = await runRealAnalysis({
      repositoryId: REPO,
      headSha: SHA,
      source: fixtureSource(clean, changed),
    });

    expect(outcome.candidates).toEqual([]);
    expect(outcome.report.complete).toBe(true);
  });
});

describe("The analyzer cache key", () => {
  const base = {
    repositoryId: REPO,
    headSha: SHA,
    contextDigest: "c".repeat(64),
  };

  it("changes when the model changes", () => {
    // The trap this exists to prevent: change the model, serve a cached
    // result, and every quality number afterwards describes a model that
    // never ran.
    expect(analyzerCacheKey({ ...base, modelIdentity: "model-a" })).not.toBe(
      analyzerCacheKey({ ...base, modelIdentity: "model-b" }),
    );
  });

  it("distinguishes a deterministic result from a model result", () => {
    expect(analyzerCacheKey(base)).not.toBe(
      analyzerCacheKey({ ...base, modelIdentity: "model-a" }),
    );
  });

  it("changes when the supplied context changes", () => {
    expect(
      analyzerCacheKey({ ...base, contextDigest: "d".repeat(64) }),
    ).not.toBe(analyzerCacheKey(base));
  });

  it("is stable for identical inputs", () => {
    expect(analyzerCacheKey(base)).toBe(analyzerCacheKey(base));
  });
});

describe("The context snapshot digest", () => {
  const item = {
    path: "src/a.ts",
    reason: "changed_hunk",
    representation: "full",
    suppliedContent: "export const a = 1;",
  };

  it("ignores the order items were assembled in", () => {
    const other = { ...item, path: "src/b.ts" };
    expect(contextSnapshotDigest([item, other])).toBe(
      contextSnapshotDigest([other, item]),
    );
  });

  it("changes when supplied content changes", () => {
    expect(
      contextSnapshotDigest([
        { ...item, suppliedContent: "export const a = 2;" },
      ]),
    ).not.toBe(contextSnapshotDigest([item]));
  });

  it("changes when the same content is supplied for a different reason", () => {
    // Reason is part of what the reviewer was told, not decoration: the same
    // file offered as a caller and as the changed hunk are different prompts.
    expect(contextSnapshotDigest([{ ...item, reason: "caller" }])).not.toBe(
      contextSnapshotDigest([item]),
    );
  });
});
