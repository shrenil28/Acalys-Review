import type {
  PublicationContent,
  RemotePublication,
  ReviewPublicationPort,
} from "../src/index.js";

/**
 * The shape the real adapter throws.
 *
 * An `Error` subclass rather than a bare object, matching
 * `GithubProviderError` — a double that throws something the production type
 * system would reject is a double that can pass tests the real adapter fails.
 */
class FakeProviderError extends Error {
  public readonly failure: {
    readonly class: "retryable" | "permanent" | "ambiguous";
    readonly code: string;
  };

  public constructor(failure: {
    class: "retryable" | "permanent" | "ambiguous";
    code: string;
  }) {
    super(`fake GitHub: ${failure.code}`);
    this.name = "FakeProviderError";
    this.failure = failure;
  }
}

/**
 * A GitHub double whose rules are copied from the E.3 transcripts.
 *
 * A double that behaves how we *wish* GitHub behaved would make every test
 * below pass while proving nothing, so each rule cites the observation it
 * encodes. Evidence: `docs/review/phase-1/e3-experiment.md`.
 *
 * ```
 * observed                                          encoded as
 * ────────────────────────────────────────────────  ─────────────────────────
 * create with `event` omitted → 200, PENDING,       #createPending
 * body returned verbatim, submitted_at null
 *
 * second create while one is PENDING → 422          #createPending, the
 * "User can only have one pending review per        pendingReviewExists guard
 * pull request"
 *
 * create while a SUBMITTED review exists → 200      the guard checks PENDING
 * (the constraint covers the pending window only)   only — deliberately
 *
 * list returns the pending review WITH its body     #reconcile
 *
 * submit → 200, state COMMENTED, submitted_at set,  #submit
 * SAME review id
 * ```
 *
 * The lost-response switch is the point of the whole class: `loseNextResponse`
 * makes the provider commit the effect and then fail the caller, which is the
 * one ordering that cannot be simulated by throwing before the call.
 */
export class FakeGithub implements ReviewPublicationPort {
  #reviews: {
    id: number;
    body: string;
    pending: boolean;
    commitId: string;
  }[] = [];
  #nextId = 1_000;

  /** Requests, in order, for asserting that no blind create happened. */
  public readonly calls: string[] = [];

  /** Commit the effect, then fail the caller. The dangerous ordering. */
  public loseNextResponse = false;
  /** Fail without committing anything. */
  public failNextWith:
    | { class: "retryable" | "permanent" | "ambiguous"; code: string }
    | undefined;

  public reviews(): readonly { id: number; body: string; pending: boolean }[] {
    return this.#reviews.map((review) => ({ ...review }));
  }

  #maybeFail(): void {
    const failure = this.failNextWith;
    if (failure !== undefined) {
      this.failNextWith = undefined;
      throw new FakeProviderError(failure);
    }
  }

  #maybeLose(): void {
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      // What a dropped connection after a committed write looks like to the
      // caller: no status, no body, and the effect exists anyway.
      throw new FakeProviderError({
        class: "ambiguous",
        code: "transport_failure_on_write",
      });
    }
  }

  #toRemote(review: {
    id: number;
    body: string;
    pending: boolean;
    commitId: string;
  }): RemotePublication {
    return {
      reference: String(review.id),
      nodeId: `PRR_${String(review.id)}`,
      commitId: review.commitId,
      pending: review.pending,
      body: review.body,
    };
  }

  public reconcile(logicalKey: string): Promise<RemotePublication | undefined> {
    this.calls.push(`reconcile:${logicalKey}`);
    this.#maybeFail();
    const marker = `<!-- acalys:publication:${logicalKey} -->`;
    const matches = this.#reviews.filter((review) =>
      review.body.includes(marker),
    );
    if (matches.length > 1) {
      throw new FakeProviderError({
        class: "permanent",
        code: "duplicate_publication_detected",
      });
    }
    const found = matches[0];
    return Promise.resolve(
      found === undefined ? undefined : this.#toRemote(found),
    );
  }

  public createPending(
    logicalKey: string,
    content: PublicationContent,
  ): Promise<RemotePublication> {
    this.calls.push(`create:${logicalKey}`);
    this.#maybeFail();

    // The constraint GitHub actually enforces — and only over pending reviews.
    // A submitted review blocks nothing, which is why a blind retry after a
    // lost submit response duplicates.
    if (this.#reviews.some((review) => review.pending)) {
      throw new FakeProviderError({
        class: "ambiguous",
        code: "pending_review_exists",
      });
    }

    const review = {
      id: (this.#nextId += 1),
      body: `<!-- acalys:publication:${logicalKey} -->\n${content.summary}`,
      pending: true,
      commitId: "9823a185ded39c2075320c0cb48bc09404881803",
    };
    this.#reviews.push(review);

    // Committed first, then the response is lost. Order matters.
    this.#maybeLose();
    return Promise.resolve(this.#toRemote(review));
  }

  public submit(reference: string): Promise<RemotePublication> {
    this.calls.push(`submit:${reference}`);
    this.#maybeFail();

    const review = this.#reviews.find((r) => String(r.id) === reference);
    if (review === undefined) {
      throw new FakeProviderError({ class: "permanent", code: "not_found" });
    }
    review.pending = false;

    this.#maybeLose();
    return Promise.resolve(this.#toRemote(review));
  }

  public confirm(
    reference: string,
    logicalKey: string,
  ): Promise<RemotePublication> {
    this.calls.push(`confirm:${reference}`);
    this.#maybeFail();

    const review = this.#reviews.find((r) => String(r.id) === reference);
    if (review === undefined) {
      throw new FakeProviderError({ class: "permanent", code: "not_found" });
    }
    if (!review.body.includes(`<!-- acalys:publication:${logicalKey} -->`)) {
      throw new FakeProviderError({
        class: "permanent",
        code: "confirmation_identity_mismatch",
      });
    }
    if (review.pending) {
      throw new FakeProviderError({
        class: "ambiguous",
        code: "still_pending_after_submit",
      });
    }
    return Promise.resolve(this.#toRemote(review));
  }

  /** Plants a review nobody asked for — a different writer, same identity. */
  public plant(body: string, pending = false): number {
    const review = {
      id: (this.#nextId += 1),
      body,
      pending,
      commitId: "0000000000000000000000000000000000000000",
    };
    this.#reviews.push(review);
    return review.id;
  }
}
