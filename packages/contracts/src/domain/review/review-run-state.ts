/**
 * The ReviewRun state machine (P0.txt §19, §73, §74, §75).
 *
 * A run's lifecycle is a frozen transition table, not a set of strings a
 * caller may assign freely. The distinction matters because a review is a
 * long, distributed, retryable process: several workers, a queue, and a
 * webhook gateway can all try to move the same run at once, and "which moves
 * are legal" has to be one answer that every process agrees on.
 *
 * The happy path:
 *
 *     queued → preparing → analyzing → reviewing → verifying → reconciling
 *           → publishing → completed
 *
 * Off-ramps, and what each one means:
 *
 *     failed       the attempt broke. A *new run* may retry the same request.
 *     cancelled    a human or policy stopped it before any side effect.
 *     superseded   a newer revision landed; this run's answer is now stale.
 *
 * `superseded` exists as its own state precisely because §74 forbids
 * representing an obsolete run as a generic failure. Nothing went wrong — the
 * world moved on — and metrics, retry policy, and the UI all need to tell
 * those apart.
 */

import { z } from "zod";
import { ConflictError } from "../errors/errors.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { TEXT_LIMITS } from "../primitives/limits.js";

/**
 * Every state a run can occupy.
 *
 * The middle six are pipeline stages rather than arbitrary labels:
 *
 * | State          | What is happening |
 * | -------------- | ----------------- |
 * | `queued`       | accepted, awaiting a worker |
 * | `preparing`    | materializing the snapshot, resolving config |
 * | `analyzing`    | building the ChangeManifest; running tools |
 * | `reviewing`    | agents producing candidate findings |
 * | `verifying`    | candidates checked against evidence |
 * | `reconciling`  | dedup, aggregation, lineage against prior revisions |
 * | `publishing`   | writing comments back to the provider |
 */
export const REVIEW_RUN_STATES = [
  "queued",
  "preparing",
  "analyzing",
  "reviewing",
  "verifying",
  "reconciling",
  "publishing",
  "completed",
  "failed",
  "cancelled",
  "superseded",
] as const;

export type ReviewRunState = (typeof REVIEW_RUN_STATES)[number];

export const reviewRunStateSchema = z.enum(REVIEW_RUN_STATES);

/**
 * States from which no transition is legal.
 *
 * §19 is explicit that `completed → analyzing` must be impossible: re-running
 * work creates a **new run** against the same request, so the record of what
 * this attempt did stays intact. That is what makes a run auditable at all.
 */
export const TERMINAL_REVIEW_RUN_STATES = [
  "completed",
  "failed",
  "cancelled",
  "superseded",
] as const;

export type TerminalReviewRunState =
  (typeof TERMINAL_REVIEW_RUN_STATES)[number];

const TERMINAL_SET: ReadonlySet<ReviewRunState> = new Set(
  TERMINAL_REVIEW_RUN_STATES,
);

export function isTerminalReviewRunState(
  state: ReviewRunState,
): state is TerminalReviewRunState {
  return TERMINAL_SET.has(state);
}

/**
 * The complete transition table. Frozen, exhaustive, and the single authority.
 *
 * Two decisions here are deliberate and worth stating, because both look like
 * omissions otherwise.
 *
 * **1. `publishing` cannot be cancelled or superseded.**
 *
 * Publishing is the commit point: it writes comments to a pull request, and
 * those writes are not transactional. If a run could move `publishing →
 * cancelled`, the domain would report "cancelled" while the provider showed a
 * half-posted review — the contract would be lying about the world.
 *
 * So publishing runs to `completed` or `failed`, and nothing else. §73's
 * "review cancelled during publication" scenario is still handled, just at the
 * right layer: the orchestrator lets the run settle, then supersedes its
 * *findings* (§27's `published → superseded`), which is a finding-lifecycle
 * concern rather than a run-state one.
 *
 * **2. Terminal states have no outbound edges at all — including `completed →
 * superseded`.**
 *
 * When a newer revision lands after a run finished, the run is still a true
 * record of what was analyzed and published. It is the *findings* that go
 * stale. Mutating the run's state would destroy the audit trail to express
 * something the finding lifecycle already expresses correctly.
 */
const TRANSITIONS: Readonly<Record<ReviewRunState, readonly ReviewRunState[]>> =
  deepFreezeTable({
    queued: ["preparing", "failed", "cancelled", "superseded"],
    preparing: ["analyzing", "failed", "cancelled", "superseded"],
    analyzing: ["reviewing", "failed", "cancelled", "superseded"],
    reviewing: ["verifying", "failed", "cancelled", "superseded"],
    verifying: ["reconciling", "failed", "cancelled", "superseded"],
    reconciling: ["publishing", "failed", "cancelled", "superseded"],
    // See note 1 above: no cancelled, no superseded.
    publishing: ["completed", "failed"],
    // See note 2 above: terminal means terminal.
    completed: [],
    failed: [],
    cancelled: [],
    superseded: [],
  });

/**
 * Freezes the table **and** each of its arrays.
 *
 * `Object.freeze` is shallow: it would leave every destination array mutable,
 * so `allowedTransitionsFrom("queued").push("completed")` would silently widen
 * the state machine for the rest of the process. `readonly` prevents that at
 * compile time, but this table is reachable from JavaScript callers and from
 * anything that casts — and a state machine that can be edited at runtime is
 * not a state machine.
 */
