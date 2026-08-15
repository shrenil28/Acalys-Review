/**
 * Deterministic configuration resolution (P0.txt §109, §58).
 *
 *     platform defaults → organization → repository → path instructions
 *                       → request overrides (if allowed) → EffectiveReviewConfig
 *
 * A pure function of its inputs. No clock, no environment, no I/O, no `Math
 * .random`, no iteration over an object whose key order came from a parser.
 * Same inputs, byte-identical output — which is what lets a
 * {@link ReviewConfigSnapshot} claim a run is reproducible.
 *
 * # Merge semantics are per-field, and stated
 *
 * "Later wins" is the obvious rule and it is wrong for half of these fields.
 * Whether an array replaces or accumulates decides whether an organization's
 * policy is a *policy* or merely a *default*, so each is chosen deliberately:
 *
 * | Field | Semantics | Why |
 * | --- | --- | --- |
 * | every scalar | replace | a narrower level knows better |
 * | `review.categories` | replace | narrowing what is analyzed is legitimate |
 * | `paths` | concatenate | org and repo instructions both apply; §40 orders them |
 * | `tools.allowed` | replace | a repository picks from what it is offered |
 * | `tools.denied` | **union** | a ban must not be defeatable from below |
 * | `premerge.checks` | union | policy accumulates |
 * | `premerge.blockingChecks` | union | so does what blocks |
 *
 * The union rows are the security-relevant ones. If `denied` replaced, a
 * repository could re-enable a tool its organization forbade by simply not
 * mentioning it — the configuration equivalent of privilege escalation.
 *
 * # Request overrides are an allow-list, not a merge
 *
 * The last stage takes input from whoever opened the pull request, so it is
 * the least trusted. It may adjust *how hard the reviewer looks*; it may not
 * touch data egress, tool policy, or merge policy. See
 * {@link RequestOverrides}.
 */

import { z } from "zod";
import {
  FINDING_CATEGORIES,
  findingCategorySchema,
  type FindingCategory,
  type FindingSeverity,
} from "../finding/taxonomy.js";
import { canonicalJson } from "../primitives/canonical-json.js";
import { COLLECTION_LIMITS } from "../primitives/limits.js";
import type { NamespacedId } from "../primitives/namespaced-id.js";
import type { ContentHasher } from "../ports/content-hasher.js";
import type { Checksum } from "../primitives/checksum.js";
import {
  pathInstructionSchema,
  type PathInstruction,
} from "./path-instruction.js";
import {
  knowledgeConfigSchema,
  preMergeConfigBaseSchema,
  publicationConfigSchema,
  reviewBehaviorConfigSchema,
  reviewDepthSchema,
  toolConfigBaseSchema,
  PLATFORM_DEFAULT_REVIEW_CONFIG,
  REVIEW_CONFIG_SCHEMA_VERSION,
  type ReviewConfig,
  type ReviewDepth,
  type ReviewTriggerMode,
} from "./review-config.js";

/**
 * The levels, in application order.
 *
 * An ordered constant rather than an implicit sequence of function calls: the
 * order *is* the contract, and a test can assert it.
 */
export const CONFIG_LAYERS = [
  "platform_default",
  "organization",
  "repository",
  "request_override",
] as const;

export type ConfigLayer = (typeof CONFIG_LAYERS)[number];
export const configLayerSchema = z.enum(CONFIG_LAYERS);

/**
 * A partial configuration document — what one level actually declares.
 *
 * Spelled out field by field rather than derived with a recursive deep-partial
 * helper, because the merge semantics above are per-field and a generated type
 * would silently give every new field "replace". A field that needs union
 * semantics must be a visible decision, not a default.
 */
