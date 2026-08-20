/**
 * Choosing what the analyzer sees.
 *
 * The part of the product users actually judge. Everything before it decides
 * *whether* a review happens; this decides whether it can possibly be good — a
 * model given the wrong forty thousand tokens cannot find the bug in the file
 * it was not shown.
 *
 * Three separate steps, deliberately not one:
 *
 *     generate   be generous — offer every plausibly relevant item
 *     score      say why each matters, with a reason a human can argue with
 *     assemble   fit the budget, and record what was ACTUALLY sent
 *
 * The separation is what stops the planner degenerating into
 * `files.slice(0, tokenLimit)`. Generation without scoring has no basis for
 * choosing; scoring without a separate assembly step cannot record truncation,
 * because it never sees the budget being spent.
 *
 * # Two things this file refuses to conflate
 *
 * **Instruction and data.** A repository's `AGENTS.md` is an instruction the
 * platform honours. A comment in a source file saying "ignore previous
 * instructions" is *data that happens to contain text*. Once both are strings
 * in a prompt, neither the builder nor the model can tell them apart — so trust
 * travels with every item, from generation through assembly.
 *
 * **Intended and shown.** The planner selects; the budget truncates. Only the
 * assembled result is recorded, because a snapshot of intentions would tell an
 * engineer during an incident that the analyzer saw something it never did.
 */

import type { ExtractedSymbol, FileIntelligence } from "./symbols.js";
import { containingSymbol, isTestFor, referencingFiles } from "./symbols.js";
import type {
  BindingEdge,
  DeclarationRecord,
  ReferenceRecord,
  RepositoryIndex,
  TestRelationship,
} from "./repository-index/index.js";
import {
  bindingOf,
  citeBinding,
  citeDeclaration,
  declarationAt,
  describeIdentity,
  citeTestRelationship,
  isUsable,
  modulesReferencing,
  referencesIn,
  resolvedDeclarations,
  symbolById,
  testRelationships,
} from "./repository-index/index.js";

/**
 * Where a piece of context came from, and how far it may be trusted.
 *
 * The vocabulary the prompt builder needs to keep instruction and data apart.
 * `platform_policy` is the only level that may direct the reviewer; everything
 * else is material to reason *about*.
 */
export const TRUST_LEVELS = [
  "platform_policy",
  "tenant_instruction",
  "repository_source",
  "tool_output",
  "author_supplied",
  "third_party",
] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** Whether a trust level may direct the reviewer's behaviour. */
export function isInstruction(trust: TrustLevel): boolean {
  return trust === "platform_policy" || trust === "tenant_instruction";
}

/** Why an item was offered. Closed, so scoring cannot be ad hoc. */
export const INCLUSION_REASONS = [
  "changed_hunk",
  "containing_symbol",
  // Supplied by the repository index rather than by single-file extraction.
  // A separate reason rather than a flag on `containing_symbol`, because the
  // two are produced by different procedures with different standing: one
  // parses a file alone, the other resolves bindings across the revision and
  // can say which of two same-named declarations it means.
  "indexed_declaration",
  "referenced_symbol",
  "caller",
  "associated_test",
  "repository_instruction",
  "path_instruction",
  "configuration",
  "prior_finding",
  "git_history",
] as const;

export type InclusionReason = (typeof INCLUSION_REASONS)[number];

export const CONTEXT_ITEM_KINDS = [
  "source_file",
  "source_excerpt",
  "symbol",
  "instruction",
  "test",
  "configuration",
  "finding",
] as const;

export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

/**
 * Where an item's *fact* came from — not where its text came from.
 *
 * Every candidate carries source text. This says which procedure decided the
 * text was the right text: a single-file parse, or a revision-wide index that
 * resolved bindings and can cite a record.
 *
 * It exists so that "the index is integrated" is checkable rather than
 * asserted. A snapshot whose items all say `direct_source` is a snapshot the
 * index never touched, whatever the call graph suggests — and that is exactly
 * the gap P1-K found between a well-tested module and a production path that
 * never reached it.
 */
