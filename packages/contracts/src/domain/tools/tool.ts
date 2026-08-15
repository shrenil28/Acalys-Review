/**
 * Tool identity and execution status (P0.txt §41, §115).
 *
 * The tool *registry* and its execution are later phases. What Phase 0 fixes
 * is identity, so that evidence produced by a tool can be attributed, counted,
 * and reproduced without the contracts package knowing anything about how
 * tools run.
 *
 * `id` is a namespaced string rather than an enum because the tool set is open
 * by definition — the platform is meant to host dozens of analyzers plus
 * tenant-defined checks, and adding one must never require a schema release
 * (§79, §115).
 *
 * `version` matters more than it looks: an analyzer's findings change between
 * releases, so "semgrep found this" is only reproducible as "semgrep 1.52.0
 * with rule X found this" (§72).
 */

import { z } from "zod";
import { TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/**
 * Which tool, at which version.
 *
 * Deliberately carries no command line, no configuration, and no file paths:
 * those are execution details that would couple this contract to one runner
 * and leak host paths into stored evidence (§41, §63).
 */
export interface ToolReference {
  /** e.g. `tool.semgrep`, `acalys.compiler.typescript`. */
  readonly id: NamespacedId;
  /** The tool's own version string, verbatim. */
  readonly version?: string | undefined;
}

export const toolReferenceSchema = z.strictObject({
  id: namespacedIdSchema,
  version: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
});

/**
 * Lifecycle of one tool invocation (§41).
 *
 * `timed_out` and `skipped` are distinct from `failed` because they mean
 * different things for the review: a timeout leaves coverage genuinely
 * unknown, a skip was a deliberate decision, and a failure is a defect. A
 * reviewer that treats all three as "no findings" would silently report clean
 * on a file nothing ever examined.
 */
export const TOOL_RUN_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
] as const;

export type ToolRunState = (typeof TOOL_RUN_STATES)[number];

export const toolRunStateSchema = z.enum(TOOL_RUN_STATES);

/**
 * A pointer to one execution of a tool.
 *
 * Evidence cites this so a finding can be traced to the exact invocation that
 * produced it, and so the same tool run backing twenty findings is stored once
 * (§29, §115).
 */
export interface ToolRunReference {
  readonly tool: ToolReference;
  /** Identifies this invocation. Opaque to the domain. */
  readonly runId: string;
  readonly state: ToolRunState;
}

export const toolRunReferenceSchema = z.strictObject({
  tool: toolReferenceSchema,
  runId: z.string().min(1).max(TEXT_LIMITS.identifier),
  state: toolRunStateSchema,
});

/**
 * Whether a run finished in a way that makes its absence of findings
 * meaningful.
 *
 * Only `completed` licenses the inference "this tool found nothing, therefore
 * nothing is there". Every other terminal state means coverage is unknown.
 */
export function producedTrustworthyCoverage(run: ToolRunReference): boolean {
  return run.state === "completed";
}
