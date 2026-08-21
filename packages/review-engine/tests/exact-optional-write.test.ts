/**
 * P1-M.2 mechanism witness — `exact_optional_property_write`.
 *
 * Two stages that must disagree when the code is fine:
 *
 * ```
 * analyzer   syntax + governing option        cheap, fallible
 * verifier   the project, built and compiled  authoritative
 * ```
 *
 * The tests are arranged so that a verifier which could only ever agree would
 * fail visibly. That is the property P1-H and P1-J are built on, and the one a
 * new capability is most likely to erode by accident.
 */

import { describe, expect, it } from "vitest";

import {
  EXACT_OPTIONAL_WRITE_RULE_ID,
  analyzeExactOptionalWrite,
} from "../src/correctness/exact-optional-write.js";
import {
  EXACT_OPTIONAL_DIAGNOSTIC_CODE,
  verifyExactOptionalWrite,
} from "../src/verification/exact-optional.js";
import type { AssembledItem } from "@acalys/code-intelligence";

const STRICT_CONFIG = JSON.stringify({
  compilerOptions: { strict: true, exactOptionalPropertyTypes: true },
});
const RELAXED_CONFIG = JSON.stringify({
  compilerOptions: { strict: true, exactOptionalPropertyTypes: false },
});

/** The defect: `tag?: string`, so the declared type excludes `undefined`. */
const VIOLATING_SOURCE = [
  "interface Entry { tag?: string }",
  "export function clear(entry: Entry): void {",
  "  entry.tag = undefined;",
  "}",
].join("\n");

/**
 * The trap: syntactically identical, semantically legal.
 *
 * `Maybe<string>` includes `undefined`, so the compiler affirmatively permits
 * the write. A syntax-and-config analyzer cannot see that and should not try —
 * this is what the verifier exists to settle.
 */
const PERMITTED_SOURCE = [
  "type Maybe<T> = T | undefined;",
  "interface Entry { value?: Maybe<string> }",
  "export function clear(entry: Entry): void {",
  "  entry.value = undefined;",
  "}",
].join("\n");

function sourceItem(path: string, content: string): AssembledItem {
  return {
    kind: "source_file",
    path,
    reason: "changed_hunk",
    trust: "repository_source",
    content,
    suppliedContent: content,
    representation: "full",
    ordinal: 0,
    score: 900,
    estimatedTokens: 10,
  };
}

function configItem(
  path: string,
  content: string,
  governs: string,
): AssembledItem {
  return {
    kind: "configuration",
    path,
    reason: "configuration",
    trust: "repository_source",
    content,
    suppliedContent: content,
    representation: "full",
    ordinal: 1,
    score: 400,
    estimatedTokens: 10,
    provenance: {
      source: "configuration_facts",
      factIdentity: "test",
      citation: `${path} governs ${governs}`,
    },
  };
}

const analyze = (
  items: readonly AssembledItem[],
  changedLines: number[],
  path: string,
) =>
  analyzeExactOptionalWrite({
    context: { items, omissions: [], budget: { limit: 1000, consumed: 10 } },
    subject: [{ path, changedLines }],
    clusterId: "cluster:m2",
  });

const verifyContext = (files: Record<string, string>) => ({
  items: Object.entries(files).map(([path, content]) => ({
    path,
    content,
    reason: "changed_hunk",
  })),
  digest: "test",
  incomplete: false,
});

// ---------------------------------------------------------------------------

