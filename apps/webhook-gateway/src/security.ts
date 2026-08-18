/**
 * Hardening for a public endpoint.
 *
 * The webhook route is the only address in the platform a stranger can reach.
 * Signature verification decides *authenticity*; nothing in it limits how often
 * someone may make the platform do work, how long they may hold a connection,
 * or what a failure discloses. Those are separate problems, and each has bitten
 * real services.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  createClientIdentity,
  type ClientIdentityOptions,
} from "./client-identity.js";

/**
 * Rejects a webhook secret weak enough to be guessed.
 *
 * GitHub does not enforce a minimum, so the weakest link is whoever typed the
 * value into the App settings. A short secret makes the HMAC brute-forceable
 * offline: an attacker with one captured delivery can search the keyspace
 * without touching the platform, and nothing here would ever see the attempt.
 *
 * Checked at startup, so the process refuses to serve rather than serving
 * something forgeable.
 */
export const MIN_SECRET_LENGTH = 32;

export class InsecureConfigurationError extends Error {
  public override readonly name = "InsecureConfigurationError";

  public constructor(reason: string) {
    // The reason never quotes the value.
    super(`Refusing to start: ${reason}`);
  }
}

export function assertStrongWebhookSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new InsecureConfigurationError(
      `webhook secret is shorter than ${String(MIN_SECRET_LENGTH)} characters`,
    );
  }
  // A secret of one repeated character has the length but not the entropy, and
  // is the shape a placeholder takes ("xxxxxxxx…", "aaaa…").
  if (new Set(secret).size < 8) {
    throw new InsecureConfigurationError(
      "webhook secret has too little variety to be a real secret",
    );
  }
}

/**
 * A token bucket with a bounded key space.
 *
 * The bound is the part that is easy to omit and that matters most. A plain
 * `Map<ip, state>` is itself a memory-exhaustion vector: an attacker with a
 * large address pool — trivial over IPv6, where a single /64 gives billions —
 * inserts an entry per request and the limiter becomes the outage it was added
 * to prevent.
 *
 * So the map is capped. But a cap alone converts one attack into another: with
 * naive FIFO eviction, an attacker flooding fresh addresses evicts every
 * legitimate bucket before its window expires, and the limiter stops limiting
 * anyone. Bounded memory, and a rate-limit **bypass**.
 *
 * The eviction policy therefore never discards an *active* bucket. When the map
 * is full it first sweeps entries whose windows have already expired — free,
 * and enough under normal load. If every tracked key is still active, new keys
 * are not tracked individually at all: they share a single **overflow bucket**.
 *
 *     established key   keeps its own bucket, whatever the flood
 *     new key, room     gets its own bucket
 *     new key, no room  shares the overflow budget
 *
 * An attacker with a large address pool is confined to the overflow bucket and
 * cannot displace anyone. The cost is that genuinely new clients share a budget
 * while under flood — degraded service for them, rather than no limiting for
 * everyone.
 */
export interface RateLimiterOptions {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowMillis: number;
  /** Maximum tracked keys. Beyond this the oldest is evicted. */
  readonly maxKeys?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface RateLimiter {
  /** True when the caller is within budget. Consumes one token. */
  tryConsume(key: string): boolean;
  readonly size: number;
}

/** The shared key used once the map is full of active buckets. */
export const OVERFLOW_KEY = "\u0000overflow";

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const maxKeys = options.maxKeys ?? 100_000;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, { tokens: number; resetAt: number }>();

  const fresh = (timestamp: number) => ({
    tokens: options.limit - 1,
    resetAt: timestamp + options.windowMillis,
  });

  /** Drops expired buckets. Amortized: only runs when the map is full. */
  const sweepExpired = (timestamp: number): void => {
    for (const [key, bucket] of buckets) {
      if (timestamp >= bucket.resetAt) buckets.delete(key);
    }
  };

  const consume = (key: string, timestamp: number): boolean => {
    const existing = buckets.get(key);
    if (existing === undefined || timestamp >= existing.resetAt) {
      buckets.set(key, fresh(timestamp));
      return true;
    }
    if (existing.tokens <= 0) return false;
    existing.tokens -= 1;
    return true;
  };

  /**
   * Tracked keys, excluding the overflow bucket.
   *
   * The overflow bucket is a single fixed entry, not a tracked key, so it is
   * not counted against the cap. Total memory is therefore `maxKeys + 1`
   * entries at most — bounded, and the `+1` is a constant rather than
   * something an attacker can grow.
   */
  const trackedSize = (): number =>
    buckets.size - (buckets.has(OVERFLOW_KEY) ? 1 : 0);

  return {
    tryConsume(key: string): boolean {
      const timestamp = now();

      // A key already tracked keeps its bucket unconditionally — this is the
      // clause that makes an established client immune to flooding.
      if (buckets.has(key)) return consume(key, timestamp);

      if (trackedSize() >= maxKeys) {
        sweepExpired(timestamp);
      }

      if (trackedSize() >= maxKeys) {
        // Still full of *active* buckets. Share rather than evict: discarding
        // an active bucket to make room is the bypass this avoids.
        return consume(OVERFLOW_KEY, timestamp);
      }

      return consume(key, timestamp);
    },
    get size(): number {
      return trackedSize();
    },
  };
}

/**
 * How a request's client address is resolved.
 *
 * See `client-identity.ts`. The default ignores `X-Forwarded-For` entirely,
 * which is correct for direct exposure and *degraded but safe* behind an
 * unconfigured proxy — every request shares one bucket rather than every
 * request being spoofable.
 */
