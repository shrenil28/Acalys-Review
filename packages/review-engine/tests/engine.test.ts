import { describe, expect, it } from "vitest";

import {
  extractFile,
  planContext,
  type AssembledItem,
  type PlannerInput,
} from "@acalys/code-intelligence";

import {
  CONFIDENCE_FLOOR,
  allocateBudget,
  analyzeAsyncCompletion,
  assessChange,
  buildClusters,
  classifyChangeType,
  propose,
  type AnalysisSubject,
  type Proposal,
} from "../src/index.js";

/** Plans context the way the pipeline does, so tests exercise the real seam. */
function plan(
  files: Record<string, string>,
  subject: readonly AnalysisSubject[],
) {
  const input: PlannerInput = {
    changed: subject.map((entry) => ({
      path: entry.path,
      content: files[entry.path] ?? "",
      changedLines: entry.changedLines,
    })),
    repository: Object.entries(files).map(([path, source]) =>
      extractFile(path, source),
    ),
    sources: new Map(Object.entries(files)),
  };
  return planContext(input, 100_000);
}

describe("Risk clusters are semantic units, not files", () => {
  it("keeps unrelated changed files in separate clusters", () => {
    const files = {
      "src/a.ts": "export function a(): void {}",
      "src/b.ts": "export function b(): void {}",
    };
    const subject = [
      { path: "src/a.ts", changedLines: [1] },
      { path: "src/b.ts", changedLines: [1] },
    ];

    const clusters = buildClusters(subject, plan(files, subject).items);
    expect(clusters).toHaveLength(2);
  });

  it("merges a changed caller with the changed callee it imports", () => {
    // The contract between them is what the review is about, so reviewing them
    // apart means neither invocation can see the mismatch.
    const files = {
      "src/caller.ts":
        'import { save } from "./store.js";\nexport function run(): void {\n  save();\n}',
      "src/store.ts": "export function save(): void {}",
    };
    const subject = [
      { path: "src/caller.ts", changedLines: [3] },
      { path: "src/store.ts", changedLines: [1] },
    ];

    const clusters = buildClusters(subject, plan(files, subject).items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.subject.map((entry) => entry.path).sort()).toEqual([
      "src/caller.ts",
      "src/store.ts",
    ]);
  });

  it("merges two changed files that share a dependency", () => {
    const files = {
      "src/one.ts":
        'import { Config } from "./config.js";\nexport const a: Config = {};',
      "src/two.ts":
        'import { Config } from "./config.js";\nexport const b: Config = {};',
      "src/config.ts": "export interface Config { retries?: number }",
    };
    const subject = [
      { path: "src/one.ts", changedLines: [2] },
      { path: "src/two.ts", changedLines: [2] },
    ];

    const clusters = buildClusters(subject, plan(files, subject).items);
    expect(clusters).toHaveLength(1);
  });

  it("puts instructions in every cluster", () => {
    // Conventions change what counts as a defect, so a cluster reviewed
    // without them answers a different question.
    const files: Record<string, string> = {
      "src/a.ts": "export function a(): void {}",
      "src/b.ts": "export function b(): void {}",
    };
    const subject = [
      { path: "src/a.ts", changedLines: [1] },
      { path: "src/b.ts", changedLines: [1] },
    ];
    const context = planContext(
      {
        changed: subject.map((entry) => ({
          path: entry.path,
          content: files[entry.path] ?? "",
          changedLines: entry.changedLines,
        })),
        repository: Object.entries(files).map(([path, source]) =>
          extractFile(path, source),
        ),
        sources: new Map(Object.entries(files)),
        instructions: [{ path: "AGENTS.md", content: "Be strict." }],
      },
      100_000,
    );

    const clusters = buildClusters(subject, context.items);
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) {
      expect(cluster.context.some((item) => item.path === "AGENTS.md")).toBe(
        true,
      );
    }
  });

  it("keeps coverage visible without treating it as changed source", () => {
    const files = {
      "src/caller.ts":
        'import { save } from "./store.js";\nexport function run(): void {\n  save();\n}',
      "src/store.ts": "export function save(): void {}",
    };
    const subject = [
      { path: "src/caller.ts", changedLines: [3] },
      { path: "src/store.ts", changedLines: [1] },
    ];
    const context = plan(files, subject);
    const changed = context.items.find(
      (item) => item.path === "src/caller.ts" && item.reason === "changed_hunk",
    );
    if (changed === undefined) throw new Error("changed context missing");
    const coverage: AssembledItem = {
      ...changed,
      kind: "coverage",
      reason: "instruction_coverage",
      trust: "tool_output",
      content: "Instruction coverage is incomplete.",
      suppliedContent: "Instruction coverage is incomplete.",
      deduplicationKey: "instruction-coverage|src/caller.ts",
    };

    // Coverage deliberately comes first: insertion order must not make prose
    // become the source used to establish imports between changed files.
    const clusters = buildClusters(subject, [coverage, ...context.items]);

    expect(clusters).toHaveLength(1);
    expect(
      clusters[0]?.context.some(
        (item) =>
          item.kind === "coverage" && item.reason === "instruction_coverage",
      ),
    ).toBe(true);
  });
});

