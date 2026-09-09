/**
 * Walking a run through the lifecycle, resumably.
 *
 *     queued → preparing → analyzing → reviewing → verifying
 *            → reconciling → publishing → completed
 *
 * The orchestrator holds no state of its own. It reads the run's current state
 * and advances it one step — so a process that dies mid-run is recovered by
 * *any* worker simply calling `advance` again, with no handoff, no checkpoint
 * file, and no recovery mode distinct from normal operation.
 *
 * That is deliberate. A separate recovery path is a path that runs rarely, and
 * paths that run rarely are wrong. Here, recovery *is* the normal path.
 *
 * # Why each step is a compare-and-swap plus its output, atomically
 *
 * See `ReviewStageStore.runStage`. The short version: an enum is not evidence
 * that work happened, so the work and the enum commit together.
 *
 * # `publishing` is a durable obligation
 *
 * Entering `publishing` means *the decision to make this review externally
 * visible is irrevocable; the system is now responsible for converging external
 * state to the intended publication.* It does not mean "a worker is currently
 * making HTTP calls". A worker may die; the obligation survives it.
 *
 * That is why `publishing → superseded` does not exist, and why the publication
 * intents are written **before** the run enters `publishing` — the ledger has
 * to outlive the process that created it.
 */

import type {
  CandidateFindingRow,
  PgClient,
  PolicyDecisionStore,
  PreMergeStore,
  ReviewIngestionStore,
  ReviewStageStore,
  StageWork,
  TenantScope,
  VerificationScheduler,
  VerificationStore,
} from "@acalys/database";
import type { FindingSeverity } from "@acalys/contracts/domain";

import { inputDigest, type AnalysisInput } from "./stages.js";
import {
  reconcileAndPlan,
  runVerification,
  type CandidateVerifier,
  type FunnelConfig,
  type FunnelStores,
  type ReconciledCandidate,
} from "./funnel.js";

/** Where the orchestrator got to, and why it stopped. */
export type AdvanceOutcome =
  | { readonly kind: "advanced"; readonly from: string; readonly to: string }
  /** Terminal, or waiting on something outside the orchestrator. */
  | { readonly kind: "settled"; readonly state: string }
  /** Another worker moved it — supersession, cancellation, a concurrent peer. */
  | { readonly kind: "refused"; readonly actualState: string | undefined }
  /**
   * The work described a revision the run no longer points at.
   *
   * Separate from `refused` because the recoveries are opposites:
   *
   * ```
   * refused  →  stop. Someone else advanced the run; retrying is wrong.
   * stale    →  recompute. The run is still ours, but the analysis describes a
   *             revision it no longer points at; re-committing is wrong.
   * ```
   */
  | {
      readonly kind: "stale";
      readonly expectedRevisionId: string;
      readonly actualRevisionId: string | undefined;
    }
  /**
   * The state claims a stage happened and its artifact is missing.
   *
   * Unreachable under the atomic design, so reaching it means something outside
   * this code wrote to the database. The run is not advanced: continuing would
   * review nothing and report success.
   */
  | {
      readonly kind: "invariant_violation";
      readonly state: string;
      readonly missing: string;
    };

