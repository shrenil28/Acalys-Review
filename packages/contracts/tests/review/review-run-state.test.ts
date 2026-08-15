import { describe, expect, it } from "vitest";
import {
  INITIAL_REVIEW_RUN_STATE,
  REVIEW_RUN_STATES,
  TERMINAL_REVIEW_RUN_STATES,
  allowedTransitionsFrom,
  assertValidReviewRunHistory,
  assertValidReviewRunTransition,
  canTransition,
  currentStateFromHistory,
  isSettled,
  isTerminalReviewRunState,
  type ReviewRunState,
  type ReviewRunTransition,
} from "../../src/domain/review/review-run-state.js";
import { ConflictError } from "../../src/domain/errors/errors.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";

const at = (seconds: number) =>
  timestamp(
    `2026-08-15T15:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000Z`,
  );

const step = (
  from: ReviewRunState,
  to: ReviewRunState,
  seconds: number,
): ReviewRunTransition => ({ from, to, at: at(seconds) });

/**
 * The complete transition matrix (P0.txt §19).
 *
 * Every one of the 11 × 11 = 121 ordered pairs is asserted explicitly, as
 * ALLOWED or REJECTED. Sampling the happy path would miss precisely the cases
 * that matter — a terminal state quietly accepting a transition, or a stage
 * skipping ahead — and those are the ones a concurrent worker will eventually
 * attempt.
 */
