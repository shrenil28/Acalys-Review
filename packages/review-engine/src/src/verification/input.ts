/**
 * What a verifier is allowed to know.
 *
 * The verifier's job is to answer *is this claim true?* — not *does this
 * analyzer usually get it right?*. Those questions have different answers, and
 * a verifier that can see the second stops asking the first. Shown a
 * confidence score, it becomes an agreement machine; shown the analyzer's
 * argument, it grades prose instead of checking facts.
 *
 * So the boundary is a **type with no capacity to carry any of it**, not a
 * convention that call sites remember:
 *
 * ```
 * absent by construction
 *     analyzer confidence      analyzer reasoning
 *     analyzer prompt          raw model completion
 *     analyzer identity        rule identity
 *     budget tier              suppression score
 * ```
 *
 * `verify(candidate: CandidateFinding)` is deliberately not the signature, even
 * though `CandidateFinding` looks harmless today. A projection is the only way
 * the compiler can tell anyone that a field was added on the wrong side of the
 * line.
 *
 * # Why even `ruleId` is excluded
 *
 * If the verifier knows a claim came from `…/promise-in-condition`, that is a
 * source-authority cue: rules acquire reputations, and a verifier that knows
 * which rule spoke is weighing the speaker. Rule identity is not needed to
 * establish whether the code does what the claim says, so it does not cross.
 *
 * It is still carried *around* the verifier — `candidateId` ties the decision
 * back to its candidate for persistence — but it is not *in* what gets
 * reasoned over.
 */

import type { FindingSeverity } from "@acalys/contracts/domain";

import type { FindingLocation } from "../analyzer.js";
import type { CandidateFinding } from "../finding.js";

/**
 * A factual statement the verifier is asked to check.
 *
 * The claim and its causal steps cross the boundary because they are *what is
 * being verified* — a verifier that cannot see the claim has nothing to check.
 * What does not cross is any expression of how sure the analyzer was.
 */
export interface VerificationClaim {
  /** What is asserted to be wrong. */
  readonly statement: string;
  /** The mechanism asserted, step by step. Checkable, not persuasive. */
  readonly steps: readonly string[];
  /** The input or state asserted to reach it. */
  readonly trigger: string;
  /** The effect asserted to follow. */
  readonly consequence: string;
}

/**
 * Supporting material, as fact rather than argument.
 *
 * The subtler leak this guards: an analyzer can defeat every structural
 * separation above by writing evidence like *"I am 97% confident this is
 * definitely a bug because…"*. Confidence and reasoning have then crossed the
 * boundary with no field named after them.
 *
 * So evidence admitted here is observational — a location, a declaration, a
 * tool result, a test outcome — and {@link toVerificationInput} rejects items
 * that read as an argument about those facts.
 */
export interface VerificationEvidence {
  readonly type: string;
  readonly observation: string;
  readonly location?: FindingLocation | undefined;
}

export interface VerificationInput {
  /** Ties the decision back to its candidate. Never reasoned over. */
  readonly candidateId: string;
  readonly claim: VerificationClaim;
  readonly location: FindingLocation;
  readonly evidence: readonly VerificationEvidence[];
  readonly remediation: string;
  /** The revision the claim is about. Facts are revision-relative. */
  readonly revisionId: string;
  readonly repositoryId: string;
  /** Severity as *proposed*, because scope of harm is part of the claim. */
  readonly proposedSeverity: FindingSeverity;
}

/**
 * Phrasings that carry the analyzer's certainty rather than an observation.
 *
 * A blunt instrument, and deliberately so: the alternative is trusting every
 * future rule author to keep argument out of evidence, and the failure is
 * silent when they do not. Anything matching is dropped from the projection
 * and recorded, so a rule that keeps producing argument is visible rather than
 * quietly weakening verification.
 */
const ARGUMENT_MARKERS: readonly RegExp[] = [
  /\bconfiden(?:ce|t)\b/i,
  /\b\d{1,3}\s*%\s*(?:sure|certain|confident)/i,
  /\bI (?:am|believe|think|suspect)\b/i,
  /\b(?:definitely|certainly|obviously|clearly) (?:a|an|is)\b/i,
  /\blikely a (?:bug|defect|problem)\b/i,
  /\bthe analyzer\b/i,
];

export function readsAsArgument(observation: string): boolean {
  return ARGUMENT_MARKERS.some((marker) => marker.test(observation));
}

export interface ProjectionResult {
  readonly input: VerificationInput;
  /** Evidence dropped for reading as argument, so the rule is diagnosable. */
  readonly droppedEvidence: readonly string[];
}

/**
 * The only way to build a verifier input.
 *
 * Fields are copied explicitly, never spread. A spread would carry whatever the
 * candidate gains next — which is exactly how a confidence score arrives at a
 * verifier six months after someone wrote a comment promising it would not.
 */
export function toVerificationInput(
  candidateId: string,
  candidate: CandidateFinding,
  context: { readonly repositoryId: string; readonly revisionId: string },
): ProjectionResult {
  const dropped: string[] = [];
  const evidence: VerificationEvidence[] = [];

  for (const item of candidate.evidence) {
    if (readsAsArgument(item.observation)) {
      dropped.push(item.observation);
      continue;
    }
    evidence.push({
      type: item.type,
      observation: item.observation,
      ...(item.location === undefined ? {} : { location: item.location }),
    });
  }

  return {
    input: {
      candidateId,
      claim: {
        statement: candidate.claim,
        steps: candidate.causal.steps,
        trigger: candidate.causal.trigger,
        consequence: candidate.causal.consequence,
      },
      location: candidate.location,
      evidence,
      remediation: candidate.remediation,
      revisionId: context.revisionId,
      repositoryId: context.repositoryId,
      proposedSeverity: candidate.proposedSeverity,
    },
    droppedEvidence: dropped,
  };
}

/**
 * Keys that must never appear anywhere in a serialized verifier input.
 *
 * Checked against the **serialized** shape rather than the type, because a
 * compile-time guarantee says nothing about an adapter that spread an object on
 * the way past. The type stops the honest mistake; this stops the clever one.
 */
export const FORBIDDEN_INPUT_KEYS: readonly string[] = [
  "confidence",
  "confidenceScore",
  "reasoning",
  "prompt",
  "completion",
  "rawModelResponse",
  "analyzerId",
  "producerId",
  "ruleId",
  "family",
  "clusterId",
  "tier",
  "budget",
  "suppression",
  "identityHint",
];

/** Every key present anywhere in a value, at any depth. */
function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysOf(entry, found);
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      found.add(key);
      keysOf(nested, found);
    }
  }
  return found;
}

/**
 * Refuses to hand the verifier anything carrying analyzer authority.
 *
 * Throws rather than filters. A projection that silently strips a forbidden
 * field would let the leak persist upstream, and the next field added would be
 * one nobody thought to name here.
 */
export function assertNoAnalyzerAuthority(input: VerificationInput): void {
  const present = keysOf(input);
  const violations = FORBIDDEN_INPUT_KEYS.filter((key) => present.has(key));

  if (violations.length > 0) {
    throw new Error(
      `Verifier input carries analyzer authority: ${violations.join(", ")}. ` +
        "A verifier that can see how sure the analyzer was stops checking the " +
        "claim and starts agreeing with it.",
    );
  }
}
