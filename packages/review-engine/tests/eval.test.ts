import { describe, expect, it } from "vitest";

import {
  allocateBudget,
  buildClusters,
  createMemoryCache,
  fingerprintCluster,
  runAnalysis,
  toFindingView,
  type AnalysisResult,
} from "../src/index.js";
// The eval is a separate entry point: it is a development surface, and keeping
// the corpus out of the package's main export stops it reaching a bundle.
import {
  ANALYZER_CORPUS,
  evaluateCorpus,
  failures,
  runCase,
} from "../src/eval/index.js";
import { extractFile, planContext } from "@acalys/code-intelligence";

/**
 * The P1-G gate.
 *
 * The engineering suite proves the platform works. This proves the reviewer is
 * worth reading, and the two are not the same claim.
 */
describe("Analyzer corpus", () => {
  it("actually ran, across all four buckets", async () => {
    // Fail-closed. A harness that silently evaluated nothing would report a
    // perfect precision of 1 and a recall of 1, which is the exact shape of
    // three bugs this project has already shipped.
    const report = await evaluateCorpus(ANALYZER_CORPUS);
    expect(report.cases.length).toBe(ANALYZER_CORPUS.length);
    expect(report.cases.length).toBeGreaterThanOrEqual(14);
    for (const bucket of ["positive", "clean", "incremental", "adversarial"]) {
      expect(report.cases.some((c) => c.bucket === bucket)).toBe(true);
    }
  }, 60_000);

  it("finds every planted defect, and names any it missed", async () => {
    const report = await evaluateCorpus(ANALYZER_CORPUS);
    // Failures carry the `because` of the case, so a red test states its own
    // cause rather than printing an id.
    expect(failures(report)).toEqual([]);
    expect(report.recall).toBe(1);
  }, 60_000);

  it("produces nothing at all on clean code", async () => {
    // The adoption metric. A reviewer with excellent recall and two false
    // positives per clean pull request gets switched off, and its recall stops
    // mattering that afternoon.
    const report = await evaluateCorpus(ANALYZER_CORPUS);
    expect(report.falsePositivesOnCleanCases).toBe(0);
    expect(report.precision).toBe(1);
  }, 60_000);

  it("reports recall per family, so a regression names where to look", async () => {
    const report = await evaluateCorpus(ANALYZER_CORPUS);
    // Breadth is the point: one family at 1.0 would say almost nothing.
    expect(Object.keys(report.recallByFamily).length).toBeGreaterThanOrEqual(4);
    for (const [family, recall] of Object.entries(report.recallByFamily)) {
      expect(`${family}:${String(recall)}`).toBe(`${family}:1`);
    }
  }, 60_000);

  it("cannot be talked out of a finding by text in the source", async () => {
    // Source is data. A defect a comment can dismiss is a defect anyone can
    // hide, and an unimplemented suppression directive must do nothing rather
    // than work by accident.
    for (const id of [
      "adversarial-comment-instruction",
      "adversarial-fake-suppression-in-catch",
    ]) {
      const testCase = ANALYZER_CORPUS.find((entry) => entry.id === id);
      expect(testCase).toBeDefined();
      if (testCase === undefined) continue;
      const outcome = await runCase(testCase);
      expect(`${id}:${String(outcome.findings.length > 0)}`).toBe(`${id}:true`);
    }
  }, 60_000);

  it("keeps finding identity stable when the defect moves within a file", async () => {
    const base = ANALYZER_CORPUS.find((c) => c.id === "stability-base");
    const moved = ANALYZER_CORPUS.find((c) => c.id === "stability-moved");
    expect(base).toBeDefined();
    if (base === undefined || moved === undefined) return;

    const [a, b] = [await runCase(base), await runCase(moved)];
    expect(a.findings[0]?.identityHint).toBe(b.findings[0]?.identityHint);
  }, 60_000);

  it("gives every finding something the reader can act on", async () => {
    // Driven by what `apps/web` renders: the Deep Scan screen has a
    // remediation field, and a finding that leaves it empty tells the reader
    // something is wrong and gives them no way to act.
    const report = await evaluateCorpus(ANALYZER_CORPUS);
    const produced = report.cases.flatMap((outcome) => outcome.findings);
    expect(produced.length).toBeGreaterThan(0);

    for (const finding of produced) {
      const view = toFindingView(finding);
      expect(
        `${finding.ruleId}:${String(view.remediation.trim().length > 0)}`,
      ).toBe(`${finding.ruleId}:true`);
      // Not a restatement of the problem, and not a shrug.
      expect(view.remediation.toLowerCase()).not.toContain(
        "consider reviewing",
      );
      expect(view.summary).not.toBe("");
      expect(view.detail).toContain("Happens when:");
      expect(view.detail).toContain("Consequence:");
      expect(view.file).not.toBe("");
      expect(view.line).toBeGreaterThan(0);
    }
  }, 60_000);

  it("keeps the economics visible", async () => {
    const report = await evaluateCorpus(ANALYZER_CORPUS);
    // Not a threshold to pass — a number to watch. It is the only metric that
    // catches both a cheap reviewer producing garbage and an excellent one
    // costing more than the bug it found.
    expect(report.tokensPerFinding).toBeGreaterThan(0);
    expect(report.tokensPerCase).toBeGreaterThan(0);
    // Chattiness: findings per case rising while recall is flat.
    expect(report.findingsPerCase).toBeLessThan(2);
  }, 60_000);
});