export interface ReviewConfigOverlay {
  readonly review?:
    | {
        readonly trigger?: ReviewTriggerMode | undefined;
        readonly depth?: ReviewDepth | undefined;
        readonly reviewDrafts?: boolean | undefined;
        readonly supersedeOnPush?: boolean | undefined;
        readonly categories?: readonly FindingCategory[] | undefined;
      }
    | undefined;
  /** Concatenated onto the levels above, never replacing them. */
  readonly paths?: readonly PathInstruction[] | undefined;
  readonly tools?:
    | {
        readonly enabled?: boolean | undefined;
        readonly allowed?: readonly NamespacedId[] | undefined;
        /** Unioned with every level above. A ban only ever grows. */
        readonly denied?: readonly NamespacedId[] | undefined;
        readonly timeoutSeconds?: number | undefined;
      }
    | undefined;
  readonly knowledge?:
    | {
        readonly learningsEnabled?: boolean | undefined;
        readonly useLinkedIssues?: boolean | undefined;
        readonly useRepositoryInstructions?: boolean | undefined;
        readonly useExternalSources?: boolean | undefined;
      }
    | undefined;
  readonly premerge?:
    | {
        readonly enabled?: boolean | undefined;
        readonly checks?: readonly NamespacedId[] | undefined;
        readonly blockingChecks?: readonly NamespacedId[] | undefined;
      }
    | undefined;
  readonly publication?:
    | {
        readonly postSummary?: boolean | undefined;
        readonly postInlineComments?: boolean | undefined;
        readonly postSuggestedFixes?: boolean | undefined;
        readonly minSeverityToPublish?: FindingSeverity | undefined;
        readonly minConfidenceToPublish?: number | undefined;
        readonly maxCommentsPerRun?: number | undefined;
        readonly submitReviewDecision?: boolean | undefined;
      }
    | undefined;
}

export const reviewConfigOverlaySchema = z.strictObject({
  review: reviewBehaviorConfigSchema.partial().optional(),
  paths: z
    .array(pathInstructionSchema)
    .max(COLLECTION_LIMITS.pathInstructions)
    .optional(),
  tools: toolConfigBaseSchema.partial().optional(),
  knowledge: knowledgeConfigSchema.partial().optional(),
  premerge: preMergeConfigBaseSchema.partial().optional(),
  publication: publicationConfigSchema.partial().optional(),
});

/**
 * What the requester may change (§109, "request overrides **if allowed**").
 *
 * Deliberately three fields. This input comes from a PR body, a comment, or a
 * CLI flag — anyone with push access can set it — so the allow-list is the
 * security boundary, and it is expressed as a *type*, not as a runtime filter
 * that a future caller could forget to apply.
 *
 * What is excluded matters more than what is included:
 *
 * - **`knowledge.useExternalSources`** — turning it on sends the change's
 *   context outside the tenant. That is an organization's decision (§26).
 * - **`tools.denied`** — see the union rule above; a per-request override
 *   would be the same escalation by another route.
 * - **`premerge.*`** — a merge policy the person being gated can switch off
 *   is not a merge policy.
 * - **`publication.minSeverityToPublish`** — lowering it is harmless, raising
 *   it lets an author hide their own critical findings from reviewers.
 */
export interface RequestOverrides {
  readonly depth?: ReviewDepth | undefined;
  /** Narrows what is analyzed for this run. Cannot widen past the config. */
  readonly categories?: readonly FindingCategory[] | undefined;
  /** Review a draft PR this once, even when the repository says not to. */
  readonly reviewDrafts?: boolean | undefined;
}

export const requestOverridesSchema = z.strictObject({
  depth: reviewDepthSchema.optional(),
  categories: z
    .array(findingCategorySchema)
    .max(FINDING_CATEGORIES.length)
    .optional(),
  reviewDrafts: z.boolean().optional(),
});

/** Everything resolution reads. */
export interface ConfigResolutionInput {
  readonly organization?: ReviewConfigOverlay | undefined;
  readonly repository?: ReviewConfigOverlay | undefined;
  readonly requestOverrides?: RequestOverrides | undefined;
  /**
   * Whether request overrides are honoured at all — §109's "if allowed".
   *
   * Required rather than defaulted, so allowing them is always an explicit act
   * at the call site.
   */
  readonly allowRequestOverrides: boolean;
}

export const configResolutionInputSchema = z.strictObject({
  organization: reviewConfigOverlaySchema.optional(),
  repository: reviewConfigOverlaySchema.optional(),
  requestOverrides: requestOverridesSchema.optional(),
  allowRequestOverrides: z.boolean(),
});

/**
 * The resolved configuration, plus how it got that way.
 *
 * `layers` records which levels actually contributed. Without it, "why is this
 * repository not reviewing drafts?" is unanswerable from the result alone —
 * and a config nobody can explain is a config nobody will trust (§72).
 */
export interface EffectiveReviewConfig {
  readonly config: ReviewConfig;
  /** Layers that contributed, in application order. */
  readonly layers: readonly ConfigLayer[];
  /**
   * True when overrides were supplied but suppressed by policy.
   *
   * Distinct from "no overrides were supplied": a requester who asked for a
   * thorough review and did not get one deserves to be told why, and a
   * silently ignored request is the kind of thing that gets reported as a bug
   * against the reviewer instead of against the policy.
   */
  readonly requestOverridesRejected: boolean;
}

