/**
 * The lifecycle of a published finding (P0.txt §27, §107).
 *
 * Distinct from {@link ReviewRunState} in both vocabulary and meaning, and the
 * distinction is load-bearing:
 *
 *     ReviewRun lifecycle    an execution. Immutable once terminal.
 *     Finding lifecycle      a claim about code. Evolves as the code evolves.
 *
 * A completed run stays completed forever; its findings go stale, get fixed,
 * or get dismissed long afterwards. Mutating the run to express that would
 * destroy the audit trail (Checkpoint B's terminal-means-terminal rule).
 *
 * # Why six states and not §27's eight
 *
 * §27 lists `candidate, verified, rejected, published, resolved, dismissed,
 * stale, superseded`, and in the same breath instructs: *"determine carefully
 * whether candidate lifecycle should live on `CandidateFinding` versus
 * `ReviewFinding`. Avoid contradictory state modeling."*
 *
 * Taking that seriously, two of the eight are not states of this machine:
 *
 * - **`candidate`** is not a state a `ReviewFinding` can occupy — it is a
 *   *different type*, {@link CandidateFinding}, which by design owns no
 *   lifecycle at all.
 * - **`rejected`** is not a state either — it is a
 *   {@link VerificationDecision}. A rejected candidate never becomes a
 *   `ReviewFinding`, so §107's "a published finding must not have
 *   verification=REJECTED" holds structurally rather than by runtime check.
 *
 * Modelling them as lifecycle states would create exactly the contradiction
 * §27 warns about: a `ReviewFinding` in state `candidate` would be a
 * lifecycle-bearing entity claiming not to have entered its lifecycle.
 *
 * Nothing from §27's vocabulary is lost — each name still exists, on the
 * concept that actually owns it:
 *
 *     candidate   → CandidateFinding (a type)
 *     rejected    → VerificationDecision.rejected
 *     the rest    → the six states below
 */

import { z } from "zod";
import { ConflictError } from "../errors/errors.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { TEXT_LIMITS } from "../primitives/limits.js";

/**
 * States a `ReviewFinding` can occupy.
 *
 * | State | Meaning |
 * | --- | --- |
 * | `verified` | accepted by verification, not yet visible to anyone |
 * | `published` | posted to the provider; the developer can see it |
 * | `resolved` | the underlying issue was fixed |
 * | `dismissed` | a human judged it not a problem |
 * | `stale` | the code it referenced changed; the claim can no longer be located |
 * | `superseded` | a later run raised an equivalent finding that replaces it |
 *
 * `stale` and `superseded` are separate because they mean opposite things
 * about whether anyone should look again. Stale means "we lost track of this
 * — it may or may not still be true". Superseded means "this is still true and
 * a newer record now carries it".
 */
export const FINDING_LIFECYCLE_STATES = [
  "verified",
  "published",
  "resolved",
  "dismissed",
  "stale",
  "superseded",
] as const;

export type FindingLifecycleState = (typeof FINDING_LIFECYCLE_STATES)[number];

export const findingLifecycleStateSchema = z.enum(FINDING_LIFECYCLE_STATES);

/**
 * Where a finding's lifecycle begins.
 *
 * `verified` and not `published`: verification is what admits a candidate into
 * the lifecycle at all, and publication can fail or be suppressed by policy
 * (a `local` review has nowhere to publish). Nothing transitions *into* this
 * state — it is only ever the entry point.
 */
export const INITIAL_FINDING_LIFECYCLE_STATE: FindingLifecycleState =
  "verified";

export const TERMINAL_FINDING_LIFECYCLE_STATES = [
  "resolved",
  "dismissed",
  "superseded",
] as const;

export type TerminalFindingLifecycleState =
  (typeof TERMINAL_FINDING_LIFECYCLE_STATES)[number];

const TERMINAL_SET: ReadonlySet<FindingLifecycleState> = new Set(
  TERMINAL_FINDING_LIFECYCLE_STATES,
);

export function isTerminalFindingLifecycleState(
  state: FindingLifecycleState,
): state is TerminalFindingLifecycleState {
  return TERMINAL_SET.has(state);
}

/**
 * The transition table. Frozen, exhaustive, the single authority.
 *
 * Decisions worth stating, since each looks like an omission otherwise:
 *
 * **`dismissed` is terminal — a dismissal cannot be reversed.** A dismissal is
 * a human judgement recorded at a moment in time. If the same issue matters
 * later, a subsequent run raises a *new* finding, linked to this one by
 * fingerprint lineage (§28). Reopening would rewrite the record of what
 * someone decided and when, which is the same mistake as mutating a completed
 * run.
 *
 * **`resolved` is terminal, and cannot be superseded.** Once an issue is
 * fixed there is nothing left to replace. A regression is a new finding, not a
 * resurrection of the old one — and lineage already connects them.
 *
 * **Supersession applies only to live findings** (`verified`, `published`,
 * `stale`). Superseding a resolved or dismissed finding would claim a newer
 * record now carries something that was already closed.
 *
 * **`verified` can be superseded without publishing.** A newer revision can
 * land while a finding sits verified-but-unpublished; it should be replaced
 * rather than posted stale.
 *
 * **`stale` is not terminal.** A finding whose anchor was lost can still be
 * confirmed fixed, or replaced by a newer equivalent. It cannot be dismissed —
 * there is nothing locatable left for a human to judge.
 *
 * **No self-transitions.** Re-running publication must not append a second
 * history entry for one event (the §73 duplicate-delivery rule).
 */
