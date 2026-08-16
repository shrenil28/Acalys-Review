/**
 * The public API layer (P0.txt §76).
 *
 * What `apps/web` is allowed to see, and the only contract layer it may
 * import. Everything here is either a DTO, a projection that builds one, or
 * the route manifest that describes where they travel.
 *
 * Nothing here exposes an execution concept — no attempt, lease, worker,
 * queue, sandbox, raw model output, or idempotency key. That exclusion is
 * asserted by `tests/api/dto-leakage.test.ts`, which walks every schema in
 * this layer rather than trusting review.
 */
export * from "./common.js";
export * from "./resources.js";
export * from "./progress.js";
export * from "./routes.js";
