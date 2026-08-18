/**
 * A planner scenario: a small repository whose required context is known.
 *
 * The corpus exists so that "did the planner supply what a reviewer would need?"
 * has an objective answer *before* a model is involved. Without it, every missed
 * finding looks like a model problem, and the two most expensive failure modes
 * are indistinguishable:
 *
 *     the model saw the callee and failed to reason about it
 *     the model never saw the callee
 *
 * Each scenario states what must be present, what must not consume budget, and
 * why — so a failing metric names its own cause rather than reporting that a
 * number moved.
 */

import type { ChangedFileInput } from "../planner.js";

/** Something the planner must supply, and the reason it matters. */
export interface RequiredContext {
  readonly path: string;
  /** When set, the specific declaration that must appear. */
  readonly symbol?: string | undefined;
  /** Why a reviewer cannot do without it. Shown in failure output. */
  readonly because: string;
}

/**
 * Something that must NOT reach the analyzer.
 *
 * Distinct from "merely not required": these are items the planner will be
 * tempted by — a generated file that genuinely imports the changed symbol, a
 * vendored dependency — and that would evict real context if admitted.
 */
export interface ForbiddenContext {
  readonly path: string;
  readonly because: string;
}

export interface PlannerScenario {
  readonly id: string;
  readonly summary: string;
  /** path → source. The whole repository, including unchanged files. */
  readonly files: Readonly<Record<string, string>>;
  readonly changed: readonly {
    readonly path: string;
    readonly changedLines: readonly number[];
  }[];
  readonly instructions?:
    readonly { readonly path: string; readonly content: string }[] | undefined;
  readonly pathInstructions?:
    | readonly { readonly glob: string; readonly instructions: string }[]
    | undefined;
  readonly required: readonly RequiredContext[];
  readonly forbidden?: readonly ForbiddenContext[] | undefined;
  /** Budget to plan under. Defaults to a generous one. */
  readonly budgetTokens?: number | undefined;
  /**
   * Another scenario this one must select equivalent context to.
   *
   * The stability pair: the same semantic change expressed differently — moved
   * down a file, reformatted — must not change what the reviewer sees. Without
   * this, an unrelated edit above a function silently changes its review.
   */
  readonly equivalentTo?: string | undefined;
}

export type { ChangedFileInput };
