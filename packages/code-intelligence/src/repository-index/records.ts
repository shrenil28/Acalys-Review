/**
 * The facts. Only facts.
 *
 * Every record here answers "what exists, and how do we know". None of them
 * answers "is this a problem" — there is no `isBuggy`, no `riskScore`, no
 * `likelyAsyncBug`, and adding one would be a structural mistake rather than a
 * scope question:
 *
 * ```
 *          RepositoryIndex               NOT:  RepositoryIndex
 *            ↑         ↑                             ↓
 *            │         │                     BugDecisionEngine
 *       Analyzer   Verifier                        ↓   ↓
 *                                            Analyzer  Verifier
 * ```
 *
 * The analyzer and the verifier may both stand on the same factual substrate.
 * They must not both outsource the *contested judgement* to it — that is how
 * two independent opinions become one opinion consulted twice, which is the
 * failure P1-H and P1-J exist to prevent.
 *
 * # Provenance is part of the fact
 *
 * A record without provenance makes the index an opaque authority: downstream
 * evidence would read "the index says so", which cannot be argued with and
 * cannot be checked. Every declaration carries where it was read, by what, at
 * which revision — so a citation can be re-derived instead of believed.
 */

import type { SymbolKind } from "../symbols.js";
import type { RepositoryIndexIdentity } from "./identity.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * What role a file plays in the repository.
 *
 * Note that this is **not** production reachability. A file can be indexed,
 * classified `production`, and still be unreachable dead code — the
 * architecture census answers that question and this one does not.
 *
 * ```
 * indexed  ≠  production reachable
 * ```
 *
 * Keeping them separate is deliberate. An index that silently dropped
 * unreachable production-looking code would let the index and the reachability
 * gate hide each other's defects: the index would have no record to contradict
 * the census, and the census would have no record to explain.
 */
export const MODULE_ROLES = [
  "production",
  "test",
  "generated",
  "configuration",
  "scratch",
] as const;

export type ModuleRole = (typeof MODULE_ROLES)[number];

/**
 * Whether this module's facts are trustworthy, and if not, why not.
 *
 * The `parse_failed` and `unsupported_language` cases are why this exists. A
 * module that could not be read must not be indistinguishable from a module
 * with nothing in it — see {@link SymbolLookup}.
 */
export const MODULE_COVERAGE = [
  "indexed",
  "parse_failed",
  "unsupported_language",
  "excluded",
] as const;

export type ModuleCoverage = (typeof MODULE_COVERAGE)[number];

/**
 * How firmly a declaration was resolved.
 *
 * The vocabulary exists to stop one specific collapse:
 *
 * ```
 * "we could not resolve it"   →   "it does not exist"
 * ```
 *
 * Those are different claims and only the second is falsifiable by absence. A
 * verifier that treats the first as the second concludes "no such declaration"
 * from its own failure to look, which is the closed-world mistake P1-J spent a
 * checkpoint learning to name.
 *
 * # `ambiguous` is not declaration multiplicity
 *
 * TypeScript lets one logical symbol have several declarations, and that is
 * ordinary rather than uncertain:
 *
 * ```ts
 * interface Foo { a: string }
 * interface Foo { b: number }   // one symbol, two declarations
 * ```
 *
 * That is an `exact` symbol whose {@link SymbolRecord.declarationCount} is 2 —
 * the checker knows precisely which symbol it is. Reporting it as `ambiguous`
 * would say we could not tell *which* symbol, which is false, and would make
 * the word useless for the case that really is uncertain.
 *
 * `ambiguous` means the opposite: a *reference* that could denote more than one
 * symbol and cannot be narrowed to one. That is reference resolution, which is
 * L.2's subject. **At a declaration site it is currently unreachable**, and a
 * test asserts so rather than leaving the claim in prose. It is declared here
 * because L.2 will reach it, and a vocabulary invented at the moment it is
 * first needed tends to be shaped by that moment.
 */
export const RESOLUTIONS = [
  "exact",
  "ambiguous",
  "external",
  "unresolved",
] as const;

export type Resolution = (typeof RESOLUTIONS)[number];

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a fact came from, precisely enough to go and look.
 *
 * `extractorVersion` is repeated here rather than only living on the index
 * identity, because a record may outlive the index object it was read from —
 * once it is embedded in a context snapshot or a finding's evidence, the
 * identity is no longer alongside it.
 */
