/**
 * A verifier that re-derives the claim instead of agreeing with it.
 *
 * Deterministic on purpose, and first on purpose. A model-backed verifier
 * cannot be trusted until there is something to compare it against, and this is
 * that baseline: given the same facts and the same independently-planned
 * context it always reaches the same decision with the same reasons, so a
 * later disagreement with a model verifier is attributable to the model.
 *
 * # What "independent" means here, concretely
 *
 * It re-parses the claimed location **from its own context** and asks whether
 * the mechanism the claim describes is actually there. It does not read the
 * evidence and nod.
 *
 * ```
 * the mechanism is present, and the cited declaration confirms it
 *     → verified
 * the mechanism is absent, or something guards it
 *     → rejected, with the specific reason
 * the context could not establish either
 *     → inconclusive
 * ```
 *
 * # The degradation rule that is easy to get wrong
 *
 * Missing evidence degrades `verified → inconclusive`, **never → rejected**.
 * "We could not confirm it" and "we established it is false" are different
 * claims, and collapsing them means every gap in context is recorded as an
 * analyzer false positive — precision would improve as the planner got worse.
 */

import ts from "typescript";

import { resolveCallProduct } from "./binding.js";
import { verifyAsyncCallbackContract } from "./callback.js";
import { verifyConditionValue } from "./condition.js";
import { verifyExceptionFlow } from "./exception.js";
import { verifyExactOptionalWrite } from "./exact-optional.js";
import { verifyRemovedExport } from "./removed-export.js";
import { verifyRequiredParameterAdded } from "./required-parameter.js";
import { adjudicateCompatibility } from "./compatibility-route.js";
import { verifySignatureCompatibility } from "./signature.js";
import { assertReasonForCapability, assessCompetence } from "./competence.js";
import {
  assertReasonsSupport,
  type VerificationAttempt,
  type VerificationContext,
  type VerificationDecision,
  type VerificationReason,
  type Verifier,
} from "./decide.js";
import type { VerificationInput } from "./input.js";

export const DETERMINISTIC_VERIFIER_ID = "acalys.verifier.re-derivation";
export const DETERMINISTIC_VERIFIER_VERSION = "1.0.0";

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * What the verifier itself found at the claimed line.
 *
 * Three outcomes, and the middle one is the correction this type exists to
 * carry. The first version had a single `found: boolean`, which conflated:
 *
 * ```
 * nothing is there                          the planner did not supply it
 * something is there, in a shape I model    a real observation
 * something is there, in a shape I do not   my reach, not the claim's truth
 * ```
 *
 * All three arrived as `found: false`, and the caller turned that into
 * `rejected` with 0.8 confidence — so every claim the verifier could not parse
 * was recorded as the analyzer being wrong. The end-to-end corpus made it
 * visible immediately: five of ten true defects rejected, precision still 1.0,
 * and every dashboard blaming the analyzer for the verifier's narrowness.
 */
type SiteObservation =
  /** A modelled shape, observed. Only this can support a rejection. */
  | {
      readonly kind: "recognized";
      readonly callee: string | undefined;
      readonly guarded: boolean;
    }
  /**
   * A statement covers the line and contains a call this verifier does not
   * model — in a condition, an argument, a return position.
   *
   * `inconclusive`. The call might be exactly the mechanism claimed; this
   * verifier cannot follow it there. Rejecting would suppress every finding
   * from the next analyzer anyone writes, before that analyzer had a chance to
   * be wrong.
   */
  | { readonly kind: "unmodelled_call" }
  /**
   * A statement covers the line, contains no call, and is not one of the shapes
   * this verifier knows it cannot analyze.
   *
   * `rejected`, and this is the one place the verifier may say
   * `claimed_mechanism_not_present`. Every mechanism it models is call-based,
   * so a line holding ordinary code with no call anywhere in it positively
   * lacks the mechanism — that is an observation, not an absence of one.
   */
  | { readonly kind: "no_call" }
  /**
   * A shape this verifier explicitly knows it does not model — today, a `catch`
   * clause.
   *
   * `inconclusive`. The swallowed-error family is not call-based, so "no call
   * here" refutes nothing about it: the mechanism *is* the empty handler. A
   * verifier that applied its call-based reasoning here would reject a real
   * defect and report it as an analyzer false positive.
   *
   * This is an **abstain list, and it should shrink.** Every entry is a shape
   * the verifier ought to learn to analyze; until it does, saying so is the
   * honest answer, and the funnel baseline is what measures the cost of each
   * remaining entry in lost recall.
   */
  | { readonly kind: "unmodelled_shape" }
  /**
   * Nothing at the claimed location, or the file was never supplied.
   *
   * Also `inconclusive`, and for the sharper reason: this is the *planner*
   * failing, and the P1-H rule is that missing evidence may degrade
   * `verified → inconclusive` and must never reach `rejected`. Otherwise a
   * worse planner produces better precision, and the metric rewards breaking
   * the system.
   */
  | { readonly kind: "absent" };

