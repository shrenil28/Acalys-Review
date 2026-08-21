import { describe, expect, it } from "vitest";

import { INCLUSION_REASONS, type InclusionReason } from "../src/planner.js";
import {
  InvalidL5ContextObservationError,
  UNDEFINED_RATIO,
  accountL5Context,
  factFamilyFor,
  reportReasonFor,
  type L5ContextAccountingInput,
  type L5ContextCandidateObservation,
  type L5FactFamily,
  type L5ReportReason,
} from "../src/eval/l5-context.js";

const EXPECTED_REPORT_REASONS = {
  changed_hunk: "changed_source",
  containing_symbol: "declaration",
  indexed_declaration: "declaration",
  referenced_symbol: "declaration",
  caller: "caller",
  associated_test: "test",
  configuration: "config",
  repository_instruction: "instruction",
  path_instruction: "instruction",
  instruction_coverage: "coverage",
  prior_finding: "other",
  git_history: "other",
  base_revision: "other",
} as const satisfies Readonly<Record<InclusionReason, L5ReportReason>>;

/**
 * Production inclusion reasons that L.5 has no fact family for, on purpose.
 *
 * Not an exemption from coverage — the opposite. Each of these is asserted
 * below to be *refused* by `factFamilyFor`, so the combination table stays
 * exhaustive over everything L.5 can legitimately see, and a reason that
 * belongs in neither list fails the coverage assertion.
 */
const REASONS_L5_REFUSES = ["base_revision"] as const;

const VALID_PRODUCTION_COMBINATIONS = [
  ["changed_hunk", undefined, "none"],
  ["containing_symbol", "direct_source", "none"],
  ["indexed_declaration", "repository_index", "structural_index"],
  ["referenced_symbol", "direct_source", "none"],
  ["referenced_symbol", "repository_index", "binding"],
  ["caller", "direct_source", "none"],
  ["caller", "repository_index", "binding"],
  ["associated_test", "direct_source", "none"],
  ["associated_test", "repository_index", "test_relationship"],
  ["configuration", "configuration_facts", "config_governance"],
  ["repository_instruction", "direct_source", "none"],
  ["repository_instruction", "instruction_facts", "instruction_governance"],
  ["path_instruction", "direct_source", "none"],
  ["path_instruction", "instruction_facts", "instruction_governance"],
  ["instruction_coverage", "instruction_coverage", "instruction_governance"],
  ["prior_finding", "direct_source", "none"],
  ["git_history", "direct_source", "none"],
] as const satisfies readonly (readonly [
  InclusionReason,
  string | undefined,
  L5FactFamily,
])[];

function candidate(
  candidateId: string,
  overrides: Partial<L5ContextCandidateObservation> = {},
): L5ContextCandidateObservation {
  return {
    candidateId,
    path: "src/example.ts",
    reason: "changed_hunk",
    originalContent: "export const value = 1;",
    ...overrides,
  };
}

function emptyAccounting(
  overrides: Partial<L5ContextAccountingInput> = {},
): L5ContextAccountingInput {
  return {
    offered: [],
    scoredCandidateIds: [],
    selected: [],
    omittedCandidateIds: [],
    labels: [],
    ...overrides,
  };
}

