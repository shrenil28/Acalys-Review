/**
 * The production commit barrier for an incrementally assembled revision.
 *
 * # Why this is not redundant with the equivalence oracle
 *
 * A read-only trace of the call graph established something that corrects an
 * earlier claim in this codebase:
 *
 * ```
 * TEST ONLY                      PRODUCTION
 * incremental(H1 -> H2)          incremental(H1 -> H2)
 *        vs                             |
 * full(H2)                       validateIndexConsistency
 * canonical equivalence                 |
 *                                  return H2
 * ```
 *
 * `canonicalSerialization` and `indexDigest` are called from no production
 * path. The full-rebuild oracle exists only in the test suite. So in
 * production this function is the *sole* barrier between a malformed candidate
 * and an index labelled H2, and "the equivalence tests would catch it first" —
 * which an earlier comment in `incremental.ts` offered as a reason not to test
 * these rules directly — is true of tests and false of production.
 *
 * The two mechanisms answer different questions and neither replaces the other:
 *
 * ```
 * the oracle     does incremental construction agree with the reference
 *                implementation?
 * this file      is this candidate internally coherent enough to be allowed
 *                to exist as an H2 index at all?
 * ```
 *
 * Consequently every rule below has a direct test with a fixture that is valid
 * in every respect except the one rule it violates. A fixture breaking three
 * rules would let mutations in two of the validators survive behind the third.
 *
 * # The resolution consistency matrix
 *
 * Derived from what the extractor can actually emit, not from what the type
 * permits:
 *
 * ```
 * exact        one symbolId, the symbol exists, at least one declaration,
 *              and every declaration belongs to that symbol
 * external     no symbolId, no declarations — bound, but outside this index
 * unresolved   no symbolId, no declarations — not bound at all
 * ambiguous    no symbolId
 * ```
 *
 * `ambiguous` deserves its line. The record type carries a single optional
 * `symbolId` and has no way to express candidates, so an `ambiguous` binding
 * naming one symbol would be uncertainty claiming a unique answer — the exact
 * blurring of multiplicity and uncertainty that L.1 had to correct once
 * already. Today nothing produces `ambiguous` anywhere in the index; the rule
 * exists so that if L.4 makes it reachable, it cannot arrive dishonest.
 */

import type { RepositoryIndex } from "./records.js";

/** Every way a candidate index can be internally incoherent. Closed. */
export const CONSISTENCY_RULES = [
  "declaration_symbol_missing",
  "declaration_revision_mismatch",
  "reference_revision_mismatch",
  "reference_without_binding",
  "binding_reference_missing",
  "binding_duplicate_for_reference",
  "binding_declaration_missing",
  "binding_symbol_missing",
  "binding_revision_mismatch",
  "exact_without_symbol",
  "exact_without_declarations",
  "declaration_not_owned_by_symbol",
  "external_with_symbol",
  "external_with_declarations",
  "unresolved_with_symbol",
  "unresolved_with_declarations",
  "ambiguous_with_symbol",
] as const;

export type ConsistencyRule = (typeof CONSISTENCY_RULES)[number];

export interface ConsistencyViolation {
  readonly rule: ConsistencyRule;
  /** Enough to find the offending record by hand. */
  readonly detail: string;
}

/**
 * Returns the first violation, or `undefined` when the candidate is coherent.
 *
 * First rather than all: this is a commit barrier, and one proven
 * inconsistency is already sufficient to refuse. Collecting every violation
 * would invite a caller to weigh them.
 */
