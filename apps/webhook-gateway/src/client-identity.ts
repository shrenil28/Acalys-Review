/**
 * Deciding which address a request came from.
 *
 * This looks like a detail and is the difference between a working rate limiter
 * and a self-inflicted outage. Two deployment shapes, and the limiter has to be
 * correct in both:
 *
 *     Internet → gateway                       socket peer IS the client
 *     Internet → ALB/nginx/ingress → gateway   socket peer is the PROXY
 *
 * In the second shape, using the socket peer puts every request — GitHub's,
 * an attacker's, everyone's — into **one bucket**. The tight unauthenticated
 * budget then fires on legitimate traffic, and the limiter added to protect
 * availability is what takes the service down.
 *
 * The naive fix, trusting `X-Forwarded-For`, is worse: the header is
 * caller-supplied, so anyone can vary it to get a fresh budget per request and
 * fill the limiter's key space with fabricated addresses. That is why Express's
 * blanket `trust proxy: true` is never enabled here.
 *
 * The correct rule needs a fact only the deployment knows — *which* hops are
 * ours:
 *
 *     socket peer ∈ trustedProxies  →  read the client from X-Forwarded-For,
 *                                      counting back the configured hops
 *     otherwise                     →  the socket peer, and ignore the header
 *
 * With no `trustedProxies` configured, the header is never consulted. Direct
 * exposure is therefore the safe default, and running behind a proxy is an
 * explicit configuration act rather than something inferred.
 */

import type { Request } from "express";

export interface ClientIdentityOptions {
  /**
   * Addresses and CIDR blocks that are known infrastructure.
   *
   * Empty means direct exposure: `X-Forwarded-For` is ignored entirely.
   */
  readonly trustedProxies?: readonly string[] | undefined;
  /**
   * How many trusted hops sit in front of this process.
   *
   * The client is read that many entries from the **right** of
   * `X-Forwarded-For`, because an attacker can prepend arbitrary entries on
   * the left but cannot remove the ones each real proxy appends. Reading from
   * the left is the classic spoofable mistake.
   */
  readonly proxyHops?: number | undefined;
}

/** Parses an IPv4 or IPv6 address to a comparable integer. Undefined if invalid. */
function toBigInt(address: string): bigint | undefined {
  // Node reports IPv4 peers over a dual-stack socket as `::ffff:1.2.3.4`.
  // Normalizing means one trusted-proxy entry works regardless of socket mode.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const candidate = mapped?.[1] ?? address;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(candidate)) {
    const parts = candidate.split(".").map(Number);
    if (
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return undefined;
    }
    return parts.reduce((total, part) => (total << 8n) | BigInt(part), 0n);
  }

  if (!candidate.includes(":")) return undefined;

  const [head, tail, ...extra] = candidate.split("::");
  if (extra.length > 0 || head === undefined) return undefined;

  const expand = (group: string): string[] =>
    group.length === 0 ? [] : group.split(":");

  const left = expand(head);
  const right = tail === undefined ? [] : expand(tail);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return undefined;

  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

interface TrustedRange {
  readonly base: bigint;
  readonly mask: bigint;
  readonly bits: number;
}

/** Compiles trusted entries once, at construction, rather than per request. */
export function compileTrustedProxies(
  entries: readonly string[],
): readonly TrustedRange[] {
  const ranges: TrustedRange[] = [];

  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    if (address === undefined) continue;

    const base = toBigInt(address);
    if (base === undefined) continue;

    const bits = address.includes(":") && !address.includes(".") ? 128 : 32;
    const prefixLength = prefix === undefined ? bits : Number(prefix);
    if (
      !Number.isInteger(prefixLength) ||
      prefixLength < 0 ||
      prefixLength > bits
    ) {
      continue;
    }

    const hostBits = BigInt(bits - prefixLength);
    const mask = ((1n << BigInt(bits)) - 1n) ^ ((1n << hostBits) - 1n);
    ranges.push({ base: base & mask, mask, bits });
  }

  return ranges;
}

function isTrusted(address: string, ranges: readonly TrustedRange[]): boolean {
  const value = toBigInt(address);
  if (value === undefined) return false;
  const bits = address.includes(":") && !address.includes(".") ? 128 : 32;
  return ranges.some(
    (range) => range.bits === bits && (value & range.mask) === range.base,
  );
}

/**
 * Resolves the address to rate-limit on.
 *
 * Returns the socket peer unless it is a configured trusted proxy, in which
 * case the client is read from `X-Forwarded-For` counting back `proxyHops`
 * entries from the right.
 */
export function createClientIdentity(
  options: ClientIdentityOptions = {},
): (request: Request) => string {
  const ranges = compileTrustedProxies(options.trustedProxies ?? []);
  const hops = options.proxyHops ?? 1;

  return (request: Request): string => {
    const peer = request.socket.remoteAddress ?? "unknown";

    // No trusted infrastructure configured, or this peer is not it. The header
    // is not consulted at all — an untrusted caller cannot influence its own
    // rate-limit key.
    if (ranges.length === 0 || !isTrusted(peer, ranges)) {
      return peer;
    }

    const header = request.headers["x-forwarded-for"];
    const chain = (Array.isArray(header) ? header.join(",") : (header ?? ""))
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    // Counted from the right: each real proxy *appends*, so the rightmost
    // entries are the ones our own infrastructure wrote. Anything further left
    // may have been supplied by the caller.
    const index = chain.length - hops;
    const client = index >= 0 ? chain[index] : undefined;

    // A trusted proxy that sent no usable chain is a misconfiguration, not an
    // invitation to guess. Falling back to the peer degrades to one shared
    // bucket — degraded, but never spoofable.
    return client ?? peer;
  };
}
