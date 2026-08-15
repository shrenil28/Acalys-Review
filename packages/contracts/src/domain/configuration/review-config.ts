/**
 * The review configuration model (P0.txt §38).
 *
 * §38's operative instruction is "**do not let later agents parse arbitrary
 * `.yaml` directly**". This module is what makes that possible: it is the
 * *only* shape a reviewer, worker, or agent ever sees, and the pipeline that
 * produces it is one-way.
 *
 *     raw user config → parser → schema validation → normalization → ReviewConfig
 *
 * Everything upstream of the arrow lives outside the domain (Phase 1 reads the
 * file). Everything downstream depends on this type and nothing else, so a
 * change to the file format — a renamed key, a new syntax, YAML replaced by
 * TOML — stops at the parser instead of reaching the reviewer.
 *
 * # Every field is required
 *
 * A `ReviewConfig` is the *effective* answer, not a partial document. Optional
 * fields would push the defaulting decision into every consumer, and two
 * consumers defaulting differently is the same class of bug as two workers
 * resolving different rules. Partial documents are a separate type
 * ({@link ReviewConfigOverlay}), and they exist only in the resolver.
 */

import { z } from "zod";
import {
  FINDING_CATEGORIES,
  findingCategorySchema,
  findingSeveritySchema,
  type FindingCategory,
  type FindingSeverity,
} from "../finding/taxonomy.js";
import { COLLECTION_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";
import {
  pathInstructionSchema,
  type PathInstruction,
} from "./path-instruction.js";

/** Schema version for this durable contract (§7). */
export const REVIEW_CONFIG_SCHEMA_VERSION = 1;

/**
 * When a review starts on its own.
 *
 * `on_push` versus `on_open` is a cost decision as much as a behavioural one:
 * a repository with heavy CI may want one review per PR, not one per commit.
 * `manual` is not "disabled" — the reviewer still runs when asked.
 */
export const REVIEW_TRIGGER_MODES = [
  "on_open",
  "on_push",
  "manual",
  "disabled",
] as const;

export type ReviewTriggerMode = (typeof REVIEW_TRIGGER_MODES)[number];
export const reviewTriggerModeSchema = z.enum(REVIEW_TRIGGER_MODES);

/**
 * How much the reviewer says.
 *
 * A ladder, not a set of independent switches, because the levels are nested:
 * anything `minimal` reports, `thorough` reports too. Independent switches
 * would admit incoherent combinations no user asked for.
 */
export const REVIEW_DEPTHS = ["minimal", "standard", "thorough"] as const;
export type ReviewDepth = (typeof REVIEW_DEPTHS)[number];
export const reviewDepthSchema = z.enum(REVIEW_DEPTHS);

/** When and how much to review. */
export interface ReviewBehaviorConfig {
  readonly trigger: ReviewTriggerMode;
  readonly depth: ReviewDepth;
  /** Whether draft pull requests are reviewed. */
  readonly reviewDrafts: boolean;
  /**
   * Whether a new push cancels the run still working on the previous one.
   *
   * The knob behind `superseded` in the run state machine: with it off, every
   * push in a rapid series gets a full review nobody will read.
   */
  readonly supersedeOnPush: boolean;
  /** Categories the reviewer looks for at all. */
  readonly categories: readonly FindingCategory[];
}

export const reviewBehaviorConfigSchema = z.strictObject({
  trigger: reviewTriggerModeSchema,
  depth: reviewDepthSchema,
  reviewDrafts: z.boolean(),
  supersedeOnPush: z.boolean(),
  categories: z.array(findingCategorySchema).max(FINDING_CATEGORIES.length),
});

/**
 * Which analyzers may run.
 *
 * Allow-list and deny-list are both present and both meaningful: an
 * organization allows a set, and a repository denies one of them without
 * having to restate the rest. `denied` wins on conflict — a rule that forbids
 * must not be defeatable by a rule that permits, or "denied" means nothing.
 */
export interface ToolConfig {
  readonly enabled: boolean;
  /** Empty means "every tool the platform offers", not "none". */
  readonly allowed: readonly NamespacedId[];
  readonly denied: readonly NamespacedId[];
  /** Seconds one tool may run before it is abandoned. */
  readonly timeoutSeconds: number;
}

/**
 * The field shape, without the cross-field rules.
 *
 * Split out so a partial overlay can reuse the fields (`.partial()`) without
 * inheriting rules that only make sense once every level has been merged: an
 * organization may deny a tool that a repository allows, and neither document
 * is wrong on its own — only the resolved config can be.
 */
export const toolConfigBaseSchema = z.strictObject({
  enabled: z.boolean(),
  allowed: z.array(namespacedIdSchema).max(200),
  denied: z.array(namespacedIdSchema).max(200),
  timeoutSeconds: z.number().int().positive().max(3_600),
});

export const toolConfigSchema = toolConfigBaseSchema.superRefine(
  (config, ctx) => {
    // Listing a tool in both is not a resolvable preference, it is a mistake in
    // the document. Silently applying "denied wins" would hide it.
    const denied = new Set(config.denied);
    for (const [index, tool] of config.allowed.entries()) {
      if (denied.has(tool)) {
        ctx.addIssue({
          code: "custom",
          path: ["allowed", index],
          message: `Tool '${tool}' is both allowed and denied`,
        });
      }
    }
  },
);

/** What the reviewer is allowed to know. */
export interface KnowledgeConfig {
  /** Whether past reviews may become learnings. */
  readonly learningsEnabled: boolean;
  /** Whether linked issues are read for intent. */
  readonly useLinkedIssues: boolean;
  /** Whether repository instruction files are honoured. */
  readonly useRepositoryInstructions: boolean;
  /**
   * Whether external sources (MCP, web) may be consulted.
   *
   * Off by default in {@link PLATFORM_DEFAULT_REVIEW_CONFIG}: consulting an
   * external service means the change's context leaves the tenant boundary,
   * and that is a decision an organization makes deliberately (§26).
   */
  readonly useExternalSources: boolean;
}

export const knowledgeConfigSchema = z.strictObject({
  learningsEnabled: z.boolean(),
  useLinkedIssues: z.boolean(),
  useRepositoryInstructions: z.boolean(),
  useExternalSources: z.boolean(),
});

/** Which merge-policy checks run, and which of them block. */
export interface PreMergeConfig {
  readonly enabled: boolean;
  readonly checks: readonly NamespacedId[];
  /** A subset of `checks`. Only these stop a merge. */
  readonly blockingChecks: readonly NamespacedId[];
}

/** Field shape without the cross-field rule; see {@link toolConfigBaseSchema}. */
export const preMergeConfigBaseSchema = z.strictObject({
  enabled: z.boolean(),
  checks: z.array(namespacedIdSchema).max(200),
  blockingChecks: z.array(namespacedIdSchema).max(200),
});

export const preMergeConfigSchema = preMergeConfigBaseSchema.superRefine(
  (config, ctx) => {
    // A blocking check that is not in `checks` never runs, so it blocks
    // nothing — a configuration that reads as strict and behaves as absent.
    const checks = new Set(config.checks);
    for (const [index, check] of config.blockingChecks.entries()) {
      if (!checks.has(check)) {
        ctx.addIssue({
          code: "custom",
          path: ["blockingChecks", index],
          message: `Blocking check '${check}' is not in the enabled check list, so it would never run`,
        });
      }
    }
  },
);

/**
 * What reaches the pull request.
 *
 * Separate from {@link ReviewBehaviorConfig} because *finding* something and
 * *saying* it are different decisions. A team can run a thorough review and
 * publish only high-severity findings; collapsing the two would force them to
 * weaken the analysis to quieten the output, and the findings they suppressed
 * would no longer exist to be queried later.
 */
export interface PublicationConfig {
  /** Whether the run-level summary comment is posted. */
  readonly postSummary: boolean;
  /** Whether findings are posted as inline comments. */
  readonly postInlineComments: boolean;
  /** Whether suggested fixes are offered as suggestion blocks. */
  readonly postSuggestedFixes: boolean;
  /** Findings below this severity are recorded but not published. */
  readonly minSeverityToPublish: FindingSeverity;
  /** Findings below this confidence score are recorded but not published. */
  readonly minConfidenceToPublish: number;
  /** Cap on published comments per run, so one bad run cannot flood a PR. */
  readonly maxCommentsPerRun: number;
  /** Whether a provider review decision is submitted (§110 permitting). */
  readonly submitReviewDecision: boolean;
}

export const publicationConfigSchema = z.strictObject({
  postSummary: z.boolean(),
  postInlineComments: z.boolean(),
  postSuggestedFixes: z.boolean(),
  minSeverityToPublish: findingSeveritySchema,
  minConfidenceToPublish: z.number().min(0).max(1),
  maxCommentsPerRun: z.number().int().positive().max(1_000),
  submitReviewDecision: z.boolean(),
});

/**
 * A complete, resolved configuration.
 *
 * Field names follow §38 exactly, including `paths` for the path instructions.
 */
export interface ReviewConfig {
  readonly schemaVersion: number;
  readonly review: ReviewBehaviorConfig;
  readonly paths: readonly PathInstruction[];
  readonly tools: ToolConfig;
  readonly knowledge: KnowledgeConfig;
  readonly premerge: PreMergeConfig;
  readonly publication: PublicationConfig;
}

export const reviewConfigSchema = z.strictObject({
  schemaVersion: z
    .number()
    .int()
    .positive()
    .max(REVIEW_CONFIG_SCHEMA_VERSION, {
      error: `Unsupported ReviewConfig schemaVersion; this build understands up to ${String(REVIEW_CONFIG_SCHEMA_VERSION)}`,
    }),
  review: reviewBehaviorConfigSchema,
  paths: z.array(pathInstructionSchema).max(COLLECTION_LIMITS.pathInstructions),
  tools: toolConfigSchema,
  knowledge: knowledgeConfigSchema,
  premerge: preMergeConfigSchema,
  publication: publicationConfigSchema,
});

/**
 * The platform's defaults — the first stage of resolution (§109).
 *
 * Deep-frozen, because it is a module-level singleton every resolution starts
 * from: one accidental mutation would change the defaults for every tenant in
 * the process, and the symptom would appear somewhere else entirely.
 *
 * The values are deliberately conservative. `useExternalSources` is off (data
 * leaves the tenant only on request), `minSeverityToPublish` is `low` rather
 * than `info` (an unconfigured repository should not have its PRs filled with
 * nits), and every category is enabled (finding is cheap to configure down,
 * and a missed vulnerability is not recoverable after the fact).
 */
export const PLATFORM_DEFAULT_REVIEW_CONFIG: ReviewConfig = deepFreezeConfig({
  schemaVersion: REVIEW_CONFIG_SCHEMA_VERSION,
  review: {
    trigger: "on_push",
    depth: "standard",
    reviewDrafts: false,
    supersedeOnPush: true,
    categories: [...FINDING_CATEGORIES],
  },
  paths: [],
  tools: {
    enabled: true,
    allowed: [],
    denied: [],
    timeoutSeconds: 300,
  },
  knowledge: {
    learningsEnabled: true,
    useLinkedIssues: true,
    useRepositoryInstructions: true,
    useExternalSources: false,
  },
  premerge: {
    enabled: false,
    checks: [],
    blockingChecks: [],
  },
  publication: {
    postSummary: true,
    postInlineComments: true,
    postSuggestedFixes: true,
    minSeverityToPublish: "low",
    minConfidenceToPublish: 0.5,
    maxCommentsPerRun: 50,
    submitReviewDecision: true,
  },
});

/**
 * Freezes a config and every object and array inside it.
 *
 * `Object.freeze` is shallow: without this, `PLATFORM_DEFAULT_REVIEW_CONFIG`
 * would look immutable while `config.review.categories.push("style")` silently
 * widened the defaults process-wide — the same shallow-freeze defect the state
 * machines had.
 */
function deepFreezeConfig(config: ReviewConfig): ReviewConfig {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  };
  freeze(config);
  return config;
}
