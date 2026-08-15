// LineRange and lineRangeSchema moved to ../location in Checkpoint C —
// they are location primitives, and one canonical home avoids the duplicate
// definitions P0.txt §105 warns against. Consumers import them from
// @acalys/contracts/domain, which re-exports both modules.
export * from "./change-manifest.js";
