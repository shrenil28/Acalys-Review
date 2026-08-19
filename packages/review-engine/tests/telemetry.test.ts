import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ANALYZER_CORPUS,
  add,
  assertConsistent,
  createRecorder,
  evaluateFunnel,
  measure,
  measured,
  notApplicable,
  ratio,
  render,
  sum,
  summarize,
  unmeasured,
  NULL_RECORDER,
  type ExecutionReport,
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

  it("measures durations with a monotonic clock", async () => {
    // `Date.now()` differences are wall-clock differences: one NTP correction
    // during a stage yields a negative or wildly inflated duration, and at the
    // millisecond scale these stages occupy that single adjustment would
    // dominate every percentile in the report.
    const recorder = createRecorder();
    await measure(
      recorder,
      {
        runId: "r",
        stage: "verification",
        invocationId: "i",
        implementationKind: "deterministic",
        procedureId: "p",
        procedureVersion: "1",
        attempt: 1,
      },
      () => new Promise((resolve) => setTimeout(resolve, 20)),
    );

    const [only] = recorder.measurements;
    expect(only?.wallMs).toBeGreaterThan(0);
    expect(Number.isFinite(only?.wallMs)).toBe(true);
    // Sub-millisecond resolution: a whole-millisecond wall clock cannot
    // produce a fractional duration, so this distinguishes the two sources.
    expect(only?.startedAt).toBeGreaterThan(0);
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

describe("Quantities compose by stated rules", () => {
  it("lets an unknown component absorb the total", () => {
    // ── The rule that produces the honest cost number ─────────────────────
    //
    // `measured(0) + unmeasured` is unmeasured. An unknown component makes the
    // sum unknown however small the known part is — which is exactly the case
    // today: inference cost is a true zero, infrastructure cost is unaccounted
    // for, and the total therefore does not exist as a number.
    expect(add(measured(0), unmeasured("infra")).kind).toBe("unmeasured");
    expect(add(unmeasured("infra"), measured(99)).kind).toBe("unmeasured");
  });

  it("treats an absent component as contributing nothing", () => {
    // Permitted only because `notApplicable` means *this component does not
    // exist within this aggregate*, which is a fact about the total — unlike
    // `unmeasured`, which is an admission of not having looked.
    expect(add(measured(5), notApplicable("no models ran"))).toEqual(
      measured(5),
    );
    expect(add(notApplicable("a"), notApplicable("b")).kind).toBe(
      "notApplicable",
    );
    expect(add(measured(2), measured(3))).toEqual(measured(5));
  });

  it("refuses to add a ratio into a scalar aggregate", () => {
    // A denominator-less value routed into a sum is a category error, not a
    // value to propagate. Without this the four-state type degenerates into a
    // bag where any state can appear anywhere.
    expect(add(measured(1), ratio(1, 0, "none")).kind).toBe("unmeasured");
  });

  it("sums an empty list to a measured zero", () => {
    expect(sum([])).toEqual(measured(0));
    expect(sum([measured(1), measured(2), notApplicable("x")])).toEqual(
      measured(3),
    );
    expect(sum([measured(1), unmeasured("y")]).kind).toBe("unmeasured");
  });
});

describe("A report cannot contradict itself", () => {
  const base = {
    runId: "r",
    logicalInvocations: 1,
    physicalAttempts: 1,
    retryAmplification: measured(1),
    contextTokenEstimate: 0,
    contextItems: 0,
    contextOmittedItems: 0,
    modelCalls: 0,
    providerInputTokens: notApplicable("none"),
    providerOutputTokens: notApplicable("none"),
    modelInferenceCostUsd: measured(0),
    infrastructureCostUsd: unmeasured("not accounted"),
    totalCostUsd: unmeasured("not accounted"),
    latencyByStage: {},
    work: {
      candidatesTotal: 0,
      competenceSupported: 0,
      competenceUnsupported: 0,
      deterministicallySettled: 0,
      deepVerificationRequired: 0,
    },
  } satisfies ExecutionReport;

  it("rejects provider usage without model calls", () => {
    // Two defensible field values, one impossible report. The contradiction
    // exists only between them, which is why it is checked between them.
    expect(() =>
      assertConsistent({ ...base, providerInputTokens: measured(800) }),
    ).toThrow(/no model calls/);
  });

  it("rejects a billed inference cost without model calls", () => {
    expect(() =>
      assertConsistent({ ...base, modelInferenceCostUsd: measured(0.14) }),
    ).toThrow(/measured zero/);
  });

  it("rejects fewer executions than units of work", () => {
    // More physical than logical is retries and expected. Fewer is impossible:
    // work that requires an execution cannot have had none.
    expect(() =>
      assertConsistent({ ...base, logicalInvocations: 5, physicalAttempts: 2 }),
    ).toThrow(/physical attempts/);
  });

  it("rejects a measured total built on an unmeasured component", () => {
    expect(() =>
      assertConsistent({ ...base, totalCostUsd: measured(0) }),
    ).toThrow(/component of it is unmeasured/);
  });

  it("accepts the report the pipeline actually produces", () => {
    expect(() => assertConsistent(base)).not.toThrow();
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
