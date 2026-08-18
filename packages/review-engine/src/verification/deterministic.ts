/**
 * A verifier that re-derives the claim instead of agreeing with it.
 *
 * Deterministic on purpose, and first on purpose. A model-backed verifier
 * cannot be trusted until there is something to compare it against, and this is
 * that baseline: given the same facts and the same independently-planned
 * context it always reaches the same decision with the same reasons, so a
 * later disagreement with a model verifier is attributable to the model.
 *
 * # What "independent" means here, concretely
 *
 * It re-parses the claimed location **from its own context** and asks whether
 * the mechanism the claim describes is actually there. It does not read the
 * evidence and nod.
 *
 * ```
 * the mechanism is present, and the cited declaration confirms it
 *     → verified
 * the mechanism is absent, or something guards it
 *     → rejected, with the specific reason
 * the context could not establish either
 *     → inconclusive
 * ```
 *
 * # The degradation rule that is easy to get wrong
 *
 * Missing evidence degrades `verified → inconclusive`, **never → rejected**.
 * "We could not confirm it" and "we established it is false" are different
 * claims, and collapsing them means every gap in context is recorded as an
 * analyzer false positive — precision would improve as the planner got worse.
 */

import ts from "typescript";

import {
  assertReasonsSupport,
  type VerificationAttempt,
  type VerificationContext,
  type VerificationDecision,
  type VerificationReason,
  type Verifier,
} from "./decide.js";
import type { VerificationInput } from "./input.js";

export const DETERMINISTIC_VERIFIER_ID = "acalys.verifier.re-derivation";
export const DETERMINISTIC_VERIFIER_VERSION = "1.0.0";

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isAsyncDeclaration(node: ts.Node): boolean {
  const asyncKeyword =
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    );
  if (asyncKeyword) return true;

  const typed = node as { type?: ts.TypeNode };
  return (
    typed.type !== undefined &&
    ts.isTypeReferenceNode(typed.type) &&
    ts.isIdentifier(typed.type.typeName) &&
    typed.type.typeName.text === "Promise"
  );
}

/**
 * Whether a name is declared asynchronous anywhere in the verifier's context.
 *
 * Returns `undefined` for "the context does not contain this declaration",
 * which is a different fact from "it is not asynchronous". Collapsing the two
 * is what turns a planner gap into a rejection.
 */
function declaredAsync(
  context: VerificationContext,
  name: string,
): boolean | undefined {
  let seen = false;
  let isAsync = false;

  for (const item of context.items) {
    const source = parse(item.path, item.content);
    const visit = (node: ts.Node): void => {
      const named = node as ts.NamedDeclaration;
      const nameNode = named.name;
      if (
        nameNode !== undefined &&
        ts.isIdentifier(nameNode) &&
        nameNode.text === name &&
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isVariableDeclaration(node))
      ) {
        seen = true;
        if (
          isAsyncDeclaration(node) ||
          (ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            isAsyncDeclaration(node.initializer))
        ) {
          isAsync = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  return seen ? isAsync : undefined;
}

/** What the verifier itself found at the claimed line. */
interface SiteObservation {
  readonly found: boolean;
  readonly callee: string | undefined;
  readonly guarded: boolean;
}

function observeSite(
  context: VerificationContext,
  path: string,
  line: number,
): SiteObservation {
  const item = context.items.find((entry) => entry.path === path);
  if (item === undefined) {
    return { found: false, callee: undefined, guarded: false };
  }

  const source = parse(path, item.content);
  let result: SiteObservation = {
    found: false,
    callee: undefined,
    guarded: false,
  };

  const visit = (node: ts.Node): void => {
    if (result.found) return;
    const start =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

    if (ts.isExpressionStatement(node) && start <= line && line <= end) {
      const expression = node.expression;

      // The guards a reader would call deliberate, observed independently
      // rather than taken from the claim.
      if (ts.isVoidExpression(expression) || ts.isAwaitExpression(expression)) {
        result = { found: true, callee: undefined, guarded: true };
        return;
      }

      if (ts.isCallExpression(expression)) {
        const methods: string[] = [];
        let current: ts.Expression = expression;
        while (
          ts.isCallExpression(current) &&
          ts.isPropertyAccessExpression(current.expression) &&
          ts.isIdentifier(current.expression.name) &&
          ts.isCallExpression(current.expression.expression)
        ) {
          methods.push(current.expression.name.text);
          current = current.expression.expression;
        }

        const root = ts.isCallExpression(current) ? current : undefined;
        let callee: string | undefined;
        if (root !== undefined) {
          if (ts.isIdentifier(root.expression)) {
            callee = root.expression.text;
          } else if (
            ts.isPropertyAccessExpression(root.expression) &&
            ts.isIdentifier(root.expression.name)
          ) {
            callee = root.expression.name.text;
          }
        }

        result = {
          found: true,
          callee,
          guarded: methods.includes("catch") || methods.includes("finally"),
        };
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return result;
}

/**
 * Re-derives the claim from independently planned context.
 *
 * Never rejects a claim it does not understand: an unrecognized shape is
 * `inconclusive`. A verifier that rejected what it could not parse would
 * suppress every finding from the next analyzer anyone writes.
 */
export function verifyDeterministically(
  input: VerificationInput,
  context: VerificationContext,
): VerificationAttempt {
  const decide = (
    decision: VerificationDecision,
    reasons: readonly VerificationReason[],
    confidence: number,
  ): VerificationAttempt => {
    // Checked on the way out, so a confirming reason can never appear under a
    // rejection however the branches below are edited later.
    assertReasonsSupport(decision, reasons);
    return {
      status: "completed",
      decision,
      reasons,
      confidence,
      severity: input.proposedSeverity,
    };
  };

  if (context.incomplete || context.items.length === 0) {
    // The planner could not supply something it wanted. Not the analyzer's
    // fault, and not evidence against the claim.
    return decide("inconclusive", ["context_incomplete"], 0.2);
  }

  const site = observeSite(
    context,
    input.location.path,
    input.location.startLine,
  );

  if (!site.found) {
    return decide("rejected", ["claimed_mechanism_not_present"], 0.8);
  }

  if (site.guarded) {
    return decide("rejected", ["guarded_on_all_paths"], 0.85);
  }

  const callee = site.callee;
  if (callee === undefined) {
    return decide("inconclusive", ["insufficient_evidence"], 0.3);
  }

  const asyncInContext = declaredAsync(context, callee);

  if (asyncInContext === undefined) {
    // The declaration that would settle it was never supplied.
    return decide("inconclusive", ["insufficient_evidence"], 0.3);
  }

  const evidenceClaimsAsync = input.evidence.some(
    (item) =>
      item.observation.includes(callee) &&
      /async|Promise/.test(item.observation),
  );

  if (!asyncInContext && evidenceClaimsAsync) {
    // Something is known, and it conflicts with the supplied support — the most
    // interesting signal a verifier produces, and it would be lost inside a
    // generic insufficiency.
    return decide("inconclusive", ["conflicting_independent_evidence"], 0.25);
  }

  if (!asyncInContext) {
    return decide("rejected", ["claim_contradicted_by_context"], 0.85);
  }

  const reasons: VerificationReason[] = ["independent_context_confirms"];
  if (evidenceClaimsAsync) reasons.push("evidence_supports_claim");
  return decide("verified", reasons, 0.9);
}

export const deterministicVerifier: Verifier = {
  id: DETERMINISTIC_VERIFIER_ID,
  version: DETERMINISTIC_VERIFIER_VERSION,
  verify: verifyDeterministically,
};
