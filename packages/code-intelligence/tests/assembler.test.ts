import { describe, expect, it } from "vitest";

import {
  assembleContext,
  estimateTokens,
  type ScoredCandidate,
} from "../src/index.js";

/**
 * The assembler, tested on candidate lists the generator would not produce.
 *
 * `assembleContext` is the only component that spends the budget, and it is
 * exported, so its guarantees have to hold for any input rather than for the
 * shapes today's `generateCandidates` happens to emit. Several of its guards
 * are unreachable through `planContext` — which is exactly why they need a test
 * that reaches them: a guard no test can falsify is a comment.
 *
 * Assembly consumes the list in the order given; ordering is `scoreCandidates`'
 * job. That makes adversarial orderings constructible here.
 */

function candidate(overrides: Partial<ScoredCandidate> = {}): ScoredCandidate {
  const content = overrides.content ?? "export function f(): void {}";
  return {
    kind: "source_file",
    path: "src/a.ts",
    reason: "changed_hunk",
    trust: "repository_source",
    score: 900,
    ...overrides,
    content,
    estimatedTokens: overrides.estimatedTokens ?? estimateTokens(content),
  };
}

const BIG = [
  "export function big(): number {",
  ...Array.from(
    { length: 40 },
    (_unused, index) => `  const v${String(index)} = ${String(index)};`,
  ),
  "  return 0;",
  "}",
].join("\n");

describe("the budget is never exceeded", () => {
  it("holds for every prefix of a large candidate list", () => {
    const scored = Array.from({ length: 30 }, (_unused, index) =>
      candidate({
        path: `src/f${String(index)}.ts`,
        content: BIG,
        score: 900 - index,
      }),
    );

    for (const budget of [0, 1, 10, 60, 137, 500, 5_000]) {
      const context = assembleContext(scored, budget);
      expect(
        `${String(budget)}:${String(context.budget.consumed <= budget)}`,
      ).toBe(`${String(budget)}:true`);
    }
  });

  it("records every candidate exactly once, as an item or an omission", () => {
    // Nothing may vanish silently. "Dropped for budget" and "never considered"
    // are different facts, and only the first explains a missed finding.
    const scored = Array.from({ length: 12 }, (_unused, index) =>
      candidate({ path: `src/f${String(index)}.ts`, content: BIG }),
    );
    const context = assembleContext(scored, 300);

    expect(context.items.length + context.omissions.length).toBe(scored.length);
  });
});

describe("de-duplication guards hold for candidate lists the generator cannot produce", () => {
  const body = "export function subject(): number {\n  return 41 + 1;\n}";
  const file = `// header\n${body}\n// trailer`;

  it("collapses a symbol whose body the file already supplied", () => {
    const context = assembleContext(
      [
        candidate({ kind: "source_file", content: file }),
        candidate({
          kind: "symbol",
          reason: "containing_symbol",
          content: body,
          startLine: 2,
          endLine: 4,
        }),
      ],
      10_000,
    );

    expect(context.items[1]?.representation).toBe("metadata");
    expect(context.items[1]?.suppliedContent).not.toContain("return 41 + 1;");
  });

  it("never collapses an instruction, even when a source file repeats its text", () => {
    // Path-scoping already makes this unreachable through `planContext`, but an
    // instruction reduced to "body shown above" is a rule the reviewer cannot
    // read — so the guard is asserted where it can actually be exercised.
    const context = assembleContext(
      [
        candidate({ kind: "source_file", content: file }),
        candidate({
          kind: "instruction",
          reason: "repository_instruction",
          trust: "tenant_instruction",
          content: body,
        }),
      ],
      10_000,
    );

    const instruction = context.items.find(
      (item) => item.kind === "instruction",
    );
    expect(instruction?.representation).toBe("full");
    expect(instruction?.suppliedContent).toBe(body);
  });

  it("collapses in the reverse order too, and frees the tokens it saved", () => {
    const symbolFirst = assembleContext(
      [
        candidate({
          kind: "symbol",
          reason: "containing_symbol",
          content: BIG,
          startLine: 1,
          endLine: 43,
        }),
        candidate({ kind: "source_file", content: `// header\n${BIG}` }),
      ],
      10_000,
    );

    expect(symbolFirst.items[0]?.representation).toBe("metadata");
    // The freed budget is real, not cosmetic: consumption must reflect it.
    expect(symbolFirst.budget.consumed).toBeLessThan(
      estimateTokens(BIG) + estimateTokens(`// header\n${BIG}`),
    );
  });

  it("never collapses into a pointer longer than the text it replaces", () => {
    const tiny = "const a = 1;";
    const context = assembleContext(
      [
        candidate({ kind: "source_file", content: `${tiny}\n// more` }),
        candidate({
          kind: "symbol",
          reason: "containing_symbol",
          content: tiny,
          startLine: 1,
          endLine: 1,
        }),
      ],
      10_000,
    );

    expect(context.items[1]?.representation).toBe("full");
    expect(context.items[1]?.suppliedContent).toBe(tiny);
  });

  it("never points at text that was itself truncated", () => {
    // Reachable only here: an excerpt of a path, followed by a full item on the
    // same path. Pointing the excerpt at the later text would tell the reviewer
    // a declaration is above when truncation may have removed it.
    const excerptable = `${BIG}\n// tail`;
    const context = assembleContext(
      [
        candidate({ kind: "source_file", content: excerptable, score: 900 }),
        candidate({ kind: "source_file", content: "// short", score: 800 }),
      ],
      // Enough to force an excerpt of the first (needs >= 50 remaining), then
      // admit the second in full.
      120,
    );

    const excerpt = context.items.find(
      (item) => item.representation === "excerpt",
    );
    expect(excerpt).toBeDefined();
    expect(excerpt?.suppliedContent).not.toContain("body shown above");
    expect(context.budget.consumed).toBeLessThanOrEqual(120);
  });

  it("every pointer refers to text the context actually contains in full", () => {
    // The invariant that makes pointers safe at all. A pointer to something the
    // reviewer cannot find is strictly worse than the duplication it replaced.
    const context = assembleContext(
      [
        candidate({ kind: "source_file", content: file }),
        candidate({
          kind: "symbol",
          reason: "containing_symbol",
          content: body,
          startLine: 2,
          endLine: 4,
        }),
      ],
      10_000,
    );

    for (const pointer of context.items.filter(
      (item) => item.representation === "metadata",
    )) {
      expect(
        context.items.some(
          (item) =>
            item !== pointer &&
            item.representation === "full" &&
            item.suppliedContent.includes(pointer.content),
        ),
      ).toBe(true);
    }
  });
});

