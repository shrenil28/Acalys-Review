/**
 * Deterministic stand-ins for the reviewer, verifier and reconciler.
 *
 * Not placeholders to be deleted — the *point* of this checkpoint. Mixing model
 * nondeterminism into a crash-recovery proof makes the proof worthless: when a
 * replay produces different findings you cannot tell whether recovery is broken
 * or the model simply answered differently.
 *
 * So the middle of the pipeline is a pure function of the change under review.
 * Then the invariant becomes checkable:
 *
 * > Given the same persisted input, **every crash schedule converges to the
 * > same findings, verifications and publication intents.**
 *
 * Note what that does *not* claim: the same number of infrastructure attempts.
 * Worker history may differ; the logical result may not.
 *
 * Real intelligence replaces these functions later. The orchestration around
 * them, and the tests proving it, do not change — which is the whole reason to
 * build it in this order.
 */

import { createHash } from "node:crypto";

import type { VerificationAttempt } from "@acalys/review-engine";
import type { CandidateFindingRow } from "@acalys/database";

export const STUB_ANALYZER_ID = "acalys.analyzer.deterministic-stub";
export const STUB_ANALYZER_VERSION = "1";
export const STUB_VERIFIER_ID = "acalys.verifier.deterministic-stub";
export const STUB_VERIFIER_VERSION = "1";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * What the analyzer was given.
 *
 * Deliberately minimal and fully determined by stored rows: repository,
 * revision, and the head commit. A replay months later reconstructs it exactly,
 * which is what makes the determinism claim testable rather than aspirational.
 */
export interface AnalysisInput {
  readonly repositoryId: string;
  /**
   * The revision this analysis belongs to.
   *
   * Carried for provenance and **excluded from {@link inputDigest}** — see
   * there for why a platform surrogate must not determine analysis output.
   */
  readonly revisionId: string;
  readonly headSha: string;
}

/**
 * Digest of what was analyzed, recorded on every candidate for provenance.
 *
 * Over **repository + head commit**, deliberately *not* the revision row id.
 * That id is a platform surrogate minted when we first saw the push; the
 * identity of the code is the commit, and the same commit re-ingested through a
 * different delivery gets a different surrogate.
 *
 * Including it would make analysis depend on our own bookkeeping, so two runs
 * over identical code could legitimately produce different findings — which
 * would make the convergence claim untestable and, worse, would be a real
 * source of nondeterminism once the analyzer is real.
 *
 * This was found by the crash-schedule test: a resumed run produced two
 * candidates where the reference produced three, purely because the surrogate
 * differed.
 *
 * # ⚠ This is NOT the real analyzer's cache key
 *
 * The stub analyzes nothing, so repository + head commit fully determines its
 * output. A real analyzer's input is strictly larger, and reducing it to the
 * head commit would be a serious bug — "same head SHA" would silently come to
 * mean "same analysis" while the actual prompt differed.
 *
 * Two layers, and only the first is modelled here:
 *
 *     code / change identity
 *         repository
 *         base revision and merge base   ← the same head against a different
 *                                          base is a different change
 *         head revision
 *         normalized ChangeManifest
 *
 *     analyzer-input identity
 *         code / change identity
 *         resolved path instructions and configuration snapshot
 *         the context snapshot digest    ← P1-CONTEXT
 *         analyzer id and version
 *
 * The second layer is what a real cache may key on, and it is exactly what
 * `AnalysisContextSnapshot.digest` is for. Until that exists, this function
 * deliberately serves only the stub, and any caching built on it would be
 * wrong.
 */
export function inputDigest(input: AnalysisInput): string {
  return sha256(`${input.repositoryId}|${input.headSha}`);
}

/**
 * Fingerprint, computed the way the real one is (§28).
 *
 * Line numbers are excluded on purpose even in a stub: the stub's job is to
 * exercise the *shape* of the pipeline, and a fingerprint that moved with lines
 * would make the incremental-review tests pass for the wrong reason.
 */
function fingerprint(
  repositoryId: string,
  issueKey: string,
  path: string,
  symbol: string,
): string {
  return sha256(
    JSON.stringify({
      algorithm: "acalys.fingerprint.symbol-anchor",
      anchor: `symbol:function:${symbol}`,
      category: "correctness",
      issueKey,
      path,
      repositoryId,
      version: 1,
    }),
  );
}

