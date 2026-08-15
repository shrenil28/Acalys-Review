/**
 * Independent verification of a candidate finding (P0.txt §32).
 *
 * The architectural point: **a generator proposes, a verifier decides**, and
 * the two are different acts recorded separately. An agent producing a
 * candidate does not make it true; only evidence does. That separation is what
 * lets the platform run a cheap generator and an expensive verifier, swap
 * either independently, or verify one candidate several ways.
 *
 * Verification is never a boolean (§32). `verified: true` cannot express *why*,
 * cannot distinguish "reproduced by a failing test" from "the model thought
 * about it again", and cannot be aggregated, filtered, or measured for
 * precision. So a decision carries:
 *
 *     decision      the machine-readable verdict
 *     reasonCodes   why, in a closed vocabulary
 *     evidence      what it rests on
 *     confidence    how sure, given that evidence
 *     summary       prose for a human — supplementary, never parsed
 *
 * **No chain of thought is stored** (§32, §120). Only structured conclusions
 * and the evidence they rest on. A hidden reasoning trace is neither auditable
 * nor safe to surface, and persisting one is explicitly out of scope.
 */

import { z } from "zod";
import {
  evidenceReferenceListSchema,
  type EvidenceReference,
} from "../evidence/evidence.js";
import { findingConfidenceSchema, type FindingConfidence } from "./taxonomy.js";
import {
  AGENT_TYPES,
  modelReferenceSchema,
  type ModelReference,
} from "../actor/actor.js";
import { toolReferenceSchema, type ToolReference } from "../tools/tool.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { TEXT_LIMITS } from "../primitives/limits.js";

/**
 * The verdict (§32).
 *
 * Three values, and `inconclusive` is the important one: without it a verifier
 * that could not reach an answer must lie in one direction or the other.
 * Rejecting an unverifiable finding hides real bugs; accepting it publishes
 * noise. `inconclusive` lets policy decide — some tenants want to see
 * unverified findings, most do not.
 */
export const VERIFICATION_DECISIONS = [
  "verified",
  "rejected",
  "inconclusive",
] as const;

export type VerificationDecision = (typeof VERIFICATION_DECISIONS)[number];

export const verificationDecisionSchema = z.enum(VERIFICATION_DECISIONS);

/**
 * Why the verifier decided as it did (§32).
 *
 * Machine-readable and closed, because these drive analytics, reconciliation,
 * policy, and precision measurement. Free-form explanation cannot answer "what
 * fraction of rejections were false positives versus not-caused-by-this-change?"
 * — a question that directly tunes the generator.
 *
 * The first four confirm; the rest reject or fail to conclude, and each
 * captures a genuinely different situation:
 *
 * | Code | Meaning |
 * | --- | --- |
 * | `not_reachable` | the code path cannot execute |
 * | `already_guarded` | a check upstream already prevents it |
 * | `not_caused_by_change` | real, but pre-existing — not this PR's doing |
 * | `false_positive` | the claim is simply wrong |
 * | `duplicate` | another finding already covers it |
 * | `insufficient_evidence` | could not be established either way |
 */
export const VERIFICATION_REASON_CODES = [
  "confirmed_by_runtime",
  "confirmed_by_static_trace",
  "confirmed_by_test",
  "confirmed_by_contract",
  "not_reachable",
  "false_positive",
  "already_guarded",
  "not_caused_by_change",
  "insufficient_evidence",
  "duplicate",
] as const;

export type VerificationReasonCode = (typeof VERIFICATION_REASON_CODES)[number];

export const verificationReasonCodeSchema = z.enum(VERIFICATION_REASON_CODES);

/** Codes that can only accompany a `verified` decision. */
const CONFIRMING_CODES: ReadonlySet<VerificationReasonCode> = new Set([
  "confirmed_by_runtime",
  "confirmed_by_static_trace",
  "confirmed_by_test",
  "confirmed_by_contract",
]);

export function isConfirmingReason(code: VerificationReasonCode): boolean {
  return CONFIRMING_CODES.has(code);
}

/**
 * Who performed the verification.
 *
 * A union rather than a free-form string so "verified by the compiler" and
 * "verified by a model" are structurally distinguishable — they warrant very
 * different trust, and a consumer must be able to tell without parsing a name.
 *
 * Deliberately narrower than {@link EvidenceProvenance}: only an agent or a
 * tool can *decide*. Repository content and external documents are evidence a
 * verifier weighs, never verifiers themselves.
 */
export type VerifierReference =
  | {
      readonly kind: "agent";
      readonly agentType: (typeof AGENT_TYPES)[number];
      readonly agentRunId?: string | undefined;
      readonly model?: ModelReference | undefined;
    }
  | { readonly kind: "tool"; readonly tool: ToolReference };

export const verifierReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    agentType: z.enum(AGENT_TYPES),
    agentRunId: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
    model: modelReferenceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("tool"),
    tool: toolReferenceSchema,
  }),
]);

/**
 * The outcome of verifying one candidate.
 *
 * `reasonCodes` is a list, not a single value: a rejection is commonly both
 * `not_caused_by_change` and `already_guarded`, and forcing a choice discards
 * information that matters when tuning the generator.
 *
 * `summary` supplements the codes and never replaces them. No consumer parses
 * prose to learn the outcome (§32).
 */
export interface VerificationResult {
  readonly decision: VerificationDecision;
  /** At least one. Closed vocabulary. */
  readonly reasonCodes: readonly VerificationReasonCode[];
  /** What the decision rests on. Empty is legal only for `inconclusive`. */
  readonly evidence: readonly EvidenceReference[];
  readonly confidence: FindingConfidence;
  readonly verifiedBy: VerifierReference;
  /** Human-facing prose. Supplementary. */
  readonly summary?: string | undefined;
  readonly verifiedAt: Timestamp;
}

export const verificationResultSchema = z
  .strictObject({
    decision: verificationDecisionSchema,
    reasonCodes: z
      .array(verificationReasonCodeSchema)
      .min(1, {
        error: "A verification decision must record at least one reason",
      })
      .max(VERIFICATION_REASON_CODES.length),
    evidence: evidenceReferenceListSchema,
    confidence: findingConfidenceSchema,
    verifiedBy: verifierReferenceSchema,
    summary: z.string().min(1).max(TEXT_LIMITS.summary).optional(),
    verifiedAt: timestampSchema,
  })
  .superRefine((result, ctx) => {
    // A confirming code on a rejection is a contradiction no consumer could
    // resolve: "rejected because confirmed_by_test" is meaningless (§C18).
    const confirming = result.reasonCodes.filter(isConfirmingReason);
    if (result.decision !== "verified" && confirming.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: `Confirming reason(s) ${confirming.join(", ")} cannot accompany a '${result.decision}' decision`,
      });
    }
    if (result.decision === "verified" && confirming.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message:
          "A 'verified' decision must record how it was confirmed (a confirmed_by_* reason)",
      });
    }

    // Verification means "established by evidence" (§26, §31). A confirmation
    // resting on nothing is exactly the model self-report the design excludes.
    if (result.decision === "verified" && result.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A 'verified' decision must cite the evidence supporting it",
      });
    }

    // Duplicate codes would double-count in analytics.
    if (new Set(result.reasonCodes).size !== result.reasonCodes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "Reason codes must be unique",
      });
    }
  });

/** Whether this result permits the candidate to become a published finding. */
export function permitsPublication(result: VerificationResult): boolean {
  return result.decision === "verified";
}
