/**
 * Which TypeScript projects exist in a revision, and how sure we are that
 * this is all of them.
 *
 * # One question, deliberately narrow
 *
 * This module answers "which config paths are there to evaluate", nothing
 * more. It does not read `include`/`exclude`/`files` — that needs
 * `ts.parseJsonConfigFileContent`, which needs every other config already
 * resolved, which is circular with "which configs are there". It does not
 * decide which project governs a source file. Both are downstream of this
 * one, and both would silently inherit any mistake made here, which is why
 * `coverage` exists at all: a caller concluding `not_governed` from "zero
 * admitting projects" must first be sure the *projects* were not the part
 * that went missing. See {@link ConfigGovernanceResult} in `config-model.ts`.
 *
 * # Two ways a project becomes known
 *
 * ```
 * by name        matches the tsconfig* convention TypeScript itself uses
 * by reference    named in another known project's `references`, whatever
 *                 its filename
 * ```
 *
 * Name matching alone misses a project referenced under a non-conventional
 * filename — `tsc -b` does not care what a referenced config is called, only
 * that something points at it, so this module follows the same graph a build
 * would. It does not follow `extends`: an extends target is not a project
 * (see `config-model.ts`'s `OptionInheritance` commentary), it is where a
 * project's *options* come from, and resolving that chain is Agent B's
 * concern once these paths are handed to it.
 *
 * # What makes discovery incomplete
 *
 * The one case this module can actually prove: a discovered project's own
 * `references` names a path that is not in the snapshot at all. That is a
 * project the repository itself attests to, which we cannot see — direct
 * evidence of a gap, not a guess about one.
 *
 * A project with a non-conventional name that nothing references is a
 * different failure mode: nothing in the snapshot points at it, so nothing
 * here can notice it is missing. That is a real limitation of name-plus-graph
 * discovery, and no signal in a flat path-to-content map can close it. It is
 * not reported as `incomplete`, because `incomplete` must mean "a specific,
 * demonstrable gap", not "an unfalsifiable possibility" — a status this
 * module can never leave would be as useless as one it always leaves.
 */

import ts from "typescript";
import { posix as posixPath } from "node:path";
import type { RevisionSnapshot } from "./build.js";

export interface ProjectDiscovery {
  /** Config paths that are known to exist, in canonical (codepoint) order. */
  readonly discovered: readonly string[];
  readonly coverage:
    | { readonly status: "complete" }
    | { readonly status: "incomplete"; readonly why: string };
}

/**
 * The filename convention TypeScript's own tooling recognizes as a project
 * entry point: `tsconfig.json`, `tsconfig.build.json`, `tsconfig.base.json`,
 * and so on. Deliberately narrow — a looser pattern (e.g. anything containing
 * "tsconfig") would claim project-ness for files nothing in the toolchain
 * would ever load that way. A narrower true answer beats a detailed invented
 * one; a project under an unconventional name is instead reached through
 * `references` (see the module doc comment).
 */
const TSCONFIG_SHAPED = /(^|\/)tsconfig(\.[\w.-]+)?\.json$/;

/**
 * Vendored and generated trees are never authored project configuration, even
 * when a `tsconfig.json` happens to live inside one (a published package's own
 * build config, copied into `node_modules` as-is). Mirrors `build.ts`'s
 * `EXCLUDED_PATH` — restated rather than imported because that constant is not
 * exported, and duplicating one regex is cheaper than widening that module's
 * surface for it.
 */
const EXCLUDED_PATH = /(^|\/)(node_modules|dist|build|\.git|coverage)\//;

/** Codepoint ordering — locale-independent, so it is the same everywhere. */
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

interface ReferenceEdge {
  readonly from: string;
  readonly rawPath: string;
  readonly resolvedTarget: string;
}

