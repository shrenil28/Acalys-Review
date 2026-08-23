/**
 * P1-M.4 — a call whose result was used at base and is thrown away at head.
 *
 * ```ts
 * // base                        // head
 * return normalize(raw);         normalize(raw);
 *                                return raw;
 * ```
 *
 * The call still happens, so nothing reads as unused. What is lost is the
 * difference between what came back and what the caller now returns.
 *
 * # What this analyzer is forbidden to know
 *
 * Everything about the callee. It may not resolve the binding, consult the
 * checker, or read the callee's body:
 *
 * ```
 * FORBIDDEN: bindings, types, the callee's return statements
 * ```
 *
 * So it will propose on `assertValid(raw)` returning `void`, on
 * `isValid(raw)` returning a predicate, and on `identity(raw)` returning its
 * own argument — none of which is this capability's defect. That is the
 * design. The verifier resolves the exact callee and settles it, and an
 * analyzer taught to be certain here would move the semantics into the stage
 * that cannot be contradicted.
 *
 * The hypothesis is one thing only:
 *
 * ```
 * BASE  the call's value was consumed
 * HEAD  the same call stands alone as a statement
 * ```
 */

import ts from "typescript";
import type { AnalysisResult, CandidateFinding } from "../finding.js";
import type { AsyncAnalyzerInput } from "./async-completion.js";
import { comparableSources, type ChangedSource } from "./api-compatibility.js";

export const DISCARDED_REPLACEMENT_RULE_ID =
  "acalys.correctness/discarded-replacement-return";

/** A call whose result the surrounding code does nothing with. */
interface DiscardedCall {
  readonly callee: string;
  /** The first argument's text, when the call has one. */
  readonly argument: string | undefined;
  readonly line: number;
  readonly text: string;
}

/**
 * The callee's name as written, for a plain or member call.
 *
 * Used to pair a base call with its head counterpart and to state the claim.
 * It is emphatically NOT how the verifier will find the declaration — name
 * matching is what the historical case's same-named decoy exists to punish.
 */
function calleeName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.name)
  ) {
    return node.expression.name.text;
  }
  return undefined;
}

/**
 * Calls standing alone as expression statements — their value discarded.
 *
 * `await f()` and `void f()` are excluded. The first belongs to
 * `async_value_use`, which already owns discarded promises; the second is an
 * author saying explicitly that the result is not wanted, which is a
 * statement of intent rather than an oversight.
 */
function discardedCalls(source: ts.SourceFile): readonly DiscardedCall[] {
  const found: DiscardedCall[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression)
    ) {
      const call = node.expression;
      const name = calleeName(call);
      if (name !== undefined) {
        found.push({
          callee: name,
          argument: call.arguments[0]?.getText(source),
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          text: node.getText(source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}

/**
 * Callee names whose result this revision consumes somewhere.
 *
 * "Consumed" is any position that is not a bare expression statement —
 * returned, assigned, passed on, awaited, used in a condition. The analyzer
 * does not care which; it cares that the value went somewhere at base and
 * goes nowhere at head.
 */
function consumedCallees(source: ts.SourceFile): ReadonlySet<string> {
  const consumed = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const discarded =
        node.parent !== undefined && ts.isExpressionStatement(node.parent);
      if (name !== undefined && !discarded) consumed.add(name);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return consumed;
}

export function analyzeDiscardedReplacement(
  input: AsyncAnalyzerInput,
): AnalysisResult {
  const findings: CandidateFinding[] = [];
  const clusterId = input.clusterId ?? "cluster:unscoped";
  const { sources, degradations } = comparableSources(input);

  for (const source of sources) {
    findings.push(...candidatesFor(source, clusterId));
  }

  return {
    findings,
    suppressions: [],
    degradations: degradations.map((entry) => ({
      clusterId,
      reason: `${entry.path}: ${entry.because}`,
    })),
  };
}

function candidatesFor(
  source: ChangedSource,
  clusterId: string,
): readonly CandidateFinding[] {
  const consumedAtBase = consumedCallees(source.base);
  const consumedAtHead = consumedCallees(source.head);
  const findings: CandidateFinding[] = [];
  const seen = new Set<string>();

  for (const call of discardedCalls(source.head)) {
    // The value had to be going somewhere before. A call that was already a
    // bare statement at base is not a change this capability is about.
    if (!consumedAtBase.has(call.callee)) continue;
    // Still consumed somewhere at head — the author kept a use of the result
    // and this particular statement is not the loss.
    if (consumedAtHead.has(call.callee)) continue;
    if (call.argument === undefined) continue;
    if (seen.has(call.callee)) continue;
    seen.add(call.callee);

    findings.push(candidateFor(source.path, call, clusterId));
  }

  return findings;
}

function candidateFor(
  path: string,
  call: DiscardedCall,
  clusterId: string,
): CandidateFinding {
  // From the discarding statement itself. M.3.3's holdout false positive is
  // the standing reminder that a correct finding at an invented line is still
  // a broken review, so there is no fallback constant here.
  const location = { path, startLine: call.line, endLine: call.line };
  const argument = call.argument ?? "the argument";

  return {
    ruleId: DISCARDED_REPLACEMENT_RULE_ID,
    category: "correctness",
    family: "data_flow",
    claim:
      `The result of \`${call.callee}(${argument})\` was used at the base revision and is discarded here, ` +
      `so any replacement value it returns for \`${argument}\` is lost.`,
    causal: {
      anchor: location,
      steps: [
        `The base revision consumed the result of \`${call.callee}\`.`,
        `\`${call.text}\` now discards it.`,
        `If \`${call.callee}\` returns a transformed replacement for \`${argument}\`, the caller keeps the original instead.`,
      ],
      trigger: `calling \`${call.callee}\` and continuing with \`${argument}\``,
      consequence:
        "the untransformed value flows onward, and the callee's normalization is silently lost",
    },
    remediation: `Use the result of \`${call.callee}(${argument})\` instead of \`${argument}\`, or confirm the callee returns nothing worth keeping.`,
    counterfactual: {
      existsWithoutChange: false,
      because: "the base revision consumed the result",
    },
    proposedSeverity: "medium",
    // Deliberately modest. Discarding a result is consistent with a void
    // procedure, a predicate, and an identity function, none of which is this
    // capability's defect. The verifier is what separates them.
    confidenceScore: 0.45,
    location,
    evidence: [
      {
        type: "static_analysis",
        strength: "supporting",
        observation: `The base revision used the result of \`${call.callee}\`; the changed file does not.`,
        location,
      },
      {
        type: "static_analysis",
        strength: "supporting",
        observation: `The published location is established evidence: \`${call.text}\` is the statement that discards the result.`,
        location,
      },
    ],
    identityHint: `${path}:${call.callee}:discarded-replacement-return`,
    clusterId,
  };
}
