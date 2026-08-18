/**
 * Symbols and references, extracted from source rather than guessed from text.
 *
 * This is what the context planner selects *from*. Its quality sets a ceiling
 * on review quality that no amount of model capability can raise: if the callee
 * containing the bug is never offered as a candidate, no reviewer can find it.
 *
 * # Why the TypeScript compiler rather than regexes
 *
 * A regex can find `function handler(` and will also find it inside a string, a
 * comment, and a minified bundle. It cannot tell a declaration from a call, a
 * type from a value, or a local from an export. Every one of those distinctions
 * matters when deciding what a reviewer needs to see:
 *
 *     "changed `parse`"  →  which `parse`? the local one, the imported one,
 *                           or the method on the class three files away?
 *
 * The compiler answers that. The cost is a dependency on `typescript` and
 * TypeScript-only support for now — an honest limitation, recorded rather than
 * hidden, and the reason the interfaces below name no language.
 */

import ts from "typescript";

/** What kind of thing a symbol is. Closed: consumers switch on it. */
export const SYMBOL_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "type",
  "variable",
  "enum",
  "module",
] as const;

export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** A declaration, with the span a reviewer would need to read. */
export interface ExtractedSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  /** `Session.verify` for a method; the bare name otherwise. */
  readonly qualifiedName: string;
  /** Enclosing declaration, when there is one. */
  readonly container?: string | undefined;
  /** 1-based, inclusive — the whole declaration, not just its signature. */
  readonly startLine: number;
  readonly endLine: number;
  readonly exported: boolean;
}

/** A name used somewhere, and where it was used. */
export interface SymbolReference {
  readonly name: string;
  readonly line: number;
  /** True when this is the declaration itself rather than a use of it. */
  readonly isDeclaration: boolean;
}

/** What one file imports, so the dependency edges can be walked. */
export interface ImportEdge {
  /** The specifier as written: `./session.js`, `node:crypto`, `zod`. */
  readonly specifier: string;
  /** Names taken from it. Empty for a bare or namespace import. */
  readonly names: readonly string[];
  readonly line: number;
  /** True for `import type` — a type-only edge carries no runtime behaviour. */
  readonly typeOnly: boolean;
}

export interface FileIntelligence {
  readonly path: string;
  readonly symbols: readonly ExtractedSymbol[];
  readonly references: readonly SymbolReference[];
  readonly imports: readonly ImportEdge[];
  /**
   * True when the file looks machine-generated.
   *
   * Detected rather than assumed from the path, because generated files are the
   * single largest source of wasted context budget: a 40,000-line client that a
   * changed file happens to import would evict everything a reviewer actually
   * needs.
   */
  readonly generated: boolean;
}

