import { describe, expect, it } from "vitest";
import {
  FINDING_LIFECYCLE_STATES,
  INITIAL_FINDING_LIFECYCLE_STATE,
  TERMINAL_FINDING_LIFECYCLE_STATES,
  allowedFindingTransitionsFrom,
  assertValidFindingHistory,
  assertValidFindingTransition,
  canTransitionFinding,
  currentFindingState,
  isLiveFinding,
  isTerminalFindingLifecycleState,
  wasEverPublished,
  type FindingLifecycleState,
  type FindingTransition,
} from "../../src/domain/finding/finding-lifecycle.js";
import { REVIEW_RUN_STATES } from "../../src/domain/review/review-run-state.js";
import { ConflictError } from "../../src/domain/errors/errors.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";

const at = (second: number) =>
  timestamp(`2026-08-16T10:00:${String(second).padStart(2, "0")}.000Z`);

const step = (
  from: FindingLifecycleState,
  to: FindingLifecycleState,
  second: number,
): FindingTransition => ({ from, to, at: at(second) });

describe("Finding lifecycle (P0.txt §27, §107)", () => {
  /**
   * The expected table, written independently of the implementation.
   *
   * Deriving it from `allowedFindingTransitionsFrom` would make the matrix
   * tautological — it would pass for any table, including a wrong one.
   */
  const EXPECTED: Readonly<
    Record<FindingLifecycleState, readonly FindingLifecycleState[]>
  > = {
    verified: ["published", "superseded"],
    published: ["resolved", "dismissed", "stale", "superseded"],
    stale: ["resolved", "superseded"],
    resolved: [],
    dismissed: [],
    superseded: [],
  };

  it("has 6 states, giving a 36-cell matrix", () => {
    expect(FINDING_LIFECYCLE_STATES).toHaveLength(6);
    expect(new Set(FINDING_LIFECYCLE_STATES).size).toBe(6);
    expect(FINDING_LIFECYCLE_STATES.length ** 2).toBe(36);
  });

  describe("all 36 ordered pairs", () => {
    const cases: {
      from: FindingLifecycleState;
      to: FindingLifecycleState;
      expected: "ALLOWED" | "REJECTED";
    }[] = [];

    for (const from of FINDING_LIFECYCLE_STATES) {
      for (const to of FINDING_LIFECYCLE_STATES) {
        cases.push({
          from,
          to,
          expected: EXPECTED[from].includes(to) ? "ALLOWED" : "REJECTED",
        });
      }
    }

    it("enumerates every pair exactly once", () => {
      expect(cases).toHaveLength(36);
      expect(new Set(cases.map((c) => `${c.from}->${c.to}`)).size).toBe(36);
    });

    it.each(cases)("$from -> $to is $expected", ({ from, to, expected }) => {
      const allowed = expected === "ALLOWED";
      expect(canTransitionFinding(from, to)).toBe(allowed);

      if (allowed) {
        expect(() => assertValidFindingTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertValidFindingTransition(from, to)).toThrow(
          ConflictError,
        );
      }
    });

    it("allows 8 of the 36 pairs", () => {
      // A number that changes if anyone edits the table, forcing the change to
      // be deliberate rather than incidental.
      const allowedCount = cases.filter((c) => c.expected === "ALLOWED").length;
      expect(allowedCount).toBe(8);
      expect(cases.length - allowedCount).toBe(28);
    });

    it.each(FINDING_LIFECYCLE_STATES)(
      "allowedFindingTransitionsFrom(%s) matches the canonical set exactly",
      (state) => {
        expect([...allowedFindingTransitionsFrom(state)]).toEqual([
          ...EXPECTED[state],
        ]);
      },
    );
  });

  describe("terminal states", () => {
    it("are exactly resolved, dismissed, superseded", () => {
      expect([...TERMINAL_FINDING_LIFECYCLE_STATES].sort()).toEqual([
        "dismissed",
        "resolved",
        "superseded",
      ]);
    });

    it.each(TERMINAL_FINDING_LIFECYCLE_STATES)(
      "%s has zero outbound transitions",
      (state) => {
        expect(allowedFindingTransitionsFrom(state)).toHaveLength(0);
        expect(isTerminalFindingLifecycleState(state)).toBe(true);
        expect(isLiveFinding(state)).toBe(false);

        for (const to of FINDING_LIFECYCLE_STATES) {
          expect(canTransitionFinding(state, to)).toBe(false);
        }
      },
    );

    it("stale is NOT terminal — a lost anchor can still be fixed or replaced", () => {
      expect(isTerminalFindingLifecycleState("stale")).toBe(false);
      expect(isLiveFinding("stale")).toBe(true);
      expect(allowedFindingTransitionsFrom("stale")).toEqual([
        "resolved",
        "superseded",
      ]);
    });
  });

  describe("deliberate exclusions", () => {
    it("a dismissal cannot be reversed", () => {
      // A dismissal is a human judgement at a point in time. A recurrence is a
      // new finding linked by fingerprint, not a resurrection of this record.
      for (const to of FINDING_LIFECYCLE_STATES) {
        expect(canTransitionFinding("dismissed", to)).toBe(false);
      }
      expect(() =>
        assertValidFindingTransition("dismissed", "published"),
      ).toThrow(/is terminal; a recurrence is a new finding/);
    });

    it("a resolved finding cannot be superseded", () => {
      // Nothing left to replace once it is fixed.
      expect(canTransitionFinding("resolved", "superseded")).toBe(false);
    });

    it("supersession applies only to live findings", () => {
      expect(canTransitionFinding("verified", "superseded")).toBe(true);
      expect(canTransitionFinding("published", "superseded")).toBe(true);
      expect(canTransitionFinding("stale", "superseded")).toBe(true);
      expect(canTransitionFinding("resolved", "superseded")).toBe(false);
      expect(canTransitionFinding("dismissed", "superseded")).toBe(false);
    });

    it("an unpublished finding cannot be dismissed or go stale", () => {
      // A human cannot dismiss what they have not seen.
      expect(canTransitionFinding("verified", "dismissed")).toBe(false);
      expect(canTransitionFinding("verified", "stale")).toBe(false);
      expect(canTransitionFinding("verified", "resolved")).toBe(false);
    });

    it("a stale finding cannot be dismissed", () => {
      // There is nothing locatable left for a human to judge.
      expect(canTransitionFinding("stale", "dismissed")).toBe(false);
    });

    it("no state transitions to itself", () => {
      for (const state of FINDING_LIFECYCLE_STATES) {
        expect(canTransitionFinding(state, state)).toBe(false);
      }
    });

    it("nothing transitions back into the initial state", () => {
      expect(INITIAL_FINDING_LIFECYCLE_STATE).toBe("verified");
      for (const state of FINDING_LIFECYCLE_STATES) {
        expect(canTransitionFinding(state, "verified")).toBe(false);
      }
    });
  });

  describe("separation from the ReviewRun lifecycle", () => {
    it("overlaps on 'superseded' alone", () => {
      // The two vocabularies are almost entirely disjoint, and not by accident:
      // a run is a *process* and takes gerunds (verifying, publishing), while a
      // finding is a *claim* and takes participles (verified, published). That
      // grammatical split is what stops the two being confused at a call site.
      //
      // 'superseded' is the one shared word. It means the same thing in both —
      // obsoleted by newer work — but they remain different types operated on
      // by different machines, so neither accepts the other's values.
      const runStates = new Set<string>(REVIEW_RUN_STATES);
      const shared = FINDING_LIFECYCLE_STATES.filter((state) =>
        runStates.has(state),
      );
      expect(shared).toEqual(["superseded"]);

      // The near-misses that would have been genuinely confusing.
      expect(runStates.has("verifying")).toBe(true);
      expect(runStates.has("verified")).toBe(false);
      expect(runStates.has("publishing")).toBe(true);
      expect(runStates.has("published")).toBe(false);
    });

    it("rejects a ReviewRunState that is not a finding state", () => {
      for (const runState of [
        "queued",
        "analyzing",
        "publishing",
        "completed",
      ]) {
        expect(
          canTransitionFinding("published", runState as FindingLifecycleState),
        ).toBe(false);
      }
    });
  });

  describe("reachability", () => {
    it("every state is reachable from the initial state", () => {
      const seen = new Set<FindingLifecycleState>([
        INITIAL_FINDING_LIFECYCLE_STATE,
      ]);
      const queue: FindingLifecycleState[] = [INITIAL_FINDING_LIFECYCLE_STATE];

      while (queue.length > 0) {
        const state = queue.shift();
        if (state === undefined) break;
        for (const next of allowedFindingTransitionsFrom(state)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }

      expect([...seen].sort()).toEqual([...FINDING_LIFECYCLE_STATES].sort());
    });

    it("§107: resolved is only ever reachable via published", () => {
      // The invariant "a resolved finding must previously have been published"
      // holds structurally: resolved comes only from published or stale, and
      // stale comes only from published.
      const predecessorsOfResolved = FINDING_LIFECYCLE_STATES.filter((state) =>
        canTransitionFinding(state, "resolved"),
      );
      expect([...predecessorsOfResolved].sort()).toEqual([
        "published",
        "stale",
      ]);

      const predecessorsOfStale = FINDING_LIFECYCLE_STATES.filter((state) =>
        canTransitionFinding(state, "stale"),
      );
      expect(predecessorsOfStale).toEqual(["published"]);
    });
  });

  describe("append-only history (§71)", () => {
    it("accepts the fix path", () => {
      const history = [
        step("verified", "published", 1),
        step("published", "resolved", 2),
      ];
      expect(() => assertValidFindingHistory(history)).not.toThrow();
      expect(currentFindingState(history)).toBe("resolved");
      expect(wasEverPublished(history)).toBe(true);
    });

    it("accepts the stale-then-resolved path", () => {
      const history = [
        step("verified", "published", 1),
        step("published", "stale", 2),
        step("stale", "resolved", 3),
      ];
      expect(() => assertValidFindingHistory(history)).not.toThrow();
      expect(wasEverPublished(history)).toBe(true);
    });

    it("accepts supersession before publication", () => {
      const history = [step("verified", "superseded", 1)];
      expect(() => assertValidFindingHistory(history)).not.toThrow();
      expect(currentFindingState(history)).toBe("superseded");
      // Never published, and the helper says so.
      expect(wasEverPublished(history)).toBe(false);
    });

    it("treats empty history as a newly verified finding", () => {
      expect(currentFindingState([])).toBe("verified");
      expect(() => assertValidFindingHistory([])).not.toThrow();
    });

    it("rejects a history that does not begin at verified", () => {
      expect(() =>
        assertValidFindingHistory([step("published", "resolved", 1)]),
      ).toThrow(/must begin at 'verified'/);
    });

    it("rejects a disconnected chain of individually-legal steps", () => {
      expect(() =>
        assertValidFindingHistory([
          step("verified", "published", 1),
          step("stale", "resolved", 2),
        ]),
      ).toThrow(/disconnected at index 1/);
    });

    it("rejects an illegal step inside a sound chain", () => {
      expect(() =>
        assertValidFindingHistory([
          step("verified", "published", 1),
          step("published", "verified", 2),
        ]),
      ).toThrow(ConflictError);
    });

    it("rejects time moving backwards", () => {
      expect(() =>
        assertValidFindingHistory([
          step("verified", "published", 9),
          step("published", "resolved", 2),
        ]),
      ).toThrow(/backwards in time/);
    });

    it("allows two transitions in the same instant", () => {
      expect(() =>
        assertValidFindingHistory([
          step("verified", "published", 3),
          step("published", "superseded", 3),
        ]),
      ).not.toThrow();
    });

    it("cannot be extended past a terminal state", () => {
      expect(() =>
        assertValidFindingHistory([
          step("verified", "published", 1),
          step("published", "dismissed", 2),
          step("dismissed", "published", 3),
        ]),
      ).toThrow(ConflictError);
    });
  });

  describe("error quality (§96)", () => {
    it("names the allowed destinations", () => {
      try {
        assertValidFindingTransition("verified", "resolved");
        expect.unreachable();
      } catch (error) {
        const conflict = error as ConflictError;
        expect(conflict.message).toContain("'verified' → 'resolved'");
        expect(conflict.message).toContain(
          "allowed from 'verified': published, superseded",
        );
        expect(conflict.details).toEqual({
          from: "verified",
          to: "resolved",
          allowed: ["published", "superseded"],
        });
      }
    });

    it("is a ConflictError, not a ValidationError", () => {
      try {
        assertValidFindingTransition("resolved", "published");
        expect.unreachable();
      } catch (error) {
        const conflict = error as ConflictError;
        expect(conflict.code).toBe("CONFLICT");
        expect(conflict.retryable).toBe(false);
      }
    });
  });

  it("exposes a deep-frozen table callers cannot widen", () => {
    const allowed = allowedFindingTransitionsFrom("resolved");
    expect(() => {
      (allowed as FindingLifecycleState[]).push("published");
    }).toThrow();
    expect(canTransitionFinding("resolved", "published")).toBe(false);
  });

  it("is deterministic across repeated queries", () => {
    for (const from of FINDING_LIFECYCLE_STATES) {
      const first = allowedFindingTransitionsFrom(from);
      for (let index = 0; index < 50; index += 1) {
        expect(allowedFindingTransitionsFrom(from)).toEqual(first);
      }
    }
  });
});
