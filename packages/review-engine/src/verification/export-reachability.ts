/**
 * P1-M.3.4 — can a consumer still reach the name, through the boundary it used?
 *
 * # The boundary is the point
 *
 * Epoch 2 gave this a concrete warning. The superseded verifier treated a
 * symbol as reachable because *some* module still exported it, even where the
 * package's declared entry point had stopped exposing it:
 *
 * ```
 * internal module can still reach X   !=   a consumer can still reach X
 * ```
 *
 * Consumers import entry points. A name reachable only through an internal
 * path is, to them, gone. So the synthetic probe always enters through the
 * boundary the base consumer used, never through whichever file happens to
 * contain the declaration.
 *
 * # The proof is M.3's, unchanged
 *
 * ```
 * synthesize a consumer importing X from boundary B
 *         ↓
 * compile against BASE     ← MANDATORY: a probe invalid everywhere proves nothing
 *         ↓
 * compile the same consumer against HEAD
 *         ↓
 * HEAD accepts  -> rejected      HEAD loses X -> verified
 * ```
 *
 * Recognised diagnostics extend the three M.3.1 established empirically with a
 * fourth it never needed — see EXPORT_REACHABILITY_CODES below.
 */

import ts from "typescript";
import { declaredBoundaries } from "../correctness/boundary-surface.js";
import {
  adjudicateComparison,
  specifierFor,
  type ComparisonVerdict,
} from "./compatibility-probe.js";
/**
 * The diagnostics a lost export produces, established empirically.
 *
 * ```
 * 2459  declares `X` locally, but it is not exported
 * 2460  declares `X` locally, but it is exported as `Y`
 * 2305  module has no exported member `X`
 * 2724  module has no exported member named `X` — did you mean `Y`?
 * ```
 *
 * `2724` is the one M.3.1 never needed. It is the suggestion variant TypeScript
 * emits when a similarly named export exists, which is exactly what a name
 * dropped from an export list beside its siblings produces — and M.3.1 could
 * not detect that shape at all, so its premise never encountered the code.
 * Observed by compiling the case, not guessed.
 *
 * `2307` and `2693` remain excluded. An absent module is indistinguishable
 * from an incomplete snapshot, and a value-shaped probe against a type-only
 * export reports a fact about the probe rather than about the change.
 */
export const EXPORT_REACHABILITY_CODES: ReadonlySet<number> = new Set([
  2459, 2460, 2305, 2724,
]);

export interface ExportReachabilityQuery {
  /** The changed module that declared the name at base. */
  readonly declarationPath: string;
  readonly exportName: string;
  readonly namespace: "value" | "type";
  /**
   * The consumer-visible boundary the claim is about, when the candidate
   * knows it.
   *
   * M.3.5 proposes from boundary surfaces, so its candidates carry the
   * boundary they lost. Re-deriving one from a declaration path would find
   * whichever entry sits nearest above it — for a package exposing both `.`
   * and `./codec`, that is the wrong one — and the verifier would then
   * faithfully adjudicate a boundary nobody claimed anything about.
   *
   * Adjudication is unchanged either way: probe base, probe head, compare.
   * Only which boundary is probed comes from the candidate now.
   */
  readonly boundaryIdentity?: string | undefined;
}

/** The entry a named boundary resolves to, when the revision declares it. */
export function entryForBoundary(
  files: ReadonlyMap<string, string>,
  identity: string,
): string | undefined {
  for (const boundary of declaredBoundaries(files)) {
    if (boundary.identity === identity) return boundary.entry;
  }
  return undefined;
}

/**
 * The nearest declared package entry point above a path, if any.
 *
 * Reads `exports`, then `main`, then `types` — the order a consumer's resolver
 * would. Returns nothing when no package declares an entry that exists in the
 * snapshot, in which case the module itself is the boundary: that is what a
 * relative import inside one project actually targets.
 */
