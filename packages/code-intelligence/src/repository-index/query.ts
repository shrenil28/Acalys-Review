/**
 * Asking the index things — factually, and never for a verdict.
 *
 * Every function here is of the form "what exists at this revision". None is
 * of the form "should this be flagged". That boundary is architectural rather
 * than stylistic:
 *
 * ```
 * good                          bad
 * ----                          ---
 * declarationsIn(module)        index.isPromiseBug(call)
 * symbolNamed(module, name)     index.isSafeCallback(api)
 * declarationAt(module, line)   index.shouldFlag(candidate)
 * ```
 *
 * The analyzer and the verifier are both allowed to stand on this substrate.
 * If they could also both ask it to settle the contested question, their two
 * independent opinions would become one opinion consulted twice, and the
 * independence P1-H and P1-J are built on would be gone with nothing in the
 * type system to notice.
 *
 * # Absence is a claim, and claims need standing
 *
 * `symbolNamed` returns `not_indexed` rather than `absent` when the module was
 * never successfully read. The distinction costs callers a branch and buys the
 * only thing that makes an index citable: the difference between "this
 * repository does not contain that" and "we did not manage to look".
 */

import type {
  BindingEdge,
  BindingLookup,
  DeclarationRecord,
  ModuleRecord,
  ReferenceRecord,
  RepositoryIndex,
  SymbolLookup,
  SymbolRecord,
} from "./records.js";

/** The module record for a path, or `undefined` if the path is not in the index. */
export function moduleAt(
  index: RepositoryIndex,
  path: string,
): ModuleRecord | undefined {
  return index.modules.find((record) => record.path === path);
}

/**
 * Every declaration in a module, in canonical order.
 *
 * Returns an empty array both for "no declarations" and for "module absent",
 * which is why it is not the right function to ask an existence question with.
 * {@link symbolNamed} is.
 */
export function declarationsIn(
  index: RepositoryIndex,
  moduleId: string,
): readonly DeclarationRecord[] {
  return index.declarations.filter((record) => record.moduleId === moduleId);
}

export function symbolById(
  index: RepositoryIndex,
  symbolId: string,
): SymbolRecord | undefined {
  return index.symbols.find((record) => record.symbolId === symbolId);
}

/**
 * Does this module declare something by this name?
 *
 * The three-way answer is the point. A caller that wants to conclude "there is
 * no such function" must first establish that the module was indexed at all,
 * and the type will not let it skip that step.
 */
export function symbolNamed(
  index: RepositoryIndex,
  moduleId: string,
  name: string,
): SymbolLookup {
  const module = index.modules.find((record) => record.moduleId === moduleId);

  if (module === undefined) {
    return {
      kind: "not_indexed",
      moduleId,
      coverage: "excluded",
      why: `${moduleId} is not present in this index`,
    };
  }

  if (module.coverage !== "indexed") {
    return {
      kind: "not_indexed",
      moduleId,
      coverage: module.coverage,
      why:
        module.coverageDetail ??
        `${moduleId} was not successfully indexed (${module.coverage})`,
    };
  }

  const symbol = index.symbols.find(
    (record) => record.moduleId === moduleId && record.name === name,
  );

  return symbol === undefined
    ? { kind: "absent", moduleId }
    : { kind: "found", symbol };
}

/**
 * The innermost declaration containing a line.
 *
 * Innermost rather than first: a method inside a class inside a module all
 * contain the line, and the one a reviewer needs is the tightest. Ties break
 * on the shorter span, then on `declarationId`, so the answer is stable across
 * runs rather than dependent on record order.
 */
export function declarationAt(
  index: RepositoryIndex,
  moduleId: string,
  line: number,
): DeclarationRecord | undefined {
  const containing = index.declarations.filter(
    (record) =>
      record.moduleId === moduleId &&
      record.startLine <= line &&
      record.endLine >= line,
  );

  if (containing.length === 0) return undefined;

  return containing.reduce((best, candidate) => {
    const bestSpan = best.endLine - best.startLine;
    const candidateSpan = candidate.endLine - candidate.startLine;
    if (candidateSpan !== bestSpan)
      return candidateSpan < bestSpan ? candidate : best;
    return candidate.declarationId < best.declarationId ? candidate : best;
  });
}

/** Whether the index can answer factual questions at all. */
export function isUsable(index: RepositoryIndex): boolean {
  return index.availability.kind === "built";
}

/**
 * A one-line, human-readable citation for a declaration fact.
 *
 * The string a finding or a context item carries so that "the index says so"
 * is never the whole of the evidence. Everything needed to go and check it by
 * hand is present: revision, file, span, and the extractor that read it.
 */
export function citeDeclaration(record: DeclarationRecord): string {
  return (
    `${record.provenance.path}:${String(record.provenance.startLine)}-` +
    `${String(record.provenance.endLine)} ` +
    `(${record.kind} ${record.resolution}, ` +
    `${record.provenance.source}, ` +
    `revision ${record.provenance.revision.slice(0, 12)}, ` +
    `${record.provenance.extractorVersion})`
  );
}