export interface OrchestratorOptions {
  readonly ingestion: ReviewIngestionStore;
  readonly stages: ReviewStageStore;
  /**
   * The durable verification boundary.
   *
   * Required, not optional. An optional store is a store a caller can forget,
   * and "the orchestrator was constructed without one" is exactly how the
   * pipeline came to be promoting candidates nothing had verified.
   */
  readonly scheduler: VerificationScheduler;
  readonly verifications: VerificationStore;
  readonly decisions: PolicyDecisionStore;
  readonly premerge: PreMergeStore;
  /**
   * Required analysis boundary. Production composition supplies the real Phase-2
   * analyzer; deterministic crash suites opt into the stub explicitly.
   */
  readonly analyzer: (
    input: AnalysisInput,
    context: RunContext,
  ) => readonly CandidateFindingRow[] | Promise<readonly CandidateFindingRow[]>;
  /** Required independent verification boundary; there is no silent stub fallback. */
  readonly verifier: CandidateVerifier;
  readonly config?: FunnelConfig | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface RunContext {
  readonly scope: TenantScope;
  readonly runId: string;
  readonly revisionId: string;
  readonly headSha: string;
  /**
   * Which provider will carry the publication, and which pull request it
   * belongs to.
   *
   * Both are on the context rather than looked up when needed, because the
   * publication ledger is written in the transition into `publishing` — the one
   * moment where a lookup that fails would leave a durable obligation with no
   * record of what it obliges.
   */
  readonly provider: "github" | "gitlab";
  readonly pullRequestId: string;
}

/**
 * Advances a run by exactly one state.
 *
 * One step per call, rather than a loop, so a caller can crash between any two
 * steps and a test can inject that crash precisely.
 */
export async function advance(
  context: RunContext,
  options: OrchestratorOptions,
): Promise<AdvanceOutcome> {
  const run = await options.ingestion.getRun(context.runId);
  if (run === undefined) {
    return { kind: "refused", actualState: undefined };
  }

  const input: AnalysisInput = {
    repositoryId: context.scope.repositoryId,
    revisionId: context.revisionId,
    headSha: context.headSha,
  };

  const stores: FunnelStores = {
    scheduler: options.scheduler,
    verifications: options.verifications,
    decisions: options.decisions,
    premerge: options.premerge,
    stages: options.stages,
  };

  const step = async (
    from: string,
    to: string,
    produce: (client: PgClient) => StageWork | Promise<StageWork>,
    prerequisites: readonly (
      "candidates" | "verifications" | "every_candidate_examined" | "findings"
    )[] = [],
  ): Promise<AdvanceOutcome> => {
    const outcome = await options.stages.runStage(
      context.scope,
      context.runId,
      from,
      to,
      produce,
      prerequisites,
    );
    switch (outcome.kind) {
      case "advanced":
        return { kind: "advanced", from, to };
      case "refused":
        return { kind: "refused", actualState: outcome.actualState };
      case "stale":
        return {
          kind: "stale",
          expectedRevisionId: outcome.expectedRevisionId,
          actualRevisionId: outcome.actualRevisionId,
        };
      case "prerequisite_missing":
        return {
          kind: "invariant_violation",
          state: outcome.state,
          missing: outcome.missing,
        };
      case "illegal":
        // The orchestrator only issues transitions the machine allows, so this
        // is a bug here rather than a race.
        throw new Error(
          `Orchestrator issued an illegal transition ${from} → ${to}`,
        );
    }
  };

  switch (run.state) {
    case "queued":
      // Nothing durable yet — `preparing` only records that a worker owns it.
      return step("queued", "preparing", () => ({}));

    case "preparing":
      // Analysis output and the transition commit together, so
      // `state = analyzing` entails candidates exist.
      return step("preparing", "analyzing", async () => ({
        candidates: await options.analyzer(input, context),
      }));

    case "analyzing":
      // `reviewing` is where a real implementation would enrich candidates.
      // The stub produces nothing new, and the prerequisite check still runs —
      // it is the guard against an externally corrupted database.
      return step("analyzing", "reviewing", () => ({}), ["candidates"]);

    case "reviewing":
      // Verification runs while the run is IN `verifying`, not as the output of
      // entering it. The verifier may call a model, and a stage that produced
      // its output inside the transition transaction would hold the run's row
      // lock across that call.
      return step("reviewing", "verifying", () => ({}), ["candidates"]);

    case "verifying": {
      const outputs = await options.stages.readOutputs(context.runId);
      const outcome = await runVerification(
        context.scope,
        context.runId,
        context.revisionId,
        outputs.candidates,
        options.verifier,
        stores,
      );

      if (outcome.kind === "in_progress") {
        // Another live claimant owns at least one stochastic verification.
        // Staying in `verifying` is neither failure nor success; a later queue
        // delivery resumes after that claim settles or expires.
        return { kind: "settled", state: "verifying" };
      }

      if (outcome.kind === "unavailable") {
        // Strict production behaviour: an unverifiable candidate fails the run
        // rather than publishing the subset that verified. Partial review may
        // become a product feature; it must not be acquired by accident,
        // because the shape it takes is "fewer comments on a successful
        // review", which is indistinguishable from good news.
        await options.stages.runStage(
          context.scope,
          context.runId,
          "verifying",
          "failed",
          () => ({}),
        );
        return {
          kind: "settled",
          state: "failed",
        };
      }

      // The prerequisite is per candidate, not `count(*) > 0`. A run whose
      // twentieth candidate was never examined must not advance because the
      // first nineteen were.
      return step("verifying", "reconciling", () => ({}), [
        "candidates",
        "every_candidate_examined",
      ]);
    }

    case "reconciling": {
      const candidates = await readReconciliationInput(options, context.runId);

      // Promotion, publication policy and the pre-merge branch all commit with
      // the transition. The intents come back for `runStage` to write, so the
      // ledger and `state = publishing` are one durable fact.
      return step(
        "reconciling",
        "publishing",
        async (client) => {
          const { intents } = await reconcileAndPlan(
            context.scope,
            {
              provider: context.provider,
              pullRequestId: context.pullRequestId,
              revisionId: context.revisionId,
              runId: context.runId,
            },
            candidates,
            stores,
            client,
            options.config ?? {},
          );
          return { publications: intents };
        },
        ["candidates", "every_candidate_examined"],
      );
    }

    case "publishing":
      // The provider call lives here, and is P1-E.3. Until then the run stops
      // at the commit point rather than pretending to have published.
      return { kind: "settled", state: "publishing" };

    default:
      // Terminal, or a state the orchestrator does not drive.
      return { kind: "settled", state: run.state };
  }
}

/**
 * Advances until the run settles or is refused.
 *
 * Bounded, because an orchestrator that loops on a state it cannot move is a
 * spin: the ceiling is the longest legal path plus slack, and exceeding it is a
 * bug rather than a slow run.
 */
export async function advanceToSettled(
  context: RunContext,
  options: OrchestratorOptions,
  maxSteps = 16,
): Promise<AdvanceOutcome> {
  let last: AdvanceOutcome = { kind: "settled", state: "unknown" };

  for (let step = 0; step < maxSteps; step += 1) {
    last = await advance(context, options);
    if (last.kind !== "advanced") return last;
  }

  throw new Error(
    `Orchestrator exceeded ${String(maxSteps)} steps; the run is not converging`,
  );
}

/**
 * The reconciliation input: candidates paired with what verification concluded.
 *
 * Read from the database rather than recomputed from the analyzer, which is the
 * correction this checkpoint forced. The previous implementation re-ran
 * `analyze()` and matched the results to rows by fingerprint to recover the
 * candidate ids — so the reconciler's view of "what did we claim?" came from
 * running the analyzer a second time, and any nondeterminism in it would have
 * silently dropped candidates from the funnel.
 *
 * A candidate with no attempt keeps a `null` attempt id and is carried into the
 * promotion gate as missing, where the run is blocked. It is deliberately not
 * filtered out here: a candidate that quietly left the review is the failure
 * hardest to see from outside.
 */
async function readReconciliationInput(
  options: OrchestratorOptions,
  runId: string,
): Promise<readonly ReconciledCandidate[]> {
  const rows = await options.verifications.readForReconciliation(runId);

  return rows.map((row): ReconciledCandidate => {
    const attempt =
      row.attemptId === null || row.status === null
        ? // Nothing examined it. Left ABSENT rather than fabricated as an
          // `unavailable` attempt: the promotion gate reports
          // `verification_missing` for it, which sends an operator to the
          // scheduler rather than to the model provider. Both block the run;
          // only the reason says which system is broken.
          undefined
        : row.status === "completed"
          ? ({
              status: "completed" as const,
              decision: row.decision as
                "verified" | "rejected" | "inconclusive",
              reasons: row.reasons as never,
              confidence: row.confidence ?? 0,
              severity: (row.severity ??
                row.proposedSeverity) as FindingSeverity,
            } as const)
          : ({
              status: "unavailable" as const,
              failure: (row.failure ?? "provider_error") as never,
            } as const);

    return {
      candidateId: row.candidateId,
      fingerprintValue: row.fingerprintValue,
      severity: row.proposedSeverity as FindingSeverity,
      category: row.category,
      path: row.path,
      startLine: row.startLine,
      endLine: row.endLine,
      title: row.title,
      claim: row.claim,
      explanation: row.explanation,
      attemptId: row.attemptId ?? "",
      attempt,
    };
  });
}

export { inputDigest };
