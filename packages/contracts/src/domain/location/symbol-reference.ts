/**
 * The semantic program element a finding is about (P0.txt §22, §28).
 *
 * This is the load-bearing input for fingerprint stability. A finding anchored
 * to `auth.Session.verify` survives every edit that does not touch that
 * function: inserting imports above it, reformatting the file, moving it
 * within the file. A finding anchored to "line 82" survives none of them.
 *
 * **Designed to degrade gracefully.** Most analyzers cannot produce a fully
 * qualified symbol — a regex-based linter knows a path and a line and nothing
 * else. Requiring rich semantics would make the type unusable for exactly the
 * tools that produce the most findings. So only `name` and `kind` are
 * required, and `kind` has an explicit `unknown` member for the case where
 * even that is not available.
 *
 * Case is **never** normalized here. `getUser` and `GetUser` are different
 * symbols in every language the platform will review, and folding case would
 * merge two distinct findings into one (§58's determinism must not come at the
 * cost of correctness).
 */

import { z } from "zod";
import { TEXT_LIMITS } from "../primitives/limits.js";
import { lineRangeSchema, type LineRange } from "./line-range.js";

/**
 * What kind of program element the symbol is.
 *
 * A closed vocabulary rather than a namespaced open string, unlike tool and
 * check ids. The set of things a *fingerprint anchor* can be is bounded by
 * what general-purpose code analysis recognizes, and keeping it closed means
 * `kind` can participate in exhaustive matching. Language-specific concepts
 * (a Rust trait, a Go interface) map onto the nearest member rather than
 * expanding the set.
 *
 * `file` is included because a file is a legitimate anchor for findings that
 * are genuinely file-scoped — a missing license header, a misconfigured
 * manifest — and forcing those into `unknown` would lose real information.
 */
export const SYMBOL_KINDS = [
  "file",
  "module",
  "namespace",
  "class",
  "interface",
  "type",
  "enum",
  "function",
  "method",
  "constructor",
  "property",
  "field",
  "variable",
  "parameter",
  "unknown",
] as const;

export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export const symbolKindSchema = z.enum(SYMBOL_KINDS);

/**
 * A reference to a named program element.
 *
 * `qualifiedName` is what fingerprinting prefers when present: `verify` is
 * ambiguous across a codebase, `auth.Session.verify` is not. `name` alone is
 * the fallback, and `container` lets an analyzer supply partial qualification
 * without constructing a full path.
 *
 * `range` is present for display and navigation only. It is deliberately **not**
 * part of symbol identity — that is the entire point of anchoring to a symbol
 * rather than to lines (§28).
 */
export interface SymbolReference {
  /** Local name, e.g. `verify`. Case-sensitive. */
  readonly name: string;
  readonly kind: SymbolKind;
  /**
   * Fully-qualified name when the analyzer can produce one, e.g.
   * `auth.Session.verify`. Preferred for fingerprinting.
   */
  readonly qualifiedName?: string | undefined;
  /** Enclosing symbol's name, e.g. `Session` for a method. */
  readonly container?: string | undefined;
  /**
   * Where the symbol sits *right now*. Display and navigation only — never an
   * identity component, because it changes every time code moves.
   */
  readonly range?: LineRange | undefined;
}

export const symbolReferenceSchema = z.strictObject({
  name: z.string().min(1).max(TEXT_LIMITS.identifier),
  kind: symbolKindSchema,
  qualifiedName: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  container: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  range: lineRangeSchema.optional(),
});

/**
 * The most specific stable name available, for identity purposes.
 *
 * Preference order is qualified name, then container-qualified name, then bare
 * name — most-specific first, because a more specific name collides less. The
 * result never includes a line number.
 */
export function symbolIdentity(symbol: SymbolReference): string {
  if (symbol.qualifiedName !== undefined) return symbol.qualifiedName;
  if (symbol.container !== undefined)
    return `${symbol.container}.${symbol.name}`;
  return symbol.name;
}

/**
 * Whether two references denote the same program element.
 *
 * Compares identity and kind, never `range`: a symbol that moved down the file
 * is the same symbol, which is precisely the property fingerprints rely on.
 */
export function symbolsEqual(
  left: SymbolReference,
  right: SymbolReference,
): boolean {
  return (
    left.kind === right.kind && symbolIdentity(left) === symbolIdentity(right)
  );
}
