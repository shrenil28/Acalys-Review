import {
  type ReviewDispatchStore,
  StaleReviewDispatchClaim,
  type ReviewDispatchClaim,
  type ReviewDispatchExecutionGuard,
} from "@acalys/database";
import type { ReviewExecutionPort } from "./worker.js";

export interface ApiDispatchWorkerOptions {
  readonly store: ReviewDispatchStore;
  readonly reviewExecution: ReviewExecutionPort;
  readonly batchSize?: number | undefined;
  readonly leaseMillis?: number | undefined;
  readonly pollIntervalMillis?: number | undefined;
  readonly retryBackoffMillis?: number | undefined;
  readonly observer?:
    { readonly onError?: ((error: unknown) => void) | undefined } | undefined;
}

export interface RunningApiDispatchWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<number>;
}

export function createApiDispatchWorker(
  options: ApiDispatchWorkerOptions,
): RunningApiDispatchWorker {
  const batchSize = options.batchSize ?? 10;
  const leaseMillis = options.leaseMillis ?? 60_000;
  const pollMillis = options.pollIntervalMillis ?? 1_000;
  const retryBackoff = options.retryBackoffMillis ?? 5_000;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const reportError = (error: unknown): void => {
    options.observer?.onError?.(error);
  };

  const settle = async (
    claim: ReviewDispatchClaim,
    outcome: Awaited<ReturnType<ReviewExecutionPort["execute"]>>,
  ): Promise<void> => {
    switch (outcome.kind) {
      case "settled":
        await options.store.complete(claim.reviewRunId, claim.claimGeneration);
        return;
      case "deferred":
        await options.store.defer(
          claim.reviewRunId,
          claim.claimGeneration,
          pollMillis,
        );
        return;
      case "retryable_failure":
        await options.store.release(
          claim.reviewRunId,
          claim.claimGeneration,
          retryBackoff,
          outcome.errorCode,
        );
        return;
      case "permanent_failure":
        await options.store.deadLetter(
          claim.reviewRunId,
          claim.claimGeneration,
          outcome.errorCode,
        );
        return;
    }
  };

  const executeOwnedClaim = async (
    claim: ReviewDispatchClaim,
    guard: ReviewDispatchExecutionGuard,
  ): Promise<void> => {
    let leaseLost = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatChain: Promise<void> = Promise.resolve();
    const heartbeatMillis = Math.max(10, Math.floor(leaseMillis / 3));

    const pulse = (): void => {
      heartbeatChain = heartbeatChain
        .then(async () => {
          if (leaseLost) return;
          if (!(await guard.renew(leaseMillis))) leaseLost = true;
        })
        .catch((error) => {
          leaseLost = true;
          reportError(error);
        });
    };

    heartbeatTimer = setInterval(pulse, heartbeatMillis);
    heartbeatTimer.unref?.();

    try {
      const outcome = await options.reviewExecution.execute({
        runId: claim.reviewRunId,
        revisionId: claim.revisionId,
        pullRequestId: claim.pullRequestId,
        deliveryRowId: `api:${claim.reviewRunId}`,
      });

      // Stop renewal before settling. This makes the last renewal result a stable
      // ownership decision rather than racing a DELETE/defer with an in-flight
      // heartbeat query.
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      await heartbeatChain;
      if (leaseLost) return;

      await settle(claim, outcome);
    } finally {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      await heartbeatChain;
      await guard.release();
    }
  };

  const handleClaim = async (claim: ReviewDispatchClaim): Promise<void> => {
    try {
      const acquisition = await options.store.acquireExecutionGuard(
        claim.reviewRunId,
        claim.claimGeneration,
      );
      switch (acquisition.kind) {
        case "busy":
          // Another live process owns the execution fence. Never rewrite this
          // generation here: doing so would fence the legitimate owner. Its
          // heartbeat/settlement remains authoritative, and a crashed owner is
          // recovered by the ordinary lease-expiry path.
          return;
        case "stale":
          return;
        case "settled":
          // The lifecycle became terminal/publishing between claim and execution.
          // No review work is owed; remove only this generation's dispatch row.
          await options.store.complete(
            claim.reviewRunId,
            claim.claimGeneration,
          );
          return;
        case "owned":
          await executeOwnedClaim(claim, acquisition.guard);
          return;
      }
    } catch (error) {
      if (error instanceof StaleReviewDispatchClaim) return;
      reportError(error);
    }
  };

  const runOnce = async (): Promise<number> => {
    const claims = await options.store.claim(batchSize, leaseMillis);
    for (const claim of claims) await handleClaim(claim);
    return claims.length;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = runOnce()
        .then(() => undefined)
        .catch(reportError)
        .finally(() => {
          inFlight = undefined;
          schedule();
        });
    }, pollMillis);
  };

  return {
    start() {
      if (!stopped && timer === undefined && inFlight === undefined) schedule();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await inFlight;
    },
    runOnce,
  };
}
