/**
 * Installation access tokens: minting, caching, invalidation, and the one
 * bounded retry.
 *
 * JWT signing is arithmetic. This file is where a production implementation
 * actually fails, in four specific ways:
 *
 * 1. **Thundering herd.** Forty workers hit an expired entry at once and send
 *    forty token exchanges. Solved by single-flight.
 * 2. **Cross-installation leakage.** A cache key that omits part of the token's
 *    scope hands installation A a token minted for B, or a full-access token to
 *    a caller that asked for a restricted one.
 * 3. **Revocation that does not revoke.** An installation is removed and the
 *    cache keeps serving its token until natural expiry — up to an hour of
 *    calls against a repository the platform no longer has rights to.
 * 4. **Retry loops.** A 401 triggers a refresh, the refresh returns a token
 *    that is also rejected, and the worker spins.
 *
 * Each has a test asserting the property, not an example.
 */

import type { Clock } from "@acalys/contracts/domain";

/**
 * A token as GitHub issued it.
 *
 * `expiresAt` is **GitHub's** value, never `now + 3600`. The documented hour is
 * a current behaviour, not a contract, and computing expiry locally means a
 * clock difference or a shortened lifetime turns into requests that fail with
 * no local explanation.
 */
export interface InstallationToken {
  /** The bearer token. Secret — see {@link redactToken}. */
  readonly token: string;
  /** RFC 3339, exactly as GitHub returned it. */
  readonly expiresAt: string;
  /**
   * Permissions GitHub actually granted.
   *
   * Kept because granted ≠ requested ≠ configured. An owner can remove
   * `pull_requests: write` after installation, and code that assumes "we are
   * installed, therefore we may comment" fails at publication time — after a
   * full review has been paid for.
   */
  readonly permissions: Readonly<Record<string, string>>;
  /** `all`, or `selected` when the installation is scoped to some repositories. */
  readonly repositorySelection?: string | undefined;
}

/**
 * How much earlier than GitHub the cache expires an entry.
 *
 * Without a margin, a token handed out with two seconds left expires mid-clone
 * and the operation fails for no reason a log would explain. Five minutes is
 * comfortably longer than any single GitHub call and far shorter than the
 * hour-long lifetime, so it costs roughly one extra exchange per hour per
 * installation.
 */
export const DEFAULT_EXPIRY_MARGIN_SECONDS = 300;

/**
 * What a caller asks for.
 *
 * Scope is part of the request because GitHub can mint a token restricted to
 * fewer repositories or permissions than the installation holds — and a
 * restricted token must never be satisfied from a cache entry holding a broader
 * one, nor the reverse.
 */
export interface InstallationTokenRequest {
  readonly installationId: number;
  /** Restrict to these repository ids. Omitted means the installation's default. */
  readonly repositoryIds?: readonly number[] | undefined;
  /** Restrict to these permissions. Omitted means all the installation grants. */
  readonly permissions?: Readonly<Record<string, string>> | undefined;
}

/**
 * Performs the exchange with GitHub.
 *
 * A port, not a fetch call. It keeps this module free of HTTP and makes every
 * concurrency and failure property above testable without a network — which is
 * the only way to test them deterministically.
 */
export type InstallationTokenExchange = (
  request: InstallationTokenRequest,
) => Promise<InstallationToken>;

export class InstallationAuthError extends Error {
  public override readonly name = "InstallationAuthError";

  public constructor(
    public readonly installationId: number,
    reason: string,
  ) {
    // No token, no JWT, no key. The installation id is a public identifier.
    super(`Installation ${String(installationId)}: ${reason}`);
  }
}

/**
 * The cache identity for a request.
 *
 * Every dimension that changes what the token *can do* is part of the key.
 * Omitting one is the cross-installation leak: a caller asking for
 * `contents: read` on repository 7 must not receive a cached token granting
 * `contents: write` across the installation, even though that token would
 * "work" — it would silently widen every operation performed with it.
 *
 * Sorted, so key order in the request cannot produce two entries for one scope.
 */
export function cacheKeyFor(request: InstallationTokenRequest): string {
  const repositories =
    request.repositoryIds === undefined
      ? "*"
      : [...request.repositoryIds].sort((a, b) => a - b).join(",");

  const permissions =
    request.permissions === undefined
      ? "*"
      : Object.entries(request.permissions)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([name, level]) => `${name}=${level}`)
          .join(",");

  return `${String(request.installationId)}|${repositories}|${permissions}`;
}

/** Replaces all but the last four characters. For logs and error context. */
export function redactToken(token: string): string {
  return token.length <= 4 ? "[REDACTED]" : `[REDACTED…${token.slice(-4)}]`;
}

interface CacheEntry {
  readonly token: InstallationToken;
  /** Epoch millis at which this entry stops being served. */
  readonly usableUntil: number;
  /** The installation's generation when this was stored. See invalidate(). */
  readonly generation: number;
}

export interface InstallationTokenProviderOptions {
  readonly exchange: InstallationTokenExchange;
  readonly clock: Clock;
  readonly expiryMarginSeconds?: number | undefined;
}

/**
 * Caches installation tokens, with single-flight and immediate invalidation.
 *
 * In-process only, and deliberately so. A shared cache (Redis) would need the
 * token at rest in a second system, and the saving is one exchange per worker
 * per hour — a poor trade against widening where a live credential lives.
 */
export class InstallationTokenProvider {
  readonly #exchange: InstallationTokenExchange;
  readonly #clock: Clock;
  readonly #marginMillis: number;

