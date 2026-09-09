/**
 * The webhook inbox — the ingestion boundary's durability contract.
 *
 * The invariant the whole gateway exists to hold:
 *
 *     authenticate exact bytes → durably own exactly once → acknowledge
 *                              → process asynchronously
 *
 * Each clause is load-bearing, and each fails differently:
 *
 * - **exact bytes**: the signature is an HMAC over the body GitHub sent, so any
 *   re-serialization breaks authentication (see the gateway's raw-body route).
 * - **durably own**: GitHub does **not** automatically redeliver a failed
 *   delivery. A 2xx sent before the work is committed loses the event
 *   permanently if the process dies in the gap — no retry will bring it back.
 * - **exactly once**: a redelivery carries the same `X-GitHub-Delivery`, so the
 *   inbox must recognize it rather than starting a second review.
 * - **asynchronously**: GitHub expects 2xx within 10 seconds. A review takes
 *   minutes.
 *
 * # Why an inbox rather than an idempotency table
 *
 * An idempotency table remembers *that* a delivery happened. The inbox retains
 * the authenticated payload, so a worker crash after acknowledgement does not
 * leave the platform knowing an event existed while unable to process it.
 *
 * That distinction is the same one P1-CONTEXT draws for analysis context:
 * **a digest proves identity; bytes enable replay.** The inbox needs both —
 * the digest to detect a forged duplicate, the bytes to do the work.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * How far a delivery has got.
 *
 * `ignored` is distinct from `processed`: a validly signed delivery for an
 * event the platform has no use for is a successful outcome, and recording it
 * as processed would make "did we do something?" unanswerable. `failed` is
 * terminal after retries; it feeds recovery, because GitHub will not redeliver.
 */
export const DELIVERY_STATES = [
  "received",
  "processing",
  "processed",
  "ignored",
  "failed",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * One authenticated delivery.
 *
 * Written inside the same transaction as the work it schedules. There is no
 * state in which a row exists and its job does not.
 */
export interface WebhookDelivery {
  readonly id: string;
  readonly provider: string;
  /**
   * Which endpoint received it.
   *
   * The uniqueness scope, and not decoration. Delivery ids are unique per
   * *webhook*, and the platform will eventually run more than one — a GitHub
   * App, a per-repository hook during migration, a staging endpoint replaying
   * production traffic. A globally-unique assumption means one endpoint's
   * delivery silently suppresses another's.
   */
  readonly sourceEndpointId: string;
  /** `X-GitHub-Delivery`. Stable across redeliveries of the same event. */
  readonly deliveryId: string;
  readonly event: string;
  /** `action`, where the event has one. Null for events without. */
  readonly action: string | null;
  /**
   * SHA-256 of the **authenticated raw body**.
   *
   * The reason a duplicate can be told from an anomaly. Same id and same digest
   * is a redelivery; same id and a *different* digest means either GitHub
   * reused an id (it does not) or something between GitHub and here rewrote the
   * body. Neither is a duplicate, and `ON CONFLICT DO NOTHING` would discard
   * the evidence.
   */
  readonly bodyDigest: string;
  /** The bytes, retained so a worker can process after a crash. */
  readonly payload: Buffer;
  readonly receivedAt: Date;
  readonly authenticatedAt: Date;
  readonly state: DeliveryState;
  /** Why it was ignored or how it failed. Never secret material. */
  readonly outcomeReason: string | null;
  readonly attempts: number;
  /** Fencing generation for this exact claim. Increments on every reclaim. */
  readonly claimGeneration: number;
}

export const deliveryStateSchema = z.enum(DELIVERY_STATES);

/** What the gateway hands the inbox once a delivery has been authenticated. */
export interface AuthenticatedDelivery {
  readonly provider: string;
  readonly sourceEndpointId: string;
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly bodyDigest: string;
  readonly payload: Buffer;
  readonly receivedAt: Date;
}

/**
 * What happened when the inbox was asked to take ownership.
 *
 * A union rather than a boolean, because the gateway answers differently to
 * each and an operator needs them separated in metrics:
 *
 * | Outcome | HTTP | Meaning |
 * | --- | --- | --- |
 * | `accepted` | 202 | first sight; a job was scheduled |
 * | `duplicate` | 202 | same id, same bytes — a redelivery, already owned |
 * | `conflict` | 409 | same id, **different** bytes — an anomaly, alert |
 *
 * `duplicate` returns 2xx deliberately: GitHub redelivering a delivery we
 * already own is the system working, and a non-2xx would mark the hook as
 * failing in the GitHub UI.
 */
export type IngestOutcome =
  | { readonly kind: "accepted"; readonly delivery: WebhookDelivery }
  | { readonly kind: "duplicate"; readonly delivery: WebhookDelivery }
  | {
      readonly kind: "conflict";
      readonly existing: WebhookDelivery;
      readonly attemptedDigest: string;
    };

/**
 * A unit of work scheduled alongside a delivery.
 *
 * Written in the delivery's transaction. This is the outbox half: the row and
 * the job land together or neither does, so there is no window in which the
 * platform has acknowledged an event with nothing scheduled to handle it.
 */
export interface ScheduledJob {
  readonly id: string;
  readonly deliveryRowId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly availableAt: Date;
  readonly attempts: number;
  /** Monotonic fencing generation for the worker that owns this claim. */
  readonly claimGeneration: number;
}

export interface JobRequest {
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * The port the gateway depends on.
 *
 * An interface because there are two implementations with different purposes:
 * Postgres in production, and an in-memory one for tests that need to inject a
 * crash between two statements. Both are held to the same property suite —
 * a test double that is easier to satisfy than the real store proves nothing.
 */
export interface WebhookInbox {
  /**
   * Takes ownership of a delivery and schedules its work, atomically.
   *
   * Must be a single transaction. The caller acknowledges only after this
   * resolves, so a failure here must leave **nothing** behind: a delivery row
   * with no job is an event that will never be processed and that redelivery
   * cannot fix, because the row makes the next attempt look like a duplicate.
   */
  ingest(
    delivery: AuthenticatedDelivery,
    jobs: readonly JobRequest[],
  ): Promise<IngestOutcome>;

  findDelivery(
    sourceEndpointId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery | undefined>;

  /**
   * Jobs ready to run, claimed on a lease so a dead worker releases them.
   *
   * Ordered oldest first.
   */
  claimJobs(
    limit: number,
    leaseMillis?: number,
  ): Promise<readonly ScheduledJob[]>;

  /** Releases a finished job. A stale claimant must be rejected. */
  completeJob(jobId: string, claimGeneration: number): Promise<void>;

  /**
   * Reschedules healthy coordination without consuming the bounded failure
   * attempt budget (for example, another worker owns verification).
   */
  deferJob(
    jobId: string,
    claimGeneration: number,
    retryAfterMillis?: number,
  ): Promise<void>;

  /** Returns a job for a later attempt, or dead-letters it. */
  releaseJob(
    jobId: string,
    claimGeneration: number,
    options: {
      readonly retryable: boolean;
      readonly errorCode: string;
      readonly retryAfterMillis?: number | undefined;
    },
  ): Promise<{ readonly deadLettered: boolean }>;

  markDeliveryState(
    deliveryRowId: string,
    state: DeliveryState,
    reason?: string,
  ): Promise<void>;
}

/**
 * SHA-256 of the authenticated body, lowercase hex.
 *
 * Computed over the same bytes the signature was verified against — not over a
 * parsed and re-serialized object, which would digest something GitHub never
 * sent and make the conflict check compare the wrong thing.
 */
export function digestBody(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
