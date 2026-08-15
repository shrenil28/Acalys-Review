/**
 * A proposed code change attached to a finding (P0.txt §37).
 *
 * §37's requirement is that a fix must not be "an arbitrary patch stuffed into
 * a finding". A unified-diff blob is opaque: it cannot be validated before it
 * is applied, cannot be rendered as a provider suggestion block, and cannot be
 * checked against the file it claims to modify. So a fix is **structured
 * edits**, which can be.
 *
 * The critical safety property is `baseBlobSha`. An edit describes a change to
 * a file *as it was*, and by the time anyone applies it the file may have
 * moved on. Without the anchor, applying a stale edit silently corrupts code —
 * the string it searched for may now appear somewhere else entirely. With it,
 * a stale edit is detected and refused.
 *
 * The fix **agent** is a later phase. This contract exists so that when it
 * lands, its output has somewhere to go that is already validated,
 * publishable, and safe to apply.
 */

import { z } from "zod";
import {
  findingIdSchema,
  suggestedFixIdSchema,
  type FindingId,
  type SuggestedFixId,
} from "../identity/ids.js";
import {
  repositoryPathSchema,
  type RepositoryPath,
} from "../primitives/repository-path.js";
import { lineRangeSchema, type LineRange } from "../location/line-range.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { COLLECTION_LIMITS, TEXT_LIMITS } from "../primitives/limits.js";
import { assertNever } from "../primitives/assert-never.js";

/**
 * A single edit within one file.
 *
 * A union rather than a general "replace these lines with this text", because
 * the three cases have different failure modes and different renderings. A
 * `replace_lines` edit maps directly onto a provider suggestion block; an
 * `insert` does not, and squeezing an insertion into a replacement means
 * re-emitting untouched lines the reviewer never intended to claim.
 */
export type EditOperation =
  | {
      readonly kind: "replace_lines";
      /** Lines to replace, 1-based inclusive, in the file as it stands. */
      readonly lines: LineRange;
      /** Replacement text. May be empty to delete the span. */
      readonly text: string;
    }
  | {
      readonly kind: "insert_before";
      /** 1-based line the text goes above. */
      readonly line: number;
      readonly text: string;
    }
  | {
      readonly kind: "delete_lines";
      readonly lines: LineRange;
    };

export const editOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("replace_lines"),
    lines: lineRangeSchema,
    // Empty is legal: it deletes the span. `delete_lines` says the same thing
    // more clearly, but a generator emitting an empty replacement is not wrong.
    text: z.string().max(TEXT_LIMITS.explanation),
  }),
  z.strictObject({
    kind: z.literal("insert_before"),
    line: z.number().int().positive({ error: "Lines are 1-based" }),
    text: z.string().min(1).max(TEXT_LIMITS.explanation),
  }),
  z.strictObject({
    kind: z.literal("delete_lines"),
    lines: lineRangeSchema,
  }),
]);

/** The lines an operation touches, for overlap detection. */
export function operationRange(operation: EditOperation): LineRange {
  switch (operation.kind) {
    case "replace_lines":
    case "delete_lines":
      return operation.lines;
    case "insert_before":
      // An insertion occupies no existing lines; treating it as a zero-width
      // point at `line` is what lets two insertions at the same place be
      // detected as ambiguous.
      return { start: operation.line, end: operation.line };
    default:
      return assertNever(operation, "operationRange");
  }
}

/**
 * Every edit to one file.
 *
 * `baseBlobSha` is the Git blob hash of the file this edit was computed
 * against — not the commit. A commit sha changes when *any* file changes,
 * which would invalidate every fix in the change on every push; a blob sha
 * changes only when this file does.
 */
export interface FileEdit {
  readonly path: RepositoryPath;
  /** Blob hash the edit was computed against. Absent means unverifiable. */
  readonly baseBlobSha?: string | undefined;
  readonly operations: readonly EditOperation[];
}

