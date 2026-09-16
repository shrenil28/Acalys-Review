/**
 * The trust funnel, as the worker actually executes it.
 *
 * ```
 * CandidateFinding[]
 *      ↓   verification        durable command, then the verifier, then the attempt
 * VerificationAttempt[]
 *      ↓   promotion           only `verified`, and only through the gate
 * ReviewFinding[]
 *      ↓   publication policy  real ≠ worth interrupting someone about
 * PublicationDecision[]
 *      ↓
 * PublicationIntent[]          only for decisions that said publish
 * ```
 *
 * and, branching off `ReviewFinding[]` and never off anything to its right:
 *
 * ```
 *      ↓   pre-merge policy
 * PreMergeCheckResult[]
 * ```
 *
 * # Why this file exists at all
 *
 * Every module above already existed and was tested. None of them was called.
 * The orchestrator ran a stub that wrote to a since-deleted `verifications`
 * table, promoted candidates by INSERTing `review_findings` directly, and
 * planned one comment per finding with no policy in the path. A probe against
 * the live pipeline produced 2 candidates, 0 verification attempts, 2 findings
 * with `verification_attempt_id = NULL`, and 3 publication intents — while
 * 1,670 tests passed.
 *
 * So the stages are wired here, and each is a separate function with a separate
 * input type, because the failure mode was never "the code was wrong". It was
 * that a shorter path existed.
 *
 * # Where the transaction boundaries fall, and why
 *
 * ```
 * verification   OUTSIDE any transaction, attempt by attempt
 * promotion  ┐
 * policy     ├─ INSIDE the transaction that transitions reconciling → publishing
 * pre-merge  ┘
 * ```
 *
 * Verification is outside because the verifier is the expensive part and may
 * call a model: holding the run's row lock across that would serialize the
 * fleet on the slowest claim, and a transaction that spans an external call is
 * a transaction that will one day span an outage. Each attempt is durable on
 * its own, so a crash loses at most the attempt in flight.
 *
 * The other three are inside because they must agree. A crash between promotion
 * and policy would leave findings nobody has decided about; a crash between
 * policy and the ledger would leave a `publish` decision with no obligation to
 * discharge. Committing them with the transition makes
 * `state = publishing ⟹ every promoted finding has been decided` structural.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_PREMERGE_CONFIG,
  DEFAULT_PUBLICATION_CONFIG,
  EMPTY_PUBLICATION_STATE,
  assertReasonDecides,
  evaluatePreMerge,
  planPublication,
  promoteVerified,
  type PreMergeConfig,
  type PublicationConfig,
  type PublicationState,
  type VerificationAttempt,
  type VerifiedCandidate,
} from "@acalys/review-engine";
import type {
  PgClient,
  PolicyDecisionStore,
  PreMergeStore,
  PublicationIntentRow,
  ReviewStageStore,
  TenantScope,
  VerificationScheduler,
  VerificationStore,
} from "@acalys/database";
import type { FindingSeverity } from "@acalys/contracts/domain";

import {
  STUB_VERIFIER_ID,
  STUB_VERIFIER_VERSION,
  logicalKey,
} from "./stages.js";

/**
 * What the worker needs to run one candidate through verification.
 *
 * A function rather than an object with a `verify` method so a test can inject
 * `unavailable` for a chosen candidate without constructing a whole verifier —
 * the outage path is the one that most needs exercising and the one an
 * elaborate seam discourages testing.
 */
export interface CandidateVerifier {
  readonly id: string;
  readonly version: string;
  verify(
    candidate: {
      readonly id: string;
      readonly fingerprintValue: string;
      readonly path?: string | undefined;
      readonly startLine?: number | undefined;
      readonly endLine?: number | undefined;
      readonly claim?: string | undefined;
      readonly category?: string | undefined;
      readonly proposedSeverity?: string | undefined;
    },
    execution: {
      readonly scope: TenantScope;
      readonly reviewRunId: string;
      readonly revisionId: string;
    },
  ): Promise<VerificationAttempt> | VerificationAttempt;
}

export interface FunnelStores {
  readonly scheduler: VerificationScheduler;
  readonly verifications: VerificationStore;
  readonly decisions: PolicyDecisionStore;
  readonly premerge: PreMergeStore;
  readonly stages: ReviewStageStore;
}