describe("P1-L.5 production taxonomy", () => {
  it("maps every production inclusion reason into the frozen report taxonomy", () => {
    expect(new Set(Object.keys(EXPECTED_REPORT_REASONS))).toEqual(
      new Set(INCLUSION_REASONS),
    );
    for (const reason of INCLUSION_REASONS) {
      expect(reportReasonFor(reason)).toBe(EXPECTED_REPORT_REASONS[reason]);
    }
  });

  it("maps every established production reason/provenance combination", () => {
    const coveredReasons = new Set<InclusionReason>();
    for (const [
      reason,
      provenance,
      expected,
    ] of VALID_PRODUCTION_COMBINATIONS) {
      coveredReasons.add(reason);
      expect(factFamilyFor(reason, provenance)).toBe(expected);
    }
    expect(coveredReasons).toEqual(
      new Set(
        INCLUSION_REASONS.filter(
          (reason) =>
            !(REASONS_L5_REFUSES as readonly string[]).includes(reason),
        ),
      ),
    );
  });

  it("refuses the reasons it has deliberately no family for", () => {
    // The other half of the coverage assertion above. Without this, moving a
    // reason into REASONS_L5_REFUSES would be a way to make an unmapped
    // reason pass silently instead of a way to declare it out of scope.
    for (const reason of REASONS_L5_REFUSES) {
      expect(() => factFamilyFor(reason, "base_revision_facts")).toThrow(
        InvalidL5ContextObservationError,
      );
    }
  });

  it("rejects new reasons, new provenance, and impossible production pairs", () => {
    expect(() => reportReasonFor("future_reason")).toThrow(
      "Unknown production inclusion reason",
    );
    expect(() => factFamilyFor("changed_hunk", "future_source")).toThrow(
      "Unknown production provenance source",
    );
    expect(() => factFamilyFor("indexed_declaration", "direct_source")).toThrow(
      "Unrecognized production reason/provenance combination",
    );
    expect(() => factFamilyFor("configuration", "repository_index")).toThrow(
      "Unrecognized production reason/provenance combination",
    );
    expect(() =>
      factFamilyFor("instruction_coverage", "instruction_facts"),
    ).toThrow("Unrecognized production reason/provenance combination");
  });
});

