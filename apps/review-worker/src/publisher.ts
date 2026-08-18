/**
 * Driving the publication ledger to convergence.
 *
 * Provider-neutral on purpose: every GitHub-specific fact lives behind
 * `ReviewPublicationPort`, and every fact this file relies on came from
 * measuring GitHub (`docs/review/phase-1/e3-experiment.md`) rather than from
 * hoping.
 *
 * # The guarantee, stated accurately
 *
 * > Acalys executes publication at least once internally when needed. Stable
 * > publication identity minted before the first request, plus reconciliation
 * > against provider state, make the externally visible result converge
 * > idempotently.
 *
 * Not exactly-once. GitHub exposes no primitive that would make that claim
 * true, and writing it down anyway would be the kind of comment that survives
 * long after anyone remembers it was aspirational.
 *
 * # Reconcile first, always
 *
 * `publishOne` looks up provider state before it creates anything — including
 * on the very first attempt, when nothing can possibly exist yet. One wasted
 * GET buys an invariant that holds without the caller reasoning about which
 * attempt this is:
 *
 *     no create is issued without a preceding lookup.
 *
 * Making the lookup conditional on "have we attempted before?" makes safety
 * depend on the accuracy of local state, which is precisely what a crash
 * destroys.
 */

import { createHash } from "node:crypto";

import type {
  AttemptFailure,
  PublicationIntent,
  PublicationStore,
} from "@acalys/database";

/**
 * What the publisher needs from a provider.
 *
 * Declared here and satisfied *structurally* by
 * `GithubReviewPublisher` — the adapter does not import this interface, and
 * must not: `packages/providers/*` cannot depend on `apps/*` without inverting
 * the platform's dependency direction. Structural typing lets the boundary hold
 * while the shapes stay checked. The interface moves into a shared package when
 * GitLab provides the second implementation that shows which parts are
 * essential rather than GitHub's accident.
 */
export interface RemotePublication {
  readonly reference: string;
  readonly nodeId: string | undefined;
  readonly commitId: string | undefined;
  readonly pending: boolean;
  readonly body: string;
}

export interface PublicationContent {
  readonly summary: string;
  readonly comments: readonly {
    readonly path: string;
    readonly line: number;
    readonly fingerprint: string;
    readonly body: string;
  }[];
}

export interface ReviewPublicationPort {
  reconcile(logicalKey: string): Promise<RemotePublication | undefined>;
  createPending(
    logicalKey: string,
    content: PublicationContent,
  ): Promise<RemotePublication>;
  submit(reference: string): Promise<RemotePublication>;
  confirm(reference: string, logicalKey: string): Promise<RemotePublication>;
}

/** A failure the port raises, carrying how Acalys should treat it. */
export interface PortFailure {
  readonly failure: {
    readonly class: "retryable" | "permanent" | "ambiguous";
    readonly code: string;
  };
}

function isPortFailure(error: unknown): error is PortFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    typeof (error as PortFailure).failure?.class === "string"
  );
}

/**
 * The content a provider review carries, with our identity marker removed.
 *
 * Digested and compared against the ledger, because finding the marker proves
 * only that *a* publication with this identity exists — not that it says what
 * this run intends to say. A marker match with a content mismatch is an
 * invariant violation, and resolving it by overwriting provider state would
 * destroy whatever the other writer published.
 */
export function strippedBody(body: string): string {
  const lines = body.split("\n");
  const first = lines[0] ?? "";
  return (first.startsWith("<!-- acalys:publication:") ? lines.slice(1) : lines)
    .join("\n")
    .trim();
}

export function contentDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A publication whose provider content is not the content we intended.
 *
 * Surfaced loudly and never resolved automatically. Both available resolutions
 * are destructive: overwriting discards someone else's publication, and
 * accepting records a lie in the ledger.
 */
export class PublicationInvariantViolation extends Error {
  public readonly logicalKey: string;

  public constructor(logicalKey: string, detail: string) {
    super(
      `Publication ${logicalKey} exists on the provider but ${detail}. ` +
        "Marker identity matched while content did not; this is not a retry " +
        "and must not be resolved automatically.",
    );
    this.name = "PublicationInvariantViolation";
    this.logicalKey = logicalKey;
  }
}

export type PublishOutcome =
  | { readonly kind: "confirmed"; readonly reference: string }
  | { readonly kind: "already_confirmed" }
  /** Ledger state moved underneath us. Re-read; never retry a refusal. */
  | { readonly kind: "refused"; readonly actualState: string | undefined }
  | {
      readonly kind: "deferred";
      readonly failureClass: "retryable" | "permanent" | "ambiguous";
      readonly code: string;
    };

