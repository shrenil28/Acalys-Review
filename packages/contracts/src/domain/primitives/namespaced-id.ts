/**
 * Extensible identifiers for values the platform does not own (P0.txt §79, §80).
 *
 * Closed TypeScript unions are right for platform invariants — `ReviewRunState`
 * and `FindingSeverity` mean something specific and adding a member is a
 * deliberate breaking change. They are wrong for anything a third party can
 * introduce: tools, custom checks, and knowledge sources are open sets, and
 * modelling them as unions would mean shipping a release to support one new
 * analyzer.
 *
 * A namespaced string is the middle ground: still validated, still stable, but
 * extensible without a schema change. The namespace prefix says who owns the
 * identifier and prevents collisions between vendors:
 *
 *     tool.semgrep                       a well-known tool
 *     acalys.compiler.typescript         first-party, Acalys-owned
 *     github.check.codeql                provider-scoped
 *     org.acme.check.no-direct-sql       tenant-defined
 *
 * Grammar — lowercase alphanumeric segments joined by `.` or `-`:
 *
 *     id      := segment (separator segment)*
 *     segment := [a-z0-9]+
 *     separator := "." | "-"
 *
 * Lowercase-only is a deliberate constraint, not an aesthetic one: it makes
 * equality a plain `===` with no case-folding, so the same identifier hashes
 * identically everywhere (§58) and cannot appear twice in a config under two
 * spellings.
 */

import { z } from "zod";
import { unsafeBrand, type Brand } from "./brand.js";
import { ValidationError } from "../errors/errors.js";
import { quoteValue, truncateForDetails } from "./format.js";

/** A validated, namespaced, extensible identifier. */
export type NamespacedId = Brand<string, "NamespacedId">;

export const MAX_NAMESPACED_ID_LENGTH = 128;

const NAMESPACED_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function isNamespacedId(value: unknown): value is NamespacedId {
  return (
    typeof value === "string" &&
    value.length <= MAX_NAMESPACED_ID_LENGTH &&
    NAMESPACED_ID_PATTERN.test(value)
  );
}

/**
 * @throws {ValidationError} when the value breaks the grammar or length bound
 */
export function namespacedId(value: string): NamespacedId {
  if (value.length === 0) {
    throw new ValidationError("Namespaced identifier is empty");
  }
  if (value.length > MAX_NAMESPACED_ID_LENGTH) {
    throw new ValidationError(
      `Namespaced identifier exceeds ${String(MAX_NAMESPACED_ID_LENGTH)} characters`,
      { details: { value: truncateForDetails(value) } },
    );
  }
  if (!NAMESPACED_ID_PATTERN.test(value)) {
    throw new ValidationError(
      `Namespaced identifier ${quoteValue(value)} must be lowercase alphanumeric segments joined by '.' or '-' (e.g. tool.semgrep)`,
      { details: { value } },
    );
  }
  return unsafeBrand<NamespacedId>(value);
}

/**
 * The leading segment — `"org"` in `org.acme.check.no-direct-sql`.
 *
 * Lets policy decide by ownership: first-party `acalys.*` checks may be
 * trusted differently from tenant-authored `org.*` ones.
 */
export function namespaceOf(value: NamespacedId): string {
  const index = value.indexOf(".");
  return index === -1 ? value : value.slice(0, index);
}

export const namespacedIdSchema = z
  .string()
  .max(MAX_NAMESPACED_ID_LENGTH)
  .regex(NAMESPACED_ID_PATTERN, {
    error:
      "Expected lowercase alphanumeric segments joined by '.' or '-', e.g. tool.semgrep",
  })
  .transform((value) => unsafeBrand<NamespacedId>(value));