export interface FactProvenance {
  /** The mechanism that produced the fact. Closed, so it stays checkable. */
  readonly source: "typescript_checker" | "typescript_syntax";
  readonly path: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly extractorVersion: string;
  readonly revision: string;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface ModuleRecord {
  /** Index-local, canonical: the repository-relative path. */
  readonly moduleId: string;
  readonly path: string;
  readonly language: "typescript";
  readonly role: ModuleRole;
  readonly coverage: ModuleCoverage;
  /** SHA-256 of the file's bytes, so a record can be checked against source. */
  readonly contentDigest: string;
  /** Present only when `coverage` is not `indexed`. */
  readonly coverageDetail?: string | undefined;
}

/**
 * A named thing, identified within this index only.
 *
 * # Why identity is revision-scoped and not clever
 *
 * `symbolId` is derived from the revision, module, span, and kind. It is
 * deliberately **not** a cross-revision fingerprint. Renames, moves, splits,
 * and merges each break any fingerprint simple enough to compute here, and a
 * fingerprint that is wrong across revisions is worse than none: it silently
 * claims continuity that does not hold, and downstream code would carry a
 * finding from one declaration to a different one.
 *
 * Cross-revision continuity is a real problem with real semantics. It gets its
 * own checkpoint, with explicit continuity records, rather than being smuggled
 * in as a hash function.
 */
export interface SymbolRecord {
  readonly symbolId: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly moduleId: string;
  readonly exported: boolean;
  /**
   * How many declarations this one symbol has in the indexed set.
   *
   * Usually 1. Greater for merged interfaces, overload sets, and
   * declaration-merged namespaces. A separate fact from
   * {@link Resolution} on purpose: multiplicity is something the checker knows
   * exactly, and calling it uncertainty would blunt the word `ambiguous`
   * before L.2 needs it.
   */
  readonly declarationCount: number;
  /** Enclosing declaration's name, when there is one. */
  readonly container?: string | undefined;
}

export interface DeclarationRecord {
  readonly declarationId: string;
  readonly symbolId: string;
  readonly moduleId: string;
  readonly kind: SymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly resolution: Resolution;
  readonly provenance: FactProvenance;
}

// ---------------------------------------------------------------------------
// Query results
// ---------------------------------------------------------------------------

/**
 * The answer to "is there a symbol called X in module M".
 *
 * Three outcomes, not two. The third is the one that matters:
 *
 * ```
 * found         here it is
 * absent        M was indexed successfully, and has no such symbol
 * not_indexed   we do not know — M was never successfully read
 * ```
 *
 * Collapsing `not_indexed` into `absent` would turn an indexing failure into a
 * factual claim, and the caller would have no way to tell a real absence from
 * our own outage. Callers must switch on this; the type makes them.
 */
export type SymbolLookup =
  | { readonly kind: "found"; readonly symbol: SymbolRecord }
  | { readonly kind: "absent"; readonly moduleId: string }
  | {
      readonly kind: "not_indexed";
      readonly moduleId: string;
      readonly coverage: ModuleCoverage;
      readonly why: string;
    };

/**
 * Why the whole index is or is not usable.
 *
 * Modelled now rather than when it first fails in production, because the
 * shape of the failure decides what callers can say. A caller holding
 * `unavailable` can honestly report "not analyzed"; a caller holding an empty
 * index cannot tell that from "nothing to report" — the same false-reassurance
 * shape P1-K found rendering an outage as a clean scan.
 */
export type IndexAvailability =
  | { readonly kind: "built" }
  | { readonly kind: "unavailable"; readonly why: string }
  | { readonly kind: "unsupported"; readonly why: string }
  | { readonly kind: "invariant_failed"; readonly why: string };

/**
 * Coverage in aggregate, so a caller can judge how much to trust the whole.
 *
 * `partial` is a first-class state. An index over a repository where three
 * files failed to parse is useful and must say so, rather than presenting
 * itself as complete or refusing to exist.
 */
export interface IndexCoverage {
  readonly modulesTotal: number;
  readonly modulesIndexed: number;
  readonly modulesFailed: number;
  readonly modulesUnsupported: number;
  readonly modulesExcluded: number;
}

export interface RepositoryIndex {
  readonly identity: RepositoryIndexIdentity;
  readonly availability: IndexAvailability;
  readonly coverage: IndexCoverage;
  readonly modules: readonly ModuleRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly declarations: readonly DeclarationRecord[];
}