describe("Budget allocation", () => {
  const clusterFor = (
    files: Record<string, string>,
    subject: readonly AnalysisSubject[],
  ) => buildClusters(subject, plan(files, subject).items)[0];

  it("cannot produce a finding", () => {
    // Structural, not a convention: the moment a cheap mechanism can publish,
    // it becomes a second reviewer nobody tuned.
    const cluster = clusterFor({ "src/a.ts": "export function a(): void {}" }, [
      { path: "src/a.ts", changedLines: [1] },
    ]);
    if (cluster === undefined) throw new Error("no cluster");

    const allocation = allocateBudget(cluster);
    expect(Object.keys(allocation)).not.toContain("findings");
    expect(Object.keys(allocation)).not.toContain("claims");
  });

  it("rates a small self-contained change low, and spends nothing deep on it", () => {
    const cluster = clusterFor({ "src/a.ts": "export function a(): void {}" }, [
      { path: "src/a.ts", changedLines: [1] },
    ]);
    if (cluster === undefined) throw new Error("no cluster");

    const allocation = allocateBudget(cluster);
    expect(allocation.tier).toBe("low");
    expect(allocation.deepPass).toBe(false);
    expect(allocation.maxReasoningCalls).toBe(0);
  });

  it("rates a contract-sensitive change above a merely large one", () => {
    const contract = clusterFor(
      {
        "src/impl.ts":
          'import type { Store } from "./contract.js";\nexport class S implements Store {\n  get(): string { return ""; }\n}',
        "src/contract.ts": "export interface Store {\n  get(): string;\n}",
      },
      [{ path: "src/impl.ts", changedLines: [3] }],
    );
    const bulk = clusterFor(
      {
        "src/big.ts": `export function big(): void {\n${"  const x = 1;\n".repeat(300)}}`,
      },
      [
        {
          path: "src/big.ts",
          changedLines: Array.from({ length: 300 }, (_u, i) => i + 2),
        },
      ],
    );
    if (contract === undefined || bulk === undefined)
      throw new Error("no cluster");

    const order = ["low", "medium", "high", "critical"];
    expect(order.indexOf(allocateBudget(contract).tier)).toBeGreaterThan(
      order.indexOf(allocateBudget(bulk).tier),
    );
  });
});

describe("A finding must explain itself", () => {
  const complete: Proposal = {
    ruleId: "test/rule",
    family: "error_handling",
    claim: "The promise is discarded.",
    causal: {
      anchor: { path: "src/a.ts", startLine: 3, endLine: 3 },
      steps: ["the call returns a promise", "nothing observes settlement"],
      trigger: "any rejection",
      consequence: "an unhandled rejection",
    },
    remediation: "Add `await`, or `void` if discarding it is deliberate.",
    counterfactual: { existsWithoutChange: false, because: "the line is new" },
    proposedSeverity: "medium",
    location: { path: "src/a.ts", startLine: 3, endLine: 3 },
    evidence: [
      {
        type: "static_analysis",
        strength: "deterministic",
        observation: "declared async at src/store.ts:1",
      },
    ],
    identityHint: "src/a.ts:save:floating",
    clusterId: "cluster:src/a.ts",
  };

  it("accepts a complete proposal and derives confidence from evidence", () => {
    const outcome = propose(complete);
    expect(outcome.kind).toBe("finding");
    if (outcome.kind !== "finding") return;
    expect(outcome.finding.confidenceScore).toBe(0.95);
    expect(outcome.finding.category).toBe("correctness");
    expect(outcome.finding.family).toBe("error_handling");
  });

  it.each([
    ["no_causal_chain", { causal: { ...complete.causal, steps: [] } }],
    ["no_trigger", { causal: { ...complete.causal, trigger: "  " } }],
    ["no_consequence", { causal: { ...complete.causal, consequence: "" } }],
    ["no_evidence", { evidence: [] }],
    ["no_remediation", { remediation: "   " }],
    [
      "pre_existing",
      {
        counterfactual: {
          existsWithoutChange: true,
          because: "predates the change",
        },
      },
    ],
    [
      "below_confidence_floor",
      {
        evidence: [
          {
            type: "agent_observation" as const,
            strength: "weak" as const,
            observation: "it looks suspicious",
          },
        ],
      },
    ],
  ])("suppresses with reason %s", (reason, override) => {
    const outcome = propose({ ...complete, ...override });
    expect(outcome.kind).toBe("suppressed");
    if (outcome.kind !== "suppressed") return;
    expect(outcome.suppression.reason).toBe(reason);
    // Recorded, not silent: "considered and rejected" is tunable, "never
    // noticed" is not.
    expect(outcome.suppression.detail).not.toBe("");
    expect(outcome.suppression.ruleId).toBe("test/rule");
  });

  it("keeps the floor above the weak-evidence ceiling", () => {
    // If weak evidence could clear the floor, the floor would permit exactly
    // the comments it exists to stop.
    expect(CONFIDENCE_FLOOR).toBeGreaterThan(0.3);
  });
});

