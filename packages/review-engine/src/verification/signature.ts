/**
 * Signature compatibility, decided by the compiler and bounded by what the
 * verifier can actually see.
 *
 * # The rule this capability exists to enforce
 *
 * > Prove the exact compatibility proposition for the exact symbol and the
 * > exact consumer scope; never turn *"I found no stale callers"* into
 * > *"none exist"* unless a closed world has been established.
 *
 * That second half is where signature analysis usually goes wrong.
 * `findReferences()` returning four results means four references were found in
 * what was searched — not that four consumers exist. For a callable exported
 * from a published package, the consumers that matter may be in repositories
 * this verifier will never see, and "all repo-local callers migrated" says
 * nothing about them.
 *
 * So the answer depends on **which claim** is being made:
 *
 * ```
 * "src/foo.ts still calls the old signature"
 *      one named call site → resolvable → verifiable or refutable
 *
 * "this change breaks existing callers"
 *      an unbounded population → not refutable without a closed world
 * ```
 *
 * Both mention the same declaration. Only the first is settleable here.
 *
 * # Compatibility comes from the compiler, not from arity
 *
 * The tempting implementation is `old params 2, new params 3, caller passes 2 →
 * broken`. TypeScript has optional parameters, defaults, rest parameters,
 * overloads, generics, unions, structural assignability and method variance,
 * and JavaScript's own argument handling is looser still. A home-grown
 * approximation of that is wrong in ways that look right on the three cases
 * anyone writes tests for.
 *
 * So the question asked is: *does the compiler accept this call against the
 * head program?* — read from semantic diagnostics at the call site. That
 * handles every case above by construction, including the ones nobody
 * remembered.
 *
 * # Independent from the analyzer, again
 *
 * The analyzer proposes signature candidates from `@acalys/code-intelligence`'s
 * symbol graph. This adjudicates them through the TypeScript checker and its
 * diagnostics. Neither calls the other, and there is deliberately no shared
 * `resolveAffectedCallers()` — that would be one derivation with two callers,
 * which P1-J.2 showed is worth nothing as corroboration.
 */

import ts from "typescript";

import { programOf } from "./binding.js";
import type {
  VerificationAttempt,
  VerificationContext,
  VerificationReason,
} from "./decide.js";
import type { VerificationInput } from "./input.js";

/**
 * The distinct propositions a "signature break" claim can make.
 *
 * Declared in full because they need different evidence, and routing them all
 * into one procedure is how a capability comes to answer a question it was not
 * asked — the failure competence gating was built to stop, one level down.
 *
 * Only `stale_call_site` is implemented. The rest are recognized and declined,
 * which is the honest state and makes each a named target.
 */
export const SIGNATURE_CLAIM_KINDS = [
  /** A specific named call site no longer satisfies the contract. */
  "stale_call_site",
  /** Consumers outside the enumerable world may break. Needs closed world. */
  "public_api_break",
  /** A consumer assumes the old return type. */
  "return_type_incompatibility",
  /** A callback no longer satisfies the interface it is passed to. */
  "callback_contract_break",
  /** A subclass no longer satisfies its base. */
  "override_incompatibility",
  /** A previously valid overload is no longer accepted. */
  "overload_break",
] as const;

export type SignatureClaimKind = (typeof SIGNATURE_CLAIM_KINDS)[number];

/**
 * How much of the consumer population the verifier actually covered.
 *
 * Carried rather than implied, so a reason that requires completeness cannot be
 * emitted from a search that was not complete.
 */
export interface ConsumerCoverage {
  readonly scope:
    /** The claim names one call site, and that site was resolved. */
    | "single_call_site"
    /** References enumerated within the verifier's context. Not complete. */
    | "repo_local_only"
    /**
     * Every consumer that can exist was enumerated.
     *
     * Currently unreachable, and stated rather than quietly absent: the
     * verifier's context is a **subset** of a repository by construction, so it
     * cannot establish this even for a non-exported callable. Reaching it needs
     * whole-repository reference enumeration plus an export-boundary check, and
     * that is a capability, not an assumption.
     */
    | "closed_world";
  readonly discoveredReferences: number;
  readonly unresolvedReferences: number;
}

export const SIGNATURE_CAPABILITY_ID = "signature_compatibility";

/**
 * Which signature claim this is, from the proposition rather than the code.
 *
 * A claim naming a specific file and call site is a `stale_call_site` claim; a
 * claim about "existing callers" or "consumers" is a population claim, whatever
 * declaration it points at.
 */
