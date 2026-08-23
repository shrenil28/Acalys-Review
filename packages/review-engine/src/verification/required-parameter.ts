/**
 * P1-M.3.2 — does a call shape accepted at BASE still compile at HEAD?
 *
 * The rule this capability does NOT use:
 *
 * ```
 * head parameter count > base parameter count  ->  breaking change
 * ```
 *
 * Every one of these increases the count and none of them breaks a caller:
 *
 * ```ts
 * f(a) -> f(a, b?)                      optional
 * f(a) -> f(a, b = value)               defaulted
 * f(a) -> f(a, ...rest)                 rest
 * f(a) -> overload added, old retained  still callable the old way
 * ```
 *
 * A count comparison is this family's version of M.2's `UndefinedKeyword`
 * mistake: a syntactic proxy that looks like the semantics, is cheap to
 * implement, and is wrong. The analyzer is allowed to use such a proxy because
 * something independent can contradict it. The verifier is that something, and
 * it settles the question by making the old call and asking the compiler.
 *
 * # The probe is about arity, not about values
 *
 * Arguments are `undefined as never`, which is assignable to every parameter
 * type. Constructing plausible values for the base signature would make the
 * probe's own type-correctness part of what is being tested, so a change to a
 * parameter's *type* would surface as an arity break. `never` removes the
 * argument types from the question and leaves only the count.
 *
 * # The recognised code
 *
 * ```
 * 2554  Expected N arguments, but got M
 * ```
 *
 * Only that one. A probe that fails for any other reason has not demonstrated
 * an arity break, and reading "HEAD produced some error" as a break is exactly
 * the diagnostic-counting the contract forbids.
 */

import {
  adjudicateComparison,
  specifierFor,
  type ComparisonVerdict,
} from "./compatibility-probe.js";
import ts from "typescript";

export const REQUIRED_PARAMETER_CODES: ReadonlySet<number> = new Set([2554]);

export interface RequiredParameterQuery {
  /** The module a consumer imported the callable from at the base revision. */
  readonly boundaryPath: string;
  readonly exportName: string;
  /** How many arguments the base contract accepted. */
  readonly baseArity: number;
}

/**
 * A call with exactly the number of arguments BASE accepted.
 *
 * Built from the base contract rather than from HEAD, because the question is
 * whether the *old* usage survives. A probe derived from HEAD would compile
 * against HEAD by construction and could never report anything.
 */
export function probeSourceFor(query: RequiredParameterQuery): string {
  const specifier = specifierFor(query.boundaryPath);
  const args = Array.from(
    { length: query.baseArity },
    () => "undefined as never",
  ).join(", ");
  return [
    `import { ${query.exportName} } from "${specifier}";`,
    `void ${query.exportName}(${args});`,
    "",
  ].join("\n");
}

export function verifyRequiredParameterAdded(
  query: RequiredParameterQuery,
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
    recognisedCodes: REQUIRED_PARAMETER_CODES,
    describe: (diagnostic) =>
      `TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  });
}