export interface FunnelConfig {
  readonly publication?: PublicationConfig | undefined;
  readonly premerge?: PreMergeConfig | undefined;
  readonly publicationState?: PublicationState | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The request key for one verification pass.
 *
 * Derived entirely from domain identity: the run, the candidate, and which pass
 * this is. Deliberately contains no delivery id, job id, worker id or
 * timestamp — anything that varies per delivery would make every redelivery
 * look like a genuine retry, which is the exact confusion the scheduler exists
 * to prevent.
 */
export function verificationRequestKey(
  reviewRunId: string,
  candidateId: string,
  pass: number,
): string {
  return `acalys:verify:run:${reviewRunId}:candidate:${candidateId}:pass:${String(pass)}`;
}

export type VerificationStageOutcome =
  | { readonly kind: "examined"; readonly attempts: number }
  /**
   * At least one candidate could not be verified.
   *
   * Not a partial success. Publishing the subset that happened to verify would
   * render a verifier outage as *fewer comments on a successful review* —
   * indistinguishable from good news, and every metric would agree.
   */
  | {
      readonly kind: "unavailable";
      readonly candidateIds: readonly string[];
    }
  | {
      readonly kind: "in_progress";
      readonly candidateIds: readonly string[];
    };

/**
 * Stage 1 — verification.
 *
 * For each candidate: allocate a durable command, run the verifier, persist the
 * attempt, settle the command. In that order, and the order is the recovery
 * story:
 *
 * ```
 * crash before the command      nothing happened; the next pass allocates it
 * crash after the command       the command is `scheduled`; recoverable by any
 *                               worker, which re-presents the same request key
 *                               and gets the same invocation back
 * crash after the verifier ran  the attempt was not written; re-verification
 *                               under the SAME invocation id converges on one
 *                               row rather than inventing a second attempt
 * crash after the attempt       `recordAttempt` converges; no duplicate
 * ```
 *
 * Note what is NOT inferred anywhere: nothing reads a failed insert as evidence
 * of redelivery. The scheduler reports whether it allocated, and this function
 * believes it.
 */
export async function runVerification(
  scope: TenantScope,
  reviewRunId: string,
  revisionId: string,
  candidates: readonly {
    readonly id: string;
    readonly fingerprintValue: string;
    readonly path?: string | undefined;
    readonly startLine?: number | undefined;
    readonly endLine?: number | undefined;
    readonly claim?: string | undefined;
    readonly category?: string | undefined;
    readonly proposedSeverity?: string | undefined;
  }[],
  verifier: CandidateVerifier,
  stores: FunnelStores,
  pass = 1,
): Promise<VerificationStageOutcome> {
  const unavailable: string[] = [];
  const inProgress: string[] = [];
  let attempts = 0;

  for (const candidate of candidates) {
    const invocation = await stores.scheduler.schedule({
      organizationId: scope.organizationId,
      reviewRunId,
      candidateFindingId: candidate.id,
      requestKey: verificationRequestKey(reviewRunId, candidate.id, pass),
      reason: pass === 1 ? "initial" : "retry_unavailable",
    });

    const ownership = await stores.scheduler.claim(
      invocation.invocationId,
      process.env.ACALYS_WORKER_ID ?? `review-worker:${String(process.pid)}`,
      120_000,
    );
    if (ownership.kind === "settled") continue;
    if (ownership.kind === "busy") {
      inProgress.push(candidate.id);
      continue;
    }

    const { claim } = ownership;
    let leaseLost: unknown;
    const heartbeat = setInterval(() => {
      void stores.scheduler
        .renew(
          claim.invocationId,
          claim.claimToken,
          claim.claimGeneration,
          120_000,
        )
        .catch((error: unknown) => {
          leaseLost ??= error;
        });
    }, 30_000);
    heartbeat.unref?.();

    let attempt: VerificationAttempt;
    try {
      attempt = await verifier.verify(candidate, {
        scope,
        reviewRunId,
        revisionId,
      });
    } finally {
      clearInterval(heartbeat);
    }
    if (leaseLost !== undefined) {
      throw leaseLost instanceof Error
        ? leaseLost
        : new Error("Verification lease renewal failed");
    }

    // A final renewal closes the race between the last heartbeat and the
    // persistence fence. If ownership moved, this worker stops before writing.
    await stores.scheduler.renew(
      claim.invocationId,
      claim.claimToken,
      claim.claimGeneration,
      120_000,
    );

    const stored = await stores.verifications.recordAttempt({
      invocationId: claim.invocationId,
      claimToken: claim.claimToken,
      claimGeneration: claim.claimGeneration,
      attempt: claim.attempt,
      candidateFindingId: candidate.id,
      reviewRunId,
      organizationId: scope.organizationId,
      verifierId: verifier.id,
      verifierVersion: verifier.version,
      contextDigest: sha256(`${verifier.id}|${candidate.fingerprintValue}`),
      cacheKey: sha256(
        `${verifier.id}|${verifier.version}|${candidate.fingerprintValue}`,
      ),
      outcome:
        attempt.status === "completed"
          ? {
              status: "completed",
              decision: attempt.decision,
              reasons: attempt.reasons,
              confidence: attempt.confidence,
              severity: attempt.severity,
            }
          : { status: "unavailable", failure: attempt.failure },
    });

    await stores.scheduler.settle(
      claim.invocationId,
      claim.claimToken,
      claim.claimGeneration,
    );

    attempts += 1;
    if (stored.status !== "completed") unavailable.push(candidate.id);
  }

  if (unavailable.length > 0) {
    return { kind: "unavailable", candidateIds: unavailable };
  }
  if (inProgress.length > 0) {
    return { kind: "in_progress", candidateIds: inProgress };
  }
  return { kind: "examined", attempts };
}

export interface ReconciledCandidate {
  readonly candidateId: string;
  readonly fingerprintValue: string;
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly claim: string;
  readonly explanation: string;
  /** Empty when nothing examined the candidate; see {@link attempt}. */
  readonly attemptId: string;
  /**
   * What verification concluded, or absent if nothing examined it.
   *
   * Absent rather than a fabricated `unavailable`: "nothing was scheduled" is a
   * defect in our pipeline and "the verifier could not run" is a defect in the
   * world. Both block the run; only the reason code says which system to go and
   * look at.
   */
  readonly attempt: VerificationAttempt | undefined;
}

export interface PublicationScope {
  readonly provider: "github" | "gitlab";
  readonly pullRequestId: string;
  readonly revisionId: string;
  readonly runId: string;
}

export interface FunnelResult {
  readonly promoted: number;
  readonly published: number;
  readonly withheld: number;
  readonly noActionableFindings: boolean;
  readonly mergeBlocked: boolean;
}

/**
 * Stages 2, 3 and the pre-merge branch, inside the caller's transaction.
 *
 * Returns the publication intents for `runStage` to write, so the ledger and
 * the transition commit together — `state = publishing` with an empty ledger
 * stays unreachable.
 *
 * The pre-merge evaluation takes `findings`, the same value publication policy
 * takes, and never takes `plan`. That is the independence: there is no
 * parameter here through which a publication outcome could influence
 * enforcement, so a finding withheld by an exhausted comment budget still fails
 * the merge check.
 */
export async function reconcileAndPlan(
  scope: TenantScope,
  publication: PublicationScope,
  candidates: readonly ReconciledCandidate[],
  stores: FunnelStores,
  client: PgClient,
  config: FunnelConfig = {},
): Promise<{
  readonly intents: readonly PublicationIntentRow[];
  readonly result: FunnelResult;
}> {
  // ── Stage 2: promotion ──────────────────────────────────────────────────
  //
  // The kernel decides who may be promoted, from the attempt alone. It refuses
  // the whole run if any verification was unavailable, rather than promoting
  // the subset that happened to succeed.
  const gate = promoteVerified(
    candidates.map((candidate): VerifiedCandidate => ({
      candidateId: candidate.candidateId,
      fingerprint: candidate.fingerprintValue,
      severity: candidate.severity,
      category: candidate.category,
      path: candidate.path,
      attempt: candidate.attempt,
    })),
  );

  if (gate.kind === "blocked") {
    throw new Error(
      `Refusing to reconcile: ${gate.block} for candidate(s) ${gate.candidateIds.join(", ")}. ` +
        "Publishing the subset that verified would make an outage look like a clean review.",
    );
  }

  const promotable = new Set(
    gate.findings.map((finding) => finding.fingerprint),
  );

  // Promotion goes through the store's gate, which re-checks that the cited
  // attempt says `verified`. Belt and braces with the kernel above: this is the
  // path an ad-hoc script would take, and the last place the guarantee holds.
  const findings: {
    findingId: string;
    fingerprint: string;
    severity: FindingSeverity;
    category: string;
    path: string;
  }[] = [];

  for (const candidate of candidates) {
    if (!promotable.has(candidate.fingerprintValue)) continue;
    const { id } = await stores.verifications.promote(
      {
        reviewRunId: publication.runId,
        organizationId: scope.organizationId,
        repositoryId: scope.repositoryId,
        verificationAttemptId: candidate.attemptId,
        revisionId: publication.revisionId,
        fingerprintValue: candidate.fingerprintValue,
        // The verifier's severity, not the analyzer's proposal. Once the defect
        // is independently established, the verification is the authority.
        severity:
          candidate.attempt?.status === "completed"
            ? candidate.attempt.severity
            : candidate.severity,
        category: candidate.category,
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        title: candidate.title,
        claim: candidate.claim,
        explanation: candidate.explanation,
      },
      client,
    );

    findings.push({
      findingId: id,
      fingerprint: candidate.fingerprintValue,
      severity:
        candidate.attempt?.status === "completed"
          ? candidate.attempt.severity
          : candidate.severity,
      category: candidate.category,
      path: candidate.path,
    });
  }

  // ── Stage 3: publication policy ─────────────────────────────────────────
  const plan = planPublication(
    findings,
    config.publication ?? DEFAULT_PUBLICATION_CONFIG,
    config.publicationState ?? EMPTY_PUBLICATION_STATE,
  );
  for (const decision of plan.decisions) assertReasonDecides(decision);

  const stored = await stores.decisions.record(
    scope,
    publication.runId,
    plan.decisions.map((decision) => ({
      reviewFindingId: decision.findingId,
      decision: decision.decision,
      reason: decision.reason,
    })),
    client,
  );

  const publishableBy = new Map(
    stored
      .filter((decision) => decision.publishableId !== null)
      .map((decision) => [decision.reviewFindingId, decision.publishableId]),
  );

  // ── The pre-merge branch ────────────────────────────────────────────────
  //
  // From `findings`, not from `plan` and not from `stored`. Enforcement that
  // could read publication state would eventually be decided by it.
  const checks = evaluatePreMerge(
    findings,
    config.premerge ?? DEFAULT_PREMERGE_CONFIG,
  );
  await stores.premerge.record(
    scope,
    publication.runId,
    checks.map((check) => ({
      checkId: check.checkId,
      name: check.name,
      status: check.status,
      explanation: check.explanation,
      blocking: check.blocking,
    })),
    client,
  );

  // ── The ledger ──────────────────────────────────────────────────────────
  //
  // One run-level review container, plus one comment per finding policy said to
  // publish. A withheld finding produces nothing here — and could not, since
  // the decision it would have to cite has no `publishable_id`.
  const summary = plan.noActionableFindings
    ? "Acalys reviewed this change and found no actionable findings."
    : `Acalys reviewed this change and reported ${String(plan.publish.length)} finding(s).`;

  const intents: PublicationIntentRow[] = [
    {
      kind: "review",
      logicalKey: logicalKey(
        {
          organizationId: scope.organizationId,
          repositoryId: scope.repositoryId,
          provider: publication.provider,
          pullRequestId: publication.pullRequestId,
          revisionId: publication.revisionId,
          runId: publication.runId,
        },
        "review",
        "run",
      ),
      contentDigest: sha256(summary),
      provider: publication.provider,
      pullRequestId: publication.pullRequestId,
      revisionId: publication.revisionId,
    },
  ];

  for (const finding of plan.publish) {
    const decisionId = publishableBy.get(finding.findingId);
    if (decisionId === undefined || decisionId === null) {
      // Unreachable: `plan.publish` is a subset of the decisions just written.
      // Kept because the alternative to failing here is writing a publication
      // with no authorization, which is the exact thing the column exists to
      // make impossible.
      throw new Error(
        `Finding ${finding.findingId} is in the publication plan with no publishable decision.`,
      );
    }
    intents.push({
      kind: "inline_comment",
      logicalKey: logicalKey(
        {
          organizationId: scope.organizationId,
          repositoryId: scope.repositoryId,
          provider: publication.provider,
          pullRequestId: publication.pullRequestId,
          revisionId: publication.revisionId,
          runId: publication.runId,
        },
        "inline_comment",
        finding.fingerprint,
      ),
      contentDigest: sha256(`${finding.fingerprint}|${finding.severity}`),
      provider: publication.provider,
      pullRequestId: publication.pullRequestId,
      revisionId: publication.revisionId,
      reviewFindingId: finding.findingId,
      publicationDecisionId: decisionId,
    });
  }

  return {
    intents,
    result: {
      promoted: findings.length,
      published: plan.publish.length,
      withheld: plan.withheld.length,
      // A first-class successful outcome. Not an error, and never a reason to
      // manufacture a finding so the publisher has something to render.
      noActionableFindings: plan.noActionableFindings,
      mergeBlocked: checks.some(
        (check) => check.blocking && check.status === "failed",
      ),
    },
  };
}

/** The deterministic stub verifier's identity, re-exported for the worker. */
export const WORKER_VERIFIER = {
  id: STUB_VERIFIER_ID,
  version: STUB_VERIFIER_VERSION,
} as const;

export { randomUUID };