describe("The async-completion analyzer", () => {
  const analyze = (
    files: Record<string, string>,
    subject: readonly AnalysisSubject[],
  ) => analyzeAsyncCompletion({ context: plan(files, subject), subject });

  it("finds a floating promise using a declaration from another file", () => {
    // The cross-file case, and the reason the planner matters: the `async`
    // keyword that makes this a defect is not in the changed file.
    const files = {
      "src/caller.ts": [
        'import { save } from "./store.js";',
        "export function run(): void {",
        "  save();",
        "}",
      ].join("\n"),
      "src/store.ts": "export async function save(): Promise<void> {}",
    };

    const result = analyze(files, [
      { path: "src/caller.ts", changedLines: [3] },
    ]);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.ruleId).toContain("floating-promise");
    expect(finding?.family).toBe("error_handling");
    expect(finding?.causal.steps.length).toBeGreaterThan(1);
    expect(
      finding?.evidence.some((e) => e.observation.includes("src/store.ts")),
    ).toBe(true);
  });

  it("says nothing when the declaration was never supplied", () => {
    // The honest consequence of the analyzer-sees-only-context rule: a defect
    // whose evidence the planner did not supply is not findable, and the
    // planner metrics are what report that.
    const files = {
      "src/caller.ts": [
        'import { save } from "./unsupplied.js";',
        "export function run(): void {",
        "  save();",
        "}",
      ].join("\n"),
    };

    expect(
      analyze(files, [{ path: "src/caller.ts", changedLines: [3] }]).findings,
    ).toEqual([]);
  });

  it("reports an async call used as a condition, at high severity", () => {
    const files = {
      "src/gate.ts": [
        "async function isReady(): Promise<boolean> {",
        "  return false;",
        "}",
        "export function run(): void {",
        "  if (isReady()) {",
        "    return;",
        "  }",
        "}",
      ].join("\n"),
    };

    const result = analyze(files, [{ path: "src/gate.ts", changedLines: [5] }]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toContain("promise-in-condition");
    expect(result.findings[0]?.proposedSeverity).toBe("high");
    expect(result.findings[0]?.family).toBe("control_flow");
  });

  it("reports an async callback handed to forEach", () => {
    const files = {
      "src/loop.ts": [
        "async function save(item: number): Promise<void> {",
        "  return;",
        "}",
        "export function run(items: number[]): void {",
        "  items.forEach(async (item) => {",
        "    await save(item);",
        "  });",
        "}",
      ].join("\n"),
    };

    const result = analyze(files, [{ path: "src/loop.ts", changedLines: [5] }]);
    expect(
      result.findings.some((f) => f.ruleId.includes("discarded-in-iteration")),
    ).toBe(true);
  });

  it.each([
    ["await", "  await save();"],
    ["void", "  void save();"],
    ["a catch handler", "  save().catch(() => {});"],
    ["assignment", "  const p = save();"],
    ["being returned", "  return save();"],
    ["being passed on", "  Promise.all([save()]);"],
  ])("stays silent when the promise is handled by %s", (_label, statement) => {
    // Each of these is a real statement of intent. Flagging any of them is how
    // a reviewer earns a mute, taking its true findings with it.
    const files = {
      "src/caller.ts": [
        "async function save(): Promise<void> {}",
        "export async function run(): Promise<void> {",
        statement,
        "}",
      ].join("\n"),
    };

    expect(
      analyze(files, [{ path: "src/caller.ts", changedLines: [3] }]).findings,
    ).toEqual([]);
  });

  it("ignores a pre-existing defect on a line the change did not touch", () => {
    const files = {
      "src/caller.ts": [
        "async function save(): Promise<void> {}",
        "export function old(): void {",
        "  save();",
        "}",
        "export function added(): void {",
        "  return;",
        "}",
      ].join("\n"),
    };

    // Only the new function was written.
    expect(
      analyze(files, [{ path: "src/caller.ts", changedLines: [5, 6, 7] }])
        .findings,
    ).toEqual([]);
  });

  it("returns an empty result for clean code, and that is a success", () => {
    const files = {
      "src/clean.ts": [
        "async function save(): Promise<void> {}",
        "export async function run(): Promise<void> {",
        "  await save();",
        "}",
      ].join("\n"),
    };

    const result = analyze(files, [
      { path: "src/clean.ts", changedLines: [3] },
    ]);
    expect(result.findings).toEqual([]);
    expect(result.suppressions).toEqual([]);
    expect(result.degradations).toEqual([]);
  });

  it("keeps identity stable when the defect moves within a file", () => {
    const body = [
      "async function save(): Promise<void> {}",
      "export function run(): void {",
      "  save();",
      "}",
    ].join("\n");

    const near = analyze({ "src/a.ts": body }, [
      { path: "src/a.ts", changedLines: [3] },
    ]);
    const far = analyze({ "src/a.ts": `${"// pad\n".repeat(50)}${body}` }, [
      { path: "src/a.ts", changedLines: [53] },
    ]);

    expect(near.findings[0]?.identityHint).toBe(far.findings[0]?.identityHint);
  });
});

