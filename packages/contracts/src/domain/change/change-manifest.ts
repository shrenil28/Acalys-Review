/**
 * The canonical description of what changed (P0.txt §21, §123).
 *
 * This is the boundary that keeps the review engine off GitHub's API shape:
 *
 *     GitHub / GitLab ──> provider adapter ──> ChangeManifest ──> review engine
 *
 * and never
 *
 *     review engine ──> GitHub API response JSON
 *
 * So it cannot be `files: string[]`. A reviewer needs to know *which lines*
 * moved, whether a file was renamed (so a finding on the old path can follow
 * it), whether content is binary (unreviewable), and whether it is generated
 * (reviewable but pointless). All of that has to survive the adapter, because
 * the engine can never go back and ask the provider.
 *
 * **What deliberately is not here: patch text.** A manifest describes the
 * shape of a change and is carried in queue messages and events; embedding
 * diffs would make a large PR's manifest tens of megabytes (§21, §45). The
 * bytes live in an artifact; `patchArtifactId` points at them.
 *
 * **Ordering is part of the contract** (§123). `files` and `languages` are
 * sorted, because a manifest is hashed for caching and reproducibility, and
 * two adapters listing the same files in different orders must produce the
 * same manifest.
 */

import { z } from "zod";
import {
  artifactIdSchema,
  pullRequestRevisionIdSchema,
  repositoryIdSchema,
  type ArtifactId,
  type PullRequestRevisionId,
  type RepositoryId,
} from "../identity/ids.js";
import { gitComparisonSchema, type GitComparison } from "../git/git-refs.js";
import {
  repositoryPathSchema,
  type RepositoryPath,
} from "../primitives/repository-path.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { COLLECTION_LIMITS, TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/** Schema version for this transported contract (§7). */
export const CHANGE_MANIFEST_SCHEMA_VERSION = 1;

/**
 * How a file changed.
 *
 * `renamed` and `copied` are distinct from `added`/`deleted` because they
 * carry `previousPath`, which is what lets an existing finding follow a file
 * across a rename instead of being reported as fixed-and-reintroduced (§28).
 */
export const CHANGE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
] as const;

export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

/**
 * An inclusive 1-based line span.
 *
 * 1-based because that is what every editor, every provider comment API, and
 * every compiler diagnostic uses; a 0-based span here would mean an off-by-one
 * at every boundary. Stated explicitly because §22 warns against leaving the
 * convention implicit.
 */
export interface LineRange {
  /** First line, 1-based and inclusive. */
  readonly start: number;
  /** Last line, 1-based and inclusive. Equals `start` for a single line. */
  readonly end: number;
}

export const lineRangeSchema = z
  .strictObject({
    start: z.number().int().positive({ error: "Lines are 1-based" }),
    end: z.number().int().positive({ error: "Lines are 1-based" }),
  })
  .refine((range) => range.end >= range.start, {
    error: "Line range ends before it starts",
    path: ["end"],
  });

/**
 * One contiguous changed region within a file.
 *
 * Both sides are optional, and which one is absent carries meaning:
 * a pure addition has no `base` range, a pure deletion has no `head` range,
 * and a modification has both. Requiring both would force adapters to
 * fabricate empty ranges and lose that signal.
 */
export interface DiffHunk {
  /** Lines as they were, before the change. Absent for pure additions. */
  readonly base?: LineRange | undefined;
  /** Lines as they are, after the change. Absent for pure deletions. */
  readonly head?: LineRange | undefined;
}

export const diffHunkSchema = z
  .strictObject({
    base: lineRangeSchema.optional(),
    head: lineRangeSchema.optional(),
  })
  .refine((hunk) => hunk.base !== undefined || hunk.head !== undefined, {
    error: "A hunk must touch at least one side",
  });

/**
 * One file in the change.
 *
 * `binary` and `generated` exist so the engine can skip files cheaply and for
 * the right reason. A binary file *cannot* be reviewed line by line; a
 * generated one *should not* be, but still counts toward blast radius. They
 * are different decisions and collapsing them loses that.
 */
export interface ChangedFile {
  readonly path: RepositoryPath;
  /** Where the file came from. Present only for `renamed` / `copied`. */
  readonly previousPath?: RepositoryPath | undefined;
  readonly status: ChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  /**
   * Detected language, as a namespaced id (`lang.typescript`).
   *
   * Namespaced rather than a closed enum: languages are an open set, and a new
   * one must not require a schema release (§79).
   */
  readonly language?: NamespacedId | undefined;
  /** Lockfiles, compiled output, codegen. Reviewable but rarely worth it. */
  readonly generated?: boolean | undefined;
  /**
   * Changed regions. Absent when the adapter has not computed them, empty for
   * a binary file. Absent and empty mean different things — "unknown" versus
   * "known to be none".
   */
  readonly hunks?: readonly DiffHunk[] | undefined;
}

