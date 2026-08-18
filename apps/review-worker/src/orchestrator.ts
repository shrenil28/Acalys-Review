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
  ReviewIngestionStore,
  ReviewStageStore,
  StageWork,
  TenantScope,
} from "@acalys/database";

import {
  analyze,
  inputDigest,
  planPublications,
  reconcile,
  verify,
  type AnalysisInput,
} from "./stages.js";

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

  const step = async (
    from: string,
    to: string,
    produce: () => StageWork,
    prerequisites: readonly (
      "candidates" | "verifications" | "findings"
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
      return step("preparing", "analyzing", () => ({
        candidates: analyze(input),
      }));

    case "analyzing":
      // `reviewing` is where a real implementation would enrich candidates.
      // The stub produces nothing new, and the prerequisite check still runs —
      // it is the guard against an externally corrupted database.
      return step("analyzing", "reviewing", () => ({}), ["candidates"]);

    case "reviewing": {
      const outputs = await options.stages.readOutputs(context.runId);
      return step(
        "reviewing",
        "verifying",
        () => ({ verifications: verify(outputs.candidates) }),
        ["candidates"],
      );
    }

    case "verifying": {
      const outputs = await options.stages.readOutputs(context.runId);
      const candidates = analyze(input).map((candidate) => ({
        ...candidate,
        id:
          outputs.candidates.find(
            (row) => row.fingerprintValue === candidate.fingerprintValue,
          )?.id ?? "",
      }));
      const verifications = verify(outputs.candidates);

      return step(
        "verifying",
        "reconciling",
        () => ({ findings: reconcile(candidates, verifications) }),
        ["candidates", "verifications"],
      );
    }

    case "reconciling": {
      const outputs = await options.stages.readOutputs(context.runId);
      // The intents are written **here**, in the transition into `publishing`,
      // so the obligation is durable before the run becomes uninterruptible.
      return step(
        "reconciling",
        "publishing",
        () => ({
          publications: planPublications(
            {
              organizationId: context.scope.organizationId,
              repositoryId: context.scope.repositoryId,
              provider: context.provider,
              pullRequestId: context.pullRequestId,
              revisionId: context.revisionId,
              runId: context.runId,
            },
            outputs.findings,
          ),
        }),
        ["candidates", "verifications"],
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

export { inputDigest };