export type ClientKeyResolver = (request: Request) => string;

export interface WebhookRateLimitOptions {
  /**
   * Budget for requests that fail authentication.
   *
   * Tight, because the cost asymmetry is here: rejecting is cheap for the
   * platform and free for the attacker, so an unbounded flood of forged
   * signatures is the realistic denial of service.
   */
  readonly unauthenticated: RateLimiter;
  /**
   * Budget for the endpoint overall.
   *
   * Generous. GitHub delivers from a wide address range and a busy
   * organization can burst; a limit tuned for attackers would drop real
   * deliveries, and GitHub does not automatically redeliver them.
   */
  readonly overall: RateLimiter;
  /**
   * Resolves the client address.
   *
   * Behind a load balancer this MUST be configured with the trusted proxy
   * ranges, or every request lands in one bucket and the tight unauthenticated
   * budget fires on legitimate traffic.
   */
  readonly clientKey?: ClientKeyResolver | undefined;
}

export function createDefaultWebhookRateLimits(
  identity: ClientIdentityOptions = {},
): WebhookRateLimitOptions {
  return {
    unauthenticated: createRateLimiter({ limit: 20, windowMillis: 60_000 }),
    overall: createRateLimiter({ limit: 3_000, windowMillis: 60_000 }),
    clientKey: createClientIdentity(identity),
  };
}

/** Applies the overall budget before any work. */
export function rateLimitMiddleware(
  limits: WebhookRateLimitOptions,
): RequestHandler {
  return (request, response, next) => {
    const key = (limits.clientKey ?? defaultClientKey)(request);
    if (!limits.overall.tryConsume(key)) {
      // 429 with no detail. A limiter that explains its window tells an
      // attacker exactly how to pace themselves under it.
      response.status(429).json({ error: "too_many_requests" });
      return;
    }
    next();
  };
}

/** Records a failed authentication against the tighter budget. */
export function penalizeUnauthenticated(
  limits: WebhookRateLimitOptions,
  request: Request,
): boolean {
  return limits.unauthenticated.tryConsume(
    (limits.clientKey ?? defaultClientKey)(request),
  );
}

/** Socket peer only. Never reads a caller-supplied header. */
const defaultClientKey: ClientKeyResolver = (request) =>
  request.socket.remoteAddress ?? "unknown";

/**
 * Response headers.
 *
 * A JSON API has a narrower need than a browser-facing app — no CSP, no HSTS
 * decision here (that belongs at the TLS terminator, where the certificate
 * lives) — but three still matter:
 *
 * - `nosniff` stops a browser reinterpreting a JSON error as HTML, which is
 *   how a reflected value becomes stored XSS on an endpoint nobody thought a
 *   browser would visit.
 * - `DENY` framing, because there is nothing here worth embedding.
 * - `no-store`, so an intermediary never caches a response that may carry
 *   delivery state.
 */
export function securityHeaders(): RequestHandler {
  return (_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    next();
  };
}

/**
 * The last-resort error handler.
 *
 * Without one, Express's default handler renders the stack trace into the
 * response outside production — and "outside production" is decided by
 * `NODE_ENV`, which is exactly the variable that is wrong in a staging
 * environment reachable from the internet. Filenames, line numbers, and
 * dependency versions are free reconnaissance.
 *
 * Four arguments are required for Express to recognize this as an error
 * handler; `next` is unused and must stay in the signature.
 */
export function errorHandler(
  onError?: (error: unknown) => void,
): (
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
) => void {
  return (error, _request, response, _next) => {
    onError?.(error);
    if (response.headersSent) return;

    // Body-parser signals an over-large body this way. It is a client error,
    // not an internal one, and answering 500 would make a routine rejection
    // look like a platform fault in every dashboard.
    const status =
      typeof error === "object" &&
      error !== null &&
      (error as { type?: unknown }).type === "entity.too.large"
        ? 413
        : 500;

    response.status(status).json({
      error: status === 413 ? "payload_too_large" : "internal_error",
    });
  };
}

/**
 * Connection-level timeouts.
 *
 * Applied to the HTTP server rather than as middleware, because the attack
 * happens before any handler runs: a slowloris client opens connections and
 * dribbles headers, holding sockets indefinitely. Express never sees a
 * request, so no middleware can intervene.
 *
 * `headersTimeout` must exceed `requestTimeout` or Node warns and the
 * combination behaves unexpectedly.
 */
export interface ServerTimeouts {
  readonly requestTimeoutMillis: number;
  readonly headersTimeoutMillis: number;
  readonly keepAliveTimeoutMillis: number;
}

export const DEFAULT_SERVER_TIMEOUTS: ServerTimeouts = {
  // GitHub expects a response within 10 seconds; 30 leaves room for a slow
  // database without letting a socket be held for minutes.
  requestTimeoutMillis: 30_000,
  headersTimeoutMillis: 35_000,
  keepAliveTimeoutMillis: 5_000,
};

export function applyServerTimeouts(
  server: {
    requestTimeout: number;
    headersTimeout: number;
    keepAliveTimeout: number;
  },
  timeouts: ServerTimeouts = DEFAULT_SERVER_TIMEOUTS,
): void {
  server.requestTimeout = timeouts.requestTimeoutMillis;
  server.headersTimeout = timeouts.headersTimeoutMillis;
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMillis;
}