describe("instructions are never truncated", () => {
  it("omits an instruction that does not fit rather than shortening it", () => {
    const long = "Never approve widened auth scope. ".repeat(50);
    const context = assembleContext(
      [
        candidate({
          kind: "instruction",
          path: "AGENTS.md",
          reason: "repository_instruction",
          trust: "tenant_instruction",
          content: long,
        }),
      ],
      100,
    );

    expect(context.items).toHaveLength(0);
    expect(context.omissions[0]?.reason).toBe("budget_exceeded");
  });
});

describe("generated files are dropped before anything competes for budget", () => {
  it("drops the generated file and keeps the hand-written one", () => {
    const context = assembleContext(
      [
        candidate({ path: "generated/client.ts", content: BIG, score: 950 }),
        candidate({
          path: "src/a.test.ts",
          content: "it('x', () => {});",
          score: 700,
        }),
      ],
      60,
      new Set(["generated/client.ts"]),
    );

    expect(context.items.map((item) => item.path)).toEqual(["src/a.test.ts"]);
    expect(context.omissions[0]?.reason).toBe("generated_file");
  });

  it("still supplies an instruction that lives under a generated path", () => {
    // A generated path is a statement about source, not about policy.
    const context = assembleContext(
      [
        candidate({
          kind: "instruction",
          path: "generated/AGENTS.md",
          reason: "repository_instruction",
          trust: "tenant_instruction",
          content: "Be strict.",
        }),
      ],
      1_000,
      new Set(["generated/AGENTS.md"]),
    );

    expect(context.items).toHaveLength(1);
  });
});

describe("de-duplication guards, exercised in the reverse order", () => {
  const body = "export function subject(): number {\n  return 41 + 1;\n}";

  it("never collapses an instruction that a later file on the same path repeats", () => {
    // Only constructible here: `generateCandidates` keys instructions by their
    // own path, so an instruction and a source file never share one.
    const context = assembleContext(
      [
        candidate({
          kind: "instruction",
          path: "src/a.ts",
          reason: "repository_instruction",
          trust: "tenant_instruction",
          content: body,
        }),
        candidate({
          kind: "source_file",
          path: "src/a.ts",
          content: `${body}\n// tail`,
        }),
      ],
      10_000,
    );

    const instruction = context.items.find(
      (item) => item.kind === "instruction",
    );
    expect(instruction?.representation).toBe("full");
    expect(instruction?.suppliedContent).toBe(body);
  });

  it("leaves a short earlier item alone when a pointer would cost more", () => {
    const tiny = "const a = 1;";
    const context = assembleContext(
      [
        candidate({
          kind: "symbol",
          reason: "containing_symbol",
          content: tiny,
          startLine: 1,
          endLine: 1,
        }),
        candidate({ kind: "source_file", content: `${tiny}\n// tail` }),
      ],
      10_000,
    );

    expect(context.items[0]?.representation).toBe("full");
    expect(context.items[0]?.suppliedContent).toBe(tiny);
  });

  it("an excerpt exhausts the budget, so nothing is admitted after one", () => {
    // The property that makes a representation guard unnecessary in
    // `collapseCovered`: excerpting spends every remaining token, so no later
    // item can join a context that already truncated something.
    const long = "x".repeat(10_000);
    const context = assembleContext(
      [
        candidate({ path: "src/big.ts", content: long }),
        candidate({ path: "src/after.ts", content: "// small" }),
      ],
      200,
    );

    expect(context.items).toHaveLength(1);
    expect(context.items[0]?.representation).toBe("excerpt");
    expect(context.budget.consumed).toBe(200);
    expect(context.omissions.map((omission) => omission.path)).toEqual([
      "src/after.ts",
    ]);
  });
});
