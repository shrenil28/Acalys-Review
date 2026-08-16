/**
 * The internal layer — commands and events (P0.txt §48, §77).
 *
 * Private to the backend. `apps/web` must never import this path, and
 * dependency-cruiser fails the build if it does: a UI coupled to the event
 * taxonomy is a UI coupled to worker internals, which is the invariant the
 * monorepo shape exists to hold.
 *
 * Commands and events are kept in separate modules with separate envelopes,
 * deliberately un-shared — see `commands/envelope.ts` for why.
 */
export * from "./events/index.js";
export * from "./commands/index.js";
