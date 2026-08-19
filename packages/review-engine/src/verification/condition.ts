/**
 * One proposition: does this condition branch on a promise object rather than
 * on the boolean the programmer meant?
 *
 * # Why not a `ControlFlowVerifier`
 *
 * The tempting scope is "control flow", and it is the road back to
 * `observeSite` — one procedure recognising many shapes, accumulating reasons
 * that belong to different mechanisms, and eventually confident about a
 * proposition it never checked. That failure has already happened twice in this
 * codebase, and both times the generic thing looked like good factoring.
 *
 * So this capability answers one question and declines everything else,
 * including things that are obviously "async problems":
 *
 * ```
 * if (isReady())                 THIS capability
 * items.forEach(async …)         a different proposition entirely
 * ```
 *
 * The second is about a callback contract and an iterator API discarding the
 * promise it is handed — not about truthiness. Folding it in here would widen
 * the blast radius of every future change to either.
 *
 * # What verification requires
 *
 * All of it, or the answer is `inconclusive`:
 *
 * ```
 * the condition expression is resolved
 * the producing expression inside it is identified
 * the callee binds to a declaration
 * that declaration produces a promise
 * nothing unwraps it before the branch consumes it
 * ```
 *
 * "Probably async" is not on that list. A condition whose callee cannot be
 * bound — an untyped import, a dynamic property — stays unsettled, because the
 * pressure this capability will come under is to raise recall, and guessed
 * typing is how that pressure gets released quietly.
 */

import ts from "typescript";

import { resolveCallProduct } from "./binding.js";
import type {
  VerificationAttempt,
  VerificationContext,
  VerificationReason,
} from "./decide.js";
import type { VerificationInput } from "./input.js";

export const CONDITION_CAPABILITY_ID = "condition_value_semantics";

/** The condition, and what it branches on. */
type ConditionSite =
  | {
      readonly kind: "found";
      /** The line of the call whose product the branch consumes. */
      readonly producerLine: number;
      /** Already unwrapped — `if (await ready())`. Refutes the claim. */
      readonly unwrapped: boolean;
    }
  /** No `if`/`while` covers the claimed line, or nothing calls anything in it. */
  | { readonly kind: "absent" };

function locate(
  context: VerificationContext,
  path: string,
  line: number,
): ConditionSite {
  const item = context.items.find((entry) => entry.path === path);
  if (item === undefined) return { kind: "absent" };

  const source = ts.createSourceFile(
    path,
    item.content,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  let site: ConditionSite = { kind: "absent" };

  const visit = (node: ts.Node): void => {
    if (site.kind === "found") return;

    if (ts.isIfStatement(node) || ts.isWhileStatement(node)) {
      const start =
        source.getLineAndCharacterOfPosition(node.expression.getStart(source))
          .line + 1;
      const end = source.getLineAndCharacterOfPosition(
        node.expression.getEnd(),
      ).line;

      if (start <= line && line <= end + 1) {
        // `await ready()` — the value the branch sees is the resolved one, and
        // the claim is about the unresolved object. Observed here rather than
        // inferred from the claim's wording.
        const unwrapped = ts.isAwaitExpression(node.expression);
        const inner = unwrapped ? node.expression.expression : node.expression;

        if (ts.isCallExpression(inner)) {
          site = {
            kind: "found",
            producerLine:
              source.getLineAndCharacterOfPosition(inner.getStart(source))
                .line + 1,
            unwrapped,
          };
          return;
        }
        // A condition that is not a call at all — an identifier, a comparison.
        // Nothing here produces a value this capability can reason about.
        return;
      }
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return site;
}

/**
 * Adjudicates a "promise used as a condition" claim.
 *
 * Binding comes from {@link resolveCallProduct}, which asks the TypeScript
 * checker — the same independent channel the async capability uses, and for the
 * same reason: the analyzer proposes these from a symbol graph, and a second
 * opinion derived the same way would be no opinion at all.
 */
export function verifyConditionValue(
  input: VerificationInput,
  context: VerificationContext,
): VerificationAttempt {
  const decide = (
    decision: "verified" | "rejected" | "inconclusive",
    reasons: readonly VerificationReason[],
    confidence: number,
  ): VerificationAttempt => ({
    status: "completed",
    decision,
    reasons,
    confidence,
    severity: input.proposedSeverity,
  });

  const site = locate(context, input.location.path, input.location.startLine);

  if (site.kind === "absent") {
    // No branch here, or the branch does not consume a call's product. Not a
    // refutation: the planner may have supplied a stale revision, and the line
    // this capability was pointed at may simply not be the one that matters.
    return decide("inconclusive", ["context_incomplete"], 0.2);
  }

  if (site.unwrapped) {
    // `if (await ready())`. The branch sees the resolved boolean, so the
    // mechanism claimed cannot occur — observed, and therefore refutable.
    return decide("rejected", ["condition_value_is_not_a_promise"], 0.85);
  }

  const binding = resolveCallProduct(
    context,
    input.location.path,
    site.producerLine,
  );

  if (binding.kind === "unresolved") {
    // The decisive fact is unavailable. Not "probably async" — that is how a
    // capability under recall pressure starts inventing types.
    return decide("inconclusive", ["insufficient_evidence"], 0.25);
  }

  return binding.producesPromise
    ? decide("verified", ["condition_branches_on_promise"], 0.9)
    : decide("rejected", ["condition_value_is_not_a_promise"], 0.85);
}
