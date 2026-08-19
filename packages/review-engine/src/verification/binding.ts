/**
 * Resolving a callee through the compiler, not through its name.
 *
 * # The defect this exists to remove
 *
 * P1-J.2 planted one natural analyzer false positive and the verifier
 * **confirmed it**:
 *
 * ```ts
 * import { save } from "./store.js";        // async
 * export function run(save: (v: number) => void): void {
 *   save(1);                                 // the PARAMETER, which is sync
 * }
 * ```
 *
 * The analyzer resolves callees by name: it saw `save`, found the async import,
 * reported a floating promise. The verifier then independently did *the same
 * thing* and agreed.
 *
 * Every structural guarantee P1-H makes was intact throughout. No context, no
 * confidence, no reasoning, no rule identity crossed the boundary; there is no
 * API through which any of it could. And the second opinion was worthless,
 * because it was produced by the same fallible derivation:
 *
 * ```
 * structural independence   inputs are not shared
 * epistemic independence    the METHOD of settling the disputed fact is not shared
 * ```
 *
 * Only the second buys anything. A second agent that calls the same broken
 * helper is not corroboration; it is the same mistake, counted twice.
 *
 * # What is different here
 *
 * The analyzer asks *"is there a declaration named `save` that is async?"* — a
 * search over names. This asks the checker *"which declaration does this callee
 * bind to?"*, and reads async-ness from **that** declaration. Scope, shadowing,
 * imports and aliases are resolved by the checker doing its ordinary work, and
 * no name is ever compared to a declaration.
 *
 * For the case above the checker binds `save` to the parameter, whose annotated
 * return type is `void`, and the claim is refuted.
 *
 * The async determination itself stays syntactic, deliberately. Asking for the
 * call's full *type* would need the standard library inside the program, and
 * paying that on every verification buys nothing here: the disputed fact was
 * never "what is `Promise<void>`", it was "which `save` is this".
 *
 * # Shared substrate is fine; shared adjudication is not
 *
 * Both sides use the same TypeScript parser, the same paths, the same
 * repository snapshot. That is not the dangerous kind of sharing — it is an
 * observation substrate, and duplicating it would cost correctness and buy
 * nothing. What must not be shared is the inference that settles the disputed
 * proposition, and that is exactly what this file replaces.
 *
 * # Unresolved is never guessed
 *
 * If the checker cannot bind the callee — an untyped import, a dynamic
 * property, a construct the in-memory program cannot compile — the answer is
 * `unresolved`, and the caller abstains. The whole point is to stop deciding
 * things on evidence that only looks sufficient.
 */

import ts from "typescript";

import type { VerificationContext } from "./decide.js";

/**
 * How a fact was established.
 *
 * Recorded so correlated derivation is *observable* rather than inferred after
 * an incident. When several components agree, the useful question is not "how
 * many agreed?" but "did they agree by different means?" — and without this,
 * "three agents concurred" and "three agents called the same broken helper"
 * look identical.
 *
 * Not a numerical independence score. Just the channel, named.
 */
export const DERIVATION_METHODS = [
  /** Name matching over an AST. What the analyzer uses. Cheap, and shadow-blind. */
  "ast_name_match",
  /** The TypeScript checker's own binding and type resolution. */
  "typescript_checker",
] as const;

export type DerivationMethod = (typeof DERIVATION_METHODS)[number];

export type CalleeBinding =
  | {
      readonly kind: "resolved";
      /** Whether the call expression produces a promise. The proposition. */
      readonly producesPromise: boolean;
      readonly via: DerivationMethod;
      /** Where the checker bound the callee. For the audit trail. */
      readonly declaredAt: string | undefined;
    }
  /**
   * The checker could not settle it.
   *
   * Deliberately not `producesPromise: false`. "It is not asynchronous" and "I
   * could not tell" are the two facts this whole checkpoint exists to keep
   * apart, and collapsing them here would reintroduce the defect one layer
   * lower.
   */
  | { readonly kind: "unresolved"; readonly why: string };

const LIB = "lib.d.ts";

/**
 * A minimal standard library, declaring the contracts these capabilities need
 * to read.
 *
 * Not a convenience. Without it `items.forEach(async …)` cannot be bound at
 * all, and the async-callback capability abstains on every real instance — so
 * the only way to settle those claims would be to key on the method NAME, which
 * gets `await queue.forEach(async …)` wrong in someone's own abstraction.
 *
 * What is written here is the genuine declared contract: `Array.forEach` really
 * does declare its callback as returning `void`, which is precisely why the
 * promise is dropped. The verifier still binds the receiver through the checker
 * and reads whatever declaration it lands on; this only makes the built-in one
 * available to land on.
 *
 * Deliberately small. The full `lib.dom.d.ts` would dominate the cost of every
 * verification, and nothing here needs it — the facts in dispute are about
 * user code and a handful of library contracts.
 */