// ---------------------------------------------------------------------------
// References and bindings (L.2)
// ---------------------------------------------------------------------------

/** Every reference recorded in a module, in canonical order. */
export function referencesIn(
  index: RepositoryIndex,
  moduleId: string,
): readonly ReferenceRecord[] {
  return index.references.filter((record) => record.moduleId === moduleId);
}

/**
 * The reference at a module and line with a given name.
 *
 * Name as well as line, because one line can hold several references —
 * `save(load())` is two — and a line-only lookup would return whichever came
 * first, which is a property of iteration rather than of the code.
 */
export function referenceAt(
  index: RepositoryIndex,
  moduleId: string,
  line: number,
  name: string,
): ReferenceRecord | undefined {
  return index.references.find(
    (record) =>
      record.moduleId === moduleId &&
      record.line === line &&
      record.name === name,
  );
}

/**
 * What a reference binds to.
 *
 * Three outcomes, for the reason {@link symbolNamed} has three. `unbound` here
 * means the reference exists and carries no binding edge at all — which should
 * not happen, since the builder emits an edge for every reference including
 * unresolved ones, and is therefore worth being able to observe rather than
 * assuming away.
 */
export function bindingOf(
  index: RepositoryIndex,
  reference: ReferenceRecord,
): BindingLookup {
  const module = index.modules.find(
    (record) => record.moduleId === reference.moduleId,
  );

  if (module === undefined || module.coverage !== "indexed") {
    return {
      kind: "not_indexed",
      moduleId: reference.moduleId,
      coverage: module?.coverage ?? "excluded",
      why:
        module?.coverageDetail ??
        `${reference.moduleId} was not successfully indexed`,
    };
  }

  const binding = index.bindings.find(
    (edge) => edge.referenceId === reference.referenceId,
  );

  return binding === undefined
    ? { kind: "unbound", reference }
    : { kind: "bound", binding };
}

/**
 * The declarations a reference resolves to, or an empty list.
 *
 * Convenience over {@link bindingOf} for the common case, and deliberately NOT
 * the primary API: it returns `[]` for "external", "unresolved", and "the
 * module was never indexed" alike, so it cannot be used to conclude anything
 * about absence. Callers reasoning about whether something exists must use
 * `bindingOf` and switch on the outcome.
 */
export function resolvedDeclarations(
  index: RepositoryIndex,
  reference: ReferenceRecord,
): readonly DeclarationRecord[] {
  const lookup = bindingOf(index, reference);
  if (lookup.kind !== "bound") return [];
  return lookup.binding.declarationIds.flatMap((id) => {
    const record = index.declarations.find(
      (declaration) => declaration.declarationId === id,
    );
    return record === undefined ? [] : [record];
  });
}

/** A one-line citation for a binding, checkable by hand. */
export function citeBinding(
  reference: ReferenceRecord,
  binding: BindingEdge,
): string {
  return (
    `${reference.moduleId}:${String(reference.line)} ` +
    `${reference.kind} \`${reference.name}\` -> ${binding.resolution}` +
    (binding.viaAlias ? " (via import)" : "") +
    `, ${String(binding.declarationIds.length)} declaration(s), ` +
    `revision ${binding.provenance.revision.slice(0, 12)}`
  );
}

/**
 * The modules whose references bind into a given module.
 *
 * The reverse of {@link resolvedDeclarations}: not "what does this call" but
 * "what calls this". Both are the same binding edges read from opposite ends,
 * which is why L.2's records answer it without new extraction.
 *
 * This exists because name matching answers the same question wrongly in a way
 * that looks right. `referencingFiles(repository, "save", …)` returns every
 * file mentioning `save` — including the ones that mean a different `save`
 * entirely — and a reviewer shown those is being told something false about
 * what depends on their change.
 *
 * Returns nothing for an unusable index, so "no index" is never read as
 * "nothing depends on this".
 */
export function modulesReferencing(
  index: RepositoryIndex,
  moduleId: string,
): readonly {
  readonly moduleId: string;
  readonly reference: ReferenceRecord;
  readonly binding: BindingEdge;
}[] {
  if (!isUsable(index)) return [];

  const declarationModule = new Map(
    index.declarations.map((record) => [record.declarationId, record.moduleId]),
  );
  const references = new Map(
    index.references.map((record) => [record.referenceId, record]),
  );

  const found: {
    moduleId: string;
    reference: ReferenceRecord;
    binding: BindingEdge;
  }[] = [];
  const seen = new Set<string>();

  for (const binding of index.bindings) {
    const reference = references.get(binding.referenceId);
    if (reference === undefined) continue;
    if (reference.moduleId === moduleId) continue;

    const targets = binding.declarationIds.some(
      (id) => declarationModule.get(id) === moduleId,
    );
    if (!targets) continue;

    // One entry per referencing module: "who depends on this?" is a question
    // about modules, and ten call sites in one file are one dependant.
    if (seen.has(reference.moduleId)) continue;
    seen.add(reference.moduleId);

    found.push({ moduleId: reference.moduleId, reference, binding });
  }

  return found.sort((a, b) => (a.moduleId < b.moduleId ? -1 : 1));
}
