/**
 * P1-M.3.1 — was a public export still reachable through the same boundary?
 *
 * The claim under test is about *reachability*, not about a declaration
 * continuing to exist. These are not breaking changes and the verifier must
 * refute all of them:
 *
 * ```ts
 * export { parse } from "./impl";   // moved, re-exported by name
 * export * from "./impl";           // moved, re-exported wholesale
 * function parse() {}               // internal rename behind a public alias
 * export { parse };
 * ```
 *
 * In each, a consumer importing `parse` from the original boundary still
 * compiles, so the contract survived. The verifier learns that by importing it
 * and seeing what the compiler says, which is why it can disagree with the
 * analyzer rather than merely elaborating on it.
 *
 * # The recognised codes, and the two that are deliberately missing
 *
 * ```
 * 2459  declares `X` locally, but it is not exported
 * 2460  declares `X` locally, but it is exported as `Y`
 * 2305  module has no exported member `X`
 * ```
 *
 * `2307` (cannot find module) is NOT recognised. A boundary missing from the
 * head snapshot is ambiguous between a deleted module and a snapshot that
 * omitted it, and `adjudicateComparison` refuses that ambiguity before any
 * compile happens rather than resolving it in favour of a finding.
 *
 * `2693` ("only refers to a type, but is being used as a value") is NOT
 * recognised either, and its absence is load-bearing. It is what a value-shaped
 * probe produces against a type-only export that is still perfectly reachable.
 * Recognising it would let the verifier manufacture a removal out of its own
 * choice of probe — which is why the probe is built in the symbol's own
 * namespace instead.
 */

import {
  adjudicateComparison,
  specifierFor,
  type ComparisonVerdict,
} from "./compatibility-probe.js";
import ts from "typescript";

export const REMOVED_EXPORT_CODES: ReadonlySet<number> = new Set([
  2459, 2460, 2305,
]);

/** Which space the export lived in. The probe must match it. */
export type ExportNamespace = "value" | "type";

export interface RemovedExportQuery {
  /** The module a consumer imported from at the base revision. */
  readonly boundaryPath: string;
  readonly exportName: string;
  readonly namespace: ExportNamespace;
}

/**
 * The smallest consumer that depends on the export being reachable.
 *
 * A type-only export gets a type-position probe. Pushing it through value
 * space would produce a diagnostic about our probe rather than about the
 * author's change, and reporting that as a removal would be a fabricated
 * finding — the failure mode the namespace field exists to prevent.
 */
export function probeSourceFor(query: RemovedExportQuery): string {
  const specifier = specifierFor(query.boundaryPath);
  if (query.namespace === "type") {
    return [
      `import type { ${query.exportName} } from "${specifier}";`,
      `type __AcalysProbe = ${query.exportName};`,
      `export type { __AcalysProbe };`,
      "",
    ].join("\n");
  }
  return [
    `import { ${query.exportName} } from "${specifier}";`,
    `void ${query.exportName};`,
    "",
  ].join("\n");
}

export function verifyRemovedExport(
  query: RemovedExportQuery,
  revisions: {
    readonly baseFiles: ReadonlyMap<string, string>;
    readonly headFiles: ReadonlyMap<string, string>;
  },
): ComparisonVerdict {
  return adjudicateComparison({
    baseFiles: revisions.baseFiles,
    headFiles: revisions.headFiles,
    boundaryPath: query.boundaryPath,
    probeSource: probeSourceFor(query),
    recognisedCodes: REMOVED_EXPORT_CODES,
    describe: (diagnostic) =>
      `TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  });
}
