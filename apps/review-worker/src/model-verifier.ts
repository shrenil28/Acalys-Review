import { findingSeveritySchema } from "@acalys/contracts/domain";
import type { ModelCompleter } from "@acalys/review-engine";
import {
  LLM_INDEPENDENT_VERIFIER_ID,
  LLM_INDEPENDENT_VERIFIER_VERSION,
  verifyLlmClaim,
  type IndependentSourceReader,
} from "@acalys/review-engine";

import type { CandidateVerifier } from "./funnel.js";

export interface ModelVerifierOptions {
  readonly model: ModelCompleter;
  /**
   * Independent source access; never the analyzer's AssembledContext. The
   * source is resolved per run so one long-lived worker cannot accidentally
   * verify run B against run A's revision.
   */
  readonly sourceFor: (input: {
    readonly repositoryId: string;
    readonly revisionId: string;
    readonly reviewRunId: string;
  }) => IndependentSourceReader;
  readonly timeoutMs?: number | undefined;
}

/**
 * Adapts the independent model verifier to the worker funnel.
 *
 * The candidate seam deliberately exposes no analyzer evidence/rationale to
 * this function. The verifier receives the proposition plus a location, then
 * performs its own source read through a different port.
 */
export function createModelCandidateVerifier(
  options: ModelVerifierOptions,
): CandidateVerifier {
  return {
    id: LLM_INDEPENDENT_VERIFIER_ID,
    version: LLM_INDEPENDENT_VERIFIER_VERSION,
    async verify(candidate, execution) {
      if (
        candidate.claim === undefined ||
        candidate.path === undefined ||
        candidate.startLine === undefined ||
        candidate.endLine === undefined ||
        candidate.proposedSeverity === undefined
      ) {
        return { status: "unavailable", failure: "context_unavailable" };
      }
      const severity = findingSeveritySchema.safeParse(candidate.proposedSeverity);
      if (!severity.success) {
        return { status: "unavailable", failure: "context_unavailable" };
      }
      const source = options.sourceFor({
        repositoryId: execution.scope.repositoryId,
        revisionId: execution.revisionId,
        reviewRunId: execution.reviewRunId,
      });
      return verifyLlmClaim(
        {
          organizationId: execution.scope.organizationId,
          reviewRunId: execution.reviewRunId,
          claim: candidate.claim,
          path: candidate.path,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
          proposedSeverity: severity.data,
        },
        source,
        options.model,
        options.timeoutMs,
      );
    },
  };
}
