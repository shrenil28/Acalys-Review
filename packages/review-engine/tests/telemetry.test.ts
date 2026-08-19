import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ANALYZER_CORPUS,
  createRecorder,
  evaluateFunnel,
  measure,
  measured,
  notApplicable,
  ratio,
  render,
  summarize,
  unmeasured,
  NULL_RECORDER,
  type FunnelReport,
  type Recorder,
} from "../src/eval/index.js";

/**
 * The digest of everything a reviewer would actually see.
 *
 * Substantive fields only. Timestamps, durations and measurement ids are
 * excluded by construction rather than filtered afterwards — a comparison that
 * had to strip telemetry noise would be a comparison that could quietly strip
 * a real difference too.
 */
function substantiveDigest(report: FunnelReport): string {
  const canonical = {
    journeys: report.journeys.map((journey) => ({
      caseId: journey.caseId,
      family: journey.family,
      wanted: journey.wanted,
      status: journey.attempt.status,
      decision:
        journey.attempt.status === "completed"
          ? journey.attempt.decision
          : null,
      reasons:
        journey.attempt.status === "completed"
          ? [...journey.attempt.reasons].sort()
          : [],
      promoted: journey.promoted,
      published: journey.published,
      derivation: journey.derivation,
    })),
    candidates: report.candidates,
    verified: report.verified,
    rejected: report.rejected,
    inconclusive: report.inconclusive,
    promoted: report.promoted,
    published: report.published,
    withheld: report.withheld,
    losses: report.losses,
    publishedPrecision: report.publishedPrecision,
    publishedRecall: report.publishedRecall,
    candidatePrecision: report.candidatePrecision,
    work: report.work,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

describe("Telemetry cannot change what is reviewed", () => {
  it("produces a byte-identical review with instrumentation off and on", async () => {
    // ── The hard gate for this checkpoint ─────────────────────────────────
    //
    // Not "the headline metrics match". Every finding, decision, reason code,
    // promotion, publication and loss attribution, digested. If this differs,
    // the checkpoint fails however green the rest of the suite is.
    //
    // OFF is a recorder that runs no measurement code at all, so identical
    // output demonstrates instrumentation is inert rather than merely careful.
    const off = await evaluateFunnel(ANALYZER_CORPUS, NULL_RECORDER);
    const recorder = createRecorder();
    const on = await evaluateFunnel(ANALYZER_CORPUS, recorder);

    expect(substantiveDigest(on)).toBe(substantiveDigest(off));

    // And prove the ON run actually measured something, or the equality above
    // would hold for the most trivial of reasons.
    expect(recorder.measurements.length).toBeGreaterThan(0);
    expect(recorder.measurements.every((m) => m.wallMs >= 0)).toBe(true);
  });

  it("keeps the frozen quality baseline untouched", async () => {
    // Entering measurement, these numbers are frozen. Movement here is an
    // instrumentation defect, not a new baseline.
    const report = await evaluateFunnel(ANALYZER_CORPUS, createRecorder());
    expect({
      candidatePrecision: report.candidatePrecision,
      publishedPrecision: report.publishedPrecision,
      publishedRecall: report.publishedRecall,
      falsePositivesPublished: report.falsePositivesPublished,
      losses: report.losses,
    }).toEqual({
      candidatePrecision: 1,
      publishedPrecision: 1,
      publishedRecall: 0.8,
      falsePositivesPublished: 0,
      losses: {
        not_proposed: 0,
        verifier_refuted: 0,
        verifier_abstained: 2,
        verification_unavailable: 0,
        policy_withheld: 0,
      },
    });
  });

  it("returns the work's result and rethrows its error unchanged", async () => {
    // A timing wrapper that swallows an exception turns a verifier failure
    // into a silent success — the exact class of defect the verification
    // boundary exists to prevent, arriving through the instrumentation.
    const recorder = createRecorder();
    const describe_ = {
      runId: "r",
      stage: "verification" as const,
      invocationId: "i",
      implementationKind: "deterministic" as const,
      procedureId: "p",
      procedureVersion: "1",
      attempt: 1,
    };

    expect(await measure(recorder, describe_, () => 42)).toBe(42);
    await expect(
      measure(recorder, describe_, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Both recorded, and the failure is marked as one: a cost report that
    // omits failed invocations understates exactly the runs worth
    // investigating.
    expect(recorder.measurements.map((m) => m.outcome)).toEqual([
      "succeeded",
      "failed",
    ]);
  });

  it("survives a recorder that throws", async () => {
    // Telemetry is best effort. A metric sink that is unreachable, slow or
    // broken must not alter a single finding.
    const hostile: Recorder = {
      record: () => {
        throw new Error("sink unavailable");
      },
      measurements: [],
    };
    expect(
      await measure(
        hostile,
        {
          runId: "r",
          stage: "verification",
          invocationId: "i",
          implementationKind: "deterministic",
          procedureId: "p",
          procedureVersion: "1",
          attempt: 1,
        },
        () => "result",
      ),
    ).toBe("result");
  });
});

describe("Quantities say what kind of number they are", () => {
  it("distinguishes a real zero from an absent measurement", () => {
    const report = summarize("run", [], {
      candidatesTotal: 0,
      competenceSupported: 0,
      competenceUnsupported: 0,
      deterministicallySettled: 0,
      deepVerificationRequired: 0,
    });

    // No model calls happened, so nothing was billed: a true zero.
    expect(report.modelInferenceCostUsd).toEqual(measured(0));

    // No provider reported anything, because none was asked. Not zero.
    expect(report.providerInputTokens.kind).toBe("notApplicable");
    expect(report.providerOutputTokens.kind).toBe("notApplicable");

    // ── The number that must never render as $0.00 ────────────────────────
    //
    // CPU, Docker, Postgres and storage are real costs this system does not
    // account for. Reporting the total as zero is how a future model-backed
    // checkpoint gets compared against a figure nobody ever measured, and how
    // "we went from free to fourteen cents" becomes historical fact.
    expect(report.infrastructureCostUsd.kind).toBe("unmeasured");
    expect(report.totalCostUsd.kind).toBe("unmeasured");
    expect(render(report.totalCostUsd)).toMatch(/^unmeasured/);
  });

  it("refuses to render a ratio with no denominator", () => {
    expect(ratio(12_000, 0, "no verified findings").kind).toBe(
      "undefinedRatio",
    );
    expect(render(ratio(12_000, 0, "no verified findings"))).toMatch(
      /^undefined/,
    );
    expect(ratio(10, 2, "n/a")).toEqual(measured(5));
  });

  it("renders each kind distinguishably", () => {
    expect(render(measured(3))).toBe("3");
    expect(render(notApplicable("no models ran"))).toBe("N/A (no models ran)");
    expect(render(unmeasured("not accounted for"))).toBe(
      "unmeasured (not accounted for)",
    );
  });

  it("separates added execution time from latency", () => {
    // Four concurrent 100ms calls are 400ms of execution and ~100ms of wall
    // time. Labelling the sum as latency would make parallelism look like a
    // regression.
    const now = Date.now();
    const report = summarize(
      "run",
      Array.from({ length: 4 }, (_unused, index) => ({
        runId: "run",
        stage: "verification" as const,
        invocationId: `i${String(index)}`,
        implementationKind: "deterministic" as const,
        procedureId: "p",
        procedureVersion: "1",
        startedAt: now,
        completedAt: now + 100,
        wallMs: 100,
        attempt: 1,
        outcome: "succeeded" as const,
      })),
      {
        candidatesTotal: 4,
        competenceSupported: 4,
        competenceUnsupported: 0,
        deterministicallySettled: 4,
        deepVerificationRequired: 0,
      },
    );

    const verification = report.latencyByStage.verification;
    expect(verification?.n).toBe(4);
    expect(verification?.p50).toEqual(measured(100));
    expect(verification?.sumExecutionMs).toBe(400);
  });

  it("counts logical invocations apart from physical attempts", () => {
    // One candidate verified, two provider requests paid for. A report that
    // cannot say both hides reliability regressions inside a flat cost number.
    const now = Date.now();
    const base = {
      runId: "run",
      stage: "verification" as const,
      invocationId: "same-invocation",
      implementationKind: "deterministic" as const,
      procedureId: "p",
      procedureVersion: "1",
      startedAt: now,
      completedAt: now + 10,
      wallMs: 10,
      outcome: "succeeded" as const,
    };
    const report = summarize(
      "run",
      [
        { ...base, attempt: 1 },
        { ...base, attempt: 2 },
      ],
      {
        candidatesTotal: 1,
        competenceSupported: 1,
        competenceUnsupported: 0,
        deterministicallySettled: 1,
        deepVerificationRequired: 0,
      },
    );

    expect(report.logicalInvocations).toBe(1);
    expect(report.physicalAttempts).toBe(2);
    expect(report.retryAmplification).toEqual(measured(2));
  });
});
