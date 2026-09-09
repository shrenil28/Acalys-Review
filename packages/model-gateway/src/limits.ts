import type { CredentialPolicy, ModelAdmissionPort } from "./types.js";

class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];

  public constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error("maxConcurrency must be >= 1");
    this.#available = size;
  }

  public async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) next();
    else this.#available += 1;
  }
}

interface Bucket {
  tokens: number;
  refilledAt: number;
}

/** Process-local fast guard. Fleet-wide quota remains the usage-port authority. */
export class CredentialLimiter implements ModelAdmissionPort {
  readonly #semaphores = new Map<string, Semaphore>();
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  public constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  public async enter(policy: CredentialPolicy): Promise<
    | { readonly kind: "entered"; readonly release: () => Promise<void> }
    | { readonly kind: "rate_limited" }
  > {
    const bucket = this.#buckets.get(policy.credentialId) ?? {
      tokens: policy.requestsPerMinute,
      refilledAt: this.#now(),
    };
    const now = this.#now();
    const elapsed = Math.max(0, now - bucket.refilledAt);
    const refill = (elapsed / 60_000) * policy.requestsPerMinute;
    bucket.tokens = Math.min(policy.requestsPerMinute, bucket.tokens + refill);
    bucket.refilledAt = now;
    this.#buckets.set(policy.credentialId, bucket);
    if (bucket.tokens < 1) return { kind: "rate_limited" };
    bucket.tokens -= 1;

    let semaphore = this.#semaphores.get(policy.credentialId);
    if (semaphore === undefined) {
      semaphore = new Semaphore(policy.maxConcurrency);
      this.#semaphores.set(policy.credentialId, semaphore);
    }
    const release = await semaphore.acquire();
    return {
      kind: "entered",
      release: async () => {
        release();
      },
    };
  }
}