export type ItemProvenance =
  | { readonly source: "direct_source" }
  | {
      readonly source: "repository_index";
      /** {@link describeIdentity} — revision and extractor included. */
      readonly indexIdentity: string;
      /** The declaration record this item was cut from. */
      readonly recordId: string;
      /** Human-readable, re-checkable by hand. */
      readonly citation: string;
    };

/** Something the planner could show the analyzer. */
export interface ContextCandidate {
  readonly kind: ContextItemKind;
  readonly path: string;
  readonly reason: InclusionReason;
  readonly trust: TrustLevel;
  /** The text itself. Assembly may truncate it; generation never does. */
  readonly content: string;
  /** Present when the candidate is a specific declaration. */
  readonly symbol?: ExtractedSymbol | undefined;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
  /** Defaults to `direct_source` when the planner had no index. */
  readonly provenance?: ItemProvenance | undefined;
}

/**
 * How much each reason is worth.
 *
 * A table rather than scattered constants, because these are the product's
 * editorial judgement and they should be arguable in one place. The ordering
 * matters more than the absolute values:
 *
 * - **Instructions outrank everything.** A repository's conventions change what
 *   counts as a defect, so a review without them is answering a different
 *   question. They are effectively mandatory.
 * - **Changed code and its container are next**, and are jointly non-negotiable:
 *   a hunk without its enclosing function is a diff, not code.
 * - **Callers rank above distant dependencies**, because the most common real
 *   defect is a contract mismatch between a changed function and something that
 *   calls it.
 * - **Tests rank high**, since they encode intent more reliably than prose.
 */
export const REASON_WEIGHT: Readonly<Record<InclusionReason, number>> = {
  repository_instruction: 1_000,
  path_instruction: 950,
  changed_hunk: 900,
  containing_symbol: 880,
  // Just above the syntactic equivalent: same material, better standing.
  indexed_declaration: 885,
  associated_test: 700,
  caller: 650,
  referenced_symbol: 600,
  configuration: 400,
  prior_finding: 350,
  git_history: 200,
};

export interface ScoredCandidate extends ContextCandidate {
  readonly score: number;
  /** Roughly four characters per token — good enough for budgeting. */
  readonly estimatedTokens: number;
}

/** How an item appeared in the assembled context. */
export const REPRESENTATIONS = [
  "full",
  "excerpt",
  "summary",
  "metadata",
] as const;
export type Representation = (typeof REPRESENTATIONS)[number];

export interface AssembledItem extends ScoredCandidate {
  readonly representation: Representation;
  /** Position in the assembled prompt. Order changes model behaviour. */
  readonly ordinal: number;
  /** The text actually supplied, after any truncation. */
  readonly suppliedContent: string;
}

export const OMISSION_REASONS = [
  "budget_exceeded",
  "generated_file",
  "binary",
  "duplicate",
  "policy",
] as const;

export type OmissionReason = (typeof OMISSION_REASONS)[number];

export interface Omission {
  readonly path: string;
  readonly reason: OmissionReason;
  readonly inclusionReason: InclusionReason;
  readonly estimatedTokens: number;
}

/**
 * What was actually shown — never what was intended.
 *
 * Produced by the assembler, which is the component that spent the budget.
 * A planner-written record would name items the truncation dropped, and an
 * engineer reading it during an incident would investigate on the belief that
 * the analyzer saw them.
 */
export interface AssembledContext {
  readonly items: readonly AssembledItem[];
  readonly omissions: readonly Omission[];
  readonly budget: { readonly limit: number; readonly consumed: number };
}

/** Four characters per token. Crude, stable, and adequate for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ChangedFileInput {
  readonly path: string;
  readonly content: string;
  readonly changedLines: readonly number[];
}

export interface PlannerInput {
  readonly changed: readonly ChangedFileInput[];
  /** Every file the planner may draw on, including the changed ones. */
  readonly repository: readonly FileIntelligence[];
  /** Source text by path, for materializing candidates. */
  readonly sources: ReadonlyMap<string, string>;
  /** Repository-level instructions, already resolved. */
  readonly instructions?:
    readonly { readonly path: string; readonly content: string }[] | undefined;
  /** Path instructions that matched, with the globs already applied. */
  readonly pathInstructions?:
    | readonly { readonly glob: string; readonly instructions: string }[]
    | undefined;
  /**
   * Structural facts for the revision under review.
   *
   * Optional because the planner must still work without it — an index that
   * failed to build must degrade to syntactic candidates rather than empty the
   * context. But when it is present, the items it produces say so, and a
   * snapshot with no `repository_index` provenance is evidence the seam was
   * not exercised.
   */
  readonly index?: RepositoryIndex | undefined;
}