/**
 * Produces candidates deterministically from the head SHA.
 *
 * The count and content are a function of the commit, so two runs of the same
 * revision produce identical candidates and a replay is byte-comparable — while
 * two *different* revisions differ, so supersession and lineage tests have
 * something real to distinguish.
 */
export function analyze(input: AnalysisInput): readonly CandidateFindingRow[] {
  const digest = inputDigest(input);
  // 1–3 candidates, derived from the digest. Deterministic, and varied enough
  // that "the pipeline handled N outputs" is actually exercised.
  const count = (Number.parseInt(digest.slice(0, 2), 16) % 3) + 1;

  return Array.from({ length: count }, (_unused, index) => {
    const issueKey = `acalys.correctness.stub-${String(index)}`;
    const path = `src/module-${String(index)}.ts`;
    const symbol = `handler${String(index)}`;
    return {
      producerId: STUB_ANALYZER_ID,
      producerVersion: STUB_ANALYZER_VERSION,
      inputDigest: digest,
      title: `Deterministic finding ${String(index)}`,
      claim: `Stub claim ${String(index)} for ${input.headSha.slice(0, 7)}`,
      // Deliberately references the commit, not the revision surrogate, so
      // the text is identical across re-ingestions of the same code.
      explanation: `Produced by the deterministic stub for commit ${input.headSha}.`,
      category: "correctness",
      proposedSeverity: index === 0 ? "high" : "medium",
      path,
      startLine: 10 + index * 10,
      endLine: 12 + index * 10,
      fingerprintValue: fingerprint(input.repositoryId, issueKey, path, symbol),
    };
  });
}

/**
 * Decides each candidate deterministically, across all three decisions.
 *
 * Deliberately produces `rejected` and `inconclusive` as well as `verified`. A
 * stub that confirmed everything would make the candidate/finding distinction
 * invisible, and the funnel test would pass against a pipeline that had
 * silently collapsed the two — which is exactly the pipeline this checkpoint
 * found.
 *
 * The shape it returns is the review-engine's {@link VerificationAttempt}, not
 * a row: `unavailable` is a status rather than a fourth decision, so no
 * consumer can accidentally treat an outage as a judgement about the claim.
 */
export function verifyCandidate(candidate: {
  readonly fingerprintValue: string;
}): VerificationAttempt {
  // The last hex digit of the fingerprint decides. Stable across replays.
  const nibble = Number.parseInt(candidate.fingerprintValue.slice(-1), 16);

  if (nibble % 4 === 0) {
    return {
      status: "completed",
      decision: "rejected",
      reasons: ["claimed_mechanism_not_present"],
      confidence: 0.15,
      severity: "medium",
    };
  }
  if (nibble % 4 === 1) {
    // Never folded into `rejected`. "We could not establish it" and "we
    // established it is false" are different claims, and collapsing them makes
    // every gap in context read as an analyzer false positive.
    return {
      status: "completed",
      decision: "inconclusive",
      reasons: ["insufficient_evidence"],
      confidence: 0.3,
      severity: "medium",
    };
  }
  return {
    status: "completed",
    decision: "verified",
    reasons: ["independent_context_confirms"],
    confidence: 0.92,
    severity: nibble % 4 === 2 ? "high" : "medium",
  };
}

/** The stub verifier, in the shape the funnel consumes. */
export const deterministicVerifier = {
  id: STUB_VERIFIER_ID,
  version: STUB_VERIFIER_VERSION,
  verify: verifyCandidate,
};

/**
 * The publication scope, and the logical key built from it.
 *
 * Every scope that makes two effects different is spelled out. Not
 * `review:${runId}`: a run id is a UUID and would in fact be unique, which is
 * what makes the short form dangerous — it is correct by accident, and a future
 * key that drops a scope looks identical to one that never had it.
 */
export interface PublicationScope {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly provider: "github" | "gitlab";
  readonly pullRequestId: string;
  readonly revisionId: string;
  readonly runId: string;
}

export function logicalKey(
  scope: PublicationScope,
  kind: string,
  discriminator: string,
): string {
  return [
    "acalys",
    scope.provider,
    scope.organizationId,
    scope.repositoryId,
    scope.pullRequestId,
    scope.revisionId,
    scope.runId,
    kind,
    discriminator,
  ].join(":");
}
