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
    for (const symbol of containers.values()) {
      for (const caller of referencingFiles(
        input.repository,
        symbol.name,
        changed.path,
      )) {
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
        });
      }
    }

    // Tests named for the changed file, which frequently do not import it in a
    // way the reference walk would catch.
    for (const file of input.repository) {
      if (!isTestFor(file.path, changed.path)) continue;
      const source = input.sources.get(file.path);
      if (source === undefined) continue;
      candidates.push({
        kind: "test",
        path: file.path,
        reason: "associated_test",
        trust: "repository_source",
        content: source,
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
export function scoreCandidates(
  candidates: readonly ContextCandidate[],
): readonly ScoredCandidate[] {
  const seen = new Set<string>();
  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    // Identity is path plus span plus reason: the same file offered as both a
    // caller and a test is one item, but a symbol and its whole file are not.
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
export function assembleContext(
  scored: readonly ScoredCandidate[],
  budgetTokens: number,
  generatedPaths: ReadonlySet<string> = new Set(),
): AssembledContext {
  const items: AssembledItem[] = [];
  const omissions: Omission[] = [];
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

    if (candidate.estimatedTokens <= remaining) {
      items.push({
        ...candidate,
        representation: "full",
        ordinal: ordinal++,
        suppliedContent: candidate.content,
      });
      consumed += candidate.estimatedTokens;
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
