/**
 * Pinned configuration for a review run (P0.txt §39, §72).
 *
 * §39's requirement: "**do not only reference the current repository
 * configuration**". A run that pointed at live config would be re-interpreted
 * every time someone edited `.acalys.yaml` — and "why did this review flag
 * that?" would have no answer six hours later, because the rules it ran under
 * no longer exist anywhere.
 *
 *     ReviewRun R123  used config snapshot C78
 *
 * The snapshot embeds the whole resolved {@link ReviewConfig} by value. That
 * is deliberate duplication: a reference to a config row would be mutable by
 * the same argument, and the storage cost of a few kilobytes per run is
 * nothing against losing the ability to explain a review.
 *
 * # Immutable, and the type says so
 *
 * §109 ends with "do not mutate configuration while a review is executing".
 * There is no updater in this module and no field a caller could reassign —
 * every property is `readonly`, and {@link freezeConfigSnapshot} makes it true
 * at runtime as well, since `readonly` is erased at compile time and the
 * snapshot outlives the code that made it.
 */

import { z } from "zod";
import {
  repositoryIdSchema,
  reviewConfigSnapshotIdSchema,
  type RepositoryId,
  type ReviewConfigSnapshotId,
} from "../identity/ids.js";
import { checksumSchema, type Checksum } from "../primitives/checksum.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import type { Clock } from "../ports/clock.js";
import type { ContentHasher } from "../ports/content-hasher.js";
import type { IdGenerator } from "../ports/id-generator.js";
import { reviewConfigSchema, type ReviewConfig } from "./review-config.js";
import {
  CONFIG_LAYERS,
  configLayerSchema,
  configSourceHash,
  resolveReviewConfig,
  type ConfigLayer,
  type ConfigResolutionInput,
} from "./resolution.js";

/** Schema version for this durable contract (§7). */
export const REVIEW_CONFIG_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * The configuration a run executed under.
 *
 * `sourceHash` is a {@link Checksum} rather than §39's bare `string`, so the
 * algorithm travels with the digest: a hex string alone becomes unverifiable
 * the day the platform changes hashers, and every stored snapshot would have
 * to be re-derived to find out which one produced it.
 */
export interface ReviewConfigSnapshot {
  readonly schemaVersion: number;
  readonly id: ReviewConfigSnapshotId;
  readonly repositoryId: RepositoryId;
  readonly config: ReviewConfig;
  /** Digest of the resolution *inputs*. See {@link configSourceHash}. */
  readonly sourceHash: Checksum;
  /** Which levels contributed, in application order. */
  readonly layers: readonly ConfigLayer[];
  readonly createdAt: Timestamp;
}

export const reviewConfigSnapshotSchema = z.strictObject({
  schemaVersion: z
    .number()
    .int()
    .positive()
    .max(REVIEW_CONFIG_SNAPSHOT_SCHEMA_VERSION, {
      error: `Unsupported ReviewConfigSnapshot schemaVersion; this build understands up to ${String(REVIEW_CONFIG_SNAPSHOT_SCHEMA_VERSION)}`,
    }),
  id: reviewConfigSnapshotIdSchema,
  repositoryId: repositoryIdSchema,
  config: reviewConfigSchema,
  sourceHash: checksumSchema,
  layers: z.array(configLayerSchema).max(CONFIG_LAYERS.length),
  createdAt: timestampSchema,
});

/**
 * Deep-freezes a snapshot.
 *
 * `readonly` is a compile-time annotation and disappears at runtime, but a
 * snapshot is exactly the value that outlives its creator and gets passed to
 * code compiled separately — a worker, a serializer, an agent. Freezing turns
 * §109's rule into something the runtime enforces rather than something a
 * future caller is trusted to respect.
 */
export function freezeConfigSnapshot(
  snapshot: ReviewConfigSnapshot,
): ReviewConfigSnapshot {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  };
  freeze(snapshot);
  return snapshot;
}

/** Everything {@link createConfigSnapshot} needs that it cannot compute. */
export interface ConfigSnapshotDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator<ReviewConfigSnapshotId>;
  readonly hasher: ContentHasher;
}

/**
 * Resolves configuration and pins the result.
 *
 * The only sanctioned way to build a snapshot, so resolution and hashing can
 * never drift apart: a snapshot whose `sourceHash` was computed from different
 * inputs than its `config` would claim a reproducibility it does not have, and
 * nothing downstream could detect it.
 *
 * Time and identity arrive through ports (§95), which is what keeps this
 * testable — a `FixedClock` and a stub generator make the whole thing
 * deterministic, including the fields that are otherwise never stable.
 */
export function createConfigSnapshot(
  repositoryId: RepositoryId,
  input: ConfigResolutionInput,
  dependencies: ConfigSnapshotDependencies,
): ReviewConfigSnapshot {
  const resolved = resolveReviewConfig(input);

  return freezeConfigSnapshot({
    schemaVersion: REVIEW_CONFIG_SNAPSHOT_SCHEMA_VERSION,
    id: dependencies.ids.next(),
    repositoryId,
    config: resolved.config,
    sourceHash: configSourceHash(input, dependencies.hasher),
    layers: resolved.layers,
    createdAt: dependencies.clock.now(),
  });
}

/**
 * Whether two snapshots were resolved from the same inputs.
 *
 * Compares digests rather than configs: two snapshots can hold equal
 * configuration and still have come from different documents (an organization
 * setting a value the repository would have defaulted to anyway), and for
 * reproducibility the question is whether the *inputs* matched.
 */
export function snapshotsShareSource(
  left: ReviewConfigSnapshot,
  right: ReviewConfigSnapshot,
): boolean {
  return (
    left.sourceHash.algorithm === right.sourceHash.algorithm &&
    left.sourceHash.value === right.sourceHash.value
  );
}