const BLOB_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export const fileEditSchema = z
  .strictObject({
    path: repositoryPathSchema,
    baseBlobSha: z
      .string()
      .transform((value) => value.toLowerCase())
      .refine((value) => BLOB_SHA.test(value), {
        error: "Expected a full Git blob hash (40 or 64 hex characters)",
      })
      .optional(),
    operations: z
      .array(editOperationSchema)
      .min(1, { error: "A file edit must contain at least one operation" })
      .max(COLLECTION_LIMITS.fixEdits),
  })
  .superRefine((edit, ctx) => {
    // Overlapping operations are ambiguous: applying them in either order
    // produces a different file, so there is no single correct result.
    const ranges = edit.operations.map(operationRange);
    for (let outer = 0; outer < ranges.length; outer += 1) {
      for (let inner = outer + 1; inner < ranges.length; inner += 1) {
        const left = ranges[outer];
        const right = ranges[inner];
        if (left === undefined || right === undefined) continue;
        if (left.start <= right.end && right.start <= left.end) {
          ctx.addIssue({
            code: "custom",
            path: ["operations", inner],
            message: `Operation ${String(inner)} overlaps operation ${String(outer)}; the result would depend on application order`,
          });
        }
      }
    }
  });

/**
 * Whether a fix was validated, and how far.
 *
 * Three levels, because they license different actions. `applies_cleanly`
 * means the edit still matches the file — enough to *offer*. `compiles` and
 * `tests_pass` are progressively stronger and are what an auto-apply policy
 * should require: a fix that applies but does not compile is worse than no fix.
 */
export const FIX_VALIDATION_LEVELS = [
  "unvalidated",
  "applies_cleanly",
  "compiles",
  "tests_pass",
] as const;

export type FixValidationLevel = (typeof FIX_VALIDATION_LEVELS)[number];
export const fixValidationLevelSchema = z.enum(FIX_VALIDATION_LEVELS);

export interface SuggestedFixValidation {
  readonly level: FixValidationLevel;
  /** When it was validated. Absent while unvalidated. */
  readonly validatedAt?: Timestamp | undefined;
}

export const suggestedFixValidationSchema = z
  .strictObject({
    level: fixValidationLevelSchema,
    validatedAt: timestampSchema.optional(),
  })
  .superRefine((validation, ctx) => {
    if (
      validation.level !== "unvalidated" &&
      validation.validatedAt === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["validatedAt"],
        message: "A validated fix must record when it was validated",
      });
    }
    if (
      validation.level === "unvalidated" &&
      validation.validatedAt !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["validatedAt"],
        message: "An unvalidated fix has no validation time",
      });
    }
  });

/**
 * A proposed change that resolves a finding.
 *
 * Belongs to exactly one finding: a fix spanning several findings cannot be
 * offered or accepted per-finding, which is how a reviewer actually interacts
 * with them.
 */
export interface SuggestedFix {
  readonly id: SuggestedFixId;
  readonly findingId: FindingId;
  /** What the fix does, for a human deciding whether to take it. */
  readonly description: string;
  readonly edits: readonly FileEdit[];
  readonly validation: SuggestedFixValidation;
  readonly createdAt: Timestamp;
}

export const suggestedFixSchema = z
  .strictObject({
    id: suggestedFixIdSchema,
    findingId: findingIdSchema,
    description: z.string().min(1).max(TEXT_LIMITS.summary),
    edits: z
      .array(fileEditSchema)
      .min(1, { error: "A suggested fix must change at least one file" })
      .max(COLLECTION_LIMITS.fixEdits),
    validation: suggestedFixValidationSchema,
    createdAt: timestampSchema,
  })
  .superRefine((fix, ctx) => {
    // Two edits to one file would need merging before either could be applied,
    // and their operations could not be overlap-checked against each other.
    const paths = fix.edits.map((edit) => edit.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: "custom",
        path: ["edits"],
        message: "Each file may appear at most once; combine its operations",
      });
    }
  });

/**
 * Whether this fix may be applied without a human reading it first.
 *
 * Requires `tests_pass` and a blob anchor on every edit. Both matter: passing
 * tests say the result is correct, and the anchors say it will land on the
 * file it was computed against rather than silently corrupting a file that has
 * since changed.
 */
export function isSafeToAutoApply(fix: SuggestedFix): boolean {
  return (
    fix.validation.level === "tests_pass" &&
    fix.edits.every((edit) => edit.baseBlobSha !== undefined)
  );
}