/**
 * The distinct declarations the index says a change sits inside.
 *
 * Deduplicated by record: twenty changed lines in one function are one
 * declaration, and offering it twenty times would spend the budget on
 * repetition. Returns nothing at all when there is no index or the index is
 * not usable — a caller must not be able to tell "no index" from "index says
 * there is nothing here", so the honest answer is to produce no indexed
 * candidates rather than to fabricate an empty one.
 */
function indexedContainers(
  index: RepositoryIndex | undefined,
  changed: ChangedFileInput,
): readonly {
  readonly index: RepositoryIndex;
  readonly declaration: DeclarationRecord;
}[] {
  if (index === undefined || !isUsable(index)) return [];

  const found = new Map<string, DeclarationRecord>();
  for (const line of changed.changedLines) {
    const declaration = declarationAt(index, changed.path, line);
    if (declaration !== undefined) {
      found.set(declaration.declarationId, declaration);
    }
  }

  return [...found.values()]
    .sort((left, right) => left.startLine - right.startLine)
    .map((declaration) => ({ index, declaration }));
}

/**
 * The declarations that calls in a changed file actually bind to.
 *
 * Calls only. A changed file references many names — types, reads, imports —
 * and offering every bound declaration would spend the context budget on
 * everything the file mentions. A call is the contract the change exercises,
 * which is the same intent the name-matching loop had.
 *
 * Deduplicated by declaration: ten calls to one function are one declaration
 * worth showing. Returns nothing when there is no index or the index is not
 * usable, so "no index" is never mistaken for "this file calls nothing".
 */
function boundCallees(
  index: RepositoryIndex | undefined,
  path: string,
): readonly {
  readonly index: RepositoryIndex;
  readonly reference: ReferenceRecord;
  readonly binding: BindingEdge;
  readonly declaration: DeclarationRecord;
}[] {
  if (index === undefined || !isUsable(index)) return [];

  const seen = new Set<string>();
  const found: {
    index: RepositoryIndex;
    reference: ReferenceRecord;
    binding: BindingEdge;
    declaration: DeclarationRecord;
  }[] = [];

  for (const reference of referencesIn(index, path)) {
    if (reference.kind !== "call") continue;
    const lookup = bindingOf(index, reference);
    if (lookup.kind !== "bound") continue;
    // `external` and `unresolved` carry no declarations, so they contribute
    // nothing here — correctly. A reference into a dependency is a real fact
    // and not a file this repository can show.
    for (const declaration of resolvedDeclarations(index, reference)) {
      if (seen.has(declaration.declarationId)) continue;
      seen.add(declaration.declarationId);
      found.push({
        index,
        reference,
        binding: lookup.binding,
        declaration,
      });
    }
  }

  return found;
}

/**
 * Tests the index says reference a module, with the index carried alongside.
 *
 * Nothing when there is no index or it is not usable, so "no index" is never
 * mistaken for "nothing tests this module" — the same rule the declaration and
 * binding paths follow.
 */
function relatedTests(
  index: RepositoryIndex | undefined,
  changedPath: string,
): readonly (TestRelationship & { readonly index: RepositoryIndex })[] {
  if (index === undefined || !isUsable(index)) return [];

  return testRelationships(index)
    .filter(
      (relationship) =>
        relationship.targetModuleId === changedPath &&
        relationship.strength === "direct_symbol_reference",
    )
    .map((relationship) => ({ ...relationship, index }));
}

/**
 * Offers everything plausibly relevant.
 *
 * Deliberately generous: selection is the next step's job, and a candidate
 * never generated can never be selected. Over-generation costs a scoring pass;
 * under-generation costs the finding.
 */
