/**
 * The worker loop: claim, process, settle, repeat.
 *
 * Deliberately a poll loop over the database rather than a message broker.
 * The delivery is *already* durable in Postgres by the time a job exists — the
 * outbox pattern P1-C established — so adding a broker would introduce a second
 * system that can disagree with it, and the failure mode of that disagreement
 * is a review that was acknowledged and never runs.
 *
 * Polling costs one indexed query per interval. That is a real cost and a small
 * one, and it buys a system with exactly one durable source of truth.
 *
 * # What the loop guarantees
 *
 *     claim on a lease  →  process  →  settle  →  release
 *
 * If the process dies anywhere in that chain, the lease lapses and the job is
 * claimed again. Because the pipeline converges, the second execution reaches
 * the same rows rather than duplicating them — which is why the loop needs no
 * recovery logic of its own.
 */

import type {
  ReviewIngestionStore,
  ScheduledJob,
  WebhookInbox,
} from "@acalys/database";

import { ingestDelivery, type PipelineOutcome, type PipelinePolicyResolver } from "./pipeline.js";

export type WorkerOutcomeKind =
  | PipelineOutcome["kind"]
  | "review_deferred"
  | "review_retryable_failure"
  | "review_permanent_failure";

export type ReviewExecutionOutcome =
  | {
      readonly kind: "settled";
      readonly state: "publishing" | "completed" | "failed" | "cancelled" | "superseded";
    }
  | { readonly kind: "deferred"; readonly state: string }
  | { readonly kind: "retryable_failure"; readonly errorCode: string }
  | { readonly kind: "permanent_failure"; readonly errorCode: string };

/**
 * Required worker-to-review-lifecycle boundary.
 *
 * The inbox worker may not acknowledge current review work merely because the
 * ReviewRun row exists. Production composition must drive the resumable review
 * lifecycle through this port and return only after it either reaches a
 * terminal run state or explicitly classifies why ownership should remain owed.
 */
export interface ReviewExecutionPort {
  execute(input: {
    readonly runId: string;
    readonly revisionId: string;
    readonly pullRequestId: string;
    readonly deliveryRowId: string;
  }): Promise<ReviewExecutionOutcome>;
}

export interface WorkerObserver {
  readonly onOutcome?: (event: {
    readonly jobId: string;
    readonly outcome: WorkerOutcomeKind;
    readonly errorCode?: string | undefined;
    readonly deadLettered?: boolean | undefined;
  }) => void;
  readonly onError?: (error: unknown) => void;
}

