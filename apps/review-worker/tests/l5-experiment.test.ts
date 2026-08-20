import {
  DEFAULT_PREMERGE_CONFIG,
  DEFAULT_PUBLICATION_CONFIG,
  DEFAULT_VERIFICATION_POLICY,
} from "@acalys/review-engine";
import { describe, expect, it } from "vitest";

import { L5_CORPUS } from "../src/eval/l5-corpus.js";
import {
  L5_EXPERIMENT_REPORT_SCHEMA_VERSION,
  runL5QualityContextExperiment,
} from "../src/eval/l5-experiment.js";
import { L5_MODE_IDS } from "../src/eval/l5-run.js";

const OPTIONS = {
  repositoryId: "0192f8a1-0000-7000-8000-0000000000a5",
  tenantId: "tenant-l5-experiment",
  policies: {
    verifierPolicy: DEFAULT_VERIFICATION_POLICY,
    publicationPolicy: DEFAULT_PUBLICATION_CONFIG,
    premergePolicy: DEFAULT_PREMERGE_CONFIG,
  },
} as const;

describe("P1-L.5 quality/context experiment composer", () => {
  it("retains every guarded mode and per-case audit in a canonical report", async () => {
    const corpusCase = L5_CORPUS.cases.find(
      (candidate) => candidate.id === "binding-floating-reservation",
    );
    if (corpusCase === undefined) throw new Error("missing L.5 fixture");
    const report = await runL5QualityContextExperiment({
      ...OPTIONS,
      corpus: { ...L5_CORPUS, cases: [corpusCase] },
    });

    expect(report.schemaVersion).toBe(L5_EXPERIMENT_REPORT_SCHEMA_VERSION);
    expect(report.caseRows).toHaveLength(1);
    expect(Object.keys(report.caseRows[0]?.modes ?? {}).sort()).toEqual(
      [...L5_MODE_IDS].sort(),
    );
    expect(
      Object.values(report.caseRows[0]?.modes ?? {}).every(
        (mode) =>
          mode.recorderAudit.passed &&
          mode.context.reconciliation.selectedBytes &&
          Object.values(mode.substantiveHashes).every((hash) =>
            /^[0-9a-f]{64}$/.test(hash),
          ),
      ),
    ).toBe(true);
    expect(report.audits).toEqual({
      equivalencePairs: 6,
      recorderModeExecutions: 7,
      invalidOrExcludedRuns: [],
    });
    expect(report.quality.control.counts.cases).toBe(1);
    expect(report.quality.treatment.counts.cases).toBe(1);
    expect(report.context.control.cases).toBe(1);
    expect(report.context.treatment.cases).toBe(1);
  });
});