export interface PublishOptions {
  readonly store: PublicationStore;
  readonly port: ReviewPublicationPort;
  readonly content: PublicationContent;
  readonly now: () => Date;
  /** Backoff for retryable failures. Bounded by the caller, not by this file. */
  readonly retryDelayMs?: number | undefined;
  /**
   * Fault points, so a crash between any two provider steps is testable.
   * Production passes nothing.
   */
  readonly faults?:
    | {
        readonly afterReconcile?: (() => Promise<void>) | undefined;
        readonly afterCreate?: (() => Promise<void>) | undefined;
        readonly afterSubmit?: (() => Promise<void>) | undefined;
      }
    | undefined;
}

/**
 * Converges one ledger row with provider state.
 *
 * One row per call rather than a loop, so a caller can crash between any two
 * rows and a test can place that crash exactly.
 */
export async function publishOne(
  intent: PublicationIntent,
  options: PublishOptions,
): Promise<PublishOutcome> {
  const { store, port, content } = options;

  // A replayed completed run must do nothing at all. Not "do it again
  // harmlessly": the provider would accept a second create.
  if (intent.state === "published") return { kind: "already_confirmed" };
  if (intent.state === "failed") {
    return {
      kind: "deferred",
      failureClass: "permanent",
      code: intent.lastErrorCode ?? "failed",
    };
  }

  let existing: RemotePublication | undefined;
  try {
    existing = await port.reconcile(intent.logicalKey);
    await store.recordReconciliation(intent.id);
    await options.faults?.afterReconcile?.();
  } catch (error) {
    return await recordFailure(intent, error, options);
  }

  if (existing !== undefined) {
    // Identity matched. Content still has to.
    const actual = contentDigest(strippedBody(existing.body));
    if (actual !== intent.contentDigest) {
      throw new PublicationInvariantViolation(
        intent.logicalKey,
        "carries different content than intended",
      );
    }
  }

  const begun = await store.beginAttempt(intent.id, intent.state);
  if (begun.kind !== "moved") {
    // `reconciliation_required` should be unreachable here — the lookup ran
    // moments ago — so reaching it means another worker moved the row after
    // our reconciliation. Reported as a refusal, which is the instruction to
    // re-read rather than to retry.
    return begun.kind === "reconciliation_required"
      ? { kind: "refused", actualState: intent.state }
      : {
          kind: "refused",
          actualState: begun.kind === "refused" ? begun.actualState : undefined,
        };
  }

  try {
    let remote = existing;

    if (remote === undefined) {
      remote = await port.createPending(intent.logicalKey, content);
      await options.faults?.afterCreate?.();
    }

    if (remote.pending) {
      remote = await port.submit(remote.reference);
      await options.faults?.afterSubmit?.();
    }

    // Belief becomes evidence here, and only here.
    const confirmed = await port.confirm(remote.reference, intent.logicalKey);

    const outcome = await store.recordConfirmed(intent.id, "attempting", {
      reference: confirmed.reference,
      nodeId: confirmed.nodeId,
      commitId: confirmed.commitId,
    });

    return outcome.kind === "moved"
      ? { kind: "confirmed", reference: confirmed.reference }
      : {
          kind: "refused",
          actualState:
            outcome.kind === "refused" ? outcome.actualState : undefined,
        };
  } catch (error) {
    return await recordFailure(
      { ...intent, state: "attempting" },
      error,
      options,
    );
  }
}

async function recordFailure(
  intent: PublicationIntent,
  error: unknown,
  options: PublishOptions,
): Promise<PublishOutcome> {
  // A violation is not a failure to retry — it is a claim that two different
  // contents share one identity. Letting it become a ledger state would bury it.
  if (error instanceof PublicationInvariantViolation) throw error;

  if (!isPortFailure(error)) throw error;

  const { class: failureClass, code } = error.failure;
  const failure: AttemptFailure =
    failureClass === "retryable"
      ? {
          kind: "retryable",
          code,
          retryAt: new Date(
            options.now().getTime() + (options.retryDelayMs ?? 30_000),
          ),
        }
      : failureClass === "permanent"
        ? { kind: "permanent", code }
        : { kind: "ambiguous", code };

  await options.store.recordFailure(intent.id, intent.state, failure);
  return { kind: "deferred", failureClass, code };
}
