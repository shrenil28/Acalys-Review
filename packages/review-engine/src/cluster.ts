/**
 * Risk clusters: the unit a reviewer actually reasons about.
 *
 * A file is a storage boundary. It is not the boundary of a defect. The most
 * common real correctness bug spans two files — a caller that now violates a
 * contract stated in a callee — so analyzing per file means every invocation
 * reasons with part of the picture and pays for the shared context again.
 *
 * ```
 *   per file                          per cluster
 *   4 invocations                     1 invocation
 *   ¼ of the bug surface each         the whole surface
 *   shared context paid 4×            shared context paid once
 * ```
 *
 * Two changed files that share nothing are two clusters. One changed file
 * touching two unrelated subsystems is also two. Grouping by file produces
 * neither, which is the point.
 *
 * # What connects two changed files
 *
 * Only relationships the supplied context actually establishes:
 *
 *     direct import        one changed file imports the other
 *     shared dependency    both import the same supplied module
 *     test association     a supplied test covers both
 *
 * Not proximity, not directory, not naming. A guess about relatedness produces
 * a cluster whose members have nothing to say about each other, which costs a
 * full deep pass to discover.
 */

import { extractFile, type AssembledItem } from "@acalys/code-intelligence";

/** What is under review, as opposed to what may be consulted. */
export interface AnalysisSubject {
  readonly path: string;
  readonly changedLines: readonly number[];
}

export interface RiskCluster {
  /** Stable across revisions for the same semantic unit. */
  readonly id: string;
  /** Changed files in this cluster. Never empty. */
  readonly subject: readonly AnalysisSubject[];
  /** Declarations the change touched, qualified where known. */
  readonly changedSymbols: readonly string[];
  /**
   * Everything the analyzer may read for this cluster.
   *
   * A subset of the assembled context, not a re-fetch: the planner already
   * decided what is admissible, and a cluster narrows it rather than widening
   * it.
   */
  readonly context: readonly AssembledItem[];
  /** Context that is not optional. See the budget note in `triage.ts`. */
  readonly mandatory: readonly AssembledItem[];
}

/** Reasons a context item is mandatory rather than budget-negotiable. */
const MANDATORY_REASONS = new Set([
  "changed_hunk",
  "containing_symbol",
  "repository_instruction",
  "path_instruction",
]);