export function classifySignatureClaim(
  input: VerificationInput,
): SignatureClaimKind {
  const text = [input.claim.statement, ...input.claim.steps].join(" ");

  if (/\breturn type\b/i.test(text)) return "return_type_incompatibility";
  if (/\boverload\b/i.test(text)) return "overload_break";
  if (/\boverrid|\bsubclass\b|\bbase class\b/i.test(text))
    return "override_incompatibility";
  if (/\bcallback\b|\bsatisf(?:y|ies) interface\b/i.test(text))
    return "callback_contract_break";
  // A population claim: "existing callers", "consumers", "external".
  if (
    /\bexisting callers\b|\bconsumers\b|\bexternal\b|\bpublic api\b/i.test(text)
  )
    return "public_api_break";
  return "stale_call_site";
}

/**
 * Whether the compiler accepts the call at a location against the head program.
 *
 * `undefined` when there is no call there, or the program could not be built —
 * both are "cannot tell", never "compatible".
 */
function callSiteAccepted(
  context: VerificationContext,
  path: string,
  line: number,
): { accepted: boolean; detail: string } | undefined {
  const program = programOf(context);
  if (program === undefined) return undefined;

  const source = program.getSourceFile(path);
  if (source === undefined) return undefined;

  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (call !== undefined) return;
    if (ts.isCallExpression(node)) {
      const start =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      if (start <= line && line <= end) {
        call = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  if (call === undefined) return undefined;

  const from = call.getStart(source);
  const to = call.getEnd();

  // Only the diagnostics that mean "this call does not satisfy that signature".
  // The program has no standard library, so unrelated diagnostics are expected
  // and must not be read as incompatibility — a capability that treated any
  // error as a break would refute nothing and verify everything.
  const ARGUMENT_ERRORS = new Set([
    2554, // Expected N arguments, but got M.
    2555, // Expected at least N arguments, but got M.
    2345, // Argument of type X is not assignable to parameter of type Y.
    2559, // Type X has no properties in common with type Y.
  ]);

  const relevant = program
    .getSemanticDiagnostics(source)
    .filter(
      (diagnostic) =>
        ARGUMENT_ERRORS.has(diagnostic.code) &&
        diagnostic.start !== undefined &&
        diagnostic.start >= from &&
        diagnostic.start <= to,
    );

  return {
    accepted: relevant.length === 0,
    detail:
      relevant[0] === undefined
        ? "the compiler accepts this call against the changed declaration"
        : ts.flattenDiagnosticMessageText(relevant[0].messageText, " "),
  };
}

/**
 * Adjudicates a signature-compatibility claim.
 *
 * Returns `undefined` when this capability has no procedure for the claim, so
 * the caller reports it as a competence gap rather than as an evidence gap —
 * those send an operator to different places.
 */
export function verifySignatureCompatibility(
  input: VerificationInput,
  context: VerificationContext,
): { attempt: VerificationAttempt; coverage: ConsumerCoverage } | undefined {
  const kind = classifySignatureClaim(input);

  const decide = (
    reasons: readonly VerificationReason[],
    decision: "verified" | "rejected" | "inconclusive",
    confidence: number,
    coverage: ConsumerCoverage,
  ): { attempt: VerificationAttempt; coverage: ConsumerCoverage } => ({
    attempt: {
      status: "completed",
      decision,
      reasons,
      confidence,
      severity: input.proposedSeverity,
    },
    coverage,
  });

  if (kind !== "stale_call_site") {
    // ── The closed-world boundary ────────────────────────────────────────
    //
    // A claim about "existing callers" or external consumers is a claim about a
    // population. Refuting it needs proof that the population was enumerated,
    // and enumerating references inside a context subset is not that proof.
    //
    // This is the case where a plausible implementation gets it wrong quietly:
    // find four references, see four migrated calls, refute the claim, and
    // publish nothing about a genuinely breaking API change.
    return decide(["consumer_scope_unbounded"], "inconclusive", 0.2, {
      scope: "repo_local_only",
      discoveredReferences: 0,
      unresolvedReferences: 0,
    });
  }

  const outcome = callSiteAccepted(
    context,
    input.location.path,
    input.location.startLine,
  );

  if (outcome === undefined) {
    return decide(["context_incomplete"], "inconclusive", 0.2, {
      scope: "single_call_site",
      discoveredReferences: 0,
      unresolvedReferences: 1,
    });
  }

  const coverage: ConsumerCoverage = {
    // One named call site is the whole population this claim is about, so it
    // *can* be covered completely — which is exactly why this is the claim kind
    // implemented first.
    scope: "single_call_site",
    discoveredReferences: 1,
    unresolvedReferences: 0,
  };

  return outcome.accepted
    ? decide(["call_site_satisfies_contract"], "rejected", 0.85, coverage)
    : decide(["contract_violated_at_call_site"], "verified", 0.9, coverage);
}
