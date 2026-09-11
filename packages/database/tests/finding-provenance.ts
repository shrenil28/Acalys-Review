import { randomUUID } from "node:crypto";
import type { TestDatabase } from "./postgres.js";

/**
 * Seeds the provenance a published finding is required to have.
 *
 * Since migration 0008, `review_findings.verification_attempt_id` is NOT NULL:
 * a finding exists because a verification attempt entailed it, and a row that
 * points at nothing is exactly the unentailed promotion that migration set out
 * to make unrepresentable. Tests that want a published finding therefore have
 * to build the same chain production builds — candidate, invocation, claim,
 * attempt — rather than inserting the finding alone.
 *
 * Returns the attempt id to hang the finding on.
 */
export async function seedVerifiedAttempt(
  database: TestDatabase,
  input: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly reviewRunId: string;
    readonly fingerprint: string;
    readonly severity: string;
    readonly category: string;
    readonly at: Date;
  },
): Promise<string> {
  const candidateId = randomUUID();
  const invocationId = randomUUID();
  const attemptId = randomUUID();
  const claimToken = randomUUID();

  await database.pool.query(
    `INSERT INTO candidate_findings
       (id, organization_id, repository_id, review_run_id, producer_id, producer_version,
        input_digest, title, claim, explanation, category, proposed_severity,
        path, start_line, end_line, fingerprint_value, created_at)
     VALUES ($1,$2,$3,$4,'acalys.analyzer.test','1',$5,'candidate','claim','evidence',
        $6,$7,'src/auth.ts',10,12,$8,$9)`,
    [
      candidateId,
      input.organizationId,
      input.repositoryId,
      input.reviewRunId,
      "d".repeat(64),
      input.category,
      input.severity,
      input.fingerprint,
      input.at,
    ],
  );

  await database.pool.query(
    `INSERT INTO verification_invocations
       (id, organization_id, review_run_id, candidate_finding_id, attempt, request_key,
        reason, state, claim_token, claim_generation, claimed_by, claimed_at,
        claim_expires_at, created_at, settled_at)
     VALUES ($1,$2,$3,$4,1,$5,'initial','settled',$6,1,'test-worker',$7,$8,$7,$7)`,
    [
      invocationId,
      input.organizationId,
      input.reviewRunId,
      candidateId,
      `test:${input.reviewRunId}:${candidateId}:1`,
      claimToken,
      input.at,
      new Date(input.at.getTime() + 60_000),
    ],
  );

  await database.pool.query(
    `INSERT INTO verification_attempts
       (id, organization_id, review_run_id, candidate_finding_id, status, decision, reasons,
        confidence, severity, verifier_id, verifier_version, context_digest, cache_key,
        invocation_id, attempt, claim_token, claim_generation, created_at)
     VALUES ($1,$2,$3,$4,'completed','verified',ARRAY['evidence_supports_claim'],0.95,$5,
        'acalys.verifier.re-derivation','1.0.0',$6,$7,$8,1,$9,1,$10)`,
    [
      attemptId,
      input.organizationId,
      input.reviewRunId,
      candidateId,
      input.severity,
      "c".repeat(64),
      "k".repeat(64),
      invocationId,
      claimToken,
      input.at,
    ],
  );

  return attemptId;
}
