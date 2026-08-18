/**
 * Publishing a review to GitHub, and recovering when the answer is lost.
 *
 * Written only after P1-E.3 measured the provider. Every classification below
 * is a recorded observation, not an inference from the API reference; the
 * transcripts are summarized in `docs/review/phase-1/e3-experiment.md`.
 *
 * # The protocol, and the one fact that shapes it
 *
 * ```
 *     reconcile ──found?──▶ verify content ──▶ submit if still pending ──▶ confirm
 *          │
 *          └──not found──▶ create pending ──▶ submit ──▶ confirm
 * ```
 *
 * Reconciliation comes first, always. Not for tidiness:
 *
 *     create → lost response → retry create
 *         GitHub refuses (422). A blind retry cannot duplicate.
 *
 *     create → submit → lost response → retry create
 *         GitHub ACCEPTS. A blind retry produces a second review, visible to
 *         everyone watching the pull request.
 *
 * The provider protects the first window and nothing else. Reconciliation is
 * what protects the second, and the body marker is what makes reconciliation
 * possible.
 *
 * # Why 5xx on a write is not "retryable"
 *
 * A 502 from a proxy means the request may have reached GitHub and succeeded.
 * Calling that retryable licenses an immediate re-POST, which is precisely the
 * duplicate-producing move. On a **mutating** request an unclear failure is
 * `ambiguous`: the effect may exist, and the recovery is a lookup, not a retry.
 * On a read it is genuinely retryable, because a failed read changed nothing.
 *
 * That asymmetry is the difference between converging and publishing twice, and
 * it is invisible if errors are classified by status code alone.
 */

import {
  carriesPublication,
  findingMarker,
  publicationMarker,
} from "./markers.js";

/** How Acalys should treat a provider failure. See the module note on 5xx. */
export type ProviderFailureClass = "retryable" | "permanent" | "ambiguous";

export interface ProviderFailure {
  readonly class: ProviderFailureClass;
  /** Stable, low-cardinality, and safe to store. Never a provider message. */
  readonly code: string;
  readonly status?: number | undefined;
}

/** A review as it exists on the provider, reduced to what reconciliation needs. */
export interface RemoteReview {
  readonly reference: string;
  readonly nodeId: string | undefined;
  readonly commitId: string | undefined;
  /** `true` when the review is still a draft — GitHub's `submitted_at` is null. */
  readonly pending: boolean;
  readonly body: string;
}

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly fingerprint: string;
  readonly body: string;
}

export interface ReviewContent {
  readonly summary: string;
  readonly comments: readonly InlineComment[];
}

/** The HTTP seam. Injected so the protocol is testable without a network. */
export type GithubRequest = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ readonly status: number; readonly body: unknown }>;

export class GithubProviderError extends Error {
  public readonly failure: ProviderFailure;

  public constructor(failure: ProviderFailure) {
    // The message carries the code, never the provider's text: GitHub echoes
    // request material into `message`, and error strings end up in logs.
    super(`GitHub publication failed: ${failure.code}`);
    this.name = "GithubProviderError";
    this.failure = failure;
  }
}

/** The 422 that means "a pending review already exists", verbatim from E.3. */
const PENDING_REVIEW_EXISTS =
  "User can only have one pending review per pull request";

function errorText(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const record = body as { message?: unknown; errors?: unknown };
  // Only string-shaped values are read. GitHub's `errors` can contain objects,
  // and coercing one yields "[object Object]" — a classifier that matches on
  // that would branch on a stringification artifact.
  const message = typeof record.message === "string" ? record.message : "";
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((entry) => typeof entry === "string").join(" ")
    : "";
  return `${message} ${errors}`;
}

/**
 * Turns an HTTP result into a decision about what to do next.
 *
 * `mutating` is not a nicety. The same status means different things depending
 * on whether the request could have changed provider state.
 */
export function classifyFailure(
  status: number,
  body: unknown,
  mutating: boolean,
): ProviderFailure | undefined {
  if (status >= 200 && status < 300) return undefined;

  // The 422 that is really "your create already happened". Treating it as a
  // permanent input error would abandon a review that exists and is pending;
  // treating it as retryable would re-POST forever. It is neither: it is a
  // statement that provider state must be re-read.
  if (status === 422 && errorText(body).includes(PENDING_REVIEW_EXISTS)) {
    return { class: "ambiguous", code: "pending_review_exists", status };
  }

  if (status === 401)
    return { class: "permanent", code: "unauthenticated", status };
  if (status === 403) {
    // A 403 carrying rate-limit language is a throttle, not a permission
    // problem, and GitHub uses 403 for both.
    const text = errorText(body).toLowerCase();
    if (text.includes("rate limit") || text.includes("abuse")) {
      return { class: "retryable", code: "rate_limited", status };
    }
    return { class: "permanent", code: "forbidden", status };
  }
  if (status === 404) return { class: "permanent", code: "not_found", status };
  if (status === 410) return { class: "permanent", code: "gone", status };
  if (status === 422)
    return { class: "permanent", code: "unprocessable", status };
  if (status === 429)
    return { class: "retryable", code: "rate_limited", status };

  if (status >= 500) {
    return mutating
      ? // The effect may exist. Only a lookup can tell.
        { class: "ambiguous", code: "server_error_on_write", status }
      : { class: "retryable", code: "server_error", status };
  }

  return mutating
    ? { class: "ambiguous", code: "unexpected_status_on_write", status }
    : { class: "retryable", code: "unexpected_status", status };
}

