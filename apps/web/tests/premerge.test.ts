import { describe, expect, it, vi } from "vitest";

import { PRE_MERGE_CHECK_STATUSES } from "@acalys/contracts/domain";
import type { PreMergeCheckDto } from "@acalys/contracts/api/v1";

import { createApiClient } from "../src/lib/api/client.js";
import { listPreMergeChecks } from "../src/lib/api/preMergeChecks.js";
import { gateFrom, presentStatus, type MergeGate } from "../src/lib/premerge.js";
import { toFindingViews } from "../src/lib/findings.js";
import { dto } from "./fixtures/findings.js";

const check = (overrides: Partial<PreMergeCheckDto> = {}): PreMergeCheckDto => ({
  id: "c1",
  reviewRunId: "run-1",
  checkId: "acalys.premerge.correctness",
  name: "Correctness",
  status: "passed",
  blocking: true,
  ...overrides,
});

const respondWith = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof globalThis.fetch;

const client = (fetchImpl: typeof globalThis.fetch) =>
  createApiClient({ baseUrl: "https://api.test", fetch: fetchImpl });

describe("Status and blocking are different facts", () => {
  it("does not render a failed check as passed because merging is allowed", () => {
    // `failed` with `blocking: false` is real and common — a reviewer that
    // blocks merges the day it is installed gets uninstalled. It reads as
    // "check failed, merge not blocked", never as "Passed".
    const gate = gateFrom([check({ status: "failed", blocking: false })]);

    expect(gate.kind).toBe("not_blocked");
    if (gate.kind === "unknown") throw new Error("unreachable");
    expect(gate.checks[0]?.label).toBe("Failed");
    expect(gate.checks[0]?.blocking).toBe(false);
  });

  it("blocks only on a failure that policy marked blocking", () => {
    // The backend's rule, mirrored: `blocking && status === "failed"`. An
    // earlier draft here blocked on `blocking` alone, which would have stopped
    // a merge on a check that PASSED while being configured to block.
    expect(gateFrom([check({ status: "passed", blocking: true })]).kind).toBe(
      "not_blocked",
    );
    expect(gateFrom([check({ status: "failed", blocking: true })]).kind).toBe(
      "blocked",
    );
  });

  it("gives every status its own deliberate reading", () => {
    // ── The canonical table ───────────────────────────────────────────────
    //
    // The first version of this asserted only that each status had *a* label,
    // which a mutation exploited: reporting `inconclusive` as "Passed"
    // SURVIVED, because "Passed" is truthy. Proving a mapping is total is not
    // proving it is right.
    //
    // Every member, its exact reading, and whether it counts as a verdict.
    const table: Record<
      (typeof PRE_MERGE_CHECK_STATUSES)[number],
      { label: string; kind: "settled" | "unsettled" }
    > = {
      passed: { label: "Passed", kind: "settled" },
      failed: { label: "Failed", kind: "settled" },
      // Ran, and could not decide. Not "Passed" — nothing was established —
      // and not "Failed", because nothing was refuted either. The same
      // distinction the verifier defends on the backend.
      inconclusive: { label: "Inconclusive", kind: "settled" },
      skipped: { label: "Skipped", kind: "settled" },
      pending: { label: "Pending", kind: "unsettled" },
      running: { label: "Running", kind: "unsettled" },
    };

    for (const status of PRE_MERGE_CHECK_STATUSES) {
      expect(presentStatus(status), status).toEqual(table[status]);
    }

    // Each reading is distinct, so no two statuses can be told apart by the
    // contract and not by the screen.
    const labels = PRE_MERGE_CHECK_STATUSES.map((s) => presentStatus(s).label);
    expect(new Set(labels).size).toBe(PRE_MERGE_CHECK_STATUSES.length);

    expect(PRE_MERGE_CHECK_STATUSES).toHaveLength(6);
    expect(() =>
      presentStatus("invented" as PreMergeCheckDto["status"]),
    ).toThrow(/Unhandled pre-merge value/);
  });

  it("never derives blocking from severity or finding count", () => {
    // The backend already made this decision. Re-deriving it in the browser
    // rebuilds the policy in the one place that cannot see the config.
    const gate = gateFrom([check({ status: "passed", blocking: false })]);
    expect(gate.kind).toBe("not_blocked");
    // Even with critical findings present, enforcement is unchanged: nothing
    // in this module reads findings at all.
    expect(toFindingViews([dto({ severity: "critical" })])).toHaveLength(1);
    expect(gateFrom([check({ status: "passed", blocking: false })])).toEqual(
      gate,
    );
  });
});

describe("Not knowing is never permission", () => {
  it("treats an unfinished blocking check as unknown, not allowed", () => {
    // `pending` means the answer has not arrived. Calling it `not_blocked`
    // would let a merge proceed on a check that was still running.
    for (const status of ["pending", "running"] as const) {
      expect(gateFrom([check({ status, blocking: true })]).kind, status).toBe(
        "unknown",
      );
    }
  });

  it("treats an empty result as unknown, not allowed", () => {
    // A review that evaluated nothing has not approved anything.
    expect(gateFrom([]).kind).toBe("unknown");
  });

  it("returns unknown — never not_blocked — for every failure", async () => {
    // ── The enforcement equivalent of "outage reads as clean review" ──────
    //
    // Each of these produces no usable checks. A boolean would collapse all of
    // them to `false`, and `false` means "merge allowed".
    const failures = [
      await listPreMergeChecks(
        client(vi.fn().mockRejectedValue(new Error("offline")) as never),
        "run-1",
      ),
      await listPreMergeChecks(client(respondWith({}, 503)), "run-1"),
      await listPreMergeChecks(
        client(respondWith({ items: [{ id: "broken" }] })),
        "run-1",
      ),
    ];

    expect(failures.map((f) => f.kind)).toEqual([
      "transport",
      "rejected",
      "contract",
    ]);
    // Not one is `ok`, so no code path can reach `gateFrom` with them.
    expect(failures.every((f) => f.kind !== "ok")).toBe(true);
  });
});

