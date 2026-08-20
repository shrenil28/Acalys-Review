/**
 * Full rebuild. Nothing else, on purpose.
 *
 * There is no incremental path here, no cache, no `H1 + changed files -> H2`.
 * That is not an unfinished edge — it is the foundation the incremental
 * implementation will later have to match:
 *
 * ```
 * digest(full(H2))  ==  digest(incremental(H1 -> H2))
 * ```
 *
 * An oracle written after the optimization it judges tends to be written in
 * the optimization's own terms. Building the slow, obviously-correct version
 * first means the fast one has somewhere trustworthy to be wrong against.
 *
 * # Why a Program and a checker rather than per-file parsing
 *
 * `extractFile` parses one file at a time. That is enough to find *a*
 * declaration named `save`; it is not enough to know *which* `save`. A
 * repository with a local `save` in one module and an exported `save` in
 * another produces two identical-looking syntax nodes, and a name-matching
 * extractor merges them — exactly the epistemic error P1-J spent a checkpoint
 * learning not to make.
 *
 * The checker distinguishes them because it resolves bindings rather than
 * comparing strings. The cost is that the whole revision must be in the
 * program, which is the reason this is a full rebuild rather than a file walk.
 */

import { createHash } from "node:crypto";
import ts from "typescript";
import { looksGenerated, type SymbolKind } from "../symbols.js";
import {
  EXTRACTOR_VERSION,
  SUPPORTED_EXTENSIONS,
  type RepositoryIndexIdentity,
} from "./identity.js";
import type {
  DeclarationRecord,
  IndexAvailability,
  IndexCoverage,
  ModuleCoverage,
  ModuleRecord,
  ModuleRole,
  RepositoryIndex,
  Resolution,
  SymbolRecord,
} from "./records.js";

/** One revision's worth of source, path to content. */
export type RevisionSnapshot = ReadonlyMap<string, string>;

export interface BuildOptions {
  readonly identity: RepositoryIndexIdentity;
  readonly snapshot: RevisionSnapshot;
}

const digestOf = (material: string): string =>
  createHash("sha256").update(material, "utf8").digest("hex");

/** Short, collision-resistant enough for index-local identity. */
const shortId = (parts: readonly string[]): string =>
  digestOf(parts.join(" ")).slice(0, 24);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?tsx?$/;
const CONFIG_PATH = /(^|\/)[\w.-]*\.config\.[cm]?tsx?$|(^|\/)vitest\.[\w.]*ts$/;
const SCRATCH_PATH = /(^|\/)(scratch|tmp|\.tmp|sandbox)\//;
const EXCLUDED_PATH = /(^|\/)(node_modules|dist|build|\.git|coverage)\//;

/**
 * What role a file plays — a fact about the repository, not a verdict.
 *
 * Order matters: a generated test file is generated first. The classification
 * is coarse by design, because every distinction here is one a reviewer could
 * reasonably argue with and a fine-grained taxonomy invites arguing.
 */
export function classifyModule(path: string, content: string): ModuleRole {
  if (looksGenerated(path, content)) return "generated";
  if (SCRATCH_PATH.test(path)) return "scratch";
  if (TEST_PATH.test(path)) return "test";
  if (CONFIG_PATH.test(path)) return "configuration";
  return "production";
}

function isSupported(path: string): boolean {
  return SUPPORTED_EXTENSIONS.some((extension) => path.endsWith(extension));
}

// ---------------------------------------------------------------------------
// Declaration walking
// ---------------------------------------------------------------------------

function kindOf(node: ts.Node): SymbolKind | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    return "method";
  }
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isModuleDeclaration(node)) return "module";
  if (ts.isVariableDeclaration(node)) return "variable";
  return undefined;
}

function nameOf(node: ts.Node): string | undefined {
  const named = node as ts.Node & { readonly name?: ts.Node };
  const name = named.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  if (
    modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    return true;
  }
  // A variable's `export` sits on the statement, three nodes up.
  if (ts.isVariableDeclaration(node)) {
    const statement = node.parent.parent;
    if (ts.isVariableStatement(statement)) {
      return (
        ts
          .getModifiers(statement)
          ?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          ) === true
      );
    }
  }
  return false;
}

