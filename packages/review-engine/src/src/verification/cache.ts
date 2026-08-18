/**
 * Verification's own cache identity.
 *
 * Built from the facts under verification and the procedure used, and from
 * nothing about the analyzer that raised the claim. That gives a property
 * stronger than "the decision was stable twice":
 *
 * ```
 * change only the analyzer's confidence  →  the verification cache key is
 *                                            unchanged
 * ```
 *
 * If the analyzer's identity or confidence appeared here, a re-run after an
 * analyzer tweak would miss the cache and re-verify unchanged facts — which is
 * merely wasteful — and, worse, would make "did the verifier change its mind?"
 * unanswerable, because the key would have moved for a reason unrelated to the
 * claim.
 */

import { createHash } from "node:crypto";

import type { VerificationInput } from "./input.js";

export const VERIFICATION_PROCEDURE_VERSION = "1";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The claim and its support, canonically.
 *
 * Evidence is sorted, because the order an analyzer happened to append items in
 * is not a fact about the claim, and letting it move the key would make the
 * cache miss on reordering alone.
 */
export function claimIdentity(input: VerificationInput): string {
  return sha256(
    JSON.stringify({
      statement: input.claim.statement,
      steps: input.claim.steps,
      trigger: input.claim.trigger,
      consequence: input.claim.consequence,
      location: input.location,
      remediation: input.remediation,
      severity: input.proposedSeverity,
      evidence: [...input.evidence]
        .map((item) => `${item.type}:${item.observation}`)
        .sort(),
      repositoryId: input.repositoryId,
      revisionId: input.revisionId,
    }),
  );
}

export function verificationCacheKey(input: {
  readonly claimIdentity: string;
  readonly verifierContextDigest: string;
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly modelIdentity?: string | undefined;
}): string {
  return sha256(
    JSON.stringify({
      claim: input.claimIdentity,
      context: input.verifierContextDigest,
      verifier: `${input.verifierId}@${input.verifierVersion}`,
      procedure: VERIFICATION_PROCEDURE_VERSION,
      // Explicitly null for a deterministic verifier, so a deterministic
      // decision and a model decision can never share a key.
      model: input.modelIdentity ?? null,
    }),
  );
}