describe("P1-L.5 context accounting", () => {
  it("accounts original and supplied estimates and reconciles every detail row", () => {
    const original = "alpha\nbeta\ngamma\n";
    const supplied = "HEAD\nbeta\ngamma\n";
    const input = emptyAccounting({
      offered: [
        candidate("changed", {
          originalContent: original,
          originalStartLine: 1,
        }),
        candidate("caller", {
          path: "src/caller.ts",
          reason: "caller",
          provenanceSource: "direct_source",
          originalContent: "caller body",
        }),
        candidate("deduplicated", {
          reason: "indexed_declaration",
          provenanceSource: "repository_index",
          originalContent: "dup",
        }),
      ],
      // Repeated ids cannot inflate the unique scored count.
      scoredCandidateIds: ["changed", "caller", "changed"],
      selected: [
        {
          candidateId: "changed",
          suppliedContent: supplied,
          truncated: true,
          sourceSlices: [
            { originalStartByte: 6, suppliedStartByte: 5, byteLength: 5 },
            { originalStartByte: 11, suppliedStartByte: 10, byteLength: 6 },
          ],
        },
        // Slice traversal order cannot turn the same selection into two items.
        {
          candidateId: "changed",
          suppliedContent: supplied,
          truncated: true,
          sourceSlices: [
            { originalStartByte: 11, suppliedStartByte: 10, byteLength: 6 },
            { originalStartByte: 6, suppliedStartByte: 5, byteLength: 5 },
          ],
        },
      ],
      omittedCandidateIds: ["caller", "caller"],
      labels: [
        {
          labelId: "required-line",
          classification: "required",
          selector: {
            kind: "line_range",
            path: "src/example.ts",
            startLine: 2,
            endLine: 2,
          },
        },
        {
          labelId: "overlapping-required-content",
          classification: "required",
          selector: {
            kind: "content",
            path: "src/example.ts",
            content: "beta\n",
          },
        },
        {
          labelId: "forbidden-content",
          classification: "forbidden",
          selector: {
            kind: "content",
            path: "src/example.ts",
            content: "gamma",
          },
        },
      ],
    });

    const result = accountL5Context(input);

    expect(result.totals.offered).toEqual({ items: 3, estimatedTokens: 9 });
    expect(result.totals.scored).toEqual({ items: 2, estimatedTokens: 8 });
    expect(result.totals.selected).toEqual({ items: 1, estimatedTokens: 4 });
    expect(result.totals.omitted).toEqual({ items: 1, estimatedTokens: 3 });
    expect(result.totals.truncated).toEqual({
      items: 1,
      originalEstimatedTokens: 5,
      suppliedEstimatedTokens: 4,
      droppedEstimatedTokens: 1,
    });
    expect(result.duplicatesSuppressed).toBe(1);
    expect(result.selectedClassification).toEqual({
      all: { items: 1, estimatedTokens: 4 },
      usefulBytes: 5,
      usefulEstimatedTokens: 2,
      irrelevantBytes: 5,
      irrelevantEstimatedTokens: 2,
      unlabelledBytes: 6,
      unlabelledEstimatedTokens: 2,
      contextEfficiency: 0.5,
    });
    expect(result.byReason.changed_source.selected.items).toBe(1);
    expect(result.byReason.caller.omitted.items).toBe(1);
    expect(result.byFamily.structural_index.offered.items).toBe(1);
    expect(result.byFamily.none.offered.items).toBe(2);
    expect(result.reconciliation).toEqual({
      scoredPartition: true,
      reasonRows: true,
      familyRows: true,
      selectedBytes: true,
    });
  });

  it("supports whole-artifact selectors and exact UTF-8 byte accounting", () => {
    const content = "aéz";
    const result = accountL5Context(
      emptyAccounting({
        offered: [candidate("whole", { originalContent: content })],
        scoredCandidateIds: ["whole"],
        selected: [
          { candidateId: "whole", suppliedContent: content, truncated: false },
        ],
        labels: [
          {
            labelId: "whole",
            classification: "required",
            selector: { kind: "whole_artifact", path: "src/example.ts" },
          },
        ],
      }),
    );

    expect(result.selectedClassification.usefulBytes).toBe(4);
    expect(result.selectedClassification.unlabelledBytes).toBe(0);
    expect(result.selectedClassification.usefulEstimatedTokens).toBe(1);
    expect(result.selectedClassification.contextEfficiency).toBe(1);
  });

  it("reports an undefined ratio when no selected-token denominator exists", () => {
    const result = accountL5Context(emptyAccounting());

    expect(result.selectedClassification.contextEfficiency).toBe(
      UNDEFINED_RATIO,
    );
    expect(result.totals.selected).toEqual({ items: 0, estimatedTokens: 0 });
  });

  it("rejects contradictory labels instead of double-counting selected bytes", () => {
    expect(() =>
      accountL5Context(
        emptyAccounting({
          offered: [candidate("selected", { originalContent: "abcdef" })],
          scoredCandidateIds: ["selected"],
          selected: [
            {
              candidateId: "selected",
              suppliedContent: "abcdef",
              truncated: false,
            },
          ],
          labels: [
            {
              labelId: "required",
              classification: "required",
              selector: {
                kind: "content",
                path: "src/example.ts",
                content: "bcd",
              },
            },
            {
              labelId: "forbidden",
              classification: "forbidden",
              selector: {
                kind: "content",
                path: "src/example.ts",
                content: "cde",
              },
            },
          ],
        }),
      ),
    ).toThrow("Required and forbidden selectors overlap");
  });

  it("rejects missing partitions, conflicting duplicate selections, and guessed excerpts", () => {
    const base = emptyAccounting({
      offered: [candidate("selected")],
      scoredCandidateIds: ["selected"],
    });

    expect(() => accountL5Context(base)).toThrow(
      "must be exactly one of selected or omitted",
    );
    expect(() =>
      accountL5Context({
        ...base,
        selected: [
          {
            candidateId: "selected",
            suppliedContent: "export const value = 1;",
            truncated: false,
          },
          {
            candidateId: "selected",
            suppliedContent: "different",
            truncated: true,
            sourceSlices: [],
          },
        ],
      }),
    ).toThrow("Conflicting duplicate selection");
    expect(() =>
      accountL5Context({
        ...base,
        selected: [
          {
            candidateId: "selected",
            suppliedContent: "value",
            truncated: true,
          },
        ],
      }),
    ).toThrow("needs sourceSlices");
  });

  it("rejects source mappings that do not preserve the selected bytes", () => {
    expect(() =>
      accountL5Context(
        emptyAccounting({
          offered: [candidate("mapped", { originalContent: "abcdef" })],
          scoredCandidateIds: ["mapped"],
          selected: [
            {
              candidateId: "mapped",
              suppliedContent: "abXX",
              truncated: true,
              sourceSlices: [
                { originalStartByte: 0, suppliedStartByte: 2, byteLength: 2 },
              ],
            },
          ],
        }),
      ),
    ).toThrow("does not preserve bytes");
  });

  it("rejects malformed labels before selection accounting", () => {
    const malformed = {
      labelId: "bad",
      classification: "future_classification",
      selector: { kind: "whole_artifact", path: "src/example.ts" },
    };

    expect(() =>
      accountL5Context({
        ...emptyAccounting(),
        labels: [malformed] as unknown as L5ContextAccountingInput["labels"],
      }),
    ).toThrow("Unknown context label classification");
  });
});