function deepFreezeTable(
  table: Record<ReviewRunState, ReviewRunState[]>,
): Readonly<Record<ReviewRunState, readonly ReviewRunState[]>> {
  for (const destinations of Object.values(table)) {
    Object.freeze(destinations);
  }
  return Object.freeze(table);
}

/** The state a run begins in. Nothing may transition *into* it. */
export const INITIAL_REVIEW_RUN_STATE: ReviewRunState = "queued";

/** States reachable from `from`. Empty for terminal states. */
export function allowedTransitionsFrom(
  from: ReviewRunState,
): readonly ReviewRunState[] {
  return TRANSITIONS[from];
}

/**
 * Non-throwing check.
 *
 * Note that `canTransition(s, s)` is `false` for every state: a self-loop is
 * not a transition, and treating a redundant update as legal would let a
 * duplicate queue delivery append a second history entry for work that
 * happened once (§73).
 */
export function canTransition(
  from: ReviewRunState,
  to: ReviewRunState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Enforcing check, for the orchestration layer.
 *
 * @throws {ConflictError} — not `ValidationError`. The input is well-formed;
 *   it conflicts with the run's current state, which is exactly what a
 *   concurrent-update collision looks like and is the signal a worker needs to
 *   re-read and re-decide rather than retry blindly (§51).
 */
export function assertValidReviewRunTransition(
  from: ReviewRunState,
  to: ReviewRunState,
): void {
  if (canTransition(from, to)) return;

  const allowed = TRANSITIONS[from];
  const detail = isTerminalReviewRunState(from)
    ? `'${from}' is terminal; retrying requires a new run`
    : `allowed from '${from}': ${allowed.join(", ")}`;

  throw new ConflictError(
    `Illegal ReviewRun transition '${from}' → '${to}' (${detail})`,
    { details: { from, to, allowed: [...allowed] } },
  );
}

/**
 * One entry in a run's **append-only** state history.
 *
 * History is append-only rather than a mutable `state` column with an
 * `updatedAt`, because the sequence itself is the evidence: how long a run
 * spent verifying, whether it was retried, when supersession arrived relative
 * to publication. Overwriting loses all of that.
 *
 * `reason` is a short operator-facing note ("worker lease expired"), never a
 * stack trace, provider payload, or credential (§63).
 */
export interface ReviewRunTransition {
  readonly from: ReviewRunState;
  readonly to: ReviewRunState;
  readonly at: Timestamp;
  readonly reason?: string | undefined;
}

export const reviewRunTransitionSchema = z.strictObject({
  from: reviewRunStateSchema,
  to: reviewRunStateSchema,
  at: timestampSchema,
  reason: z.string().min(1).max(TEXT_LIMITS.summary).optional(),
});

/**
 * Validates a whole history as one connected, legal, monotonic chain.
 *
 * Checking transitions one at a time is not enough. A history can be composed
 * entirely of individually-legal steps and still be corrupt — disconnected
 * (`queued→preparing`, then `analyzing→reviewing`, skipping a step), or
 * out of order in time. Both indicate a lost or reordered write, which is
 * exactly what concurrent workers produce (§73).
 *
 * Timestamps must be **non-decreasing**, not strictly increasing: two
 * transitions can genuinely share a millisecond, and rejecting that would fail
 * on speed rather than on error.
 *
 * @throws {ConflictError} naming the index of the first broken link
 */
export function assertValidReviewRunHistory(
  history: readonly ReviewRunTransition[],
): void {
  if (history.length === 0) return;

  const first = history[0];
  if (first === undefined) return;

  if (first.from !== INITIAL_REVIEW_RUN_STATE) {
    throw new ConflictError(
      `ReviewRun history must begin at '${INITIAL_REVIEW_RUN_STATE}', but starts at '${first.from}'`,
      { details: { index: 0, from: first.from } },
    );
  }

  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (entry === undefined) continue;

    assertValidReviewRunTransition(entry.from, entry.to);

    const previous = index > 0 ? history[index - 1] : undefined;
    if (previous === undefined) continue;

    if (previous.to !== entry.from) {
      throw new ConflictError(
        `ReviewRun history is disconnected at index ${String(index)}: previous transition ended in '${previous.to}' but the next begins at '${entry.from}'`,
        { details: { index, expected: previous.to, actual: entry.from } },
      );
    }

    if (entry.at < previous.at) {
      throw new ConflictError(
        `ReviewRun history moves backwards in time at index ${String(index)}`,
        { details: { index, previousAt: previous.at, at: entry.at } },
      );
    }
  }
}

/** The state a run is in after applying its history. */
export function currentStateFromHistory(
  history: readonly ReviewRunTransition[],
): ReviewRunState {
  const last = history.at(-1);
  return last === undefined ? INITIAL_REVIEW_RUN_STATE : last.to;
}

/** True once the run has settled and no further transition is possible. */
export function isSettled(history: readonly ReviewRunTransition[]): boolean {
  return isTerminalReviewRunState(currentStateFromHistory(history));
}