export function resolvePublicBoundary(
  files: ReadonlyMap<string, string>,
  declarationPath: string,
): string {
  const segments = declarationPath.split("/");

  // Down to and INCLUDING the repository root. Stopping at depth 1 never
  // checks a root-level `package.json`, which is where a single-package
  // repository declares its entry point — so the boundary silently collapsed
  // to the declaring module, which is the behaviour this capability exists to
  // stop relying on.
  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
    const directory = segments.slice(0, depth).join("/");
    const manifestPath =
      directory === "" ? "package.json" : `${directory}/package.json`;
    const manifest = files.get(manifestPath);
    if (manifest === undefined) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest);
    } catch {
      // A manifest we cannot read declares nothing. Falling back to the module
      // is safer than guessing an entry point that may not exist.
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;

    const record = parsed as Record<string, unknown>;
    const candidates: string[] = [];
    const exportsField = record["exports"];
    if (typeof exportsField === "string") candidates.push(exportsField);
    else if (exportsField !== null && typeof exportsField === "object") {
      const dot = (exportsField as Record<string, unknown>)["."];
      if (typeof dot === "string") candidates.push(dot);
      else if (dot !== null && typeof dot === "object") {
        for (const value of Object.values(dot as Record<string, unknown>)) {
          if (typeof value === "string") candidates.push(value);
        }
      }
    }
    for (const key of ["main", "types"]) {
      const value = record[key];
      if (typeof value === "string") candidates.push(value);
    }

    for (const candidate of candidates) {
      const relative = candidate.replace(/^\.\//, "");
      for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
        const joined =
          directory === ""
            ? `${relative}${suffix}`
            : `${directory}/${relative}${suffix}`;
        const resolved = joined.replace(/\.js$/, ".ts");
        if (files.has(resolved)) return resolved;
      }
    }
  }

  return declarationPath;
}

function probeSourceFor(
  query: ExportReachabilityQuery,
  boundaryPath: string,
): string {
  const specifier = specifierFor(boundaryPath);
  if (query.namespace === "type") {
    return [
      `import type { ${query.exportName} } from "${specifier}";`,
      `type __AcalysProbe = ${query.exportName};`,
      "export type { __AcalysProbe };",
      "",
    ].join("\n");
  }
  return [
    `import { ${query.exportName} } from "${specifier}";`,
    `void ${query.exportName};`,
    "",
  ].join("\n");
}

export function verifyExportReachability(
  query: ExportReachabilityQuery,
  revisions: {
    readonly baseFiles: ReadonlyMap<string, string>;
    readonly headFiles: ReadonlyMap<string, string>;
  },
): ComparisonVerdict {
  // Resolved from BASE, because the boundary under test is the one the
  // consumer used. A head revision that moved its own entry point has not
  // thereby changed which import a published consumer already wrote.
  const named =
    query.boundaryIdentity === undefined
      ? undefined
      : entryForBoundary(revisions.baseFiles, query.boundaryIdentity);

  // A boundary the head revision no longer declares cannot be probed.
  //
  // The probe imports through a RELATIVE file specifier, so package-exports
  // resolution plays no part in it. That is adequate for a name leaving a
  // module, and structurally inadequate for a manifest withdrawing a subpath:
  // the file is untouched and still exports the name, so the probe compiles
  // and the verifier would report "still reachable" about a boundary that no
  // longer exists.
  //
  // Rather than emit that refutation, this says what is true — the evidence
  // needed is a consumer-style resolution this procedure does not perform.
  // Proving a manifest withdrawal is separate work with its own contract; a
  // wrong verdict now would be worse than no verdict, and would teach the
  // funnel that boundary withdrawals are safe.
  if (
    query.boundaryIdentity !== undefined &&
    entryForBoundary(revisions.headFiles, query.boundaryIdentity) === undefined
  ) {
    return {
      kind: "inconclusive",
      detail:
        `\`${query.boundaryIdentity}\` is no longer declared at head, so no consumer probe can be ` +
        "constructed through it; a relative-path probe would bypass the manifest and prove nothing",
    };
  }

  const boundaryPath =
    named ?? resolvePublicBoundary(revisions.baseFiles, query.declarationPath);

  return adjudicateComparison({
    baseFiles: revisions.baseFiles,
    headFiles: revisions.headFiles,
    boundaryPath,
    probeSource: probeSourceFor(query, boundaryPath),
    recognisedCodes: EXPORT_REACHABILITY_CODES,
    describe: (diagnostic) =>
      `TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  });
}