describe("the analyzer forms a hypothesis only when the option governs", () => {
  it("emits a candidate when a governing project enables the option", () => {
    const result = analyze(
      [
        sourceItem("src/cache.ts", VIOLATING_SOURCE),
        configItem("tsconfig.json", STRICT_CONFIG, "src/cache.ts"),
      ],
      [3],
      "src/cache.ts",
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe(EXACT_OPTIONAL_WRITE_RULE_ID);
    expect(result.findings[0]?.location.startLine).toBe(3);
  });

  it("emits nothing when the option is off", () => {
    // ANALYZER SUPPRESSION, not verifier refutation. The analyzer consumes the
    // governing option, so with it off no hypothesis is formed and the
    // verifier is never reached. Conflating this with refutation would leave
    // the verifier's ability to disagree entirely untested.
    const result = analyze(
      [
        sourceItem("src/cache.ts", VIOLATING_SOURCE),
        configItem("tsconfig.json", RELAXED_CONFIG, "src/cache.ts"),
      ],
      [3],
      "src/cache.ts",
    );

    expect(result.findings).toEqual([]);
  });

  it("emits nothing when no governing configuration was selected", () => {
    // Governance undetermined, not_governed, or not_indexed all arrive here as
    // "no configuration item". Forming a hypothesis from that absence would be
    // reasoning from our own failure to look.
    const result = analyze(
      [sourceItem("src/cache.ts", VIOLATING_SOURCE)],
      [3],
      "src/cache.ts",
    );

    expect(result.findings).toEqual([]);
  });

  it("emits nothing when the config governs a different file", () => {
    const result = analyze(
      [
        sourceItem("src/cache.ts", VIOLATING_SOURCE),
        configItem("tsconfig.json", STRICT_CONFIG, "src/other.ts"),
      ],
      [3],
      "src/cache.ts",
    );

    expect(result.findings).toEqual([]);
  });

  it("emits nothing for an unchanged line", () => {
    const result = analyze(
      [
        sourceItem("src/cache.ts", VIOLATING_SOURCE),
        configItem("tsconfig.json", STRICT_CONFIG, "src/cache.ts"),
      ],
      [2],
      "src/cache.ts",
    );

    expect(result.findings).toEqual([]);
  });

  it("emits nothing when the property is not optional", () => {
    const required = VIOLATING_SOURCE.replace(
      "tag?: string",
      "tag: string | undefined",
    );
    const result = analyze(
      [
        sourceItem("src/cache.ts", required),
        configItem("tsconfig.json", STRICT_CONFIG, "src/cache.ts"),
      ],
      [3],
      "src/cache.ts",
    );

    expect(result.findings).toEqual([]);
  });
});

describe("plural governance produces one candidate, not one per project", () => {
  it("aggregates several governing projects into a single finding", () => {
    // L.4.2 established that two projects can genuinely admit one file.
    // Publishing the same defect once per tsconfig would be a precision
    // failure wearing the costume of thoroughness.
    const result = analyze(
      [
        sourceItem("src/cache.ts", VIOLATING_SOURCE),
        configItem("tsconfig.json", STRICT_CONFIG, "src/cache.ts"),
        configItem("packages/api/tsconfig.json", STRICT_CONFIG, "src/cache.ts"),
      ],
      [3],
      "src/cache.ts",
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.claim).toContain("tsconfig.json");
    expect(result.findings[0]?.claim).toContain("packages/api/tsconfig.json");
  });

  it("keeps a candidate when one project enables the option and another does not", () => {
    // Partial governance is not ambiguity. The claim is scoped to the project
    // that forbids the write, and the presence of a permissive sibling does not
    // make the violation disappear from the strict one.
    const result = analyze(
      [
        sourceItem("src/cache.ts", VIOLATING_SOURCE),
        configItem("tsconfig.json", RELAXED_CONFIG, "src/cache.ts"),
        configItem("packages/api/tsconfig.json", STRICT_CONFIG, "src/cache.ts"),
      ],
      [3],
      "src/cache.ts",
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.claim).toContain("packages/api/tsconfig.json");
    expect(result.findings[0]?.claim).not.toContain(" tsconfig.json,");
  });
});

describe("the verifier can confirm and, decisively, refute", () => {
  it("verifies a genuine violation from the compiler's own diagnostic", () => {
    const outcome = verifyExactOptionalWrite(
      {
        path: "src/cache.ts",
        startLine: 3,
        endLine: 3,
        configPaths: ["tsconfig.json"],
      },
      verifyContext({
        "src/cache.ts": VIOLATING_SOURCE,
        "tsconfig.json": STRICT_CONFIG,
      }),
    );

    expect(outcome.kind).toBe("verified");
    expect(outcome.detail).toContain(String(EXACT_OPTIONAL_DIAGNOSTIC_CODE));
  });

  it("REJECTS a hypothesis the compiler affirmatively permits", () => {
    // The independence proof. The analyzer's syntactic reading says "optional
    // property assigned undefined under an enabled option", which is exactly
    // the defect shape — and the declared type includes `undefined`, so
    // TypeScript reports nothing.
    //
    // A verifier that could only agree passes every other test in this file
    // and fails this one.
    const outcome = verifyExactOptionalWrite(
      {
        path: "src/permitted.ts",
        startLine: 4,
        endLine: 4,
        configPaths: ["tsconfig.json"],
      },
      verifyContext({
        "src/permitted.ts": PERMITTED_SOURCE,
        "tsconfig.json": STRICT_CONFIG,
      }),
    );

    expect(outcome.kind).toBe("rejected");
  });

  it("proves the analyzer really does hypothesise on the permitted source", () => {
    // The premise for the refutation test. If the analyzer produced nothing
    // here, "the verifier rejected it" would be true of a candidate that never
    // existed, and the independence proof would be vacuous.
    const result = analyze(
      [
        sourceItem("src/permitted.ts", PERMITTED_SOURCE),
        configItem("tsconfig.json", STRICT_CONFIG, "src/permitted.ts"),
      ],
      [4],
      "src/permitted.ts",
    );

    expect(result.findings).toHaveLength(1);
  });

  it("is inconclusive when the changed file is absent from context", () => {
    const outcome = verifyExactOptionalWrite(
      {
        path: "src/cache.ts",
        startLine: 3,
        endLine: 3,
        configPaths: ["tsconfig.json"],
      },
      verifyContext({ "tsconfig.json": STRICT_CONFIG }),
    );

    expect(outcome.kind).toBe("inconclusive");
  });

  it("is inconclusive when no governing configuration was supplied", () => {
    // Never `rejected`. An unbuildable project is the absence of an answer,
    // and reporting it as a refutation would let a broken environment silently
    // clear every candidate.
    const outcome = verifyExactOptionalWrite(
      {
        path: "src/cache.ts",
        startLine: 3,
        endLine: 3,
        configPaths: [],
      },
      verifyContext({ "src/cache.ts": VIOLATING_SOURCE }),
    );

    expect(outcome.kind).toBe("inconclusive");
  });

  it("is inconclusive when the governing config cannot be parsed", () => {
    const outcome = verifyExactOptionalWrite(
      {
        path: "src/cache.ts",
        startLine: 3,
        endLine: 3,
        configPaths: ["tsconfig.json"],
      },
      verifyContext({
        "src/cache.ts": VIOLATING_SOURCE,
        "tsconfig.json": "{ this is not json",
      }),
    );

    expect(outcome.kind).toBe("inconclusive");
  });

  it("does not verify from a diagnostic outside the claimed region", () => {
    const twoWrites = [
      "interface Entry { tag?: string; other?: string }",
      "export function clear(entry: Entry): void {",
      "  entry.tag = undefined;",
      "  entry.other = undefined;",
      "}",
    ].join("\n");

    // The claim is about line 4; line 3 also violates. A verifier matching any
    // diagnostic in the file would confirm a claim it never checked.
    const outcome = verifyExactOptionalWrite(
      {
        path: "src/two.ts",
        startLine: 4,
        endLine: 4,
        configPaths: ["tsconfig.json"],
      },
      verifyContext({
        "src/two.ts": twoWrites,
        "tsconfig.json": STRICT_CONFIG,
      }),
    );

    expect(outcome.kind).toBe("verified");

    const wrongRegion = verifyExactOptionalWrite(
      {
        path: "src/two.ts",
        startLine: 2,
        endLine: 2,
        configPaths: ["tsconfig.json"],
      },
      verifyContext({
        "src/two.ts": twoWrites,
        "tsconfig.json": STRICT_CONFIG,
      }),
    );

    expect(wrongRegion.kind).toBe("rejected");
  });
});

describe("the analyzer never asks the compiler", () => {
  it("holds no reference to a Program, checker, or diagnostics", async () => {
    // Structural, not a promise in a comment. An analyzer that asked the
    // compiler whether the code is wrong would make both stages one opinion
    // consulted twice, and every test above would still pass.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../src/correctness/exact-optional-write.ts", import.meta.url),
        "utf8",
      ),
    );

    for (const forbidden of [
      "createProgram",
      "getTypeChecker",
      "getSemanticDiagnostics",
      "getPreEmitDiagnostics",
    ]) {
      expect(source, `analyzer must not call ${forbidden}`).not.toContain(
        `${forbidden}(`,
      );
    }
  });
});