describe("The Triage screen's assessment", () => {
  it("classifies change type by label, then title, then structure", () => {
    expect(
      classifyChangeType({
        labels: ["bug"],
        title: "feat: add thing",
        changedPaths: [],
      }),
    ).toBe("Fix");
    expect(
      classifyChangeType({ title: "refactor: tidy", changedPaths: [] }),
    ).toBe("Refactor");
    expect(
      classifyChangeType({ changedPaths: ["README.md", "docs/a.md"] }),
    ).toBe("Docs");
    expect(classifyChangeType({ changedPaths: ["package.json"] })).toBe(
      "Chore",
    );
    expect(classifyChangeType({ changedPaths: ["src/a.ts"] })).toBe("Feature");
  });

  it("derives risk from the analysis rather than from a second risk model", () => {
    const files = {
      "src/impl.ts":
        'import type { Store } from "./contract.js";\nexport class S implements Store {\n  get(): string { return ""; }\n}',
      "src/contract.ts": "export interface Store {\n  get(): string;\n}",
    };
    const subject = [{ path: "src/impl.ts", changedLines: [3] }];
    const clusters = buildClusters(subject, plan(files, subject).items);
    const allocations = clusters.map((cluster) => allocateBudget(cluster));

    const assessment = assessChange(clusters, allocations, {
      changedPaths: ["src/impl.ts"],
      title: "fix: implement Store",
    });

    expect(assessment.risk).toBe(
      allocations.some((a) => a.tier === "high" || a.tier === "critical")
        ? "High"
        : assessment.risk,
    );
    expect(assessment.changeType).toBe("Fix");
    expect(assessment.reviewEffort).toBeGreaterThan(0);
    // Stated, not implied: the number is context-local and heuristic.
    expect(assessment.basis.contextLocalBlastRadius).toBe(true);
    expect(assessment.basis.effortIsHeuristic).toBe(true);
  });

  it("names symbols in its guidance, or says nothing", () => {
    const files = { "src/a.ts": "export function a(): void {}" };
    const subject = [{ path: "src/a.ts", changedLines: [1] }];
    const clusters = buildClusters(subject, plan(files, subject).items);
    const allocations = clusters.map((cluster) => allocateBudget(cluster));

    const assessment = assessChange(clusters, allocations, {
      changedPaths: ["src/a.ts"],
    });

    // A generic "review carefully" is worse than empty: it occupies the slot a
    // useful sentence would have used.
    expect(assessment.reviewGuidance).toBe("");
  });
});