const TRANSITIONS: Readonly<
  Record<FindingLifecycleState, readonly FindingLifecycleState[]>
> = deepFreezeTable({
  verified: ["published", "superseded"],
  published: ["resolved", "dismissed", "stale", "superseded"],
  stale: ["resolved", "superseded"],
  resolved: [],
  dismissed: [],
  superseded: [],
});

/**
 * Freezes the table and each destination array.
 *
 * `Object.freeze` is shallow, so without this
 * `allowedFindingTransitionsFrom("resolved").push("published")` would widen
 * the machine at runtime for the rest of the process.
 */
function deepFreezeTable(
  table: Record<FindingLifecycleState, FindingLifecycleState[]>,
): Readonly<Record<FindingLifecycleState, readonly FindingLifecycleState[]>> {
  for (const destinations of Object.values(table)) {
    Object.freeze(destinations);
  }
  return Object.freeze(table);
}

/** States reachable from `from`. Empty for terminal states. */
export function allowedFindingTransitionsFrom(
  from: FindingLifecycleState,
): readonly FindingLifecycleState[] {
  return TRANSITIONS[from];
}

/** Non-throwing check. Self-transitions are always `false`. */
export function canTransitionFinding(
  from: FindingLifecycleState,
  to: FindingLifecycleState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Enforcing check.
 *
 * @throws {ConflictError} — the input is well-formed but conflicts with the
 *   finding's current state, which is what a concurrent update looks like and
 *   tells the caller to re-read rather than retry (§51)
 */
export function assertValidFindingTransition(
  from: FindingLifecycleState,
  to: FindingLifecycleState,
): void {
  if (canTransitionFinding(from, to)) return;

  const allowed = TRANSITIONS[from];
  const detail = isTerminalFindingLifecycleState(from)
    ? `'${from}' is terminal; a recurrence is a new finding linked by fingerprint`
    : `allowed from '${from}': ${allowed.join(", ")}`;

  throw new ConflictError(
    `Illegal finding lifecycle transition '${from}' → '${to}' (${detail})`,
    { details: { from, to, allowed: [...allowed] } },
  );
}

/**
 * One entry in a finding's append-only lifecycle history.
 *
 * `actorSummary` is a short label ("dismissed by @ada", "resolved by run
 * 0192…"), never a full actor record — the history is read constantly and
 * should stay small (§125).
 */
export interface FindingTransition {
  readonly from: FindingLifecycleState;
  readonly to: FindingLifecycleState;
  readonly at: Timestamp;
  readonly reason?: string | undefined;
  readonly actorSummary?: string | undefined;
}

export const findingTransitionSchema = z.strictObject({
  from: findingLifecycleStateSchema,
  to: findingLifecycleStateSchema,
  at: timestampSchema,
  reason: z.string().min(1).max(TEXT_LIMITS.summary).optional(),
  actorSummary: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
});

/**
 * Validates a history as one connected, legal, time-ordered chain.
 *
 * Individually-legal steps are not enough: a disconnected history
 * (`verified→published`, then `stale→resolved`) is composed of valid moves and
 * still indicates a lost write.
 *
 * @throws {ConflictError} naming the index of the first broken link
 */
export function assertValidFindingHistory(
  history: readonly FindingTransition[],
): void {
  if (history.length === 0) return;

  const first = history[0];
  if (first === undefined) return;

  if (first.from !== INITIAL_FINDING_LIFECYCLE_STATE) {
    throw new ConflictError(
      `Finding history must begin at '${INITIAL_FINDING_LIFECYCLE_STATE}', but starts at '${first.from}'`,
      { details: { index: 0, from: first.from } },
    );
  }

  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (entry === undefined) continue;

    assertValidFindingTransition(entry.from, entry.to);

    const previous = index > 0 ? history[index - 1] : undefined;
    if (previous === undefined) continue;

    if (previous.to !== entry.from) {
      throw new ConflictError(
        `Finding history is disconnected at index ${String(index)}: previous transition ended in '${previous.to}' but the next begins at '${entry.from}'`,
        { details: { index, expected: previous.to, actual: entry.from } },
      );
    }

    if (entry.at < previous.at) {
      throw new ConflictError(
        `Finding history moves backwards in time at index ${String(index)}`,
        { details: { index } },
      );
    }
  }
}

/** The state implied by a history. `verified` for an empty one. */
export function currentFindingState(
  history: readonly FindingTransition[],
): FindingLifecycleState {
  const last = history.at(-1);
  return last === undefined ? INITIAL_FINDING_LIFECYCLE_STATE : last.to;
}

/**
 * Whether a finding was ever visible to a developer.
 *
 * §107 requires that a `resolved` finding must previously have been published.
 * The transition table already guarantees it structurally — `resolved` is
 * reachable only from `published` and `stale`, and `stale` only from
 * `published` — and this makes the property checkable on a concrete history.
 */
export function wasEverPublished(
  history: readonly FindingTransition[],
): boolean {
  return history.some((transition) => transition.to === "published");
}

/** Whether the finding still represents an open claim about the code. */
export function isLiveFinding(state: FindingLifecycleState): boolean {
  return !isTerminalFindingLifecycleState(state);
}
