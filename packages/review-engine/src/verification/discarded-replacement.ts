/**
 * P1-M.4 — did the discarded call actually return a replacement?
 *
 * The analyzer proposes whenever a consumed result becomes a discarded one. It
 * is right about the change and says nothing about whether the change matters.
 * That question is answered here, and the answer is usually *no*:
 *
 * ```ts
 * function normalize(raw: string): string { return raw.trim(); }   VERIFIED
 * function assertValid(raw: string): void { ... }                  rejected
 * function isValid(raw: string): boolean { return raw.length > 0 } rejected
 * function identity(raw: string): string { return raw; }           rejected
 * ```
 *
 * Only the first loses something when its result is thrown away.
 *
 * # Five things must be established, and failing any of them is inconclusive
 *
 * ```
 * 1  the EXACT callee binding, through the checker
 * 2  the parameter the call passes
 * 3  the return type can REPLACE that parameter's type
 * 4  the returned value derives from that parameter
 * 5  at least one return transforms it
 * ```
 *
 * Step 1 is not ceremony. The historical case plants a same-named
 * `validate(): boolean` in a different module precisely so a verifier matching
 * by name reaches the wrong declaration and answers confidently about code
 * nobody called.
 *
 * Step 3 goes through `isTypeAssignableTo`, never a comparison of type names.
 * Aliases, unions, branded types and narrowed returns are all legitimate
 * replacements under different names, and unrelated types can print
 * identically.
 *
 * Steps 4 and 5 are traced locally and conservatively. When derivation cannot
 * be established the answer is `inconclusive` — never "probably transformed",
 * which would publish a finding on evidence nobody has.
 */

import ts from "typescript";
import type { ComparisonVerdict } from "./compatibility-probe.js";

export interface DiscardedReplacementQuery {
  /** The file containing the discarding call. */
  readonly path: string;
  /** The callee name as written, used only to locate the call site. */
  readonly calleeName: string;
  /** The line the call was published at. */
  readonly line: number;
}

function hostOver(files: ReadonlyMap<string, string>): ts.CompilerHost {
  const strip = (name: string): string => name.replace(/^\.?\/+/, "");
  return {
    fileExists: (name) => files.has(strip(name)),
    readFile: (name) => files.get(strip(name)),
    getSourceFile: (name, languageVersion) => {
      const content = files.get(strip(name));
      return content === undefined
        ? undefined
        : ts.createSourceFile(name, content, languageVersion, true);
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
}

/** The call statement the analyzer published, found by position not by name. */
function callAt(
  source: ts.SourceFile,
  line: number,
  calleeName: string,
): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;

  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node)) {
      const at =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      if (at === line && name === calleeName) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}

/**
 * Whether `expression` is the parameter itself, following local aliases.
 *
 * `return raw` and `const result = raw; return result` mean the same thing.
 * Implementing this as `expression !== parameterIdentifier` would be another
 * proxy: it calls the second one a transformation because the identifier text
 * differs.
 *
 * Only single-assignment local `const` bindings are followed. A `let` that is
 * reassigned, a parameter captured by a closure, or anything else this does
 * not model resolves to `unknown` rather than a guess.
 */
type Derivation = "identity" | "transformed" | "unknown";

function deriveFrom(
  expression: ts.Expression,
  parameter: ts.Symbol,
  checker: ts.TypeChecker,
  depth = 0,
): Derivation {
  if (depth > 8) return "unknown";

  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (symbol === undefined) return "unknown";
    if (symbol === parameter) return "identity";

    const declaration = symbol.declarations?.[0];
    if (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      return deriveFrom(declaration.initializer, parameter, checker, depth + 1);
    }
    return "unknown";
  }

  if (ts.isParenthesizedExpression(expression)) {
    return deriveFrom(expression.expression, parameter, checker, depth + 1);
  }

  // `raw.trim()`, `raw.slice(1)`, `normalizeFurther(raw)` — the parameter is
  // reachable inside, and the surrounding expression is not the parameter, so
  // something was computed from it.
  return mentions(expression, parameter, checker) ? "transformed" : "unknown";
}