export const changedFileSchema = z
  .strictObject({
    path: repositoryPathSchema,
    previousPath: repositoryPathSchema.optional(),
    status: z.enum(CHANGE_STATUSES),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
    language: namespacedIdSchema.optional(),
    generated: z.boolean().optional(),
    hunks: z
      .array(diffHunkSchema)
      .max(COLLECTION_LIMITS.changedFiles)
      .optional(),
  })
  .superRefine((file, ctx) => {
    // A rename with no origin is unusable: findings cannot follow the file,
    // which is the only reason the status exists as its own value.
    if (
      (file.status === "renamed" || file.status === "copied") &&
      file.previousPath === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["previousPath"],
        message: `A '${file.status}' file must record previousPath`,
      });
    }
    if (
      file.previousPath !== undefined &&
      file.status !== "renamed" &&
      file.status !== "copied"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["previousPath"],
        message: `previousPath is only meaningful for renamed or copied files, not '${file.status}'`,
      });
    }
    // Line counts are meaningless for binary content; carrying non-zero ones
    // would corrupt the statistics that drive blast-radius estimates.
    if (file.binary && (file.additions > 0 || file.deletions > 0)) {
      ctx.addIssue({
        code: "custom",
        message: "A binary file cannot report line additions or deletions",
      });
    }
  });

/** Roll-up counts, so consumers need not re-walk `files`. */
export interface ChangeStatistics {
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly filesAdded: number;
  readonly filesModified: number;
  readonly filesDeleted: number;
  readonly filesRenamed: number;
  readonly binaryFiles: number;
  readonly generatedFiles: number;
}

export const changeStatisticsSchema = z.strictObject({
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  filesAdded: z.number().int().nonnegative(),
  filesModified: z.number().int().nonnegative(),
  filesDeleted: z.number().int().nonnegative(),
  filesRenamed: z.number().int().nonnegative(),
  binaryFiles: z.number().int().nonnegative(),
  generatedFiles: z.number().int().nonnegative(),
});

