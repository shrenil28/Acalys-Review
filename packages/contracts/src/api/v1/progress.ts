/**
 * The live-progress payload the UI streams.
 *
 * `POST /api/v1/reviews` returns `202` immediately with a `reviewRunId`; the
 * work happens on a worker that may not even exist yet when the response is
 * written. `GET /api/v1/reviews/:id/events` is how the UI follows it.
 *
 *     POST /api/v1/reviews  ──►  202 { reviewRunId, state: "queued" }
 *                                        │
 *     GET  …/:id/events     ◄────────────┘   Server-Sent Events
 *
 * # A projection of the state machine, not a mirror of it
 *
 * A `ReviewProgressEvent` is built *from* `review.run.state_changed`, but it is
 * not that event. The internal event carries the trace context, the tenant, the
 * envelope, and both raw states; this carries what a progress bar needs. If the
 * UI subscribed to the internal event it would be coupled to the event
 * taxonomy, and adding a run state would be a frontend change.
 *
 * The states *are* shared, deliberately: `queued → preparing → analyzing → …`
 * is product vocabulary the user sees, not an implementation detail. What is
 * not shared is everything around them.
 *
 * # Why `phase` exists alongside `state`
 *
 * A UI rendering eleven states needs to know which ones mean "still working".
 * Deriving that from the state name is the kind of logic that silently goes
 * wrong when a state is added — a new `reconciling` state would render as
 * neither working nor finished. `phase` answers it once, on the server.
 */

import { z } from "zod";
import { REVIEW_RUN_STATES } from "../../domain/review/review-run-state.js";
import { TEXT_LIMITS } from "../../domain/primitives/limits.js";
import { apiIdSchema, apiTimestampSchema } from "./common.js";

/**
 * What the UI should be showing.
 *
 * Three values, because there are exactly three renderings: a spinner, a
 * result, or an error. A client never has to enumerate run states to decide
 * which — that mapping lives here and moves with the state machine.
 */
export const REVIEW_PROGRESS_PHASES = [
  "waiting",
  "working",
  "finished",
  "errored",
] as const;

export type ReviewProgressPhase = (typeof REVIEW_PROGRESS_PHASES)[number];
export const reviewProgressPhaseSchema = z.enum(REVIEW_PROGRESS_PHASES);

/**
 * The SSE payload.
 *
 * `progress` is a coarse 0–1 hint, explicitly *not* a promise: a review has no
 * knowable duration, and a bar that advances on state transitions is honest
 * about that while a percentage computed from elapsed time would not be.
 *
 * Carries no `attempt`, no worker id, and no queue depth. A retry is invisible
 * to the viewer by design — they asked for a review, and which attempt
 * delivered it is the platform's business (§20).
 */
export interface ReviewProgressEvent {
  readonly reviewRunId: string;
  readonly state: (typeof REVIEW_RUN_STATES)[number];
  readonly phase: ReviewProgressPhase;
  /** 0–1, monotonic within a run. A hint, never a promise. */
  readonly progress: number;
  /** Short human-facing line, e.g. "Analyzing 14 changed files". */
  readonly message?: string | undefined;
  /** Findings published so far, so a count can tick up live. */
  readonly findingCount?: number | undefined;
  readonly occurredAt: string;
}

export const reviewProgressEventSchema = z.strictObject({
  reviewRunId: apiIdSchema,
  state: z.enum(REVIEW_RUN_STATES),
  phase: reviewProgressPhaseSchema,
  progress: z.number().min(0).max(1),
  message: z.string().min(1).max(TEXT_LIMITS.title).optional(),
  findingCount: z.number().int().nonnegative().optional(),
  occurredAt: apiTimestampSchema,
});

/**
 * Phase and progress for each run state.
 *
 * A single frozen table rather than logic in three places. `Record<state, …>`
 * makes it exhaustive: adding a run state without deciding how it renders is a
 * compile error, which is the failure mode a `default:` branch would hide by
 * rendering the new state as "waiting" forever.
 *
 * The progress values are spaced by how long each phase actually takes, not
 * evenly: `analyzing` and `reviewing` dominate a real run, so the bar spends
 * most of its travel there instead of jumping to 80% and stalling.
 */
export const REVIEW_PROGRESS_TABLE: Readonly<
  Record<
    (typeof REVIEW_RUN_STATES)[number],
    { readonly phase: ReviewProgressPhase; readonly progress: number }
  >
> = Object.freeze({
  queued: { phase: "waiting", progress: 0 },
  preparing: { phase: "working", progress: 0.1 },
  analyzing: { phase: "working", progress: 0.3 },
  reviewing: { phase: "working", progress: 0.6 },
  verifying: { phase: "working", progress: 0.8 },
  reconciling: { phase: "working", progress: 0.9 },
  publishing: { phase: "working", progress: 0.95 },
  completed: { phase: "finished", progress: 1 },
  failed: { phase: "errored", progress: 1 },
  cancelled: { phase: "finished", progress: 1 },
  superseded: { phase: "finished", progress: 1 },
});

/**
 * Builds a progress event for a run state.
 *
 * `cancelled` and `superseded` are `finished`, not `errored`: nothing went
 * wrong. A superseded run was replaced because the author pushed again, which
 * is the system working — showing it as an error would train users to ignore
 * real errors.
 */
export function toReviewProgressEvent(
  reviewRunId: string,
  state: (typeof REVIEW_RUN_STATES)[number],
  occurredAt: string,
  extra: {
    readonly message?: string | undefined;
    readonly findingCount?: number | undefined;
  } = {},
): ReviewProgressEvent {
  const { phase, progress } = REVIEW_PROGRESS_TABLE[state];

  return {
    reviewRunId,
    state,
    phase,
    progress,
    ...(extra.message === undefined ? {} : { message: extra.message }),
    ...(extra.findingCount === undefined
      ? {}
      : { findingCount: extra.findingCount }),
    occurredAt,
  };
}

/** The SSE `event:` name this payload is delivered under. */
export const REVIEW_PROGRESS_EVENT_NAME = "review.progress" as const;

/**
 * The SSE `event:` name for the terminal frame.
 *
 * A distinct name rather than a flag on the payload, so a client can close the
 * stream on the event name alone without parsing every frame — and so a
 * dropped connection at the end is distinguishable from a completed one.
 */
export const REVIEW_PROGRESS_DONE_EVENT_NAME = "review.done" as const;