function containerOf(node: ts.Node): string | undefined {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isFunctionDeclaration(parent)
    ) {
      const name = nameOf(parent);
      if (name !== undefined) return name;
    }
    parent = parent.parent;
  }
  return undefined;
}

/**
 * How firmly the checker settled this declaration.
 *
 * The `unresolved` case is not a failure to record — it is the record. A
 * declaration the checker could not bind is a real fact about the revision
 * (usually a missing dependency), and dropping it would leave downstream code
 * to infer absence from silence.
 */
function resolutionOf(
  checker: ts.TypeChecker,
  node: ts.Node,
  indexedFiles: ReadonlySet<string>,
): Resolution {
  const named = node as ts.Node & { readonly name?: ts.Node };
  const nameNode = named.name;
  if (nameNode === undefined) return "unresolved";

  const symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol === undefined) return "unresolved";

  const declarations = symbol.getDeclarations() ?? [];
  if (declarations.length === 0) return "unresolved";

  const outside = declarations.filter(
    (declaration) => !indexedFiles.has(declaration.getSourceFile().fileName),
  );
  if (outside.length === declarations.length) return "external";
  if (declarations.length > 1) return "ambiguous";
  return "exact";
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

function compilerHost(snapshot: RevisionSnapshot): ts.CompilerHost {
  return {
    fileExists: (fileName) => snapshot.has(fileName),
    readFile: (fileName) => snapshot.get(fileName),
    getSourceFile: (fileName) => {
      const content = snapshot.get(fileName);
      if (content === undefined) return undefined;
      return ts.createSourceFile(
        fileName,
        content,
        ts.ScriptTarget.ES2022,
        true,
        fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
    },
    // No default library. An index over a repository must not silently acquire
    // facts about `lib.d.ts`, and a declaration that resolves only into the
    // standard library is correctly classified `external`.
    getDefaultLibFileName: () => "",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
}

/**
 * Builds the complete factual index for one revision.
 *
 * Deterministic: every collection is sorted by a canonical key before it is
 * returned, so two builds of the same snapshot are equal record-for-record
 * regardless of `Map` iteration order or the order the compiler happened to
 * visit files. That property is what makes {@link indexDigest} meaningful, and
 * it is asserted directly rather than assumed.
 */
export function buildRepositoryIndex(options: BuildOptions): RepositoryIndex {
  const { identity, snapshot } = options;

  const modules: ModuleRecord[] = [];
  const symbols: SymbolRecord[] = [];
  const declarations: DeclarationRecord[] = [];

  const indexable = new Map<string, string>();
  for (const [path, content] of snapshot) {
    if (EXCLUDED_PATH.test(path)) {
      modules.push({
        moduleId: path,
        path,
        language: "typescript",
        role: classifyModule(path, content),
        coverage: "excluded",
        contentDigest: digestOf(content),
        coverageDetail: "path is outside the indexed roots",
      });
      continue;
    }
    if (!isSupported(path)) {
      modules.push({
        moduleId: path,
        path,
        language: "typescript",
        role: classifyModule(path, content),
        coverage: "unsupported_language",
        contentDigest: digestOf(content),
        coverageDetail: `no extractor for ${path.slice(path.lastIndexOf("."))}`,
      });
      continue;
    }
    indexable.set(path, content);
  }

  if (indexable.size === 0) {
    return finish(identity, { kind: "built" }, modules, symbols, declarations);
  }

  const program = ts.createProgram({
    rootNames: [...indexable.keys()].sort(),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: false,
      noEmit: true,
      skipLibCheck: true,
      noLib: true,
    },
    host: compilerHost(indexable),
  });

  const checker = program.getTypeChecker();
  const indexedFiles = new Set(indexable.keys());
  const revision = identity.revision.value;

  // Sorted so traversal order is a property of the input, not of the Map.
  for (const path of [...indexable.keys()].sort()) {
    const content = indexable.get(path) ?? "";
    const source = program.getSourceFile(path);

    if (source === undefined) {
      modules.push({
        moduleId: path,
        path,
        language: "typescript",
        role: classifyModule(path, content),
        coverage: "parse_failed",
        contentDigest: digestOf(content),
        coverageDetail: "the compiler produced no source file",
      });
      continue;
    }

    const syntactic = program.getSyntacticDiagnostics(source);
    const coverage: ModuleCoverage =
      syntactic.length === 0 ? "indexed" : "parse_failed";

    modules.push({
      moduleId: path,
      path,
      language: "typescript",
      role: classifyModule(path, content),
      coverage,
      contentDigest: digestOf(content),
      ...(coverage === "indexed"
        ? {}
        : {
            coverageDetail: `${String(syntactic.length)} syntax error(s); facts from this module are incomplete`,
          }),
    });

    // A module that would not parse yields no declarations. Recording them
    // anyway would present guesses as facts, and the coverage field is how a
    // caller learns the difference.
    if (coverage !== "indexed") continue;

    const visit = (node: ts.Node): void => {
      const kind = kindOf(node);
      const name = nameOf(node);
      if (kind !== undefined && name !== undefined) {
        const start =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const end =
          source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

        const symbolId = shortId([
          revision,
          path,
          kind,
          name,
          String(start),
          String(end),
        ]);
        const container = containerOf(node);

        symbols.push({
          symbolId,
          name,
          kind,
          moduleId: path,
          exported: isExported(node),
          ...(container === undefined ? {} : { container }),
        });

        declarations.push({
          declarationId: shortId([symbolId, path, String(start), String(end)]),
          symbolId,
          moduleId: path,
          kind,
          startLine: start,
          endLine: end,
          resolution: resolutionOf(checker, node, indexedFiles),
          provenance: {
            source: "typescript_checker",
            path,
            startLine: start,
            endLine: end,
            extractorVersion: EXTRACTOR_VERSION,
            revision,
          },
        });
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(source, visit);
  }

  return finish(identity, { kind: "built" }, modules, symbols, declarations);
}

function finish(
  identity: RepositoryIndexIdentity,
  availability: IndexAvailability,
  modules: ModuleRecord[],
  symbols: SymbolRecord[],
  declarations: DeclarationRecord[],
): RepositoryIndex {
  const coverage: IndexCoverage = {
    modulesTotal: modules.length,
    modulesIndexed: modules.filter((m) => m.coverage === "indexed").length,
    modulesFailed: modules.filter((m) => m.coverage === "parse_failed").length,
    modulesUnsupported: modules.filter(
      (m) => m.coverage === "unsupported_language",
    ).length,
    modulesExcluded: modules.filter((m) => m.coverage === "excluded").length,
  };

  return {
    identity,
    availability,
    coverage,
    // Canonical ordering, applied once, here. Every consumer and the digest
    // depend on it, so it must not be something each caller remembers to do.
    modules: [...modules].sort((a, b) => compare(a.moduleId, b.moduleId)),
    symbols: [...symbols].sort(
      (a, b) =>
        compare(a.moduleId, b.moduleId) ||
        compare(a.name, b.name) ||
        compare(a.kind, b.kind) ||
        compare(a.symbolId, b.symbolId),
    ),
    declarations: [...declarations].sort(
      (a, b) =>
        compare(a.moduleId, b.moduleId) ||
        a.startLine - b.startLine ||
        a.endLine - b.endLine ||
        compare(a.declarationId, b.declarationId),
    ),
  };
}

/** Codepoint ordering — locale-independent, so it is the same everywhere. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The index that exists when indexing could not happen.
 *
 * Deliberately not "an empty index". An empty index and a failed index are the
 * same object to any caller that only looks at `modules.length`, and that
 * equivalence is how an outage renders as "nothing found" — the exact shape
 * P1-K caught in the frontend.
 */
export function unavailableIndex(
  identity: RepositoryIndexIdentity,
  availability: Exclude<IndexAvailability, { kind: "built" }>,
): RepositoryIndex {
  return {
    identity,
    availability,
    coverage: {
      modulesTotal: 0,
      modulesIndexed: 0,
      modulesFailed: 0,
      modulesUnsupported: 0,
      modulesExcluded: 0,
    },
    modules: [],
    symbols: [],
    declarations: [],
  };
}
