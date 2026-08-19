/**
 * Whether the API receiving an async callback ignores the promise it returns —
 * and whether that ignoring proves the claimed consequence.
 *
 * # Two facts, deliberately not collapsed
 *
 * ```
 * the callback's promise is ignored          language and API semantics
 * ignoring it causes the claimed defect      correctness semantics
 * ```
 *
 * `Array.prototype.forEach` discards its callback's return value. That is a
 * fact about the standard library, and it is not by itself an actionable
 * finding: telemetry fired inside a `forEach` and never awaited may be exactly
 * what the author intended. The claim is that the surrounding operation
 * proceeds before the work completes, and proving the first half is not proving
 * the claim.
 *
 * So `verified` requires both, and the second is why this abstains more than a
 * pattern matcher would.
 *
 * # Never by method name
 *
 * ```ts
 * items.forEach(async …)          Array — the promise is dropped
 * await queue.forEach(async …)    a user type that awaits its callbacks
 * ```
 *
 * Identical syntax, opposite verdicts. A rule keyed on `forEach` gets the
 * second wrong, and gets it wrong silently, in someone's own abstraction —
 * which is the worst place for a reviewer to be confidently mistaken. The
 * receiver is bound through the checker and its declaration decides.
 *
 * # Independence
 *
 * The analyzer proposes these from `@acalys/code-intelligence`'s call graph
 * plus a rule about known iterator APIs. This binds the receiver through the
 * TypeScript checker and reads the declared callback contract. Neither calls
 * the other, and there is deliberately no shared `isAsyncForEachBug()` — the
 * pattern is now known, which is exactly when that helper becomes tempting.
 */

import ts from "typescript";

import { programOf } from "./binding.js";
import type {
  VerificationAttempt,
  VerificationContext,
  VerificationReason,
} from "./decide.js";
import type { VerificationInput } from "./input.js";

export const CALLBACK_CAPABILITY_ID = "async_callback_contract";

/**
 * What the receiving API does with the value its callback returns.
 *
 * `ignores` is established from the receiver's declared callback return type:
 * a callback declared to return `void` cannot have its promise awaited by the
 * receiver, whatever the receiver's name is.
 */
type ReceiverContract =
  | { readonly kind: "ignores"; readonly detail: string }
  | { readonly kind: "consumes"; readonly detail: string }
  /**
   * The receiver hands the callback's value back out — `map` returning `U[]`.
   *
   * Nothing is dropped: the promises become the receiver's return value, and
   * whoever called it decides what to do with them. `await Promise.all(items.map(async …))`
   * lives here, and a rule that only distinguished "awaits" from "ignores"
   * would call it a defect.
   */
  | { readonly kind: "propagates"; readonly detail: string }
  | { readonly kind: "unknown"; readonly why: string };

/** The `void`-returning callback signature is what makes a promise droppable. */
function contractOf(
  declaration: ts.Declaration,
  argumentIndex: number,
): ReceiverContract {
  const signature = ts.isFunctionLike(declaration) ? declaration : undefined;
  if (signature === undefined) {
    return {
      kind: "unknown",
      why: "the receiver is not a callable declaration",
    };
  }

  const parameter = signature.parameters[argumentIndex];
  if (parameter?.type === undefined) {
    return {
      kind: "unknown",
      why: "the callback parameter has no declared type",
    };
  }

  const type = parameter.type;
  if (!ts.isFunctionTypeNode(type)) {
    return {
      kind: "unknown",
      why: "the callback parameter is not a function type",
    };
  }

  const returns = type.type;
  if (returns.kind === ts.SyntaxKind.VoidKeyword) {
    // The receiver has declared it will not look at the return value. A
    // promise handed back here is dropped by contract, not by accident.
    return {
      kind: "ignores",
      detail: "the receiver declares its callback returns `void`",
    };
  }

  if (
    ts.isTypeReferenceNode(returns) &&
    ts.isIdentifier(returns.typeName) &&
    (returns.typeName.text === "Promise" ||
      returns.typeName.text === "PromiseLike")
  ) {
    // The receiver accepts a promise back, so it is in a position to await it.
    // `await queue.forEach(async …)` lives here, and refuting the claim on a
    // user abstraction is exactly what a name-keyed rule cannot do.
    return {
      kind: "consumes",
      detail: "the receiver accepts a promise from its callback",
    };
  }

  // A type parameter that reappears in the receiver's own return type: the
  // callback's value flows out rather than being discarded.
  if (
    ts.isTypeReferenceNode(returns) &&
    ts.isIdentifier(returns.typeName) &&
    signature.type !== undefined &&
    signature.type.getText().includes(returns.typeName.text)
  ) {
    return {
      kind: "propagates",
      detail: "the receiver returns what its callback produced",
    };
  }

  return { kind: "unknown", why: "the callback's declared return is neither" };
}