const LIB_SOURCE = `
interface Boolean {}
interface Number {}
interface String { length: number; }
interface Object {}
interface Function {}
interface IArguments {}
interface RegExp {}
interface PromiseLike<T> {
  then<R>(onfulfilled?: (value: T) => R | PromiseLike<R>): PromiseLike<R>;
}
interface Promise<T> {
  then<R>(onfulfilled?: (value: T) => R | PromiseLike<R>): Promise<R>;
  catch(onrejected?: (reason: unknown) => unknown): Promise<T>;
  finally(onfinally?: () => void): Promise<T>;
}
interface Array<T> {
  length: number;
  [n: number]: T;
  forEach(callbackfn: (value: T, index: number, array: T[]) => void): void;
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[];
  filter(predicate: (value: T, index: number, array: T[]) => unknown): T[];
}
interface ReadonlyArray<T> {
  length: number;
  readonly [n: number]: T;
  forEach(callbackfn: (value: T, index: number, array: readonly T[]) => void): void;
}
declare var Promise: {
  all<T>(values: readonly (T | PromiseLike<T>)[]): Promise<T[]>;
  resolve<T>(value: T): Promise<T>;
  resolve(): Promise<void>;
  reject(reason?: unknown): Promise<never>;
};
`;

/**
 * A program over exactly the verifier's own context.
 *
 * Exported so the signature capability can reuse it. Sharing the *program*
 * between two capabilities of the same component is not the coupling that
 * matters — it is an observation substrate, like the parser. What must not be
 * shared is the inference that settles a disputed proposition, and each
 * capability keeps its own.
 *
 * Not over the repository: the verifier reasons about what it planned for
 * itself, and widening the program here would quietly give it material its
 * planner declined to fetch — the context snapshot would then no longer
 * describe what the verifier actually saw.
 */
export function programOf(
  context: VerificationContext,
): ts.Program | undefined {
  const files = new Map(
    context.items.map((item) => [item.path, item.content] as const),
  );

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: false,
    noEmit: true,
    // The context is a subset of a repository by construction, so unresolved
    // imports are expected and must not stop the program being built.
    noResolve: false,
    skipLibCheck: true,
  };

  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName) || fileName === LIB,
    readFile: (fileName) =>
      fileName === LIB ? LIB_SOURCE : files.get(fileName),
    getSourceFile: (fileName) => {
      const content = fileName === LIB ? LIB_SOURCE : files.get(fileName);
      if (content === undefined) return undefined;
      return ts.createSourceFile(
        fileName,
        content,
        ts.ScriptTarget.ES2022,
        true,
        fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
    },
    getDefaultLibFileName: () => LIB,
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    // Both hooks. `resolveModuleNames` is deprecated and `resolveModuleNameLiterals`
    // is what TypeScript 5 actually calls; supplying only the former silently
    // resolved nothing, every import bound to an unknown symbol, and the
    // verifier abstained on the case it was built to settle. A resolver whose
    // hook is never invoked fails exactly like one that always says "unknown",
    // which is why the debug output said "no declaration" rather than "no file".
    resolveModuleNameLiterals: (moduleLiterals, containingFile) =>
      moduleLiterals.map((literal) => {
        const resolvedModule = resolve(literal.text, containingFile);
        return {
          ...(resolvedModule === undefined ? {} : { resolvedModule }),
          failedLookupLocations: [],
        } as ts.ResolvedModuleWithFailedLookupLocations;
      }),
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((specifier) => resolve(specifier, containingFile)),
  };

  return buildProgram();

  function resolve(
    specifier: string,
    containingFile: string,
  ): ts.ResolvedModuleFull | undefined {
    // `./store.js` → `src/store.ts`, the way a bundler resolves TypeScript
    // sources written with ESM extensions.
    if (!specifier.startsWith(".")) return undefined;
    // The checker hands back an absolute path — `/src/caller.ts` — because the
    // host's current directory is `/`, while the context's keys are
    // repository-relative. Without stripping it, every join produced
    // `/src/store.ts`, missed the map, and every import bound to an unknown
    // symbol. The verifier then abstained on the exact case it exists to
    // settle, and the failure surfaced as "no declaration" rather than "no
    // file" — which is why it read as a resolver bug rather than a path bug.
    const base = containingFile.replace(/^\/+/, "").split("/").slice(0, -1);
    for (const part of specifier.split("/")) {
      if (part === ".") continue;
      else if (part === "..") base.pop();
      else base.push(part);
    }
    const joined = base.join("/");
    for (const candidate of [
      joined.replace(/\.js$/, ".ts"),
      joined.replace(/\.js$/, ".tsx"),
      `${joined}.ts`,
      joined,
    ]) {
      if (files.has(candidate)) {
        return { resolvedFileName: candidate, extension: ts.Extension.Ts };
      }
    }
    return undefined;
  }

  function buildProgram(): ts.Program | undefined {
    try {
      return ts.createProgram([LIB, ...files.keys()], options, host);
    } catch {
      return undefined;
    }
  }
}

