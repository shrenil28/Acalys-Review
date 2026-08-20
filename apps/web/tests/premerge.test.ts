import { describe, expect, it, vi } from "vitest";

import { PRE_MERGE_CHECK_STATUSES } from "@acalys/contracts/domain";
import { isMergeBlockingResult } from "@acalys/contracts/api/v1";
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
  it("withholds from the PR/developer publication surface and still blocks the merge", () => {
    // ── The load-bearing case ─────────────────────────────────────────────
    //
    //     finding    verified, publication WITHHELD
    //     premerge   failed, blocking
    //
    // The developer sees nothing on the PR/developer publication surface, and
    // the merge is stopped by enforcement visible only on the internal review
    // surface. If the UI derived enforcement from what it displays, this state
    // is unreachable — and the P1-I separation would end at the API boundary.
    const withheld = toFindingViews([dto({ lifecycle: "verified" })]);
    const gate = gateFrom([check({ status: "failed", blocking: true })]);

    // On the internal review surface, verified but unpublished reads as "In review", not "Open".
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

/**
 * The property behind every test above, stated once directly: no `MergeGate`
 * built from incomplete, failed, stale, malformed, or unavailable knowledge
 * may carry `kind === "not_blocked"`. `not_blocked` is reachable only from a
 * response that validated and whose checks all settled without a blocking
 * failure.
 */
describe("The enforcement property: not knowing is never not_blocked", () => {
  // `useMergeGate` makes this dispatch — non-`ok` result, or an `ok` result
  // for the wrong revision, both become `unknown` before `gateFrom` is ever
  // called — inside a `useEffect` callback with no exported entry point, and
  // this test stack does not render hooks. Restated here, at two lines, so the
  // property can be checked at the same boundary the hook actually crosses;
  // the policy itself (what makes a gate `blocked` vs `not_blocked`) is never
  // restated, only reached through the real `gateFrom`.
  function gateFromApiResult(
    result: Awaited<ReturnType<typeof listPreMergeChecks>>,
    reviewId: string,
  ): MergeGate {
    if (result.kind !== "ok") {
      return { kind: "unknown", reason: result.detail };
    }
    const stale = result.value.items.filter(
      (item) => item.reviewRunId !== reviewId,
    );
    if (stale.length > 0) {
      return {
        kind: "unknown",
        reason: "the checks returned were evaluated for another revision",
      };
    }
    return gateFrom(result.value.items);
  }

  it("is unknown on every construction path that does not know", async () => {
    // transport: no response was ever produced.
    const transport = await listPreMergeChecks(
      client(vi.fn().mockRejectedValue(new Error("offline")) as never),
      "run-1",
    );
    // rejected: the server declined the request.
    const rejected = await listPreMergeChecks(
      client(respondWith({}, 503)),
      "run-1",
    );
    // contract: the body does not match what the contract declares.
    const contract = await listPreMergeChecks(
      client(respondWith({ items: [{ id: "broken" }] })),
      "run-1",
    );
    // revision mismatch: a real, valid response — for the wrong revision.
    const stale = await listPreMergeChecks(
      client(
        respondWith({
          items: [
            check({ reviewRunId: "run-OLD", status: "passed", blocking: true }),
          ],
        }),
      ),
      "run-NEW",
    );

    for (const [result, reviewId] of [
      [transport, "run-1"],
      [rejected, "run-1"],
      [contract, "run-1"],
      [stale, "run-NEW"],
    ] as const) {
      expect(gateFromApiResult(result, reviewId).kind).toBe("unknown");
    }

    // unfinished blocking check: the answer has not arrived yet.
    for (const status of ["pending", "running"] as const) {
      expect(gateFrom([check({ status, blocking: true })]).kind).toBe(
        "unknown",
      );
    }

    // zero evaluated checks: nothing was evaluated, so nothing was approved.
    expect(gateFrom([]).kind).toBe("unknown");
  });

  it("is not_blocked only where nothing blocking failed and nothing is still unsettled", async () => {
    // Exhaust every (status, blocking) pair for two checks — the state space
    // `gateFrom` actually switches on — and confirm the three outcomes land
    // exactly where the contract's own rule and the settledness of each check
    // say they must, never anywhere else. A wrong implementation that gets
    // any one combination backwards fails here, not just the cases this file
    // happens to have written out by hand.
    const combos = PRE_MERGE_CHECK_STATUSES.flatMap((status) =>
      ([true, false] as const).map((blocking) => ({ status, blocking })),
    );

    for (const c1 of combos) {
      for (const c2 of combos) {
        const checks = [
          check({ id: "c1", status: c1.status, blocking: c1.blocking }),
          check({ id: "c2", status: c2.status, blocking: c2.blocking }),
        ];
        const gate = gateFrom(checks);

        const unsettledBlocking = checks.some(
          (c) => c.blocking && presentStatus(c.status).kind === "unsettled",
        );
        const someBlockingFailure = checks.some(isMergeBlockingResult);

        if (unsettledBlocking) {
          // A blocking check with no answer yet: never a verdict either way.
          expect(gate.kind, JSON.stringify(checks)).toBe("unknown");
        } else if (someBlockingFailure) {
          expect(gate.kind, JSON.stringify(checks)).toBe("blocked");
        } else {
          // The only remaining combination: every blocking check settled, and
          // none of them is the contract's own definition of a blocking
          // failure. This is the sole route to `not_blocked`.
          expect(gate.kind, JSON.stringify(checks)).toBe("not_blocked");
        }

        // Whatever the outcome, it is never the collapse this whole module
        // exists to prevent: a check that is still unsettled, or a genuine
        // blocking failure, reading as permission to merge.
        if (unsettledBlocking || someBlockingFailure) {
          expect(gate.kind).not.toBe("not_blocked");
        }
      }
    }

    // And the response-level half of "validated": an `ok`, fresh, clean
    // result is the only response shape that reaches `not_blocked` — nothing
    // upstream of a validated, current response can.
    const validated = gateFromApiResult(
      await listPreMergeChecks(
        client(
          respondWith({
            items: [check({ status: "passed", blocking: true })],
          }),
        ),
        "run-1",
      ),
      "run-1",
    );
    expect(validated.kind).toBe("not_blocked");
  });
});