function kindOf(node: ts.Node): SymbolKind | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node))
    return "method";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableDeclaration(node)) {
    // A function-valued variable is a declaration a reviewer reasons about at
    // any scope — a callback body is a real unit of review.
    const initializer = node.initializer;
    if (
      initializer !== undefined &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ) {
      return "function";
    }

    // A plain variable is only a symbol at module scope. Local ones are not
    // something a reviewer asks to see, and treating them as symbols actively
    // hurts: `containingSymbol` returns the *innermost* match, so a changed
    // `const total = a + b;` inside a 200-line function resolved to the
    // assignment itself. The planner then offered that one line as "the
    // containing symbol" and the reviewer never saw the function.
    //
    // Found by the eval, which noticed a containing-symbol item costing four
    // tokens. The old comment here claimed this restriction; the code did not
    // implement it.
    const statement = node.parent?.parent;
    const moduleScoped =
      statement !== undefined &&
      statement.parent !== undefined &&
      ts.isSourceFile(statement.parent);

    return moduleScoped ? "variable" : undefined;
  }
  return undefined;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return (
    modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

/**
 * Whether a file is machine-generated.
 *
 * Header markers first, because they are the convention every generator
 * follows and the only signal that is actually about the file rather than its
 * name. A path check alone misses `client.ts` and wrongly flags a hand-written
 * `generated-report.ts`.
 */
export function looksGenerated(path: string, source: string): boolean {
  const head = source.slice(0, 2_000).toLowerCase();
  if (
    head.includes("@generated") ||
    head.includes("do not edit") ||
    head.includes("auto-generated") ||
    head.includes("code generated by")
  ) {
    return true;
  }
  return /(^|\/)(dist|build|__generated__|generated)\//.test(path);
}

/**
 * Extracts what a planner needs from one file.
 *
 * Parses with `isolatedModules` semantics — no program, no type checker, no
 * `node_modules` resolution. That is a deliberate trade: a full type checker
 * would resolve cross-file references precisely and would also need the whole
 * dependency graph on disk and seconds per file. Syntactic extraction is
 * milliseconds and gets the declarations exactly right; cross-file edges are
 * resolved from import specifiers instead, which is approximate and honest.
 */
export function extractFile(path: string, source: string): FileIntelligence {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const symbols: ExtractedSymbol[] = [];
  const references: SymbolReference[] = [];
  const imports: ImportEdge[] = [];

  const lineOf = (position: number): number =>
    sourceFile.getLineAndCharacterOfPosition(position).line + 1;

  const visit = (node: ts.Node, container: string | undefined): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name !== undefined) names.push(clause.name.text);
      if (
        clause?.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        for (const element of clause.namedBindings.elements) {
          names.push(element.name.text);
        }
      }
      imports.push({
        specifier,
        names,
        line: lineOf(node.getStart(sourceFile)),
        typeOnly: clause?.isTypeOnly ?? false,
      });
    }

    const kind = kindOf(node);
    let nextContainer = container;

    if (kind !== undefined) {
      const named = node as ts.NamedDeclaration;
      const nameNode = named.name;
      if (nameNode !== undefined && ts.isIdentifier(nameNode)) {
        const name = nameNode.text;
        symbols.push({
          name,
          kind,
          qualifiedName:
            container === undefined ? name : `${container}.${name}`,
          ...(container === undefined ? {} : { container }),
          startLine: lineOf(node.getStart(sourceFile)),
          endLine: lineOf(node.getEnd()),
          // A variable declaration's `export` sits on the statement two levels
          // up, not on the declaration itself.
          exported:
            isExported(node) ||
            (node.parent?.parent !== undefined &&
              isExported(node.parent.parent)),
        });
        references.push({
          name,
          line: lineOf(nameNode.getStart(sourceFile)),
          isDeclaration: true,
        });
        if (kind === "class" || kind === "interface") nextContainer = name;
      }
    }

    // Identifier uses, which is what "who calls this?" is answered from.
    // `ts.isDeclarationName` is internal, so the check is explicit: an
    // identifier that IS its parent's name is a declaration, not a use.
    const isDeclarationName =
      ts.isIdentifier(node) &&
      node.parent !== undefined &&
      (node.parent as { name?: ts.Node }).name === node;

    if (ts.isIdentifier(node) && !isDeclarationName) {
      references.push({
        name: node.text,
        line: lineOf(node.getStart(sourceFile)),
        isDeclaration: false,
      });
    }

    ts.forEachChild(node, (child) => {
      visit(child, nextContainer);
    });
  };

  ts.forEachChild(sourceFile, (node) => {
    visit(node, undefined);
  });

  return {
    path,
    symbols,
    references,
    imports,
    generated: looksGenerated(path, source),
  };
}

/**
 * The symbol whose body encloses a line.
 *
 * The single most important query the planner makes: a changed line without its
 * containing function is a diff hunk, and a reviewer given only hunks cannot
 * reason about anything. Returns the *innermost* match, so a method inside a
 * class yields the method.
 */
export function containingSymbol(
  file: FileIntelligence,
  line: number,
): ExtractedSymbol | undefined {
  let best: ExtractedSymbol | undefined;
  for (const symbol of file.symbols) {
    if (symbol.startLine <= line && line <= symbol.endLine) {
      if (
        best === undefined ||
        symbol.endLine - symbol.startLine < best.endLine - best.startLine
      ) {
        best = symbol;
      }
    }
  }
  return best;
}

