/**
 * @acalys/contracts — the canonical language of the Acalys Review platform.
 *
 * Three layers, published as three subpaths so boundaries are enforced by
 * import path rather than by discipline:
 *
 *   @acalys/contracts/domain    canonical types every package models against
 *   @acalys/contracts/api/v1    public DTOs — what apps/web is allowed to see
 *   @acalys/contracts/internal  commands and events — workers only
 *
 * The root export re-exports the domain layer for convenience. The web app
 * must import `/api/v1`, never `/internal`.
 */
export * from "./domain/index.js";
