/**
 * The publication intent lifecycle.
 *
 * Five states, and the whole design turns on the fourth existing at all.
 *
 * ```
 *     planned  ──▶ attempting ──┬──▶ published   (observed in provider state)
 *                    ▲          ├──▶ unknown     (we do not know)
 *                    │          ├──▶ failed      (permanently rejected)
 *                    │          └──▶ planned     (retryable, backing off)
 *                    │
 *                 unknown ──────┴──▶ published | failed
 * ```
 *
 * # Why `unknown` is not a kind of `failed`
 *
 * A timeout means *we do not know whether the provider committed the effect*.
 * It does not mean the effect is absent. Collapsing the two is the single most
 * expensive mistake available here, because the recovery for "failed" is to
 * retry — and P1-E.3 measured what a blind retry does after a submitted review
 * exists: GitHub accepts it, and a duplicate review appears on someone's pull
 * request. (Before submission GitHub refuses with 422, which protects exactly
 * one of the two windows and is not something to rely on.)
 *
 * So `unknown` is a first-class state whose only exits go through a provider
 * lookup. That is enforced by the store, not by convention.
 *
 * # Why `failed` is terminal and `planned` is the retry state
 *
 * A retryable error returns the row to `planned` with a backoff, which keeps
 * "we will try again" and "we gave up" as different rows rather than the same
 * row with a counter someone has to interpret. `failed` therefore means
 * permanently rejected — a 403 on a repository the App was uninstalled from —
 * and never "the network was briefly unhappy".
 */

export const PUBLICATION_STATES = [
  "planned",
  "attempting",
  "unknown",
  "published",
  "failed",
] as const;

export type PublicationState = (typeof PUBLICATION_STATES)[number];

/**
 * Legal moves. Frozen, and the only source of truth for both the store and its
 * tests — a table the tests re-declare is a table that can drift from the code
 * it claims to describe.
 */
const TRANSITIONS: Readonly<
  Record<PublicationState, readonly PublicationState[]>
> = Object.freeze({
  // A failure can happen during the reconciliation lookup, before anything has
  // been attempted. `planned → planned` records the backoff and
  // `planned → failed` a permanent refusal — a 403 on the lookup is as terminal
  // as a 403 on the write. Without them the ledger has nowhere to put a failure
  // it definitely observed, and the row silently keeps its previous error.
  planned: Object.freeze(["attempting", "planned", "failed"] as const),
  // `planned` is the retryable path: same identity, later.
  //
  // `attempting → attempting` is a replacement worker resuming a row whose
  // previous owner died mid-attempt. It is a genuinely new attempt, so the
  // counter moves — and like every other re-entry it requires a fresh
  // reconciliation, because a worker that died in `attempting` may well have
  // created the review before it went.
  attempting: Object.freeze([
    "published",
    "unknown",
    "failed",
    "planned",
    "attempting",
  ] as const),
  // Every exit from `unknown` requires provider evidence; `attempting` is
  // reached only after reconciliation reported the effect absent.
  //
  // `unknown → planned` is deliberately absent: it would be a blind retry with
  // a backoff attached, which is the move that publishes duplicates.
  unknown: Object.freeze(["published", "failed", "attempting"] as const),
  published: Object.freeze([] as const),
  failed: Object.freeze([] as const),
});

export function canTransitionPublication(
  from: PublicationState,
  to: PublicationState,
): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalPublicationState(state: PublicationState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Every legal move, for exhaustive table-testing rather than sampling. */
export function legalPublicationTransitions(): readonly (readonly [
  PublicationState,
  PublicationState,
])[] {
  return PUBLICATION_STATES.flatMap((from) =>
    TRANSITIONS[from].map((to) => [from, to] as const),
  );
}
