/**
 * Exception flow, where the honest answer is usually "I cannot tell".
 *
 * # The asymmetry
 *
 * A silent `catch` is either a bug or a deliberate decision, and the code
 * usually looks identical either way. So neither direction gets a default:
 *
 * ```
 * refuting the candidate   needs affirmative evidence that swallowing is INTENDED
 * verifying the candidate  needs affirmative evidence that swallowing VIOLATES a contract
 * neither                  inconclusive
 * ```
 *
 * Two shortcuts are available and both are wrong:
 *
 * ```
 * the catch is empty          ⇏ verified
 * a comment says "ignore"     ⇏ rejected
 * ```
 *
 * The first turns every best-effort cleanup in a codebase into a review
 * comment. The second lets anyone silence the reviewer by typing the right
 * words next to the defect — and this repository's own adversarial corpus case
 * is exactly that, a `// acalys-disable-next-line` beside a real swallowed
 * failure. Comments can say where to look for a contract. They are not the
 * contract.
 *
 * # What this proves is the consequence, not the shape
 *
 * `catch {}` is a syntax. The defect is that a failure disappears and something
 * downstream proceeds as though it did not happen. So the evidence sought is
 * about what happens **after** the catch, not about how empty it is.
 *
 * # Abstention here is not a gap to close
 *
 * For a `catch {}` in a function that does nothing afterwards, `inconclusive`
 * may be the permanent right answer: the repository genuinely does not say
 * whether the author meant it. A future capability with access to tests,
 * interface contracts or call-site expectations may settle more of these. None
 * of them will settle all, and a version of this that reached for a verdict
 * anyway would be worse than the one that abstains.
 */

import ts from "typescript";

import type {
  VerificationAttempt,
  VerificationContext,
  VerificationReason,
} from "./decide.js";
import type { VerificationInput } from "./input.js";

export const EXCEPTION_CAPABILITY_ID = "exception_flow";

/** Affirmative evidence, in one direction or the other. */
interface ExceptionEvidence {
  /** The failure is suppressed and something downstream reports success. */
  readonly violates: boolean;
  /** The suppression is contracted: a fallback, a rethrow, a report. */
  readonly intended: boolean;
  readonly detail: string;
}

/** Whether a returned expression asserts success without consulting the try. */
function reportsSuccess(node: ts.Expression | undefined): boolean {
  if (node === undefined) return false;
  // A literal `true`, or an object literal with an `ok`/`success` member set to
  // `true`. Deliberately narrow: these are shapes that *assert* an outcome, as
  // opposed to returning something derived from the guarded work.
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        /^(ok|success|succeeded)$/i.test(property.name.text) &&
        property.initializer.kind === ts.SyntaxKind.TrueKeyword,
    );
  }
  return false;
}

/**
 * Reads the evidence around a catch clause.
 *
 * Everything here is a syntactic observation about consequences. Nothing reads
 * a comment, and nothing treats emptiness alone as meaningful.
 */
function gather(
  source: ts.SourceFile,
  clause: ts.CatchClause,
): ExceptionEvidence {
  const body = clause.block.statements;

  // ── intent: the failure is handled, not dropped ───────────────────────
  //
  // A rethrow, or any use of the bound error, means the catch is doing
  // something with the failure — whatever else is wrong, it is not silently
  // discarding it.
  const binding =
    clause.variableDeclaration !== undefined &&
    ts.isIdentifier(clause.variableDeclaration.name)
      ? clause.variableDeclaration.name.text
      : undefined;

  let usesBinding = false;
  let rethrows = false;
  let assignsFallback = false;

  const walk = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) rethrows = true;
    if (
      binding !== undefined &&
      ts.isIdentifier(node) &&
      node.text === binding
    ) {
      usesBinding = true;
    }
    // `catch { result = fallback; }` — the failure is deliberately consumed and
    // something is put in its place. That is a contract, expressed in code.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      assignsFallback = true;
    }
    ts.forEachChild(node, walk);
  };
  for (const statement of body) walk(statement);

  if (rethrows || usesBinding || assignsFallback) {
    return {
      violates: false,
      intended: true,
      detail: rethrows
        ? "the catch rethrows"
        : usesBinding
          ? "the catch uses the error it bound"
          : "the catch supplies a fallback value",
    };
  }

  // ── violation: something downstream asserts the work succeeded ────────
  //
  // The consequence, rather than the shape. A `catch {}` followed by nothing is
  // not evidence of anything; a `catch {}` followed by `return true` is a
  // function that reports success it did not verify.
  const enclosing = (() => {
    let node: ts.Node = clause;
    while (node.parent !== undefined) {
      node = node.parent;
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node)
      ) {
        return node;
      }
    }
    return undefined;
  })();

  if (enclosing?.body !== undefined && ts.isBlock(enclosing.body)) {
    const tryStatement = clause.parent;
    const statements = enclosing.body.statements;
    const index = statements.indexOf(tryStatement);

    if (index >= 0) {
      for (const after of statements.slice(index + 1)) {
        if (ts.isReturnStatement(after) && reportsSuccess(after.expression)) {
          return {
            violates: true,
            intended: false,
            detail: `the failure is suppressed and line ${String(
              source.getLineAndCharacterOfPosition(after.getStart(source))
                .line + 1,
            )} reports success regardless`,
          };
        }
      }
    }
  }

  return {
    violates: false,
    intended: false,
    detail: "nothing establishes whether the suppression is intended",
  };
}

/** Finds the catch clause covering a line. */
function findClause(
  source: ts.SourceFile,
  line: number,
): ts.CatchClause | undefined {
  let found: ts.CatchClause | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCatchClause(node)) {
      const start =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      if (start <= line && line <= end) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

export function verifyExceptionFlow(
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

  const item = context.items.find(
    (entry) => entry.path === input.location.path,
  );
  if (item === undefined) {
    return decide("inconclusive", ["context_incomplete"], 0.2);
  }

  const source = ts.createSourceFile(
    input.location.path,
    item.content,
    ts.ScriptTarget.Latest,
    true,
    input.location.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const clause = findClause(source, input.location.startLine);
  if (clause === undefined) {
    return decide("inconclusive", ["context_incomplete"], 0.2);
  }

  const evidence = gather(source, clause);

  if (evidence.violates && evidence.intended) {
    // Both directions supported. Not insufficiency — the opposite — and worth
    // its own reason so it is never tuned away as a coverage problem.
    return decide("inconclusive", ["conflicting_independent_evidence"], 0.25);
  }
  if (evidence.violates) {
    return decide("verified", ["suppressed_failure_reported_as_success"], 0.85);
  }
  if (evidence.intended) {
    return decide("rejected", ["failure_suppression_is_contracted"], 0.8);
  }

  // ── The common case, and a permanent answer for some of it ────────────
  //
  // The repository does not say whether the author meant this. A capability
  // that guessed here would be right often enough to look good and wrong in
  // exactly the cases where a reviewer's opinion matters.
  return decide("inconclusive", ["intent_not_establishable"], 0.2);
}