/**
 * Classifies a thrown transport error.
 *
 * A request that never produced a status is the worst case on a write: it may
 * have been delivered and answered into a closed socket.
 */
export function classifyTransportError(mutating: boolean): ProviderFailure {
  return mutating
    ? { class: "ambiguous", code: "transport_failure_on_write" }
    : { class: "retryable", code: "transport_failure" };
}

interface RawReview {
  id?: number;
  node_id?: string;
  commit_id?: string;
  submitted_at?: string | null;
  state?: string;
  body?: string;
}

function toRemote(raw: RawReview): RemoteReview {
  return {
    reference: String(raw.id ?? ""),
    nodeId: raw.node_id,
    commitId: raw.commit_id,
    // `submitted_at === null` rather than `state === "PENDING"`. E.3 confirmed
    // both, and the timestamp is the more direct fact: it is absent exactly
    // while the review is a draft, and present the moment it is not.
    pending: (raw.submitted_at ?? null) === null,
    body: raw.body ?? "",
  };
}

export class GithubReviewPublisher {
  readonly #request: GithubRequest;
  readonly #owner: string;
  readonly #repo: string;
  readonly #pullNumber: number;

  public constructor(options: {
    readonly request: GithubRequest;
    readonly owner: string;
    readonly repo: string;
    readonly pullNumber: number;
  }) {
    this.#request = options.request;
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#pullNumber = options.pullNumber;
  }

  get #base(): string {
    return `/repos/${this.#owner}/${this.#repo}/pulls/${String(this.#pullNumber)}`;
  }

  async #call(
    method: string,
    path: string,
    body: unknown,
    mutating: boolean,
  ): Promise<{ status: number; body: unknown }> {
    let response: { status: number; body: unknown };
    try {
      response = await this.#request(method, path, body);
    } catch {
      // The error itself is deliberately not inspected or propagated: a
      // transport error can carry the request, and the request carries the
      // Authorization header.
      throw new GithubProviderError(classifyTransportError(mutating));
    }

    const failure = classifyFailure(response.status, response.body, mutating);
    if (failure !== undefined) throw new GithubProviderError(failure);
    return response;
  }

  /**
   * Looks for an existing publication carrying this identity.
   *
   * One list call, because E.3 confirmed GitHub returns the body of a PENDING
   * review in the list response. Returns `undefined` for "provider state does
   * not contain it", which is a different fact from "the lookup failed" — the
   * latter throws, because acting on a failed lookup as though it were an empty
   * result is how a blind create happens.
   */
  public async reconcile(
    logicalKey: string,
  ): Promise<RemoteReview | undefined> {
    const response = await this.#call(
      "GET",
      `${this.#base}/reviews?per_page=100`,
      undefined,
      false,
    );

    const reviews = Array.isArray(response.body)
      ? (response.body as RawReview[])
      : [];
    const matches = reviews.filter((review) =>
      carriesPublication(review.body, logicalKey),
    );

    if (matches.length > 1) {
      // Two reviews carrying one identity is the duplicate this whole protocol
      // exists to prevent. Never resolve it by picking one.
      throw new GithubProviderError({
        class: "permanent",
        code: "duplicate_publication_detected",
      });
    }

    const found = matches[0];
    return found === undefined ? undefined : toRemote(found);
  }

  /** Creates a PENDING review carrying the marker and the inline findings. */
  public async createPending(
    logicalKey: string,
    content: ReviewContent,
  ): Promise<RemoteReview> {
    const response = await this.#call(
      "POST",
      `${this.#base}/reviews`,
      {
        body: `${publicationMarker(logicalKey)}\n${content.summary}`,
        comments: content.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: "RIGHT",
          body: `${findingMarker(comment.fingerprint)}\n${comment.body}`,
        })),
      },
      true,
    );

    return toRemote(response.body as RawReview);
  }

  /** Submits a pending review. Idempotent only via reconciliation, never blindly. */
  public async submit(reference: string): Promise<RemoteReview> {
    const response = await this.#call(
      "POST",
      `${this.#base}/reviews/${reference}/events`,
      { event: "COMMENT" },
      true,
    );
    return toRemote(response.body as RawReview);
  }

  /**
   * Re-reads the review and requires it to be submitted and still ours.
   *
   * The step that turns a 2xx into evidence. `published` in the ledger means
   * this returned, not that a request came back 200 — a response can be lost
   * after the provider committed, and a ledger that records belief makes the
   * `completed` entailment satisfiable without any provider state at all.
   */
  public async confirm(
    reference: string,
    logicalKey: string,
  ): Promise<RemoteReview> {
    const response = await this.#call(
      "GET",
      `${this.#base}/reviews/${reference}`,
      undefined,
      false,
    );
    const review = toRemote(response.body as RawReview);

    if (!carriesPublication(review.body, logicalKey)) {
      throw new GithubProviderError({
        class: "permanent",
        code: "confirmation_identity_mismatch",
      });
    }
    if (review.pending) {
      throw new GithubProviderError({
        class: "ambiguous",
        code: "still_pending_after_submit",
      });
    }

    return review;
  }

  /** The inline comments GitHub actually stored for a review. */
  public async listComments(
    reference: string,
  ): Promise<readonly { readonly body: string; readonly path: string }[]> {
    const response = await this.#call(
      "GET",
      `${this.#base}/reviews/${reference}/comments`,
      undefined,
      false,
    );
    const raw = Array.isArray(response.body)
      ? (response.body as { body?: string; path?: string }[])
      : [];
    return raw.map((comment) => ({
      body: comment.body ?? "",
      path: comment.path ?? "",
    }));
  }
}