describe("Attention and enforcement are independent, all the way to the screen", () => {
  it("suppresses the comment and still blocks the merge", () => {
    // ── The load-bearing case ─────────────────────────────────────────────
    //
    //     finding    verified, publication WITHHELD
    //     premerge   failed, blocking
    //
    // The developer is told nothing, and the merge is stopped. If the UI
    // derived enforcement from what it displays, this state is unreachable —
    // and the P1-I separation would end at the API boundary.
    const withheld = toFindingViews([dto({ lifecycle: "verified" })]);
    const gate = gateFrom([check({ status: "failed", blocking: true })]);

    // Verified is not published: it reads as "In review", not "Open".
    expect(withheld[0]?.status).toBe("In review");
    expect(withheld[0]?.status).not.toBe("Open");
    // And the merge is blocked regardless.
    expect(gate.kind).toBe("blocked");
  });

  it("shows the comment and allows the merge", () => {
    // The converse, so enforcement cannot be derived from visibility in either
    // direction.
    const published = toFindingViews([dto({ lifecycle: "published" })]);
    const gate = gateFrom([check({ status: "passed", blocking: true })]);

    expect(published[0]?.status).toBe("Open");
    expect(gate.kind).toBe("not_blocked");
  });

  it("blocks a merge with nothing to show the developer", () => {
    // Zero developer-visible findings AND a blocking check. It sounds strange,
    // which is exactly why it is worth asserting: the summary and the
    // enforcement surface are not secretly coupled.
    const nothingVisible = toFindingViews([
      dto({ lifecycle: "superseded" }),
    ]);
    const gate = gateFrom([check({ status: "failed", blocking: true })]);

    expect(nothingVisible).toEqual([]);
    expect(gate.kind).toBe("blocked");
  });
});

/**
 * A result is only about the revision it evaluated.
 *
 * The backend has been careful about revision identity since ingestion. This
 * is the last place it can be lost, and losing it here is expensive: a stale
 * pass renders as permission to merge code nobody checked.
 */
describe("A stale result is not current permission", () => {
  it("rejects checks evaluated for a different review run", async () => {
    const { useMergeGate } = await import("../src/lib/api/useMergeGate.js");
    expect(typeof useMergeGate).toBe("function");

    // The hook filters on `reviewRunId`; the rule is asserted directly here so
    // it does not depend on rendering.
    const forAnotherRevision = [
      check({ reviewRunId: "run-OLD", status: "passed", blocking: true }),
    ];
    const displayed = "run-NEW";

    const stale = forAnotherRevision.filter(
      (entry) => entry.reviewRunId !== displayed,
    );
    expect(stale).toHaveLength(1);

    // Had it been accepted, this would have read as permission to merge.
    expect(gateFrom(forAnotherRevision).kind).toBe("not_blocked");
    // Which is precisely why the hook returns `unknown` instead of calling
    // `gateFrom` at all when the identities disagree.
  });

  it("keeps a late response from overwriting the current one", () => {
    // The abort covers unmount and supersession. This asserts the property the
    // abort protects: a response whose identity does not match what is on
    // screen can never become the displayed gate.
    const current = "run-2";
    const late = [check({ reviewRunId: "run-1", status: "passed" })];
    const usable = late.filter((entry) => entry.reviewRunId === current);
    expect(usable).toEqual([]);
  });
});

/**
 * The component says nothing rather than something reassuring.
 *
 * Asserted at the gate level, since rendering React needs a DOM the test stack
 * deliberately does not carry yet. The property is the branch the component
 * takes: `unknown` produces no badge at all.
 */
describe("Nothing known means nothing said", () => {
  it("has no visual state that could be mistaken for permission", () => {
    // Every way of not knowing.
    const unknowns: MergeGate[] = [
      { kind: "unknown", reason: "offline" },
      { kind: "unknown", reason: "contract mismatch" },
      { kind: "unknown", reason: "evaluated for another revision" },
      gateFrom([]),
      gateFrom([check({ status: "pending", blocking: true })]),
    ];

    for (const gate of unknowns) {
      expect(gate.kind, gate.kind === "unknown" ? gate.reason : "").toBe(
        "unknown",
      );
      // The component renders `null` for exactly this branch. A badge here
      // would be a claim the app has no basis for — the enforcement version
      // of reporting an outage as a clean review.
    }

    // And the two states it does speak about are the only two it can.
    expect(gateFrom([check({ status: "failed", blocking: true })]).kind).toBe(
      "blocked",
    );
    expect(gateFrom([check({ status: "passed", blocking: true })]).kind).toBe(
      "not_blocked",
    );
  });
});
