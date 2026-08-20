import { describe, expect, it, vi } from "vitest";

import {
  FINDING_SEVERITIES,
  PRE_MERGE_CHECK_STATUSES,
} from "@acalys/contracts/domain";
import { isMergeBlockingResult } from "@acalys/contracts/api/v1";
import type { PreMergeCheckDto } from "@acalys/contracts/api/v1";

import { createApiClient } from "../src/lib/api/client.js";
import { listPreMergeChecks } from "../src/lib/api/preMergeChecks.js";
// The real freshness rule, not a copy of it. It used to live inside the
// effect, where deleting it left every test in this file green.
import { gateFromApiResult } from "../src/lib/api/useMergeGate.js";
import { gateFrom, presentStatus } from "../src/lib/premerge.js";
import { displaySeverity, toFindingViews } from "../src/lib/findings.js";
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
    // ── Independence, not determinism ─────────────────────────────────────
    //
    // The first version of this called `gateFrom` twice with identical input
    // and asserted the results were equal. That is determinism, and a
    // `gateFrom` that consulted severity would have passed it unchanged.
    //
    // Two things are asserted instead, and a severity-reading implementation
    // fails both.

    // 1. Every field a check carries other than (status, blocking) is inert —
    //    including fields whose text names a severity. An implementation that
    //    read `name`, `checkId` or `explanation` to decide blocking fails
    //    here.
    for (const overrides of [
      { name: "Critical security" },
      { checkId: "acalys.premerge.critical" },
      { explanation: "critical: 3 findings, one of them exploitable" },
      { id: "critical" },
    ] satisfies Partial<PreMergeCheckDto>[]) {
      expect(
        gateFrom([check({ status: "passed", blocking: false, ...overrides })])
          .kind,
        JSON.stringify(overrides),
      ).toBe("not_blocked");
    }

    // 2. The cross product is free: a finding of ANY severity coexists with
    //    every enforcement outcome. A UI that derived blocking from severity
    //    could not produce a `critical` finding beside `not_blocked`, nor an
    //    `info` one beside `blocked`.
    for (const severity of FINDING_SEVERITIES) {
      const views = toFindingViews([dto({ severity })]);
      expect(views[0]?.severity, severity).toBe(displaySeverity(severity));

      expect(
        gateFrom([check({ status: "passed", blocking: true })]).kind,
        severity,
      ).toBe("not_blocked");
      expect(
        gateFrom([check({ status: "failed", blocking: true })]).kind,
        severity,
      ).toBe("blocked");
      expect(
        gateFrom([check({ status: "pending", blocking: true })]).kind,
        severity,
      ).toBe("unknown");
    }
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
    // A real, valid, passing response — for the wrong revision. Run through
    // the shipping function, not a filter written in this file: this test used
    // to re-implement the rule, so deleting the rule left it green.
    const response = await listPreMergeChecks(
      client(
        respondWith({
          items: [
            check({ reviewRunId: "run-OLD", status: "passed", blocking: true }),
          ],
        }),
      ),
      "run-NEW",
    );
    expect(response.kind).toBe("ok");
    if (response.kind !== "ok") throw new Error("unreachable");

    // What it would have said had the identity check been dropped: permission
    // to merge code nobody evaluated.
    expect(gateFrom(response.value.items).kind).toBe("not_blocked");

    const gate = gateFromApiResult(response, "run-NEW");
    expect(gate.kind).toBe("unknown");
    if (gate.kind !== "unknown") throw new Error("unreachable");
    expect(gate.reason).toMatch(/another revision/);
  });

  it("keeps a late response from overwriting the current one", async () => {
    // The abort covers unmount and supersession. This asserts the property the
    // abort protects: a response carrying any check for another revision can
    // never become the displayed gate — even when the rest of it is current,
    // which is the shape a late response for the previous head arrives in.
    const response = await listPreMergeChecks(
      client(
        respondWith({
          items: [
            check({ id: "c1", reviewRunId: "run-2", status: "passed" }),
            check({ id: "c2", reviewRunId: "run-1", status: "passed" }),
          ],
        }),
      ),
      "run-2",
    );

    expect(gateFromApiResult(response, "run-2").kind).toBe("unknown");
    // And the same response, current in full, is usable — so the rule refuses
    // staleness rather than refusing everything.
    const current = await listPreMergeChecks(
      client(
        respondWith({
          items: [check({ id: "c1", reviewRunId: "run-2", status: "passed" })],
        }),
      ),
      "run-2",
    );
    expect(gateFromApiResult(current, "run-2").kind).toBe("not_blocked");
  });
});

/**
 * The component says nothing rather than something reassuring.
 *
 * Asserted at the gate level, since rendering React needs a DOM the test stack
 * deliberately does not carry yet. The property is the branch the component
 * takes: `unknown` produces no badge at all — and an `unknown` that cannot say
 * why is a silence nobody can debug.
 */
describe("Nothing known means nothing said", () => {
  it("keeps every way of not knowing distinguishable, and never reassuring", async () => {
    // ── Constructed, not asserted ─────────────────────────────────────────
    //
    // The first version of this built three `{ kind: "unknown" }` object
    // literals and asserted they were `unknown`. No implementation could fail
    // it. Every gate below comes out of the code that ships.
    const gates = [
      gateFromApiResult(
        await listPreMergeChecks(
          client(vi.fn().mockRejectedValue(new Error("offline")) as never),
          "run-1",
        ),
        "run-1",
      ),
      gateFromApiResult(
        await listPreMergeChecks(client(respondWith({}, 503)), "run-1"),
        "run-1",
      ),
      gateFromApiResult(
        await listPreMergeChecks(
          client(respondWith({ items: [{ id: "broken" }] })),
          "run-1",
        ),
        "run-1",
      ),
      gateFromApiResult(
        await listPreMergeChecks(
          client(
            respondWith({
              items: [check({ reviewRunId: "run-OLD", status: "passed" })],
            }),
          ),
          "run-NEW",
        ),
        "run-NEW",
      ),
      gateFrom([]),
      gateFrom([check({ status: "pending", blocking: true })]),
    ];

    const reasons: string[] = [];
    for (const gate of gates) {
      // The component renders `null` for exactly this branch. A badge here
      // would be a claim the app has no basis for — the enforcement version
      // of reporting an outage as a clean review.
      expect(gate.kind).toBe("unknown");
      if (gate.kind !== "unknown") throw new Error("unreachable");
      expect(gate.reason.trim()).not.toBe("");
      reasons.push(gate.reason);
    }

    // Six different ways of not knowing, and six different explanations. A
    // shared placeholder reason would leave "offline", "the server declined"
    // and "evaluated for another revision" indistinguishable to whoever has
    // to work out why the badge went quiet.
    expect(new Set(reasons).size).toBe(gates.length);

    // And the two states it does speak about remain reachable, so silence is
    // a decision and not the only outcome.
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
  // `gateFromApiResult` is the hook's own dispatch — a non-`ok` result, or an
  // `ok` result for the wrong revision, both become `unknown` before
  // `gateFrom` is ever called. It is imported, not restated: a copy of it here
  // was green with the real one deleted.
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