function isPromiseAnnotation(type: ts.TypeNode): boolean {
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    (type.typeName.text === "Promise" || type.typeName.text === "PromiseLike")
  );
}

/**
 * Whether a bound declaration produces a promise.
 *
 * Read from the declaration the checker resolved to, never from a search. The
 * shapes are enumerated rather than defaulted: an unrecognized declaration
 * returns `undefined` and the caller abstains, because defaulting to `false`
 * would refute every claim about a construct this function has not learned yet
 * — the P1-J.1 defect, one layer down.
 */
function producesPromise(declaration: ts.Declaration): boolean | undefined {
  const fromFunctionish = (node: ts.Node): boolean | undefined => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      const isAsync = (ts.getModifiers(node) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      );
      if (isAsync) return true;
      return node.type === undefined ? false : isPromiseAnnotation(node.type);
    }
    return undefined;
  };

  const direct = fromFunctionish(declaration);
  if (direct !== undefined) return direct;

  // A parameter or property annotated with a function type: the shadowing case.
  // `save: (value: number) => void` binds here, and its return annotation is
  // what settles the claim.
  if (
    ts.isParameter(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isPropertyDeclaration(declaration)
  ) {
    const type = declaration.type;
    if (type === undefined) return undefined;
    return ts.isFunctionTypeNode(type)
      ? isPromiseAnnotation(type.type)
      : undefined;
  }

  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.initializer !== undefined) {
      const fromInitializer = fromFunctionish(declaration.initializer);
      if (fromInitializer !== undefined) return fromInitializer;
    }
    const type = declaration.type;
    if (type !== undefined && ts.isFunctionTypeNode(type)) {
      return isPromiseAnnotation(type.type);
    }
    return undefined;
  }

  return undefined;
}

export function resolveCallProduct(
  context: VerificationContext,
  path: string,
  line: number,
): CalleeBinding {
  const program = programOf(context);
  if (program === undefined) {
    return { kind: "unresolved", why: "the program could not be constructed" };
  }

  const source = program.getSourceFile(path);
  if (source === undefined) {
    return {
      kind: "unresolved",
      why: `${path} is not in the verifier's context`,
    };
  }

  const checker = program.getTypeChecker();
  let found: ts.CallExpression | undefined;

  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node)) {
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

  if (found === undefined) {
    return {
      kind: "unresolved",
      why: `no call expression at ${path}:${String(line)}`,
    };
  }

  // Descend to the root of a method chain.
  //
  // `save(1).then(...)` is one call expression whose callee is `.then`, and
  // `then` is a library member this program has no lib for — so binding it
  // fails and the verifier abstains. The claim is about `save`, which is the
  // root of the chain, and that is what has to be bound.
  //
  // Found by measurement rather than by reading: the first version of this
  // resolver silently converted `then-without-catch` from verified to
  // inconclusive, and published recall fell from 0.5 to 0.4 while the headline
  // precision improvement looked like a clean win.
  let root: ts.CallExpression = found;
  for (;;) {
    const callee = root.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isCallExpression(callee.expression)
    ) {
      root = callee.expression;
      continue;
    }
    break;
  }

  const symbol = checker.getSymbolAtLocation(root.expression);
  if (symbol === undefined) {
    // An untyped import, a dynamic property, a construct this program cannot
    // bind. Abstain: a guess here is the defect this file exists to remove.
    return { kind: "unresolved", why: "the checker could not bind the callee" };
  }

  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;

  const declarations = resolved.declarations ?? [];
  if (declarations.length === 0) {
    return { kind: "unresolved", why: "the bound symbol has no declaration" };
  }

  // Several declarations that disagree: an overload set, a merged declaration,
  // a conditional export. Ambiguous binding is exactly the state in which a
  // confident answer is worst, so it abstains.
  const answers = new Set(
    declarations.map((declaration) => producesPromise(declaration)),
  );
  if (answers.size !== 1) {
    return {
      kind: "unresolved",
      why: "the callee binds to declarations that do not agree",
    };
  }

  const answer = [...answers][0];
  if (answer === undefined) {
    return {
      kind: "unresolved",
      why: "the bound declaration is a shape this resolver does not read",
    };
  }

  const declaration = declarations[0];
  return {
    kind: "resolved",
    producesPromise: answer,
    via: "typescript_checker",
    declaredAt:
      declaration === undefined
        ? undefined
        : `${declaration.getSourceFile().fileName}:${String(
            declaration
              .getSourceFile()
              .getLineAndCharacterOfPosition(declaration.getStart()).line + 1,
          )}`,
  };
}
