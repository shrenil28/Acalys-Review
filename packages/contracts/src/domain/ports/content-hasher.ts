/**
 * Content hashing as an injected dependency (P0.txt §95).
 *
 * Hashing appears in three places that must all agree across processes:
 * finding fingerprints (§28), config-snapshot identity (§39), and artifact
 * integrity (§46). Keeping the implementation behind a port serves two ends:
 *
 * - **Swappability.** Moving from SHA-256 to something else later is a change
 *   in one adapter, not a change to every call site — and {@link Checksum}
 *   already carries the algorithm, so old digests stay interpretable.
 * - **Purity.** The contracts package stays free of `node:crypto`, so the same
 *   code loads in a browser bundle (`apps/web` imports the API layer) and in a
 *   worker. A Node-backed hasher is supplied by the server-side packages that
 *   actually need one.
 *
 * The interface is synchronous on purpose. Web Crypto's `subtle.digest` is
 * async, but making this port async would force every fingerprint and config
 * function to become async and propagate `await` through otherwise pure
 * domain logic. Server-side hashing via `node:crypto` is synchronous, and that
 * is where hashing actually happens.
 */

import type { Checksum, ChecksumAlgorithm } from "../primitives/checksum.js";

export interface ContentHasher {
  /** Which algorithm this implementation produces. */
  readonly algorithm: ChecksumAlgorithm;

  /**
   * Digests UTF-8 text or raw bytes.
   *
   * Implementations must be pure: identical input always yields an identical
   * {@link Checksum}, with no salt, nonce, or ambient state. Determinism is
   * the whole contract (§58).
   */
  hash(data: string | Uint8Array): Checksum;
}
