export interface SharedRequestLease<T> {
  readonly promise: Promise<T>;
  readonly release: () => void;
}

interface Entry<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  refs: number;
  settled: boolean;
  expiresAt: number;
}

/**
 * Small in-memory request pool for read-only dashboard resources.
 *
 * - concurrent consumers share one fetch;
 * - a navigation/unmount releases its lease;
 * - the underlying fetch is aborted only when the last pending consumer leaves;
 * - settled results can be reused for a short TTL to avoid immediate refetches.
 *
 * The pool never logs keys. Callers may include a credential identity in a key
 * to prevent cross-session result reuse without exposing that identity anywhere
 * outside process memory.
 */
export class SharedRequestPool {
  readonly #entries = new Map<string, Entry<unknown>>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error("shared request TTL must be a finite non-negative number");
    }
  }

  acquire<T>(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    reusable: (value: T) => boolean = () => true,
  ): SharedRequestLease<T> {
    const now = this.now();
    let entry = this.#entries.get(key) as Entry<T> | undefined;

    if (entry !== undefined && entry.settled && entry.expiresAt <= now) {
      this.#entries.delete(key);
      entry = undefined;
    }

    if (entry === undefined) {
      const controller = new AbortController();
      // Assigned before the promise chain can run; the closure updates this
      // exact cache entry when it settles.
      // eslint-disable-next-line prefer-const
      let created!: Entry<T>;
      let retain = false;
      const promise = Promise.resolve()
        .then(() => load(controller.signal))
        .then((value) => {
          retain = reusable(value);
          return value;
        })
        .finally(() => {
          created.settled = true;
          created.expiresAt = retain ? this.now() + this.ttlMs : this.now();
        });
      created = {
        controller,
        promise,
        refs: 0,
        settled: false,
        expiresAt: Number.POSITIVE_INFINITY,
      };
      entry = created;
      this.#entries.set(key, created);
    }

    entry.refs += 1;
    let released = false;
    return {
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        entry.refs -= 1;
        if (entry.refs === 0 && !entry.settled) {
          entry.controller.abort();
          if (this.#entries.get(key) === entry) this.#entries.delete(key);
        }
      },
    };
  }

  /** Used when an authenticated browser session is explicitly replaced. */
  clear(): void {
    for (const entry of this.#entries.values()) {
      if (!entry.settled) entry.controller.abort();
    }
    this.#entries.clear();
  }
}
