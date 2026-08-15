/**
 * Per-path review rules and their precedence (P0.txt §40).
 *
 * A path instruction is how a team says "in `migrations/`, be strict about
 * destructive DDL" or "in `**\/*.test.ts`, don't complain about magic numbers".
 * Several can match one file, so the contract's real job is not the rules —
 * it is deciding **which one wins, identically, every time**.
 *
 * # Why determinism is the whole point
 *
 * The resolved configuration is hashed into a `ReviewConfigSnapshot` (§39) and
 * pinned to a run, so that a review can be explained after the fact. If
 * precedence depended on object iteration order, map ordering, or the order a
 * YAML parser happened to emit, then the same repository would resolve to
 * different rules on different workers — and two runs of the same commit could
 * disagree with each other for no visible reason. That is unreproducible by
 * construction, and no amount of logging would recover it.
 *
 * # The order (§40)
 *
 *   1. **Specificity**, descending — literal segments in the glob. A rule that
 *      names `src/auth/session.ts` beats one that says `**`.
 *   2. **Priority**, descending — the author's explicit override, for when two
 *      rules are equally specific and one should still win.
 *   3. **Declaration order** — last resort, and total. Two rules identical in
 *      both of the above still need a defined winner, and **the one declared
 *      last wins**.
 *
 * "Last wins" rather than "first wins" is the convention every path-matching
 * rule list already uses — `.gitignore`, `CODEOWNERS`, ESLint `overrides`, CSS
 * — so it is what an author expects when they append a rule to the bottom of a
 * file to override what is above it.
 *
 * It is also what makes layering compose. Resolution concatenates
 * organization instructions and then repository instructions into one list
 * (§109), so "last wins" gives the repository the final say over its own
 * organization at equal specificity, with no extra precedence key and no
 * special case. Under "first wins", the organization would silently outrank
 * the repository, and the two rules would have to be re-ordered against
 * reading order to fix it.
 *
 * Sorting is by an explicit comparator over these three keys rather than by
 * `Array.prototype.sort` on a partial key, because `sort` is only guaranteed
 * stable within one engine's implementation and the tiebreak must be part of
 * the contract, not of V8.
 */

import { z } from "zod";
import type { RepositoryPath } from "../primitives/repository-path.js";
import { TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";
import {
  globPatternSchema,
  globSpecificity,
  matchesGlob,
  type GlobPattern,
} from "./glob.js";

/** Bounds on author-set priority. Narrow on purpose: this is a tiebreak. */
export const MIN_INSTRUCTION_PRIORITY = -1_000;
export const MAX_INSTRUCTION_PRIORITY = 1_000;
export const DEFAULT_INSTRUCTION_PRIORITY = 0;

/**
 * One rule scoped to a set of paths.
 *
 * `instructions` is natural-language prose, not a rule DSL. §40 asks for
 * per-path *instructions*, and the consumer is a language model: a DSL would
 * be a second language to design, validate, and version, and would express
 * less than a sentence does.
 *
 * `id` is namespaced so a resolved config can say *which* instruction
 * suppressed a finding — traceability that an anonymous rule cannot offer.
 */
export interface PathInstruction {
  readonly id: NamespacedId;
  /** Paths this applies to, in the dialect of {@link ./glob.js}. §40 names this field `glob`. */
  readonly glob: GlobPattern;
  /** What the reviewer should do for matching files. */
  readonly instructions: string;
  /** Explicit tiebreak among equally specific rules. Higher wins. */
  readonly priority: number;
}

export const pathInstructionSchema = z.strictObject({
  id: namespacedIdSchema,
  glob: globPatternSchema,
  instructions: z.string().min(1).max(TEXT_LIMITS.instructions),
  priority: z
    .number()
    .int()
    .min(MIN_INSTRUCTION_PRIORITY)
    .max(MAX_INSTRUCTION_PRIORITY),
});

/**
 * A path instruction paired with where it was declared.
 *
 * Declaration order is an input to precedence, so it cannot live implicitly in
 * an array's index — the array gets sorted, and the index would move with it.
 */
export interface OrderedPathInstruction {
  readonly instruction: PathInstruction;
  /** Position in the concatenated document. Higher was declared later, and wins. */
  readonly declarationOrder: number;
}

/**
 * Total order over path instructions: specificity, then priority, then
 * declaration order (later first).
 *
 * Returns a negative number when `left` wins. Never returns 0 for instructions
 * with distinct declaration orders, which is what makes the sort deterministic
 * regardless of the engine's stability guarantees.
 */
export function comparePathInstructions(
  left: OrderedPathInstruction,
  right: OrderedPathInstruction,
): number {
  const specificity =
    globSpecificity(right.instruction.glob) -
    globSpecificity(left.instruction.glob);
  if (specificity !== 0) return specificity;

  const priority = right.instruction.priority - left.instruction.priority;
  if (priority !== 0) return priority;

  return right.declarationOrder - left.declarationOrder;
}

/**
 * Orders instructions most-authoritative first.
 *
 * Pure: the input array is not mutated, so the caller's declaration order —
 * which is itself an input to the result — survives the call.
 */
export function sortPathInstructions(
  instructions: readonly OrderedPathInstruction[],
): readonly OrderedPathInstruction[] {
  return [...instructions].sort(comparePathInstructions);
}

/**
 * Attaches declaration order to instructions as written.
 *
 * The one place index-implies-order is correct: at the boundary where a source
 * document is read, before anything reorders it.
 */
export function withDeclarationOrder(
  instructions: readonly PathInstruction[],
): readonly OrderedPathInstruction[] {
  return instructions.map((instruction, declarationOrder) => ({
    instruction,
    declarationOrder,
  }));
}

/**
 * Every instruction matching `path`, most-authoritative first.
 *
 * All matches are returned rather than only the winner: instructions are
 * additive prose, and a file under `src/auth/` should receive both the
 * repository-wide convention and the auth-specific rule. The *order* is what
 * tells a consumer which to prefer when two of them conflict.
 */
export function instructionsForPath(
  instructions: readonly OrderedPathInstruction[],
  path: RepositoryPath,
): readonly PathInstruction[] {
  return sortPathInstructions(
    instructions.filter((ordered) =>
      matchesGlob(ordered.instruction.glob, path),
    ),
  ).map((ordered) => ordered.instruction);
}

/**
 * The single winning instruction for `path`, if any.
 *
 * For the cases where instructions genuinely conflict and only one answer is
 * possible — which is why the total order above must never return 0.
 */
export function winningInstructionForPath(
  instructions: readonly OrderedPathInstruction[],
  path: RepositoryPath,
): PathInstruction | undefined {
  return instructionsForPath(instructions, path)[0];
}