export function generateCandidates(
  input: PlannerInput,
): readonly ContextCandidate[] {
  const candidates: ContextCandidate[] = [];
  const byPath = new Map(input.repository.map((file) => [file.path, file]));

  for (const instruction of input.instructions ?? []) {
    candidates.push({
      kind: "instruction",
      path: instruction.path,
      reason: "repository_instruction",
      // Tenant-authored: it directs the reviewer, and must stay separable from
      // the source text it talks about.
      trust: "tenant_instruction",
      content: instruction.content,
    });
  }

  for (const pathInstruction of input.pathInstructions ?? []) {
    candidates.push({
      kind: "instruction",
      path: pathInstruction.glob,
      reason: "path_instruction",
      trust: "tenant_instruction",
      content: pathInstruction.instructions,
    });
  }

  for (const changed of input.changed) {
    const intelligence = byPath.get(changed.path);

    candidates.push({
      kind: "source_file",
      path: changed.path,
      reason: "changed_hunk",
      trust: "repository_source",
      content: changed.content,
    });

    if (intelligence === undefined) continue;

    // The enclosing declaration for every changed line. Deduplicated, because
    // twenty changed lines in one function are one symbol.
    const containers = new Map<string, ExtractedSymbol>();
    for (const line of changed.changedLines) {
      const symbol = containingSymbol(intelligence, line);
      if (symbol !== undefined) containers.set(symbol.qualifiedName, symbol);
    }
    // The same question — "what declaration is this hunk inside?" — answered
    // twice, by two procedures with different standing.
    //
    // Where they agree on a span, the indexed answer REPLACES the syntactic
    // one rather than joining it. They carry identical text, so offering both
    // would spend the budget twice on one function; and the planner exists to
    // stop exactly that. What changes is not how many items there are, but
    // what the item can say about itself: a citable record and a binding the
    // compiler resolved, instead of a span a parser guessed at alone.
    //
    // Where the index has nothing — it failed, the language is unsupported,
    // the module did not parse — the syntactic candidate stands. Degrading to
    // a weaker fact is right; degrading to no context is not.
    const indexed = indexedContainers(input.index, changed);

    for (const symbol of containers.values()) {
      candidates.push({
        kind: "symbol",
        path: changed.path,
        reason: "containing_symbol",
        trust: "repository_source",
        content: sliceLines(changed.content, symbol.startLine, symbol.endLine),
        symbol,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        provenance: { source: "direct_source" },
      });
    }

    for (const record of indexed) {
      const declaration = record.declaration;
      const symbol = symbolById(record.index, declaration.symbolId);
      candidates.push({
        kind: "symbol",
        path: changed.path,
        reason: "indexed_declaration",
        trust: "repository_source",
        content: sliceLines(
          changed.content,
          declaration.startLine,
          declaration.endLine,
        ),
        ...(symbol === undefined
          ? {}
          : {
              symbol: {
                name: symbol.name,
                kind: symbol.kind,
                qualifiedName:
                  symbol.container === undefined
                    ? symbol.name
                    : `${symbol.container}.${symbol.name}`,
                ...(symbol.container === undefined
                  ? {}
                  : { container: symbol.container }),
                startLine: declaration.startLine,
                endLine: declaration.endLine,
                exported: symbol.exported,
              },
            }),
        startLine: declaration.startLine,
        endLine: declaration.endLine,
        provenance: {
          source: "repository_index",
          indexIdentity: describeIdentity(record.index.identity),
          recordId: declaration.declarationId,
          citation: citeDeclaration(declaration),
        },
      });
    }

    // What the change actually calls, resolved by the checker.
    //
    // The loop below this one answers the same question by matching names
    // across a resolved module, and gets it wrong exactly where it matters:
    // a local or parameter that shadows an import produces a real declaration
    // from a real file, which a reviewer reads and believes. The binding edge
    // says which symbol the call denotes, so the wrong one is never offered.
    //
    // Same precedence rule as L.1: an indexed answer replaces the syntactic
    // one for the same span, and where no binding is established the syntactic
    // candidate stands.
    for (const record of boundCallees(input.index, changed.path)) {
      const source = input.sources.get(record.declaration.moduleId);
      if (source === undefined) continue;
      candidates.push({
        kind: "symbol",
        path: record.declaration.moduleId,
        reason: "referenced_symbol",
        trust: "repository_source",
        content: sliceLines(
          source,
          record.declaration.startLine,
          record.declaration.endLine,
        ),
        startLine: record.declaration.startLine,
        endLine: record.declaration.endLine,
        provenance: {
          source: "repository_index",
          indexIdentity: describeIdentity(record.index.identity),
          recordId: record.binding.bindingId,
          citation: citeBinding(record.reference, record.binding),
        },
      });
    }

    // Symbols this file imports — the contract the change has to satisfy.
    for (const edge of intelligence.imports) {
      const resolved = resolveSpecifier(changed.path, edge.specifier, byPath);
      if (resolved === undefined) continue;
      const source = input.sources.get(resolved.path);
      if (source === undefined) continue;

      for (const name of edge.names) {
        const declaration = resolved.symbols.find(
          (symbol) => symbol.name === name,
        );
        if (declaration === undefined) continue;
        candidates.push({
          kind: "symbol",
          path: resolved.path,
          reason: "referenced_symbol",
          trust: "repository_source",
          content: sliceLines(
            source,
            declaration.startLine,
            declaration.endLine,
          ),
          symbol: declaration,
          startLine: declaration.startLine,
          endLine: declaration.endLine,
        });
      }
    }

    // Callers of anything the change touched. The most common real defect is a
    // contract mismatch between a changed function and something calling it.
    //
    // Two procedures again, and the difference is not cosmetic.
    // `referencingFiles` matches a NAME across the repository, so a change to
    // one `save` offers every file mentioning any `save` — and a reviewer
    // shown those is being told something false about what depends on their
    // change. `modulesReferencing` reads the binding edges backwards and
    // returns only the modules that actually bind into this one.
    //
    // The indexed answer replaces the syntactic one per module, under the
    // precedence rule L.1 established; where the index has nothing, the
    // syntactic guess still stands.
    const indexedDependants = new Set<string>();
    if (input.index !== undefined && isUsable(input.index)) {
      for (const dependant of modulesReferencing(input.index, changed.path)) {
        const source = input.sources.get(dependant.moduleId);
        if (source === undefined) continue;
        indexedDependants.add(dependant.moduleId);

        // Tests are left to the block below, which relates them at SYMBOL
        // level and can say how strong the association is. Offering them from
        // here as well would win the span-based dedupe and replace a citation
        // that names `direct_symbol_reference` with one that says only
        // "import" — the weaker fact displacing the stronger one purely
        // because it was generated first.
        const isTest =
          input.index.modules.find(
            (module) => module.moduleId === dependant.moduleId,
          )?.role === "test";
        if (isTest) {
          indexedDependants.add(dependant.moduleId);
          continue;
        }

        candidates.push({
          kind: "source_file",
          path: dependant.moduleId,
          reason: "caller",
          trust: "repository_source",
          content: source,
          provenance: {
            source: "repository_index",
            indexIdentity: describeIdentity(input.index.identity),
            recordId: dependant.binding.bindingId,
            citation: citeBinding(dependant.reference, dependant.binding),
          },
        });
      }
    }

    for (const symbol of containers.values()) {
      for (const caller of referencingFiles(
        input.repository,
        symbol.name,
        changed.path,
      )) {
        // The index spoke about this module. Either it named it a dependant —
        // in which case the indexed candidate above already covers it — or it
        // did not, in which case the syntactic guess is a name collision
        // rather than a dependency. Both are handled by the same condition.
        //
        // A separate `indexedDependants.has(caller.path)` check stood here and
        // was dead: every module in that set is an indexed module, so this
        // condition already subsumed it. A mutation removing it survived,
        // which is how it was found. Dead defensive code reads as protection,
        // so the next person adds a case rather than asking whether the branch
        // is reachable.
        if (
          input.index !== undefined &&
          isUsable(input.index) &&
          input.index.modules.some(
            (module) =>
              module.moduleId === caller.path && module.coverage === "indexed",
          )
        ) {
          continue;
        }
        const source = input.sources.get(caller.path);
        if (source === undefined) continue;
        candidates.push({
          kind:
            caller.path.match(/\.(test|spec)\./) === null
              ? "source_file"
              : "test",
          path: caller.path,
          reason:
            caller.path.match(/\.(test|spec)\./) === null
              ? "caller"
              : "associated_test",
          trust: "repository_source",
          content: source,
          provenance: { source: "direct_source" },
        });
      }
    }

    // Tests that reference the changed module, on the checker's account.
    //
    // `isTestFor` below matches filenames — `save.test.ts` is held to test
    // `save.ts` — which is a naming convention rather than a fact, and is
    // wrong in both directions. When the index is available the association
    // comes from bindings instead, and the syntactic guess is skipped for any
    // test the index already related, under the same precedence rule L.1
    // established: the indexed answer dominates when positively established.
    const indexedTests = new Set<string>();
    for (const relationship of relatedTests(input.index, changed.path)) {
      const source = input.sources.get(relationship.testModuleId);
      if (source === undefined) continue;
      indexedTests.add(relationship.testModuleId);
      candidates.push({
        kind: "test",
        path: relationship.testModuleId,
        reason: "associated_test",
        trust: "repository_source",
        content: source,
        provenance: {
          source: "repository_index",
          indexIdentity: describeIdentity(relationship.index.identity),
          recordId: relationship.viaReferenceId ?? relationship.testModuleId,
          citation: citeTestRelationship(relationship, relationship.index),
        },
      });
    }

    // Tests named for the changed file. Kept, because a test that exercises a
    // module through a helper it does not import directly is real and the
    // reference walk cannot see it — but skipped where the index already
    // spoke, so one test is not offered twice.
    for (const file of input.repository) {
      if (!isTestFor(file.path, changed.path)) continue;
      if (indexedTests.has(file.path)) continue;
      const source = input.sources.get(file.path);
      if (source === undefined) continue;
      candidates.push({
        kind: "test",
        path: file.path,
        reason: "associated_test",
        trust: "repository_source",
        content: source,
        provenance: { source: "direct_source" },
      });
    }
  }

  return candidates;
}