describe("ReviewRun state machine (P0.txt §19)", () => {
  /**
   * The expected table, written out independently of the implementation.
   *
   * Deliberately a second, hand-written source of truth. Deriving expectations
   * from `allowedTransitionsFrom` would make the test tautological — it would
   * pass for any table, including a wrong one.
   */
  const EXPECTED_ALLOWED: Readonly<
    Record<ReviewRunState, readonly ReviewRunState[]>
  > = {
    queued: ["preparing", "failed", "cancelled", "superseded"],
    preparing: ["analyzing", "failed", "cancelled", "superseded"],
    analyzing: ["reviewing", "failed", "cancelled", "superseded"],
    reviewing: ["verifying", "failed", "cancelled", "superseded"],
    verifying: ["reconciling", "failed", "cancelled", "superseded"],
    reconciling: ["publishing", "failed", "cancelled", "superseded"],
    publishing: ["completed", "failed"],
    completed: [],
    failed: [],
    cancelled: [],
    superseded: [],
  };

  it("has exactly 11 states, giving a 121-cell matrix", () => {
    expect(REVIEW_RUN_STATES).toHaveLength(11);
    expect(new Set(REVIEW_RUN_STATES).size).toBe(11);
    expect(REVIEW_RUN_STATES.length ** 2).toBe(121);
  });

  describe("all 121 ordered pairs", () => {
    const cases: {
      from: ReviewRunState;
      to: ReviewRunState;
      expected: "ALLOWED" | "REJECTED";
    }[] = [];

    for (const from of REVIEW_RUN_STATES) {
      for (const to of REVIEW_RUN_STATES) {
        cases.push({
          from,
          to,
          expected: EXPECTED_ALLOWED[from].includes(to)
            ? "ALLOWED"
            : "REJECTED",
        });
      }
    }

    it("enumerates every pair exactly once", () => {
      expect(cases).toHaveLength(121);
      expect(new Set(cases.map((c) => `${c.from}->${c.to}`)).size).toBe(121);
    });

    it.each(cases)("$from -> $to is $expected", ({ from, to, expected }) => {
      const allowed = expected === "ALLOWED";

      expect(canTransition(from, to)).toBe(allowed);

      if (allowed) {
        expect(() => assertValidReviewRunTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertValidReviewRunTransition(from, to)).toThrow(
          ConflictError,
        );
      }
    });

    it("allows 26 of the 121 pairs", () => {
      // A single number that changes if anyone edits the table, forcing the
      // change to be deliberate rather than incidental.
      const allowedCount = cases.filter((c) => c.expected === "ALLOWED").length;
      expect(allowedCount).toBe(26);
      expect(cases.length - allowedCount).toBe(95);
    });
  });

  describe("terminal states", () => {
    it("are exactly completed, failed, cancelled, superseded", () => {
      expect([...TERMINAL_REVIEW_RUN_STATES].sort()).toEqual([
        "cancelled",
        "completed",
        "failed",
        "superseded",
      ]);
    });

    it.each(TERMINAL_REVIEW_RUN_STATES)("%s has no outbound edge", (state) => {
      expect(allowedTransitionsFrom(state)).toHaveLength(0);
      expect(isTerminalReviewRunState(state)).toBe(true);

      for (const to of REVIEW_RUN_STATES) {
        expect(canTransition(state, to)).toBe(false);
      }
    });

    it("reject the §19 example explicitly: completed -> analyzing", () => {
      expect(() =>
        assertValidReviewRunTransition("completed", "analyzing"),
      ).toThrow(/terminal; retrying requires a new run/);
    });

    it("are not reachable from each other", () => {
      for (const from of TERMINAL_REVIEW_RUN_STATES) {
        for (const to of TERMINAL_REVIEW_RUN_STATES) {
          expect(canTransition(from, to)).toBe(false);
        }
      }
    });
  });

  describe("deliberate exclusions", () => {
    it("publishing cannot be cancelled — side effects are already visible", () => {
      // Publishing writes comments to a PR non-transactionally. A 'cancelled'
      // run whose comments are half-posted would make the contract lie.
      expect(canTransition("publishing", "cancelled")).toBe(false);
      expect(canTransition("publishing", "superseded")).toBe(false);
      expect(allowedTransitionsFrom("publishing")).toEqual([
        "completed",
        "failed",
      ]);
    });

    it("every pre-publishing stage CAN be cancelled or superseded", () => {
      const prePublishing: ReviewRunState[] = [
        "queued",
        "preparing",
        "analyzing",
        "reviewing",
        "verifying",
        "reconciling",
      ];
      for (const state of prePublishing) {
        expect(canTransition(state, "cancelled")).toBe(true);
        expect(canTransition(state, "superseded")).toBe(true);
      }
    });

    it("supersession is distinct from failure (§74)", () => {
      // An obsolete run is not a broken run; metrics and retry policy must be
      // able to tell them apart.
      expect(canTransition("analyzing", "superseded")).toBe(true);
      expect(canTransition("analyzing", "failed")).toBe(true);
      expect(isTerminalReviewRunState("superseded")).toBe(true);
      expect(isTerminalReviewRunState("failed")).toBe(true);
    });

    it("no state transitions to itself", () => {
      // A self-loop would let a duplicate queue delivery append a second
      // history entry for work that happened once (§73).
      for (const state of REVIEW_RUN_STATES) {
        expect(canTransition(state, state)).toBe(false);
      }
    });

    it("nothing transitions back into the initial state", () => {
      for (const state of REVIEW_RUN_STATES) {
        expect(canTransition(state, INITIAL_REVIEW_RUN_STATE)).toBe(false);
      }
    });
  });

  describe("reachability", () => {
    it("every non-initial state is reachable from queued", () => {
      const seen = new Set<ReviewRunState>([INITIAL_REVIEW_RUN_STATE]);
      const queue: ReviewRunState[] = [INITIAL_REVIEW_RUN_STATE];

      while (queue.length > 0) {
        const state = queue.shift();
        if (state === undefined) break;
        for (const next of allowedTransitionsFrom(state)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }

      // No orphan states: an unreachable state is dead code in a contract.
      expect([...seen].sort()).toEqual([...REVIEW_RUN_STATES].sort());
    });

    it("the happy path reaches completed in exactly seven transitions", () => {
      const path: ReviewRunState[] = [
        "queued",
        "preparing",
        "analyzing",
        "reviewing",
        "verifying",
        "reconciling",
        "publishing",
        "completed",
      ];

      for (let index = 0; index < path.length - 1; index += 1) {
        const from = path[index];
        const to = path[index + 1];
        if (from === undefined || to === undefined) continue;
        expect(canTransition(from, to)).toBe(true);
      }
      expect(path).toHaveLength(8);
    });

    it("no stage can skip ahead", () => {
      // Skipping verification would publish unverified candidates as findings.
      expect(canTransition("analyzing", "publishing")).toBe(false);
      expect(canTransition("reviewing", "publishing")).toBe(false);
      expect(canTransition("queued", "completed")).toBe(false);
      expect(canTransition("reviewing", "reconciling")).toBe(false);
    });

    it("no stage can move backwards", () => {
      expect(canTransition("reviewing", "analyzing")).toBe(false);
      expect(canTransition("verifying", "reviewing")).toBe(false);
      expect(canTransition("publishing", "reconciling")).toBe(false);
    });
  });

  describe("error quality (§96)", () => {
    it("names the allowed destinations", () => {
      try {
        assertValidReviewRunTransition("queued", "publishing");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictError);
        const conflict = error as ConflictError;
        expect(conflict.message).toContain("'queued' → 'publishing'");
        expect(conflict.message).toContain(
          "allowed from 'queued': preparing, failed, cancelled, superseded",
        );
        expect(conflict.details).toEqual({
          from: "queued",
          to: "publishing",
          allowed: ["preparing", "failed", "cancelled", "superseded"],
        });
      }
    });

    it("is a ConflictError, not a ValidationError", () => {
      // The input is well-formed; it conflicts with current state. That
      // distinction tells a worker to re-read rather than retry blindly (§51).
      try {
        assertValidReviewRunTransition("completed", "queued");
        expect.unreachable();
      } catch (error) {
        const conflict = error as ConflictError;
        expect(conflict.code).toBe("CONFLICT");
        expect(conflict.retryable).toBe(false);
      }
    });
  });

  describe("append-only history (§71)", () => {
    it("accepts a complete happy path", () => {
      const history: ReviewRunTransition[] = [
        step("queued", "preparing", 0),
        step("preparing", "analyzing", 1),
        step("analyzing", "reviewing", 2),
        step("reviewing", "verifying", 3),
        step("verifying", "reconciling", 4),
        step("reconciling", "publishing", 5),
        step("publishing", "completed", 6),
      ];

      expect(() => assertValidReviewRunHistory(history)).not.toThrow();
      expect(currentStateFromHistory(history)).toBe("completed");
      expect(isSettled(history)).toBe(true);
    });

    it("treats empty history as a run still queued", () => {
      expect(currentStateFromHistory([])).toBe("queued");
      expect(isSettled([])).toBe(false);
      expect(() => assertValidReviewRunHistory([])).not.toThrow();
    });

    it("rejects a history that does not begin at queued", () => {
      expect(() =>
        assertValidReviewRunHistory([step("analyzing", "reviewing", 0)]),
      ).toThrow(/must begin at 'queued'/);
    });

    it("rejects a disconnected chain even when each step is legal", () => {
      // Both transitions are individually valid; together they skip a state,
      // which is what a lost write looks like (§73).
      const history: ReviewRunTransition[] = [
        step("queued", "preparing", 0),
        step("analyzing", "reviewing", 1),
      ];
      expect(() => assertValidReviewRunHistory(history)).toThrow(
        /disconnected at index 1: previous transition ended in 'preparing' but the next begins at 'analyzing'/,
      );
    });

    it("rejects an illegal step inside an otherwise sound chain", () => {
      const history: ReviewRunTransition[] = [
        step("queued", "preparing", 0),
        step("preparing", "publishing", 1),
      ];
      expect(() => assertValidReviewRunHistory(history)).toThrow(ConflictError);
    });

    it("rejects time moving backwards", () => {
      const history: ReviewRunTransition[] = [
        step("queued", "preparing", 10),
        step("preparing", "analyzing", 5),
      ];
      expect(() => assertValidReviewRunHistory(history)).toThrow(
        /moves backwards in time at index 1/,
      );
    });

    it("allows two transitions in the same millisecond", () => {
      // Non-decreasing, not strictly increasing: fast machines are not errors.
      const history: ReviewRunTransition[] = [
        step("queued", "preparing", 3),
        step("preparing", "analyzing", 3),
      ];
      expect(() => assertValidReviewRunHistory(history)).not.toThrow();
    });

    it("records a supersession path as its own outcome", () => {
      const history: ReviewRunTransition[] = [
        step("queued", "preparing", 0),
        step("preparing", "analyzing", 1),
        { ...step("analyzing", "superseded", 2), reason: "revision 4 landed" },
      ];

      expect(() => assertValidReviewRunHistory(history)).not.toThrow();
      expect(currentStateFromHistory(history)).toBe("superseded");
      expect(isSettled(history)).toBe(true);
      expect(history.at(-1)?.reason).toBe("revision 4 landed");
    });

    it("cannot be extended once terminal", () => {
      const history: ReviewRunTransition[] = [
        step("queued", "cancelled", 0),
        step("cancelled", "preparing", 1),
      ];
      expect(() => assertValidReviewRunHistory(history)).toThrow(ConflictError);
    });
  });

  it("is deterministic — repeated queries never differ", () => {
    for (const from of REVIEW_RUN_STATES) {
      const first = allowedTransitionsFrom(from);
      for (let index = 0; index < 50; index += 1) {
        expect(allowedTransitionsFrom(from)).toEqual(first);
      }
    }
  });

  it("exposes a frozen table that callers cannot mutate", () => {
    // A caller widening the table at runtime would silently disable the whole
    // machine for that process.
    const allowed = allowedTransitionsFrom("queued");
    expect(() => {
      (allowed as ReviewRunState[]).push("completed");
    }).toThrow();
    expect(canTransition("queued", "completed")).toBe(false);
  });
});