/** Deduplicates while preserving first-seen order, then sorts for determinism. */
function mergeIdSets(
  ...groups: readonly (readonly NamespacedId[] | undefined)[]
): readonly NamespacedId[] {
  const merged = new Set<NamespacedId>();
  for (const group of groups) {
    for (const value of group ?? []) merged.add(value);
  }
  // Sorted, not insertion-ordered: these are sets, and the canonical form must
  // not depend on which level happened to mention a tool first (§123).
  return [...merged].sort();
}

function pick<T>(...candidates: readonly (T | undefined)[]): T {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate !== undefined) return candidate;
  }
  // Unreachable: the last candidate is always a platform default, which is
  // never undefined. Throwing rather than asserting keeps the invariant honest.
  throw new Error("No configuration value available, including the default");
}

/**
 * Resolves the effective configuration.
 *
 * Pure and total: every field of the result comes from
 * {@link PLATFORM_DEFAULT_REVIEW_CONFIG} unless some layer overrode it, so
 * there is no partial result and no undefined field to default downstream.
 */
export function resolveReviewConfig(
  input: ConfigResolutionInput,
): EffectiveReviewConfig {
  const defaults = PLATFORM_DEFAULT_REVIEW_CONFIG;
  const organization = input.organization;
  const repository = input.repository;

  const overridesSupplied = input.requestOverrides !== undefined;
  const overridesApplied = overridesSupplied && input.allowRequestOverrides;
  const overrides = overridesApplied ? input.requestOverrides : undefined;

  const organizationExternalSources =
    organization?.knowledge?.useExternalSources ??
    defaults.knowledge.useExternalSources;
  const repositoryExternalSources =
    repository?.knowledge?.useExternalSources ?? organizationExternalSources;

  const layers: ConfigLayer[] = ["platform_default"];
  if (organization !== undefined) layers.push("organization");
  if (repository !== undefined) layers.push("repository");
  if (overridesApplied) layers.push("request_override");

  const config: ReviewConfig = {
    schemaVersion: REVIEW_CONFIG_SCHEMA_VERSION,
    review: {
      trigger: pick(
        defaults.review.trigger,
        organization?.review?.trigger,
        repository?.review?.trigger,
      ),
      depth: pick(
        defaults.review.depth,
        organization?.review?.depth,
        repository?.review?.depth,
        overrides?.depth,
      ),
      reviewDrafts: pick(
        defaults.review.reviewDrafts,
        organization?.review?.reviewDrafts,
        repository?.review?.reviewDrafts,
        overrides?.reviewDrafts,
      ),
      supersedeOnPush: pick(
        defaults.review.supersedeOnPush,
        organization?.review?.supersedeOnPush,
        repository?.review?.supersedeOnPush,
      ),
      // Narrowing only: an override intersects with what the repository already
      // allows, so a request can ask for less analysis but never for more than
      // the organization sanctioned.
      categories: narrowCategories(
        pick(
          defaults.review.categories,
          organization?.review?.categories,
          repository?.review?.categories,
        ),
        overrides?.categories,
      ),
    },
    // Concatenated, never replaced: an organization convention and a
    // repository rule both apply to a file under both. Layer order is
    // organization then repository, which — with §40's "last declared wins"
    // tiebreak — gives the repository the final say over its own organization
    // when two rules are otherwise indistinguishable.
    paths: [...(organization?.paths ?? []), ...(repository?.paths ?? [])],
    tools: {
      enabled: pick(
        defaults.tools.enabled,
        organization?.tools?.enabled,
        repository?.tools?.enabled,
      ),
      allowed: [
        ...pick(
          defaults.tools.allowed,
          organization?.tools?.allowed,
          repository?.tools?.allowed,
        ),
      ].sort(),
      denied: mergeIdSets(
        defaults.tools.denied,
        organization?.tools?.denied,
        repository?.tools?.denied,
      ),
      timeoutSeconds: pick(
        defaults.tools.timeoutSeconds,
        organization?.tools?.timeoutSeconds,
        repository?.tools?.timeoutSeconds,
      ),
    },
    knowledge: {
      learningsEnabled: pick(
        defaults.knowledge.learningsEnabled,
        organization?.knowledge?.learningsEnabled,
        repository?.knowledge?.learningsEnabled,
      ),
      useLinkedIssues: pick(
        defaults.knowledge.useLinkedIssues,
        organization?.knowledge?.useLinkedIssues,
        repository?.knowledge?.useLinkedIssues,
      ),
      useRepositoryInstructions: pick(
        defaults.knowledge.useRepositoryInstructions,
        organization?.knowledge?.useRepositoryInstructions,
        repository?.knowledge?.useRepositoryInstructions,
      ),
      // The one field that tightens rather than replaces. A repository must
      // not be able to switch on egress its organization left off, so the
      // repository's value is an additional condition, not a replacement — it
      // can only ever turn the flag off.
      useExternalSources:
        organizationExternalSources && repositoryExternalSources,
    },
    premerge: {
      enabled: pick(
        defaults.premerge.enabled,
        organization?.premerge?.enabled,
        repository?.premerge?.enabled,
      ),
      checks: mergeIdSets(
        defaults.premerge.checks,
        organization?.premerge?.checks,
        repository?.premerge?.checks,
      ),
      blockingChecks: mergeIdSets(
        defaults.premerge.blockingChecks,
        organization?.premerge?.blockingChecks,
        repository?.premerge?.blockingChecks,
      ),
    },
    publication: {
      postSummary: pick(
        defaults.publication.postSummary,
        organization?.publication?.postSummary,
        repository?.publication?.postSummary,
      ),
      postInlineComments: pick(
        defaults.publication.postInlineComments,
        organization?.publication?.postInlineComments,
        repository?.publication?.postInlineComments,
      ),
      postSuggestedFixes: pick(
        defaults.publication.postSuggestedFixes,
        organization?.publication?.postSuggestedFixes,
        repository?.publication?.postSuggestedFixes,
      ),
      minSeverityToPublish: pick(
        defaults.publication.minSeverityToPublish,
        organization?.publication?.minSeverityToPublish,
        repository?.publication?.minSeverityToPublish,
      ),
      minConfidenceToPublish: pick(
        defaults.publication.minConfidenceToPublish,
        organization?.publication?.minConfidenceToPublish,
        repository?.publication?.minConfidenceToPublish,
      ),
      maxCommentsPerRun: pick(
        defaults.publication.maxCommentsPerRun,
        organization?.publication?.maxCommentsPerRun,
        repository?.publication?.maxCommentsPerRun,
      ),
      submitReviewDecision: pick(
        defaults.publication.submitReviewDecision,
        organization?.publication?.submitReviewDecision,
        repository?.publication?.submitReviewDecision,
      ),
    },
  };

  return {
    config,
    layers,
    requestOverridesRejected: overridesSupplied && !input.allowRequestOverrides,
  };
}