/** Per-language totals, for routing and reporting. */
export interface LanguageChangeSummary {
  readonly language: NamespacedId;
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

export const languageChangeSummarySchema = z.strictObject({
  language: namespacedIdSchema,
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

/**
 * A structural fact worth the reviewer's attention.
 *
 * Deliberately **not** a severity or a finding. A risk signal says "a database
 * migration is present"; it does not say anything is wrong. Findings are
 * claims about defects and carry evidence (§29); signals are routing hints.
 * Conflating them would let "touched auth code" render as a security issue.
 *
 * The full analysis that populates these is a later phase; Phase 0 fixes the
 * shape so the manifest need not change when it lands.
 */
export interface RiskSignal {
  /** e.g. `acalys.risk.database-migration`, `acalys.risk.auth-surface`. */
  readonly id: NamespacedId;
  /** One line, human-facing. */
  readonly summary: string;
  /** Files that triggered it. */
  readonly paths?: readonly RepositoryPath[] | undefined;
}

export const riskSignalSchema = z.strictObject({
  id: namespacedIdSchema,
  summary: z.string().min(1).max(TEXT_LIMITS.summary),
  paths: z
    .array(repositoryPathSchema)
    .max(COLLECTION_LIMITS.changedFiles)
    .optional(),
});

/**
 * A symbol whose definition changed.
 *
 * Shape only in Phase 0 — populating it needs the AST/symbol-graph subsystem
 * from a later phase. Declared now so that landing it is additive rather than
 * a manifest schema break.
 */
export interface ChangedSymbol {
  readonly path: RepositoryPath;
  /** Fully-qualified where the language has one, e.g. `auth.Session.verify`. */
  readonly name: string;
  /** `function`, `class`, `method`, … as a namespaced id (open set). */
  readonly kind: NamespacedId;
  readonly changeStatus: ChangeStatus;
  readonly range?: LineRange | undefined;
}

export const changedSymbolSchema = z.strictObject({
  path: repositoryPathSchema,
  name: z.string().min(1).max(TEXT_LIMITS.identifier),
  kind: namespacedIdSchema,
  changeStatus: z.enum(CHANGE_STATUSES),
  range: lineRangeSchema.optional(),
});

/** A dependency added, removed, or version-changed. */
export interface DependencyChange {
  /** Manifest that declares it, e.g. `package.json`. */
  readonly path: RepositoryPath;
  readonly ecosystem: NamespacedId;
  readonly name: string;
  readonly fromVersion?: string | undefined;
  readonly toVersion?: string | undefined;
  readonly changeStatus: ChangeStatus;
}

export const dependencyChangeSchema = z.strictObject({
  path: repositoryPathSchema,
  ecosystem: namespacedIdSchema,
  name: z.string().min(1).max(TEXT_LIMITS.identifier),
  fromVersion: z.string().max(TEXT_LIMITS.identifier).optional(),
  toVersion: z.string().max(TEXT_LIMITS.identifier).optional(),
  changeStatus: z.enum(CHANGE_STATUSES),
});

/**
 * What changed at one revision, in the platform's own vocabulary.
 *
 * Produced by the analysis stage, consumed by every reviewer agent, tool
 * scheduler, and pre-merge check. `revisionId` is present for pull-request
 * reviews and absent for local ones, matching §112: a working-tree review has
 * no revision to point at, and requiring one would break local review.
 */
export interface ChangeManifest {
  readonly schemaVersion: number;
  readonly repositoryId: RepositoryId;
  /** The revision analyzed. Absent for commit-range and working-tree reviews. */
  readonly revisionId?: PullRequestRevisionId | undefined;
  readonly comparison: GitComparison;
  /** Sorted by path, ascending (§123). */
  readonly files: readonly ChangedFile[];
  readonly stats: ChangeStatistics;
  /** Sorted by language id, ascending (§123). */
  readonly languages: readonly LanguageChangeSummary[];
  readonly changedSymbols?: readonly ChangedSymbol[] | undefined;
  readonly dependencyChanges?: readonly DependencyChange[] | undefined;
  readonly riskSignals?: readonly RiskSignal[] | undefined;
  /** Where the raw patch lives. The bytes are never inline (§45). */
  readonly patchArtifactId?: ArtifactId | undefined;
  /**
   * True when `files` is a subset because the change exceeded
   * {@link COLLECTION_LIMITS.changedFiles}.
   *
   * Explicit rather than silent: a reviewer that does not know it saw a
   * truncated change will confidently report that nothing else was touched.
   */
  readonly truncated: boolean;
  readonly generatedAt: Timestamp;
}

export const changeManifestSchema = z.strictObject({
  schemaVersion: z
    .number()
    .int()
    .positive()
    .max(CHANGE_MANIFEST_SCHEMA_VERSION, {
      error: `Unsupported ChangeManifest schemaVersion; this build understands up to ${String(CHANGE_MANIFEST_SCHEMA_VERSION)}`,
    }),
  repositoryId: repositoryIdSchema,
  revisionId: pullRequestRevisionIdSchema.optional(),
  comparison: gitComparisonSchema,
  files: z.array(changedFileSchema).max(COLLECTION_LIMITS.changedFiles),
  stats: changeStatisticsSchema,
  languages: z.array(languageChangeSummarySchema).max(256),
  changedSymbols: z.array(changedSymbolSchema).max(10_000).optional(),
  dependencyChanges: z.array(dependencyChangeSchema).max(5_000).optional(),
  riskSignals: z.array(riskSignalSchema).max(256).optional(),
  patchArtifactId: artifactIdSchema.optional(),
  truncated: z.boolean(),
  generatedAt: timestampSchema,
});

/**
 * Canonical ordering (§123).
 *
 * Applied by the adapter before the manifest is hashed or stored. Sorting by
 * code unit rather than locale, because `localeCompare` varies by ICU version
 * and environment — a locale-sensitive sort would make the manifest hash
 * differ between machines, defeating the point.
 */
export function sortChangedFiles(
  files: readonly ChangedFile[],
): readonly ChangedFile[] {
  return [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export function sortLanguageSummaries(
  languages: readonly LanguageChangeSummary[],
): readonly LanguageChangeSummary[] {
  return [...languages].sort((left, right) =>
    left.language < right.language
      ? -1
      : left.language > right.language
        ? 1
        : 0,
  );
}

/**
 * Derives statistics from files, so they cannot disagree with the list.
 *
 * Adapters should call this rather than counting by hand: a manifest whose
 * `stats.additions` contradicts its `files` is a silent corruption that
 * surfaces much later as a wrong blast-radius estimate.
 */
export function computeChangeStatistics(
  files: readonly ChangedFile[],
): ChangeStatistics {
  let additions = 0;
  let deletions = 0;
  let filesAdded = 0;
  let filesModified = 0;
  let filesDeleted = 0;
  let filesRenamed = 0;
  let binaryFiles = 0;
  let generatedFiles = 0;

  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
    if (file.binary) binaryFiles += 1;
    if (file.generated === true) generatedFiles += 1;

    switch (file.status) {
      case "added":
        filesAdded += 1;
        break;
      case "modified":
      case "type_changed":
        filesModified += 1;
        break;
      case "deleted":
        filesDeleted += 1;
        break;
      case "renamed":
      case "copied":
        filesRenamed += 1;
        break;
    }
  }

  return {
    filesChanged: files.length,
    additions,
    deletions,
    filesAdded,
    filesModified,
    filesDeleted,
    filesRenamed,
    binaryFiles,
    generatedFiles,
  };
}

/**
 * Files worth sending to a reviewer agent.
 *
 * Deletions are excluded because there is no post-change content to review;
 * binaries because they cannot be read as text; generated files because
 * reviewing compiled output or a lockfile wastes the model's context on code
 * no human wrote. All three remain in `files` and in `stats` — they still
 * count toward the size of the change.
 */
export function reviewableFiles(
  manifest: ChangeManifest,
): readonly ChangedFile[] {
  return manifest.files.filter(
    (file) =>
      file.status !== "deleted" && !file.binary && file.generated !== true,
  );
}

/** Total lines touched — the crude size signal for routing and budgeting. */
export function totalLinesChanged(manifest: ChangeManifest): number {
  return manifest.stats.additions + manifest.stats.deletions;
}