function observeSite(
  context: VerificationContext,
  path: string,
  line: number,
): SiteObservation {
  const item = context.items.find((entry) => entry.path === path);
  if (item === undefined) {
    return { kind: "absent" };
  }

  const source = parse(path, item.content);
  let result: SiteObservation = { kind: "absent" };
  // Set as soon as any statement covers the claimed line, whether or not this
  // verifier models its shape. It is what separates "the planner gave me
  // nothing" from "I was given code I cannot read".
  let covered = false;
  // Whether any call expression appears on the claimed line at all. The line
  // between refuting and abstaining: no call means the modelled mechanism is
  // positively absent; a call this verifier cannot follow means it cannot say.
  let sawCall = false;
  // A shape on the abstain list. Tracked separately from `sawCall` because the
  // reason to abstain is different: not "a call I cannot follow" but "a
  // mechanism family I do not implement".
  let sawUnmodelledShape = false;

  const visit = (node: ts.Node): void => {
    if (result.kind === "recognized") return;
    const start =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

    if (ts.isStatement(node) && start <= line && line <= end) {
      covered = true;
    }

    if (ts.isCallExpression(node) && start <= line && line <= end) {
      sawCall = true;
    }

    // The swallowed-error family. Its mechanism is the handler, not a call, so
    // this verifier's call-based reasoning says nothing about it either way.
    if (
      (ts.isCatchClause(node) || ts.isTryStatement(node)) &&
      start <= line &&
      line <= end
    ) {
      sawUnmodelledShape = true;
    }

    if (ts.isExpressionStatement(node) && start <= line && line <= end) {
      const expression = node.expression;

      // The guards a reader would call deliberate, observed independently
      // rather than taken from the claim.
      if (ts.isVoidExpression(expression) || ts.isAwaitExpression(expression)) {
        result = { kind: "recognized", callee: undefined, guarded: true };
        return;
      }

      if (ts.isCallExpression(expression)) {
        const methods: string[] = [];
        let current: ts.Expression = expression;
        while (
          ts.isCallExpression(current) &&
          ts.isPropertyAccessExpression(current.expression) &&
          ts.isIdentifier(current.expression.name) &&
          ts.isCallExpression(current.expression.expression)
        ) {
          methods.push(current.expression.name.text);
          current = current.expression.expression;
        }

        const root = ts.isCallExpression(current) ? current : undefined;
        let callee: string | undefined;
        if (root !== undefined) {
          if (ts.isIdentifier(root.expression)) {
            callee = root.expression.text;
          } else if (
            ts.isPropertyAccessExpression(root.expression) &&
            ts.isIdentifier(root.expression.name)
          ) {
            callee = root.expression.name.text;
          }
        }

        result = {
          kind: "recognized",
          callee,
          guarded: methods.includes("catch") || methods.includes("finally"),
        };
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  if (result.kind === "absent" && covered) {
    if (sawUnmodelledShape) return { kind: "unmodelled_shape" };
    return sawCall ? { kind: "unmodelled_call" } : { kind: "no_call" };
  }
  return result;
}

/**
 * Re-derives the claim from independently planned context.
 *
 * Never rejects a claim it does not understand: an unrecognized shape is
 * `inconclusive`. A verifier that rejected what it could not parse would
 * suppress every finding from the next analyzer anyone writes.
 */
/**
 * The export name and namespace, read back out of the claim.
 *
 * The claim is the interface between the two stages. Passing a structured
 * payload from analyzer to verifier would be the convenient design and the
 * wrong one: it would let the analyzer hand over conclusions the claim does
 * not state, and the verifier would be adjudicating something a reader of the
 * finding never saw.
 */
function parseRemovedExportClaim(
  statement: string,
):
  | { readonly exportName: string; readonly namespace: "value" | "type" }
  | undefined {
  const match =
    /^`([^`]+)` was exported from .* and no longer appears in its exported (value|type) surface\.$/.exec(
      statement,
    );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return {
    exportName: match[1],
    namespace: match[2] === "type" ? "type" : "value",
  };
}

function parseRequiredParameterClaim(
  statement: string,
): { readonly exportName: string; readonly baseArity: number } | undefined {
  const match =
    /^`([^`]+)` accepted (\d+) required argument\(s\) at the base revision/.exec(
      statement,
    );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { exportName: match[1], baseArity: Number(match[2]) };
}

export function verifyDeterministically(
  input: VerificationInput,
  context: VerificationContext,
): VerificationAttempt {
  const decide = (
    decision: VerificationDecision,
    reasons: readonly VerificationReason[],
    confidence: number,
  ): VerificationAttempt => {
    // Checked on the way out, so a confirming reason can never appear under a
    // rejection however the branches below are edited later.
    assertReasonsSupport(decision, reasons);
    // And that the reason belongs to the procedure that produced it. Every
    // branch past the competence gate belongs to `async_value_use`, so a reason
    // from another family arriving here means a future edit routed a claim to a
    // procedure that cannot settle it — the P1-J.2 defect, returning.
    assertReasonForCapability("async_value_use", reasons);
    return {
      status: "completed",
      decision,
      reasons,
      confidence,
      severity: input.proposedSeverity,
    };
  };

  // ── The competence boundary ───────────────────────────────────────────
  //
  // Before asking whether the claim is true, ask whether there is a procedure
  // that can settle this kind of claim. Everything below adjudicates
  // asynchronous value use and nothing else; letting an unrelated proposition
  // reach it is how `await charge(100)` came to refute a claim about payment
  // idempotency.
  //
  // Note this runs before the context checks: a claim no procedure can settle
  // is unsettleable whether or not the planner supplied the file, and reporting
  // it as a context gap would send someone to fix a planner that is working.
  const competence = assessCompetence(input);

  if (
    competence.kind === "supported" &&
    competence.capability === "async_callback_contract"
  ) {
    const attempt = verifyAsyncCallbackContract(input, context);
    if (attempt.status === "completed") {
      assertReasonsSupport(attempt.decision, attempt.reasons);
      assertReasonForCapability("async_callback_contract", attempt.reasons);
    }
    return attempt;
  }

  if (
    competence.kind === "supported" &&
    competence.capability === "exception_flow"
  ) {
    const attempt = verifyExceptionFlow(input, context);
    if (attempt.status === "completed") {
      assertReasonsSupport(attempt.decision, attempt.reasons);
      assertReasonForCapability("exception_flow", attempt.reasons);
    }
    return attempt;
  }

  if (
    competence.kind === "supported" &&
    competence.capability === "condition_value_semantics"
  ) {
    const attempt = verifyConditionValue(input, context);
    if (attempt.status === "completed") {
      assertReasonsSupport(attempt.decision, attempt.reasons);
      assertReasonForCapability("condition_value_semantics", attempt.reasons);
    }
    return attempt;
  }

  if (
    competence.kind === "supported" &&
    competence.capability === "exact_optional_property_write"
  ) {
    // P1-M.2. Its own procedure, not a branch of another: the evidence is a
    // compiler diagnostic obtained from a rebuilt project, which shares no
    // machinery with the syntactic observers above.
    const outcome = verifyExactOptionalWrite(
      {
        path: input.location.path,
        startLine: input.location.startLine,
        endLine: input.location.endLine,
        configPaths: context.items
          .map((item) => item.path)
          .filter((path) => /tsconfig[\w.-]*\.json$/.test(path)),
      },
      context,
    );

    const reasons: readonly VerificationReason[] =
      outcome.kind === "verified"
        ? ["governing_compiler_rejects_write"]
        : outcome.kind === "rejected"
          ? ["governing_compiler_permits_write"]
          : ["governing_project_unavailable"];

    const attempt: VerificationAttempt = {
      status: "completed",
      decision: outcome.kind,
      reasons,
      // The compiler settled it. Confidence reflects the strength of the
      // procedure, not enthusiasm for the conclusion.
      confidence: outcome.kind === "inconclusive" ? 0.2 : 0.95,
      severity: input.proposedSeverity,
    };

    assertReasonsSupport(attempt.decision, attempt.reasons);
    assertReasonForCapability("exact_optional_property_write", attempt.reasons);
    return attempt;
  }

  if (
    competence.kind === "supported" &&
    competence.capability === "removed_export"
  ) {
    const attempt = adjudicateCompatibility({
      input,
      context,
      capability: "removed_export",
      run: (revisions) => {
        const parsed = parseRemovedExportClaim(input.claim.statement);
        if (parsed === undefined) return undefined;
        return verifyRemovedExport(
          { boundaryPath: input.location.path, ...parsed },
          revisions,
        );
      },
      verifiedReason: "public_export_unreachable_at_head",
      rejectedReason: "public_export_still_reachable",
    });
    assertReasonsSupport(attempt.decision, attempt.reasons);
    assertReasonForCapability("removed_export", attempt.reasons);
    return attempt;
  }

  if (
    competence.kind === "supported" &&
    competence.capability === "required_parameter_added"
  ) {
    const attempt = adjudicateCompatibility({
      input,
      context,
      capability: "required_parameter_added",
      run: (revisions) => {
        const parsed = parseRequiredParameterClaim(input.claim.statement);
        if (parsed === undefined) return undefined;
        return verifyRequiredParameterAdded(
          { boundaryPath: input.location.path, ...parsed },
          revisions,
        );
      },
      verifiedReason: "base_valid_call_rejected_at_head",
      rejectedReason: "base_valid_call_still_accepted",
    });
    assertReasonsSupport(attempt.decision, attempt.reasons);
    assertReasonForCapability("required_parameter_added", attempt.reasons);
    return attempt;
  }

  if (
    competence.kind === "supported" &&
    competence.capability === "signature_compatibility"
  ) {
    // A separate procedure, not another branch of the async one. Each
    // capability owns its evidence, its reasons and its abstention rule; the
    // alternative is one growing `observeSite` switch whose blast radius
    // includes every mechanism every time one is added.
    const outcome = verifySignatureCompatibility(input, context);
    if (outcome !== undefined) {
      if (outcome.attempt.status === "completed") {
        assertReasonsSupport(outcome.attempt.decision, outcome.attempt.reasons);
        assertReasonForCapability(
          "signature_compatibility",
          outcome.attempt.reasons,
        );
      }
      return outcome.attempt;
    }
  }

  if (competence.kind === "unsupported") {
    return {
      status: "completed",
      decision: "inconclusive",
      reasons: ["no_applicable_procedure"],
      confidence: 0.1,
      severity: input.proposedSeverity,
    };
  }

  if (context.incomplete || context.items.length === 0) {
    // The planner could not supply something it wanted. Not the analyzer's
    // fault, and not evidence against the claim.
    return decide("inconclusive", ["context_incomplete"], 0.2);
  }

  const site = observeSite(
    context,
    input.location.path,
    input.location.startLine,
  );

  if (site.kind === "absent") {
    // The planner did not supply the claimed location. A planner gap, not a
    // refutation — and treating it as one would make precision improve as the
    // planner got worse.
    return decide("inconclusive", ["context_incomplete"], 0.2);
  }

  if (site.kind === "no_call") {
    // Positively observed: the line holds code, and it contains no call. Every
    // mechanism this verifier models is call-based, so the claimed mechanism is
    // absent — an observation, and the only shape that licenses this reason.
    return decide("rejected", ["claimed_mechanism_not_present"], 0.8);
  }

  if (site.kind === "unmodelled_shape") {
    // A mechanism family this verifier does not implement. Abstaining is the
    // honest answer; the alternative is refuting a claim it never examined.
    return decide("inconclusive", ["context_incomplete"], 0.2);
  }

  if (site.kind === "unmodelled_call") {
    // A call is there, in a position this verifier cannot follow — a condition,
    // an argument, a return. It may be exactly the mechanism claimed. Saying
    // `rejected` here is how a narrow verifier silently deletes a working
    // analyzer's findings while every precision number stays at 1.0.
    return decide("inconclusive", ["insufficient_evidence"], 0.25);
  }

  if (site.guarded) {
    // Affirmative: a `.catch()` or `.finally()` is present at the claimed site.
    // This the verifier genuinely observed, so it may refute.
    return decide("rejected", ["guarded_on_all_paths"], 0.85);
  }

  // ── Epistemic independence, at the one fact that decides the claim ─────
  //
  // The analyzer settles "is this call asynchronous?" by finding a declaration
  // with a matching NAME. So did this verifier, and the result was that both
  // confirmed a floating promise on a callee that is a synchronous parameter
  // shadowing an async import — the same mistake, made twice, reported as
  // corroboration.
  //
  // The checker is asked what the call expression's TYPE is. Scope, shadowing,
  // imports and aliases are resolved as a side effect of its ordinary work, and
  // no name is ever compared to a declaration. That is a genuinely different
  // derivation channel, which is the only kind of second opinion worth paying
  // for.
  const binding = resolveCallProduct(
    context,
    input.location.path,
    input.location.startLine,
  );

  if (binding.kind === "unresolved") {
    // Never guessed. "It is not asynchronous" and "I could not tell" are the
    // two facts this checkpoint exists to keep apart.
    return decide("inconclusive", ["insufficient_evidence"], 0.3);
  }

  const asyncInContext = binding.producesPromise;

  // The callee's NAME is used for one thing only, and never to settle the
  // claim: matching supplied evidence back to the call so a disagreement can be
  // reported as a disagreement. It is read after the binding, not before —
  // the earlier order let a callee this parser could not name short-circuit to
  // `insufficient_evidence` before the checker was ever consulted, so the whole
  // resolver was unreachable for exactly the callees it handles best. A
  // mutation that assumed such callees were synchronous survived the suite
  // because the code it mutated could not run.
  const callee = site.callee;
  const evidenceClaimsAsync =
    callee !== undefined &&
    input.evidence.some(
      (item) =>
        item.observation.includes(callee) &&
        /async|Promise/.test(item.observation),
    );

  if (!asyncInContext && evidenceClaimsAsync) {
    // Something is known, and it conflicts with the supplied support — the most
    // interesting signal a verifier produces, and it would be lost inside a
    // generic insufficiency.
    return decide("inconclusive", ["conflicting_independent_evidence"], 0.25);
  }

  if (!asyncInContext) {
    return decide("rejected", ["claim_contradicted_by_context"], 0.85);
  }

  const reasons: VerificationReason[] = ["independent_context_confirms"];
  if (evidenceClaimsAsync) reasons.push("evidence_supports_claim");
  return decide("verified", reasons, 0.9);
}

export const deterministicVerifier: Verifier = {
  id: DETERMINISTIC_VERIFIER_ID,
  version: DETERMINISTIC_VERIFIER_VERSION,
  verify: verifyDeterministically,
};