function resolveImport(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const base = from.split("/").slice(0, -1);
  const parts = specifier.split("/");
  for (const part of parts) {
    if (part === ".") continue;
    else if (part === "..") base.pop();
    else base.push(part);
  }

  const joined = base.join("/").replace(/\.[cm]?js$/, "");
  for (const candidate of [
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}/index.ts`,
    joined,
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/** Disjoint sets over subject paths. */
class Grouping {
  readonly #parent = new Map<string, string>();

  public add(key: string): void {
    if (!this.#parent.has(key)) this.#parent.set(key, key);
  }

  public find(key: string): string {
    let current = key;
    let parent = this.#parent.get(current) ?? current;
    while (parent !== current) {
      current = parent;
      parent = this.#parent.get(current) ?? current;
    }
    return current;
  }

  public union(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.#parent.set(a, b);
  }

  public groups(): ReadonlyMap<string, readonly string[]> {
    const out = new Map<string, string[]>();
    for (const key of this.#parent.keys()) {
      const root = this.find(key);
      out.set(root, [...(out.get(root) ?? []), key]);
    }
    return out;
  }
}

/**
 * Groups the change into semantic units.
 *
 * Reads only supplied content. A relationship the planner did not supply the
 * evidence for is not a relationship this function will invent — which means a
 * planner regression shows up here as clusters that should have merged and did
 * not, rather than as silence.
 */
export function buildClusters(
  subject: readonly AnalysisSubject[],
  context: readonly AssembledItem[],
): readonly RiskCluster[] {
  const subjectPaths = new Set(subject.map((entry) => entry.path));
  const suppliedPaths = new Set(context.map((item) => item.path));
  const byPath = new Map<string, AssembledItem[]>();
  for (const item of context) {
    byPath.set(item.path, [...(byPath.get(item.path) ?? []), item]);
  }

  const grouping = new Grouping();
  for (const path of subjectPaths) grouping.add(path);

  // Which non-subject modules each changed file depends on. Shared entries are
  // what merge two clusters that never import each other directly.
  const dependencies = new Map<string, Set<string>>();

  for (const path of subjectPaths) {
    const source = byPath
      .get(path)
      ?.find(
        (item) =>
          item.reason === "changed_hunk" && item.representation === "full",
      )?.suppliedContent;
    if (source === undefined) {
      dependencies.set(path, new Set());
      continue;
    }

    const resolved = new Set<string>();
    for (const edge of extractFile(path, source).imports) {
      const target = resolveImport(path, edge.specifier, suppliedPaths);
      if (target === undefined) continue;
      resolved.add(target);
      // A changed file importing another changed file is one unit by
      // construction: the contract between them is what the review is about.
      if (subjectPaths.has(target)) grouping.union(path, target);
    }
    dependencies.set(path, resolved);
  }

  for (const [left, leftDeps] of dependencies) {
    for (const [right, rightDeps] of dependencies) {
      if (left >= right) continue;
      const shared = [...leftDeps].some((dependency) =>
        rightDeps.has(dependency),
      );
      if (shared) grouping.union(left, right);
    }
  }

  const clusters: RiskCluster[] = [];

  for (const [, members] of grouping.groups()) {
    const paths = [...members].sort();
    const memberSubjects = subject.filter((entry) =>
      paths.includes(entry.path),
    );

    // The neighbourhood, in both directions.
    //
    // Outgoing edges — what the changed files depend on — give the contracts
    // the change has to satisfy. Incoming edges give the callers the change can
    // break, and those are the *more* important half: the most valuable
    // cross-file finding is a caller the author never opened.
    //
    // Following only outgoing edges is a defect this file shipped with, and the
    // corpus caught it: the api_contract case supplied the caller, the planner
    // ranked it, and the cluster dropped it before any analyzer could look.
    const neighbourhood = new Set(paths);
    for (const path of paths) {
      for (const dependency of dependencies.get(path) ?? []) {
        neighbourhood.add(dependency);
      }
    }

    const changedNames = new Set(
      context
        .filter(
          (item) =>
            item.reason === "containing_symbol" && paths.includes(item.path),
        )
        .map((item) => item.symbol?.name)
        .filter((name): name is string => name !== undefined),
    );

    for (const item of context) {
      if (neighbourhood.has(item.path) || item.representation !== "full")
        continue;

      // A supplied file that imports one of the changed files is a consumer of
      // this cluster's surface, whatever the planner labelled it.
      const importsSubject = extractFile(
        item.path,
        item.suppliedContent,
      ).imports.some((edge) => {
        const target = resolveImport(item.path, edge.specifier, suppliedPaths);
        return target !== undefined && paths.includes(target);
      });

      // Or it was supplied *because of* this cluster: the planner attaches
      // callers and tests by reason, and those reasons exist precisely to say
      // "this is here for the change".
      const attachedForChange =
        (item.reason === "caller" ||
          item.reason === "associated_test" ||
          item.reason === "prior_finding") &&
        (changedNames.size === 0 ||
          [...changedNames].some((name) =>
            item.suppliedContent.includes(name),
          ));

      if (importsSubject || attachedForChange) neighbourhood.add(item.path);
    }

    // Instructions belong to every cluster: they change what counts as a
    // defect, so a cluster reviewed without them answers a different question.
    //
    // A governing configuration belongs to the clusters it governs, for the
    // same reason and by a narrower rule. `exactOptionalPropertyTypes` decides
    // whether a line is a defect at all, so a cluster reviewed without it
    // answers a different question too — but a tsconfig is not in the
    // neighbourhood of the source it governs, so path adjacency drops it.
    //
    // Scoped by the citation rather than given to every cluster: the planner
    // records which source each configuration governs, and a config governing
    // a file this cluster does not contain says nothing about this cluster.
    // Broadcasting all of them would be the generic context enrichment P1-M
    // forbids.
    const governsThisCluster = (item: AssembledItem): boolean => {
      if (item.kind !== "configuration") return false;
      const provenance = item.provenance;
      if (provenance?.source !== "configuration_facts") return false;
      return paths.some((path) =>
        provenance.citation.includes(`governs ${path}`),
      );
    };

    const items = context.filter(
      (item) =>
        neighbourhood.has(item.path) ||
        item.kind === "instruction" ||
        governsThisCluster(item),
    );

    const changedSymbols = items
      .filter(
        (item) =>
          item.reason === "containing_symbol" && paths.includes(item.path),
      )
      .map((item) => item.symbol?.qualifiedName ?? item.path)
      .sort();

    clusters.push({
      // Content-derived, so the same semantic unit keeps its id when unrelated
      // parts of the pull request change. That is what incremental reuse keys
      // on — see the architecture note, §8.
      id: `cluster:${paths.join("|")}`,
      subject: memberSubjects,
      changedSymbols,
      context: items,
      mandatory: items.filter((item) => MANDATORY_REASONS.has(item.reason)),
    });
  }

  return clusters.sort((left, right) => (left.id < right.id ? -1 : 1));
}