/**
 * A config's own `references`, resolved to snapshot-relative paths.
 *
 * Reads with `ts.readConfigFile` — the compiler's own JSON5-tolerant parser —
 * rather than `JSON.parse`, so a comment or trailing comma in the config does
 * not read as a parse failure that is really only ours. A config that fails
 * even that relaxed parse contributes no edges: we cannot establish what it
 * references, so we claim nothing about it. That is a fact for whoever
 * evaluates the config to report (`config_unparsable`, `config-model.ts`), not
 * a discovery gap — discovery already knows this path exists, which is the
 * only thing it is answering for.
 *
 * `extends` is not read here. It names where options come from, not another
 * project, and folding it in would make every base config look referenced.
 */
function ownReferences(
  configPath: string,
  snapshot: RevisionSnapshot,
): readonly ReferenceEdge[] {
  const read = ts.readConfigFile(configPath, (path) => snapshot.get(path));
  if (read.error !== undefined) return [];

  const references: unknown = (read.config as { references?: unknown })
    .references;
  if (!Array.isArray(references)) return [];

  const dir = posixPath.dirname(configPath);
  const edges: ReferenceEdge[] = [];
  for (const entry of references) {
    if (typeof entry !== "object" || entry === null) continue;
    const rawPath = (entry as { path?: unknown }).path;
    if (typeof rawPath !== "string") continue;

    // `resolveProjectReferencePath` is the compiler's own rule for turning a
    // reference into a config file name (appending `tsconfig.json` when the
    // reference names a directory, exactly as `tsc -b` would) — reused rather
    // than re-derived so this stays "TypeScript's own project parsing" and
    // not a home-grown rule that happens to agree with it today.
    const named = ts.resolveProjectReferencePath({ path: rawPath });
    const resolvedTarget = posixPath.normalize(posixPath.join(dir, named));
    edges.push({ from: configPath, rawPath, resolvedTarget });
  }
  return edges;
}

/**
 * Every TypeScript project this revision attests to, and whether that set is
 * demonstrably complete.
 *
 * A pure function of the snapshot: given the same map, the same answer,
 * regardless of the order its entries were inserted in. Nothing here relies
 * on `Map` iteration order carrying meaning — every list that leaves this
 * function is explicitly sorted.
 */
export function discoverProjects(snapshot: RevisionSnapshot): ProjectDiscovery {
  // Unsorted here on purpose: processing order only ever affects which
  // worklist item is visited first, never the final content of `discovered`
  // or `missing`, both of which are sorted where they are returned below. A
  // sort here would be redundant weight, not correctness.
  const named = [...snapshot.keys()].filter(
    (path) => TSCONFIG_SHAPED.test(path) && !EXCLUDED_PATH.test(path),
  );

  // Fixed-point walk of the reference graph, seeded from every
  // name-recognized project. A project reached only through `references`
  // under a non-conventional filename is added — and its own `references`
  // are then followed too — until nothing new turns up.
  const discovered = new Set(named);
  const worklist = [...named];
  const missing = new Set<string>();

  while (worklist.length > 0) {
    const current = worklist.pop();
    if (current === undefined) continue;

    for (const edge of ownReferences(current, snapshot)) {
      if (EXCLUDED_PATH.test(edge.resolvedTarget)) continue;

      if (!snapshot.has(edge.resolvedTarget)) {
        missing.add(
          `${edge.from} references "${edge.rawPath}" (resolved to ` +
            `${edge.resolvedTarget}), which is not present in the snapshot`,
        );
        continue;
      }

      if (!discovered.has(edge.resolvedTarget)) {
        discovered.add(edge.resolvedTarget);
        worklist.push(edge.resolvedTarget);
      }
    }
  }

  const discoveredList = [...discovered].sort(compare);

  if (missing.size > 0) {
    return {
      discovered: discoveredList,
      coverage: {
        status: "incomplete",
        why: [...missing].sort(compare).join("; "),
      },
    };
  }

  return { discovered: discoveredList, coverage: { status: "complete" } };
}
