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

/**
 * One declaration as it was found, before symbols are formed.
 *
 * An intermediate rather than a record type: grouping into symbols needs every
 * site across every module in hand, so the walk collects and a second pass
 * decides identity.
 */
interface DeclarationSite {
  readonly moduleId: string;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly exported: boolean;
  readonly container: string | undefined;
  readonly resolution: Resolution;
  readonly symbol: ts.Symbol | undefined;
}

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
 * What the checker made of this declaration's name.
 *
 * Returns the resolved symbol alongside the verdict, because the caller needs
 * both: the verdict for the record, and the symbol so that several
 * declarations of one logical symbol are grouped rather than counted as
 * several symbols.
 *
 * `unresolved` is not a failure to record — it is the record. A declaration
 * the checker could not bind is a real fact about the revision (usually a
 * missing dependency), and dropping it would leave downstream code to infer
 * absence from silence.
 *
 * Note what is deliberately NOT here: `declarations.length > 1` does not make
 * a declaration `ambiguous`. Merged interfaces and overload sets are one
 * symbol the checker identified precisely, and calling that uncertainty would
 * spend the word `ambiguous` on the case that is not uncertain. See the
 * commentary on {@link Resolution}.
 */
function resolveDeclaration(
  checker: ts.TypeChecker,
  node: ts.Node,
  indexedFiles: ReadonlySet<string>,
): { readonly resolution: Resolution; readonly symbol: ts.Symbol | undefined } {
  const named = node as ts.Node & { readonly name?: ts.Node };
  const nameNode = named.name;
  if (nameNode === undefined) {
    return { resolution: "unresolved", symbol: undefined };
  }

  const symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol === undefined) return { resolution: "unresolved", symbol };

  const declarations = symbol.getDeclarations() ?? [];
  if (declarations.length === 0) return { resolution: "unresolved", symbol };

  const outside = declarations.filter(
    (declaration) => !indexedFiles.has(declaration.getSourceFile().fileName),
  );
  if (outside.length === declarations.length) {
    return { resolution: "external", symbol };
  }

  return { resolution: "exact", symbol };
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
  const sites: DeclarationSite[] = [];

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
        const startLine =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const endLine =
          source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const { resolution, symbol } = resolveDeclaration(
          checker,
          node,
          indexedFiles,
        );

        sites.push({
          moduleId: path,
          kind,
          name,
          startLine,
          endLine,
          exported: isExported(node),
          container: containerOf(node),
          resolution,
          symbol,
        });
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(source, visit);
  }

  // ------------------------------------------------------------------
  // Group declaration sites into symbols
  // ------------------------------------------------------------------
  //
  // Grouped by the CHECKER's symbol, not by a synthesized name key. That is
  // the difference between two claims:
  //
  //   interface Foo {}  interface Foo {}   one symbol, two declarations
  //   function save(){} in two scopes      two symbols, one declaration each
  //
  // A name-and-module key merges the second pair; a span key splits the first.
  // The checker already knows, which is the reason a Program is built at all.
  const groups = new Map<ts.Symbol | ts.Node, DeclarationSite[]>();
  for (const site of sites) {
    // Sites the checker could not bind get their own group: an unresolved
    // declaration is still a declaration, and merging them under one key would
    // invent a symbol nobody declared.
    const key = site.symbol ?? (Symbol("unbound") as unknown as ts.Node);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [site]);
    else existing.push(site);
  }

  for (const group of groups.values()) {
    // Canonical first declaration: the identity must not depend on which file
    // the compiler visited first.
    const ordered = [...group].sort(
      (a, b) =>
        compare(a.moduleId, b.moduleId) ||
        a.startLine - b.startLine ||
        a.endLine - b.endLine,
    );
    const first = ordered[0];
    if (first === undefined) continue;

    const symbolId = shortId([
      revision,
      first.moduleId,
      first.kind,
      first.name,
      String(first.startLine),
      String(first.endLine),
    ]);

    symbols.push({
      symbolId,
      name: first.name,
      kind: first.kind,
      moduleId: first.moduleId,
      // Exported if ANY declaration exports it: a merged interface declared
      // once with `export` and once without is exported.
      exported: ordered.some((site) => site.exported),
      declarationCount: ordered.length,
      ...(first.container === undefined ? {} : { container: first.container }),
    });

    for (const site of ordered) {
      declarations.push({
        declarationId: shortId([
          symbolId,
          site.moduleId,
          String(site.startLine),
          String(site.endLine),
        ]),
        symbolId,
        moduleId: site.moduleId,
        kind: site.kind,
        startLine: site.startLine,
        endLine: site.endLine,
        resolution: site.resolution,
        provenance: {
          source: "typescript_checker",
          path: site.moduleId,
          startLine: site.startLine,
          endLine: site.endLine,
          extractorVersion: EXTRACTOR_VERSION,
          revision,
        },
      });
    }
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