/** Files that reference a name, excluding the file that declares it. */
export function referencingFiles(
  files: readonly FileIntelligence[],
  name: string,
  declaredIn: string,
): readonly FileIntelligence[] {
  return files.filter(
    (file) =>
      file.path !== declaredIn &&
      file.references.some(
        (reference) => reference.name === name && !reference.isDeclaration,
      ),
  );
}

/**
 * Whether a file looks like the tests for another.
 *
 * Name-based, and deliberately so: a type checker would tell you which files
 * import the subject, but tests are frequently the *only* consumer that does
 * not, and the convention is near-universal.
 */
export function isTestFor(testPath: string, subjectPath: string): boolean {
  const base = subjectPath.replace(/\.[cm]?tsx?$/, "").replace(/^.*\//, "");
  if (base === "") return false;
  const testBase = testPath.replace(/^.*\//, "");
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(testPath) &&
    (testBase.startsWith(`${base}.`) || testBase.startsWith(`${base}-`))
  );
}

/**
 * Whether a name is bound by an enclosing lexical scope at a position.
 *
 * # Why this exists rather than a call to the TypeScript checker
 *
 * The analyzer reported a floating promise on this code:
 *
 * ```ts
 * import { save } from "./store.js";          // async
 * export function run(save: (v: number) => void): void {
 *   save(1);                                   // the PARAMETER, synchronous
 * }
 * ```
 *
 * It resolved the callee by searching declarations for a matching **name**, and
 * so did the verifier — independently, and to the same wrong answer. Structural
 * independence held completely; the mistake still survived twice, because both
 * sides settled the disputed fact the same way.
 *
 * The verifier now binds callees through the TypeScript checker. The obvious
 * fix here would be to do that too, and it would be a mistake: two components
 * calling one binder is one derivation with two callers, and the next defect in
 * that binder is a defect in both. So the analyzer instead walks lexical scopes
 * over the AST — a different implementation, in a different package, that can
 * be wrong in different ways.
 *
 * Agreement then means something. Today both conclude that `save` binds to the
 * parameter, and they reach it by unrelated routes.
 *
 * # Deliberately narrow
 *
 * It answers one question — *does an enclosing scope declare this name?* — and
 * says nothing about what the binding is or whether it is asynchronous. A
 * broader "resolve this symbol" helper shared between analyzer and verifier is
 * exactly the coupling being avoided.
 */
export function isLexicallyShadowed(
  source: string,
  path: string,
  name: string,
  line: number,
): boolean {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const lineOf = (node: ts.Node): { start: number; end: number } => ({
    start: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    end: file.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
  });

  let shadowed = false;

  const declaresName = (node: ts.Node): boolean => {
    // Parameters and locally declared functions/variables. Imports are
    // deliberately excluded: an imported name is not a shadow, it is the outer
    // binding the analyzer already resolved.
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
      return ts.isIdentifier(node.name) && node.name.text === name;
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      return node.name.text === name;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (shadowed) return;

    const isScope =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isBlock(node);

    if (isScope) {
      const span = lineOf(node);
      // Only scopes that actually contain the position can shadow it. A
      // sibling function declaring the same name is not a shadow, and treating
      // it as one would suppress real findings — the failure mode opposite to
      // the one this fixes, and just as silent.
      if (span.start <= line && line <= span.end) {
        const declarations: ts.Node[] = [];
        if (ts.canHaveModifiers(node)) {
          const parameters = (
            node as { parameters?: ts.NodeArray<ts.ParameterDeclaration> }
          ).parameters;
          if (parameters !== undefined) declarations.push(...parameters);
        }
        for (const statement of ts.isBlock(node) ? node.statements : []) {
          if (ts.isVariableStatement(statement)) {
            declarations.push(...statement.declarationList.declarations);
          } else if (ts.isFunctionDeclaration(statement)) {
            declarations.push(statement);
          }
        }
        if (declarations.some(declaresName)) {
          shadowed = true;
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return shadowed;
}