export interface WorkerOptions {
  readonly inbox: WebhookInbox;
  readonly store: ReviewIngestionStore;
  readonly policy?: PipelinePolicyResolver | undefined;
  readonly reviewExecution: ReviewExecutionPort;
  /** Jobs claimed per poll. */
  readonly batchSize?: number | undefined;
  /**
   * How long a claim is held.
   *
   * Must comfortably exceed the slowest realistic processing time. Too short
   * and a healthy worker has its job stolen mid-flight, so two workers process
   * the same delivery concurrently — survivable, because the writes converge,
   * but wasteful and confusing in logs.
   */
  readonly leaseMillis?: number | undefined;
  readonly pollIntervalMillis?: number | undefined;
  /** Backoff applied to a retryable failure before the job is available again. */
  readonly retryBackoffMillis?: number | undefined;
  readonly observer?: WorkerObserver | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface RunningWorker {
  /**
   * Begins polling.
   *
   * Explicit rather than automatic. A constructor that starts consuming work is
   * surprising — and untestable: a background poll races every assertion, which
   * is exactly how the first version of this file made `tick()` return zero
   * because the loop had already claimed the batch.
   */
  start(): void;
  /** Stops after the in-flight batch completes. */
  stop(): Promise<void>;
  /** Processes one batch and returns how many jobs it handled. */
  tick(): Promise<number>;
}

export function createWorker(options: WorkerOptions): RunningWorker {
  const batchSize = options.batchSize ?? 10;
  const leaseMillis = options.leaseMillis ?? 300_000;
  const pollIntervalMillis = options.pollIntervalMillis ?? 1_000;
  const retryBackoffMillis = options.retryBackoffMillis ?? 5_000;
  const report = options.observer?.onOutcome ?? (() => undefined);
  const reportError = options.observer?.onError ?? (() => undefined);

  let stopping = false;
  let running: Promise<void> | undefined;

  async function handle(job: ScheduledJob): Promise<void> {
    const delivery = await findDelivery(job);
    if (delivery === undefined) {
      // The delivery row is gone — only possible if it was deleted, since the
      // job has a cascading foreign key. Nothing can be done with the job, and
      // retrying would spin.
      await options.inbox.releaseJob(job.id, job.claimGeneration, {
        retryable: false,
        errorCode: "acalys.error.delivery-missing",
      });
      report({
        jobId: job.id,
        outcome: "permanent_failure",
        deadLettered: true,
      });
      return;
    }

    const outcome = await ingestDelivery(delivery, {
      store: options.store,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    switch (outcome.kind) {
      case "ingested": {
        // The pipeline has already persisted a terminal superseded state for a
        // stale revision. No model work is owed for code the repository has
        // moved past, so this delivery can settle without dispatching analysis.
        if (outcome.stale) {
          await options.inbox.markDeliveryState(delivery.id, "processed");
          await options.inbox.completeJob(job.id, job.claimGeneration);
          report({ jobId: job.id, outcome: outcome.kind });
          return;
        }

        const execution = await options.reviewExecution.execute({
          runId: outcome.runId,
          revisionId: outcome.revisionId,
          pullRequestId: outcome.pullRequestId,
          deliveryRowId: delivery.id,
        });

        switch (execution.kind) {
          case "settled":
            await options.inbox.markDeliveryState(delivery.id, "processed");
            await options.inbox.completeJob(job.id, job.claimGeneration);
            report({ jobId: job.id, outcome: outcome.kind });
            return;

          case "deferred":
            await options.inbox.deferJob(
              job.id,
              job.claimGeneration,
              retryBackoffMillis,
            );
            report({ jobId: job.id, outcome: "review_deferred" });
            return;

          case "retryable_failure":
          case "permanent_failure": {
            const released = await options.inbox.releaseJob(
              job.id,
              job.claimGeneration,
              {
                retryable: execution.kind === "retryable_failure",
                errorCode: execution.errorCode,
                retryAfterMillis:
                  execution.kind === "retryable_failure"
                    ? retryBackoffMillis
                    : 0,
              },
            );
            if (released.deadLettered) {
              await options.inbox.markDeliveryState(
                delivery.id,
                "failed",
                execution.errorCode,
              );
            }
            report({
              jobId: job.id,
              outcome:
                execution.kind === "retryable_failure"
                  ? "review_retryable_failure"
                  : "review_permanent_failure",
              errorCode: execution.errorCode,
              deadLettered: released.deadLettered,
            });
            return;
          }
        }
      }

      case "ignored":
        // Distinct from processed, so "did we act on this?" stays answerable.
        await options.inbox.markDeliveryState(
          delivery.id,
          "ignored",
          outcome.reason,
        );
        await options.inbox.completeJob(job.id, job.claimGeneration);
        report({ jobId: job.id, outcome: outcome.kind });
        return;

      case "retryable_failure":
      case "permanent_failure": {
        const released = await options.inbox.releaseJob(
          job.id,
          job.claimGeneration,
          {
            retryable: outcome.kind === "retryable_failure",
            errorCode: outcome.errorCode,
            retryAfterMillis:
              outcome.kind === "retryable_failure" ? retryBackoffMillis : 0,
          },
        );
        if (released.deadLettered) {
          // Terminal. The delivery is marked failed so recovery can find it —
          // GitHub will not redeliver, so this row is the only remaining
          // record that work was owed.
          await options.inbox.markDeliveryState(
            delivery.id,
            "failed",
            outcome.errorCode,
          );
        }
        report({
          jobId: job.id,
          outcome: outcome.kind,
          errorCode: outcome.errorCode,
          deadLettered: released.deadLettered,
        });
        return;
      }
    }
  }

  /**
   * Reads the delivery a job belongs to.
   *
   * The job carries only a row id; the bytes live on the delivery. That
   * indirection is deliberate — a job is a small, cheap, frequently-updated
   * row, and copying a 25 MiB payload into it per attempt would be absurd.
   */
  async function findDelivery(job: ScheduledJob) {
    return options.store.findDeliveryById(job.deliveryRowId);
  }

  async function tick(): Promise<number> {
    const jobs = await options.inbox.claimJobs(batchSize, leaseMillis);
    for (const job of jobs) {
      try {
        await handle(job);
      } catch (error) {
        // A failure *outside* the pipeline's own classification — the release
        // call itself failing, say. The lease is left to lapse rather than
        // guessing; that is the one recovery path guaranteed to work.
        reportError(error);
      }
    }
    return jobs.length;
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      const handled = await tick().catch((error: unknown) => {
        reportError(error);
        return 0;
      });

      // Only sleep when there was nothing to do. A busy queue is drained at
      // full speed rather than one batch per interval.
      if (handled === 0 && !stopping) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMillis));
      }
    }
  }

  return {
    start(): void {
      // Idempotent: calling start twice must not run two loops against one
      // inbox, which would double the claim rate and halve the lease headroom.
      running ??= loop();
    },
    async stop(): Promise<void> {
      stopping = true;
      await running;
      running = undefined;
    },
    tick,
  };
}