/** Extracts an inclusive 1-based line range. */
function sliceLines(source: string, start: number, end: number): string {
  return source
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

/**
 * Resolves a relative import to a known file.
 *
 * Only relative specifiers: a bare `zod` is a dependency, not repository code,
 * and pulling `node_modules` into a review's context would spend the entire
 * budget on library source.
 */
function resolveSpecifier(
  fromPath: string,
  specifier: string,
  byPath: ReadonlyMap<string, FileIntelligence>,
): FileIntelligence | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const directory = fromPath.replace(/\/[^/]*$/, "");
  const joined = `${directory}/${specifier}`
    .split("/")
    .reduce<string[]>((parts, segment) => {
      if (segment === "." || segment === "") return parts;
      if (segment === "..") {
        parts.pop();
        return parts;
      }
      parts.push(segment);
      return parts;
    }, []);
  const base = joined.join("/").replace(/\.js$/, "");

  for (const suffix of [".ts", ".tsx", "/index.ts", ""]) {
    const found = byPath.get(`${base}${suffix}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Scores and deduplicates candidates.
 *
 * The score is the reason's weight, adjusted downward for size so a 4,000-line
 * file does not outrank a precise 40-line symbol with the same reason. Ties
 * break on the earlier reason in {@link REASON_WEIGHT}, so ordering is total
 * and the assembled context is deterministic — which is what makes the
 * planner's own eval comparable across runs.
 */
/**
 * How much authority a candidate's *provenance* carries.
 *
 * Only used to break ties between candidates describing the same span. It is
 * deliberately not part of the score: standing is about which of two identical
 * texts to keep, and score is about whether the text is worth the budget.
 * Folding them together would let provenance quietly reorder the whole prompt.
 */
function standing(candidate: ContextCandidate): number {
  return candidate.provenance?.source === "repository_index" ? 1 : 0;
}

export function scoreCandidates(
  candidates: readonly ContextCandidate[],
): readonly ScoredCandidate[] {
  const seen = new Set<string>();
  const scored: ScoredCandidate[] = [];

  // Highest-standing representation first, so the loop below keeps it.
  //
  // Sorting rather than relying on the order candidates happened to be
  // generated in. Two candidates can describe the same source span — the
  // syntactic container and the indexed declaration — and they carry identical
  // text, so keeping both would spend the budget twice on one function. Which
  // one survives is a rule, not an accident of traversal:
  //
  //   same semantic location + indexed observation positively established
  //     -> the indexed representation dominates
  //
  // "Positively established" is doing work. An index that failed to build, or
  // that could not read this module, produces no indexed candidate at all
  // (see `indexedContainers`), so the syntactic one is what remains. An
  // incomplete index must cost the richer fact, never the context itself.
  const byStanding = [...candidates].sort(
    (left, right) => standing(right) - standing(left),
  );

  for (const candidate of byStanding) {
    // Identity is path plus span: the same file offered as both a caller and a
    // test is one item, but a symbol and its whole file are not.
    const identity = `${candidate.path}|${String(candidate.startLine ?? 0)}|${String(candidate.endLine ?? 0)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const estimatedTokens = estimateTokens(candidate.content);
    // A gentle size penalty — logarithmic, so a large file is deprioritized
    // without being excluded by size alone.
    const sizePenalty = Math.log10(Math.max(estimatedTokens, 1)) * 20;

    scored.push({
      ...candidate,
      estimatedTokens,
      score: REASON_WEIGHT[candidate.reason] - sizePenalty,
    });
  }

  return scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

/**
 * Fits the scored candidates into the budget, recording what was shown.
 *
 * This is the component that must write the provenance record, because it is
 * the only one that knows what survived. Three behaviours are load-bearing:
 *
 * - **Generated files are dropped before anything competes for budget.** A
 *   40,000-line generated client would otherwise evict every hand-written file
 *   a reviewer needs, purely by arriving first.
 * - **Instructions are never truncated.** A half-shown rule is worse than an
 *   absent one: the reviewer would follow the visible half.
 * - **Omissions are recorded, not merely absent.** "Dropped for budget" and
 *   "never considered" are different facts, and only the first explains a
 *   missed finding.
 */
/**
 * The text of a pointer item.
 *
 * Names the location rather than restating the body, and says explicitly that
 * the body is elsewhere in the same context — a reader that cannot tell a
 * pointer from a declaration has been given a truncated file without being
 * told.
 */
function pointerTo(candidate: ScoredCandidate): string {
  const span =
    candidate.startLine === undefined || candidate.endLine === undefined
      ? candidate.path
      : `${candidate.path}:${String(candidate.startLine)}-${String(candidate.endLine)}`;
  const name = candidate.symbol?.qualifiedName ?? candidate.path;
  // Terse on purpose: the pointer is paid for on every collapse, and prose
  // explaining the mechanism to the reader would often cost more than the few
  // lines it replaced.
  return `[${span}] ${name} — body shown above`;
}

/**
 * Collapses already-admitted items whose text a newly-admitted file repeats.
 *
 * De-duplication has to work in **both** orders, because scoring decides the
 * order and the size penalty routinely puts a small symbol ahead of the large
 * file that contains it. Handling only "file first, symbol second" would make
 * the saving depend on file length, which is precisely the case where it
 * matters most.
 *
 * Mutates in place and returns the tokens freed, which the caller subtracts —
 * so the budget released by a collapse is available to everything that follows.
 */
function collapseCovered(
  items: AssembledItem[],
  path: string,
  content: string,
): number {
  let freed = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    // Compared against the item's ORIGINAL content, not the text it was
    // supplied with. Pointing an excerpt at a later full copy is safe only if
    // the whole declaration is in that copy; comparing supplied text would
    // accept a pointer whose body had been truncated away.
    //
    // The two are indistinguishable today — excerpting spends every remaining
    // token, so nothing is ever admitted after a truncation (asserted in
    // `assembler.test.ts`). Swapping this for `suppliedContent` therefore kills
    // no test. The stricter comparison is kept anyway: it is correct without
    // depending on that budget property, which a future change to excerpting
    // could remove without anyone connecting the two.
    if (
      item === undefined ||
      item.path !== path ||
      item.kind === "instruction" ||
      item.content === content ||
      item.content === "" ||
      !content.includes(item.content)
    ) {
      continue;
    }

    const pointer = pointerTo(item);
    const saving =
      estimateTokens(item.suppliedContent) - estimateTokens(pointer);
    if (saving <= 0) continue;

    items[index] = {
      ...item,
      representation: "metadata",
      suppliedContent: pointer,
    };
    freed += saving;
  }

  return freed;
}

export function assembleContext(
  scored: readonly ScoredCandidate[],
  budgetTokens: number,
  generatedPaths: ReadonlySet<string> = new Set(),
): AssembledContext {
  const items: AssembledItem[] = [];
  const omissions: Omission[] = [];
  const suppliedInFull = new Map<string, string>();
  let consumed = 0;
  let ordinal = 0;

  for (const candidate of scored) {
    if (
      generatedPaths.has(candidate.path) &&
      candidate.kind !== "instruction"
    ) {
      omissions.push({
        path: candidate.path,
        reason: "generated_file",
        inclusionReason: candidate.reason,
        estimatedTokens: candidate.estimatedTokens,
      });
      continue;
    }

    const remaining = budgetTokens - consumed;

    // Text already supplied in full is pointed at, never repeated.
    const covering = suppliedInFull.get(candidate.path);
    if (
      covering !== undefined &&
      candidate.kind !== "instruction" &&
      candidate.content !== "" &&
      covering.includes(candidate.content)
    ) {
      const pointer = pointerTo(candidate);
      const pointerTokens = estimateTokens(pointer);
      // Cheap is not free, and a pointer is not automatically cheaper than what
      // it replaces — a three-line function costs less than the sentence
      // describing where to find it. Collapse only when it actually saves, and
      // never past the budget; otherwise fall through and let the normal path
      // decide.
      if (
        pointerTokens < candidate.estimatedTokens &&
        pointerTokens <= remaining
      ) {
        items.push({
          ...candidate,
          representation: "metadata",
          ordinal: ordinal++,
          suppliedContent: pointer,
        });
        consumed += pointerTokens;
        continue;
      }
    }

    if (candidate.estimatedTokens <= remaining) {
      items.push({
        ...candidate,
        representation: "full",
        ordinal: ordinal++,
        suppliedContent: candidate.content,
      });
      consumed += candidate.estimatedTokens;
      if (candidate.kind === "source_file") {
        suppliedInFull.set(candidate.path, candidate.content);
        consumed -= collapseCovered(items, candidate.path, candidate.content);
      }
      continue;
    }

    // An instruction that does not fit is omitted whole. Truncating it would
    // leave the reviewer following half a rule and believing it complete.
    if (candidate.kind === "instruction" || remaining < 50) {
      omissions.push({
        path: candidate.path,
        reason: "budget_exceeded",
        inclusionReason: candidate.reason,
        estimatedTokens: candidate.estimatedTokens,
      });
      continue;
    }

    // Source can be excerpted — and the excerpt is recorded as such, so nothing
    // downstream mistakes it for the whole file.
    const excerpt = candidate.content.slice(0, remaining * 4);
    items.push({
      ...candidate,
      representation: "excerpt",
      ordinal: ordinal++,
      suppliedContent: excerpt,
    });
    consumed += estimateTokens(excerpt);
  }

  return { items, omissions, budget: { limit: budgetTokens, consumed } };
}

/** Generate, score and assemble in one call. */
export function planContext(
  input: PlannerInput,
  budgetTokens: number,
): AssembledContext {
  const generated = new Set(
    input.repository.filter((file) => file.generated).map((file) => file.path),
  );
  return assembleContext(
    scoreCandidates(generateCandidates(input)),
    budgetTokens,
    generated,
  );
}