/**
 * Intersects a requested category set with the resolved one.
 *
 * Intersection rather than replacement: a request asking for `security` when
 * the organization disabled it must not re-enable it. Order follows
 * {@link FINDING_CATEGORIES} so the result is canonical regardless of how the
 * request listed them.
 */
function narrowCategories(
  resolved: readonly FindingCategory[],
  requested: readonly FindingCategory[] | undefined,
): readonly FindingCategory[] {
  const allowed = new Set(resolved);
  const target =
    requested === undefined
      ? allowed
      : new Set(requested.filter((category) => allowed.has(category)));
  return FINDING_CATEGORIES.filter((category) => target.has(category));
}

/**
 * A stable digest of the resolution *inputs* — §39's `sourceHash`.
 *
 * The inputs rather than the output, because that is what the field is for:
 * two runs with the same `sourceHash` were resolved from the same documents,
 * and any difference in their configuration would be a bug in the resolver
 * rather than a change by a user. Hashing the output instead would make the
 * resolver's own regressions invisible — the very thing reproducibility is
 * meant to catch.
 *
 * Uses {@link canonicalJson}, so key order in the source documents cannot
 * change the digest (§58).
 */
export function configSourceHash(
  input: ConfigResolutionInput,
  hasher: ContentHasher,
): Checksum {
  return hasher.hash(
    canonicalJson({
      version: REVIEW_CONFIG_SCHEMA_VERSION,
      organization: input.organization ?? null,
      repository: input.repository ?? null,
      requestOverrides: input.allowRequestOverrides
        ? (input.requestOverrides ?? null)
        : null,
      allowRequestOverrides: input.allowRequestOverrides,
    }),
  );
}