/**
 * Whether anything after the call assumes the work finished.
 *
 * The second fact. Without it, an ignored promise is a language observation and
 * not the claimed defect — telemetry nobody waits for is not a bug.
 *
 * Read narrowly: a statement *after* the call, in the same block, that is not
 * itself part of the iteration. That is the shape the claim describes — "the
 * surrounding operation proceeds before the work completes" — and anything
 * looser starts inferring intent, which this file has no basis to do.
 */
function proceedsAfterwards(call: ts.CallExpression): boolean {
  // The enclosing function's own contract counts as a consequence.
  //
  // A function declared to return `void` tells every caller that when it
  // returns, it is done. If the work it started is still in flight, the caller
  // proceeds on a promise the signature made — which is the claimed
  // consequence, established from a declaration rather than guessed.
  const enclosingReturnsVoid = (): boolean => {
    let node: ts.Node = call;
    while (node.parent !== undefined) {
      node = node.parent;
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node)
      ) {
        return node.type?.kind === ts.SyntaxKind.VoidKeyword;
      }
    }
    return false;
  };

  let statement: ts.Node = call;
  while (
    statement.parent !== undefined &&
    !ts.isExpressionStatement(statement)
  ) {
    statement = statement.parent;
  }
  const block = statement.parent;
  if (block === undefined || !ts.isBlock(block)) return false;

  const index = block.statements.indexOf(statement as ts.Statement);
  if (index < 0) return false;

  if (enclosingReturnsVoid()) return true;

  return block.statements.slice(index + 1).some((after) => {
    // A bare `return;` proceeds no further than the function boundary, and a
    // function that simply ends is not "proceeding as if the work completed".
    if (ts.isReturnStatement(after) && after.expression === undefined) {
      return false;
    }
    return true;
  });
}

export function verifyAsyncCallbackContract(
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

  const program = programOf(context);
  const source = program?.getSourceFile(input.location.path);
  if (program === undefined || source === undefined) {
    return decide("inconclusive", ["context_incomplete"], 0.2);
  }

  const checker = program.getTypeChecker();
  const line = input.location.startLine;

  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (call !== undefined) return;
    if (ts.isCallExpression(node)) {
      const start =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      if (start <= line && line <= end) {
        call = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  if (call === undefined) {
    return decide("inconclusive", ["context_incomplete"], 0.2);
  }

  // The callback argument, and whether it is actually asynchronous. A
  // synchronous callback returns no promise, so there is nothing to drop.
  const callbackIndex = call.arguments.findIndex(
    (argument) =>
      (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
      (ts.getModifiers(argument) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      ),
  );

  if (callbackIndex < 0) {
    return decide("rejected", ["callback_returns_no_promise"], 0.85);
  }

  // The receiver, bound rather than named.
  const symbol = checker.getSymbolAtLocation(call.expression);
  const resolved =
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const declaration = resolved?.declarations?.[0];

  if (declaration === undefined) {
    // Includes `Array.prototype.forEach` in a program with no standard library.
    // Abstaining is correct: the receiver's contract is genuinely unavailable,
    // and assuming `forEach` means the built-in is the name-keyed mistake by
    // another route.
    return decide("inconclusive", ["receiver_contract_unavailable"], 0.2);
  }

  const contract = contractOf(declaration, callbackIndex);

  if (contract.kind === "unknown") {
    return decide("inconclusive", ["receiver_contract_unavailable"], 0.2);
  }
  if (contract.kind === "consumes" || contract.kind === "propagates") {
    return decide("rejected", ["receiver_awaits_callback_result"], 0.85);
  }

  // The promise is dropped. That alone is a language fact, not the claim.
  if (!proceedsAfterwards(call)) {
    return decide("inconclusive", ["completion_relevance_unestablished"], 0.25);
  }

  return decide("verified", ["callback_result_discarded_by_receiver"], 0.85);
}