export function validateIndexConsistency(
  index: RepositoryIndex,
): ConsistencyViolation | undefined {
  const revision = index.identity.revision.value;

  const symbolIds = new Set(index.symbols.map((record) => record.symbolId));
  const declarationIds = new Set(
    index.declarations.map((record) => record.declarationId),
  );
  const declarationOwner = new Map(
    index.declarations.map((record) => [record.declarationId, record.symbolId]),
  );
  const referenceIds = new Set(
    index.references.map((record) => record.referenceId),
  );

  for (const record of index.declarations) {
    if (!symbolIds.has(record.symbolId)) {
      return {
        rule: "declaration_symbol_missing",
        detail: `declaration ${record.declarationId} names symbol ${record.symbolId}, which is absent`,
      };
    }
    if (record.provenance.revision !== revision) {
      return {
        rule: "declaration_revision_mismatch",
        detail: `declaration ${record.declarationId} carries revision ${record.provenance.revision}, not ${revision}`,
      };
    }
  }

  for (const record of index.references) {
    if (record.provenance.revision !== revision) {
      return {
        rule: "reference_revision_mismatch",
        detail: `reference ${record.referenceId} carries revision ${record.provenance.revision}, not ${revision}`,
      };
    }
  }

  const bound = new Set<string>();
  for (const edge of index.bindings) {
    if (!referenceIds.has(edge.referenceId)) {
      return {
        rule: "binding_reference_missing",
        detail: `binding ${edge.bindingId} names reference ${edge.referenceId}, which is absent`,
      };
    }
    if (bound.has(edge.referenceId)) {
      return {
        rule: "binding_duplicate_for_reference",
        detail: `reference ${edge.referenceId} has more than one binding`,
      };
    }
    bound.add(edge.referenceId);

    for (const declarationId of edge.declarationIds) {
      if (!declarationIds.has(declarationId)) {
        return {
          rule: "binding_declaration_missing",
          detail: `binding ${edge.bindingId} points at declaration ${declarationId}, which is absent`,
        };
      }
    }

    if (edge.symbolId !== undefined && !symbolIds.has(edge.symbolId)) {
      return {
        rule: "binding_symbol_missing",
        detail: `binding ${edge.bindingId} names symbol ${edge.symbolId}, which is absent`,
      };
    }

    if (edge.provenance.revision !== revision) {
      return {
        rule: "binding_revision_mismatch",
        detail: `binding ${edge.bindingId} carries revision ${edge.provenance.revision}, not ${revision}`,
      };
    }

    // The resolution matrix.
    switch (edge.resolution) {
      case "exact": {
        if (edge.symbolId === undefined) {
          // The shape incremental assembly can actually produce: `symbolId` is
          // recomputed from the mapped declarations while the resolution rides
          // along from H1 untouched. Under a correct plan the mapping holds —
          // which is precisely why this is the barrier for when it does not.
          return {
            rule: "exact_without_symbol",
            detail: `binding ${edge.bindingId} resolved exactly but names no symbol`,
          };
        }
        if (edge.declarationIds.length === 0) {
          return {
            rule: "exact_without_declarations",
            detail: `binding ${edge.bindingId} resolved exactly but points at no declaration`,
          };
        }
        for (const declarationId of edge.declarationIds) {
          if (declarationOwner.get(declarationId) !== edge.symbolId) {
            return {
              rule: "declaration_not_owned_by_symbol",
              detail: `binding ${edge.bindingId} names symbol ${edge.symbolId} but declaration ${declarationId} belongs to ${declarationOwner.get(declarationId) ?? "nothing"}`,
            };
          }
        }
        break;
      }
      case "external": {
        if (edge.symbolId !== undefined) {
          return {
            rule: "external_with_symbol",
            detail: `binding ${edge.bindingId} is external yet names internal symbol ${edge.symbolId}`,
          };
        }
        if (edge.declarationIds.length > 0) {
          return {
            rule: "external_with_declarations",
            detail: `binding ${edge.bindingId} is external yet points at ${String(edge.declarationIds.length)} internal declaration(s)`,
          };
        }
        break;
      }
      case "unresolved": {
        if (edge.symbolId !== undefined) {
          return {
            rule: "unresolved_with_symbol",
            detail: `binding ${edge.bindingId} is unresolved yet names symbol ${edge.symbolId}`,
          };
        }
        if (edge.declarationIds.length > 0) {
          return {
            rule: "unresolved_with_declarations",
            detail: `binding ${edge.bindingId} is unresolved yet points at ${String(edge.declarationIds.length)} declaration(s)`,
          };
        }
        break;
      }
      case "ambiguous": {
        if (edge.symbolId !== undefined) {
          return {
            rule: "ambiguous_with_symbol",
            detail: `binding ${edge.bindingId} is ambiguous yet names exactly one symbol, ${edge.symbolId}`,
          };
        }
        break;
      }
    }
  }

  for (const record of index.references) {
    if (!bound.has(record.referenceId)) {
      return {
        rule: "reference_without_binding",
        detail: `reference ${record.referenceId} has no binding edge`,
      };
    }
  }

  return undefined;
}