  readonly #entries = new Map<string, CacheEntry>();
  /** In-flight mints, keyed identically. This is the single-flight table. */
  readonly #inFlight = new Map<string, Promise<InstallationToken>>();
  /**
   * Bumped on invalidation, per installation.
   *
   * Handles the race an entry map alone cannot: a mint is already in flight
   * when revocation arrives. Deleting the cache entry does nothing, because
   * there is no entry yet — the token lands *after* the revocation and would be
   * stored as fresh. Comparing generations at store time discards it.
   */
  readonly #generations = new Map<number, number>();

  public constructor(options: InstallationTokenProviderOptions) {
    const margin = options.expiryMarginSeconds ?? DEFAULT_EXPIRY_MARGIN_SECONDS;
    if (!Number.isInteger(margin) || margin < 0) {
      throw new TypeError("expiryMarginSeconds must be a non-negative integer");
    }
    this.#exchange = options.exchange;
    this.#clock = options.clock;
    this.#marginMillis = margin * 1000;
  }

  /** Cached token if usable; otherwise mints one, joining any mint in flight. */
  public async get(
    request: InstallationTokenRequest,
  ): Promise<InstallationToken> {
    const key = cacheKeyFor(request);
    const generation = this.#generationOf(request.installationId);
    const cached = this.#entries.get(key);

    if (
      cached !== undefined &&
      cached.generation === generation &&
      this.#nowMillis() < cached.usableUntil
    ) {
      return cached.token;
    }

    // Second caller onwards joins the promise already running. This is the
    // whole of single-flight: forty callers, one exchange.
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing;

    const pending = this.#mint(request, key, generation);
    this.#inFlight.set(key, pending);

    try {
      return await pending;
    } finally {
      // Cleared in `finally` rather than after storing, so a *failed* mint does
      // not leave a rejected promise in the table for every later caller to
      // join — which would turn one transient GitHub error into a permanently
      // broken installation.
      this.#inFlight.delete(key);
    }
  }

  async #mint(
    request: InstallationTokenRequest,
    key: string,
    generation: number,
  ): Promise<InstallationToken> {
    const token = await this.#exchange(request);

    const expiresAtMillis = Date.parse(token.expiresAt);
    if (Number.isNaN(expiresAtMillis)) {
      throw new InstallationAuthError(
        request.installationId,
        `GitHub returned an unparseable expiry: ${token.expiresAt}`,
      );
    }

    // An invalidation that arrived while this was in flight. The token is still
    // returned — the caller's request will fail with a 401 and take the bounded
    // retry path — but it is never cached, so it cannot outlive the revocation.
    if (this.#generationOf(request.installationId) !== generation) {
      return token;
    }

    const usableUntil = expiresAtMillis - this.#marginMillis;

    // A token already inside the margin is returned but not cached: storing it
    // would guarantee a miss on the very next call while occupying the entry.
    if (usableUntil > this.#nowMillis()) {
      this.#entries.set(key, { token, usableUntil, generation });
    }

    return token;
  }

  /**
   * Drops every cached credential for an installation.
   *
   * Called when an `installation` or `installation_repositories` event says
   * access was removed or narrowed. Clears **all** scopes for the installation,
   * not one key: a narrowed installation invalidates broad and restricted
   * tokens alike, and enumerating which is which invites missing one.
   */
  public invalidate(installationId: number): void {
    this.#generations.set(
      installationId,
      this.#generationOf(installationId) + 1,
    );

    const prefix = `${String(installationId)}|`;
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  /** Everything, for shutdown or a global credential rotation. */
  public invalidateAll(): void {
    for (const installationId of new Set([
      ...this.#generations.keys(),
      ...[...this.#entries.keys()].map((key) => Number(key.split("|")[0])),
    ])) {
      this.#generations.set(
        installationId,
        this.#generationOf(installationId) + 1,
      );
    }
    this.#entries.clear();
  }

  /** Cached entry count. Diagnostics only; never a correctness signal. */
  public get size(): number {
    return this.#entries.size;
  }

  #generationOf(installationId: number): number {
    return this.#generations.get(installationId) ?? 0;
  }

  #nowMillis(): number {
    return Date.parse(this.#clock.now());
  }
}

/**
 * Whether a failure means "this credential is no longer good".
 *
 * Only 401. A 403 is a *permissions* problem — the token is valid and the
 * operation is not allowed — and refreshing it produces an identical token and
 * an identical 403. Treating 403 as re-authenticable is how a permission
 * removal becomes an infinite loop instead of a clear error.
 */
export function isAuthenticationFailure(status: number): boolean {
  return status === 401;
}

export interface AuthenticatedAttempt<T> {
  readonly result: T;
  /** How many times the operation ran. 1 normally, 2 after one refresh. */
  readonly attempts: number;
}

/**
 * Runs an operation with an installation token, refreshing **at most once**.
 *
 *     attempt 1  →  401  →  invalidate  →  mint  →  attempt 2  →  surface
 *
 * Not a loop. A `while (status === 401) refresh()` spins forever when the
 * credential is structurally wrong — a revoked installation, a rotated key, a
 * clock so far out that every JWT is rejected — burning rate limit and hiding
 * the actual cause behind an unbounded retry.
 *
 * The second failure is surfaced as-is. One retry absorbs the expected race
 * (a token that expired between the cache check and the request); anything
 * beyond that is a real fault and should be visible.
 */
export async function withInstallationAuth<T>(
  provider: InstallationTokenProvider,
  request: InstallationTokenRequest,
  operation: (token: InstallationToken) => Promise<T>,
  isAuthFailure: (error: unknown) => boolean,
): Promise<AuthenticatedAttempt<T>> {
  const first = await provider.get(request);
  try {
    return { result: await operation(first), attempts: 1 };
  } catch (error) {
    if (!isAuthFailure(error)) throw error;

    provider.invalidate(request.installationId);
    const second = await provider.get(request);
    // No guard around this one: a second 401 propagates, which is the point.
    return { result: await operation(second), attempts: 2 };
  }
}