function mentions(
  node: ts.Node,
  parameter: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  let seen = false;
  const visit = (child: ts.Node): void => {
    if (seen) return;
    if (
      ts.isIdentifier(child) &&
      checker.getSymbolAtLocation(child) === parameter
    ) {
      seen = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return seen;
}

const inconclusive = (detail: string): ComparisonVerdict => ({
  kind: "inconclusive",
  detail,
});

export function verifyDiscardedReplacement(
  query: DiscardedReplacementQuery,
  revision: { readonly files: ReadonlyMap<string, string> },
): ComparisonVerdict {
  if (!revision.files.has(query.path)) {
    return inconclusive(`${query.path} is not present in the revision`);
  }

  const program = ts.createProgram({
    rootNames: [query.path],
    options: {
      noLib: true,
      strict: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
    },
    host: hostOver(revision.files),
  });

  const source = program.getSourceFile(query.path);
  if (source === undefined) {
    return inconclusive(`${query.path} could not be parsed in the revision`);
  }

  const checker = program.getTypeChecker();
  const call = callAt(source, query.line, query.calleeName);
  if (call === undefined) {
    return inconclusive(
      `no call to \`${query.calleeName}\` was found at line ${String(query.line)}`,
    );
  }

  // 1. The EXACT binding. Resolved through the checker, so a same-named
  //    function in another module cannot answer for this one.
  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.declaration;
  if (
    signature === undefined ||
    declaration === undefined ||
    !(
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration)
    ) ||
    declaration.body === undefined
  ) {
    return inconclusive(
      `the declaration bound to \`${query.calleeName}\` could not be resolved to a body`,
    );
  }

  // 2. The parameter this call supplies.
  const parameterDeclaration = declaration.parameters[0];
  if (parameterDeclaration === undefined) {
    return inconclusive(
      `\`${query.calleeName}\` declares no parameter to be replaced`,
    );
  }
  const parameter = checker.getSymbolAtLocation(parameterDeclaration.name);
  if (parameter === undefined) {
    return inconclusive(
      `the parameter of \`${query.calleeName}\` has no symbol`,
    );
  }

  // 3. Can what comes back stand in for what went in? The checker decides.
  const returnType = checker.getReturnTypeOfSignature(signature);
  if (returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {
    return {
      kind: "rejected",
      detail: `\`${query.calleeName}\` returns no value, so discarding its result loses nothing`,
    };
  }

  const parameterType = checker.getTypeOfSymbolAtLocation(
    parameter,
    parameterDeclaration,
  );
  if (!checker.isTypeAssignableTo(returnType, parameterType)) {
    return {
      kind: "rejected",
      detail:
        `\`${query.calleeName}\` returns ${checker.typeToString(returnType)}, which cannot replace ` +
        `${checker.typeToString(parameterType)} — a status or predicate result is a different proposition`,
    };
  }

  // 4 and 5. Does any successful return carry a transformed version of it?
  const returns: ts.Expression[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      returns.push(node.expression);
    }
    // Not into nested functions: their returns belong to another signature.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      return;
    }
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(declaration.body, collect);

  if (returns.length === 0) {
    return {
      kind: "rejected",
      detail: `\`${query.calleeName}\` returns no value on any path`,
    };
  }

  const derivations = returns.map((expression) =>
    deriveFrom(expression, parameter, checker),
  );

  if (derivations.includes("transformed")) {
    return {
      kind: "verified",
      detail:
        `\`${query.calleeName}\` returns a transformed replacement for its argument, ` +
        "and the changed code keeps the original instead",
    };
  }

  if (derivations.every((entry) => entry === "identity")) {
    return {
      kind: "rejected",
      detail: `every return of \`${query.calleeName}\` hands back its own argument unchanged`,
    };
  }

  // Something is neither the parameter nor derived from it, and nothing was
  // positively transformed. Guessing "transformed" here would publish on
  // evidence nobody has.
  return inconclusive(
    `the returned value of \`${query.calleeName}\` could not be traced to its argument`,
  );
}
