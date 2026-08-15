/**
 * Content identity (P0.txt §46).
 *
 * One shared checksum shape serves artifact integrity, config-snapshot
 * identity, change-manifest identity, tool caching, and idempotency support.
 * Carrying the algorithm alongside the digest — rather than an bare hex string
 * — is what makes migrating to a stronger hash a non-event: old rows stay
 * readable and self-describing.
 *
 * SHA-1 is absent by design. It appears in this platform only as a *Git object
 * id*, where the format is dictated by Git itself ({@link GitObjectId}), never
 * as an integrity claim we make ourselves.
 */

import { z } from "zod";

export const CHECKSUM_ALGORITHMS = ["sha256", "sha512"] as const;
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];

/** Expected hex digest length per algorithm, in characters. */
const DIGEST_LENGTH: Record<ChecksumAlgorithm, number> = {
  sha256: 64,
  sha512: 128,
};

/**
 * An algorithm-tagged digest.
 *
 * `value` is lowercase hex. Case is normalized on parse so that two checksums
 * of identical content compare equal with `===` and hash identically (§58).
 */
export interface Checksum {
  readonly algorithm: ChecksumAlgorithm;
  readonly value: string;
}

const HEX = /^[0-9a-f]+$/;

export const checksumSchema = z
  .strictObject({
    algorithm: z.enum(CHECKSUM_ALGORITHMS),
    value: z
      .string()
      .transform((value) => value.toLowerCase())
      .refine((value) => HEX.test(value), {
        error: "Digest must be hexadecimal",
      }),
  })
  .refine(
    (checksum) => checksum.value.length === DIGEST_LENGTH[checksum.algorithm],
    {
      error: "Digest length does not match the declared algorithm",
      path: ["value"],
    },
  );

/**
 * Structural equality.
 *
 * Two checksums match only when both the algorithm and the digest agree —
 * comparing digests alone would let a sha256 and a sha512 value that happen to
 * share a prefix be treated as related.
 */
export function checksumsEqual(left: Checksum, right: Checksum): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

/** Compact display form, e.g. `sha256:9f86d081…`. */
export function formatChecksum(checksum: Checksum): string {
  return `${checksum.algorithm}:${checksum.value}`;
}
