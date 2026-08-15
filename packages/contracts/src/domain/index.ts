/**
 * The canonical domain layer — provider-neutral, persistence-neutral,
 * agent-neutral (P0.txt §59, §60, §61).
 *
 * This is the base of the dependency graph. It imports nothing from the API or
 * internal layers, and dependency-cruiser fails the build if that ever
 * changes: DTOs project *from* the domain and events are built *on* it, never
 * the reverse.
 */
export * from "./primitives/index.js";
export * from "./errors/index.js";
export * from "./identity/index.js";
export * from "./ports/index.js";
export * from "./git/index.js";
export * from "./provider/index.js";
export * from "./actor/index.js";
export * from "./tenancy/index.js";
export * from "./repository/index.js";
export * from "./location/index.js";
export * from "./review-target/index.js";
export * from "./pull-request/index.js";
export * from "./change/index.js";
export * from "./review/index.js";
export * from "./artifacts/index.js";
export * from "./tools/index.js";
export * from "./ci/index.js";
export * from "./evidence/index.js";
export * from "./finding/index.js";
