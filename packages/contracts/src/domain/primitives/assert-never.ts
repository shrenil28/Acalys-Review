/**
 * Compile-time exhaustiveness for discriminated unions (P0.txt §85).
 *
 * The platform's central types are unions that will gain variants: a fifth
 * `ReviewTarget` kind, a new `EvidenceSource`, another `ReviewRunState`. The
 * danger is not the variant itself — it is every `switch` that silently falls
 * through to a default and does the wrong thing without a single error.
 *
 * Ending a switch with `assertNever` makes the compiler prove the union is
 * fully handled. Add a variant, and every unhandled switch fails typecheck
 * immediately, with the offending file and line:
 *
 *     switch (target.kind) {
 *       case "pull_request": return handlePr(target);
 *       case "commit":       return handleCommit(target);
 *       case "commit_range": return handleRange(target);
 *       case "working_tree": return handleTree(target);
 *       default:             return assertNever(target);
 *     }
 *
 * The runtime throw is the second line of defence: unvalidated data from a
 * queue or database can carry a variant this build has never heard of, and
 * failing loudly beats proceeding on a wrong assumption.
 */

import { AcalysInternalError } from "../errors/errors.js";

/**
 * @param value - in correct code this is `never`; a type error here means a
 *   union variant is unhandled
 * @param context - optional label naming the switch, so a runtime failure
 *   points at the site rather than just the value
 * @throws {AcalysInternalError} always, if somehow reached at runtime
 */
export function assertNever(value: never, context?: string): never {
  const rendered =
    typeof value === "object" && value !== null
      ? // A `kind`/`type` discriminant is the useful part; the whole object may
        // be large or carry untrusted text we should not splice into a message.
        describeDiscriminant(value)
      : String(value);

  throw new AcalysInternalError(
    context === undefined
      ? `Unhandled union variant: ${rendered}`
      : `Unhandled union variant in ${context}: ${rendered}`,
    { details: { variant: rendered } },
  );
}

function describeDiscriminant(value: object): string {
  for (const key of ["kind", "type", "state", "status"]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string") {
      return `${key}=${candidate}`;
    }
  }
  return "<unknown variant>";
}