describe("Bounded execution", () => {
  const cluster = (id: string) => ({
    id,
    subject: [{ path: `src/${id}.ts`, changedLines: [1] }],
    changedSymbols: [],
    context: [],
    mandatory: [],
  });

  const empty = (): AnalysisResult => ({
    findings: [],
    suppressions: [],
    degradations: [],
  });

  it("never runs more than `concurrency` analyses at once", async () => {
    let live = 0;
    let peak = 0;

    const clusters = Array.from({ length: 20 }, (_u, i) =>
      cluster(`c${String(i)}`),
    );
    const allocations = clusters.map((c) => allocateBudget(c));

    await runAnalysis(clusters, allocations, {
      limits: { concurrency: 3 },
      analyzer: async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 1));
        live -= 1;
        return empty();
      },
    });

    // `Promise.all(20)` turns a large pull request into a rate-limit storm,
    // which presents as a slow review rather than an obvious error.
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("records what it skipped rather than silently reviewing half the change", async () => {
    const clusters = Array.from({ length: 10 }, (_u, i) =>
      cluster(`c${String(i)}`),
    );
    const allocations = clusters.map((c) => allocateBudget(c));

    const report = await runAnalysis(clusters, allocations, {
      limits: { maxClusters: 4 },
      analyzer: () => empty(),
    });

    expect(report.analyzed).toBe(4);
    expect(report.skipped).toBe(6);
    expect(report.degradations).toHaveLength(6);
    expect(report.degradations[0]?.reason).toBe("cluster_cap_reached");
    // The caller must be able to ask whether this was a complete review; a
    // quality number computed from a truncated one is not comparable.
    expect(report.complete).toBe(false);
  });

  it("survives a failing analyzer without fabricating or aborting", async () => {
    const clusters = [cluster("a"), cluster("b")];
    const allocations = clusters.map((c) => allocateBudget(c));

    let calls = 0;
    const report = await runAnalysis(clusters, allocations, {
      limits: { concurrency: 1 },
      analyzer: () => {
        calls += 1;
        if (calls === 1) throw new Error("model unavailable");
        return empty();
      },
    });

    expect(report.findings).toEqual([]);
    expect(report.degradations[0]?.reason).toBe("analyzer_failed");
    expect(report.degradations[0]?.detail).toContain("model unavailable");
    // The second cluster still ran.
    expect(report.analyzed).toBe(1);
  });

  it("reports a complete review as complete", async () => {
    const clusters = [cluster("a")];
    const report = await runAnalysis(clusters, [allocateBudget(clusters[0]!)], {
      analyzer: () => empty(),
    });
    expect(report.complete).toBe(true);
    expect(report.degradations).toEqual([]);
  });
});

describe("Incremental reuse", () => {
  const build = (
    files: Record<string, string>,
    changedLines: readonly number[],
  ) => {
    const subject = [{ path: "src/a.ts", changedLines }];
    const context = planContext(
      {
        changed: [
          { path: "src/a.ts", content: files["src/a.ts"] ?? "", changedLines },
        ],
        repository: Object.entries(files).map(([p, s]) => extractFile(p, s)),
        sources: new Map(Object.entries(files)),
      },
      60_000,
    );
    return buildClusters(subject, context.items);
  };

  it("gives the same fingerprint to an unchanged cluster", () => {
    const files = { "src/a.ts": "export function a(): void {}" };
    const [first] = build(files, [1]);
    const [second] = build(files, [1]);
    expect(first).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(fingerprintCluster(first)).toBe(fingerprintCluster(second));
  });

  it("changes the fingerprint when the content changes", () => {
    // Content, not just paths: a caller whose body changed can turn a correct
    // call into a defect with no file added or removed.
    const [first] = build({ "src/a.ts": "export function a(): void {}" }, [1]);
    const [second] = build(
      { "src/a.ts": "export function a(): number { return 1; }" },
      [1],
    );
    expect(first).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(fingerprintCluster(first)).not.toBe(fingerprintCluster(second));
  });

  it("does not reuse a result when the content changed underneath the same id", async () => {
    // Why the cache is keyed by fingerprint rather than by cluster id: an id
    // survives a real edit, and serving stale findings across one is worse
    // than never caching at all.
    const before = build({ "src/a.ts": "export function a(): void {}" }, [1]);
    const after = build(
      { "src/a.ts": "export function a(): number {\n  return 1;\n}" },
      [1],
    );
    expect(before[0]?.id).toBe(after[0]?.id);

    const cache = createMemoryCache();
    let invocations = 0;
    const analyzer = (): AnalysisResult => {
      invocations += 1;
      return { findings: [], suppressions: [], degradations: [] };
    };

    await runAnalysis(
      before,
      before.map((cluster) => allocateBudget(cluster)),
      { analyzer, cache },
    );
    const second = await runAnalysis(
      after,
      after.map((cluster) => allocateBudget(cluster)),
      { analyzer, cache },
    );

    expect(invocations).toBe(2);
    expect(second.reused).toEqual([]);
  });

  it("reuses a prior result instead of spending budget again", async () => {
    const files = { "src/a.ts": "export function a(): void {}" };
    const clusters = build(files, [1]);
    const allocations = clusters.map((c) => allocateBudget(c));
    const cache = createMemoryCache();

    let invocations = 0;
    const analyzer = () => {
      invocations += 1;
      return { findings: [], suppressions: [], degradations: [] };
    };

    const first = await runAnalysis(clusters, allocations, { analyzer, cache });
    const second = await runAnalysis(clusters, allocations, {
      analyzer,
      cache,
    });

    expect(invocations).toBe(1);
    expect(first.reused).toEqual([]);
    expect(second.reused).toHaveLength(clusters.length);
    // The payoff: a cluster the revision did not touch keeps its findings and
    // its budget is never spent.
    expect(second.analyzed).toBe(0);
  });
});
