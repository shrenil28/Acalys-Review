import { describe, expect, it } from "vitest";
import {
  EMPTY_FINDING_COUNTS,
  REVIEW_DECISIONS,
  findingCountsAreConsistent,
  reviewSummarySchema,
  summarizeFindingCounts,
} from "../../src/domain/output/review-summary.js";
import {
  isPublished,
  reviewCommentSchema,
  reviewConversationSchema,
} from "../../src/domain/output/conversation.js";
import {
  fileEditSchema,
  isSafeToAutoApply,
  operationRange,
  suggestedFixSchema,
  type SuggestedFix,
} from "../../src/domain/output/suggested-fix.js";
import { FINDING_SEVERITIES } from "../../src/domain/finding/taxonomy.js";
import { FINDING_LIFECYCLE_STATES } from "../../src/domain/finding/finding-lifecycle.js";
import { unsafeBrand } from "../../src/domain/primitives/brand.js";
import { repositoryPath } from "../../src/domain/primitives/repository-path.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";
import type {
  CommentId,
  ConversationId,
  ConversationMessageId,
  FindingId,
  OrganizationId,
  RepositoryId,
  ReviewRunId,
  SuggestedFixId,
} from "../../src/domain/identity/ids.js";

const uuid = (suffix: string) =>
  `0192f8a1-0000-7000-8000-${suffix.padStart(12, "0")}`;
const organizationId = unsafeBrand<OrganizationId>(uuid("1"));
const repositoryId = unsafeBrand<RepositoryId>(uuid("2"));
const reviewRunId = unsafeBrand<ReviewRunId>(uuid("3"));
const findingId = unsafeBrand<FindingId>(uuid("4"));
const commentId = unsafeBrand<CommentId>(uuid("5"));
const conversationId = unsafeBrand<ConversationId>(uuid("6"));
const messageId = unsafeBrand<ConversationMessageId>(uuid("7"));
const fixId = unsafeBrand<SuggestedFixId>(uuid("8"));
const at = timestamp("2026-08-16T10:00:00.000Z");

const summary = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  reviewRunId,
  overview: "Adds session revocation.",
  changedAreas: [],
  riskAreas: [],
  findingCounts: EMPTY_FINDING_COUNTS,
  generatedAt: at,
  ...overrides,
});

const comment = (overrides: Record<string, unknown> = {}) => ({
  id: commentId,
  organizationId,
  repositoryId,
  reviewRunId,
  kind: "summary" as const,
  author: { kind: "system" as const, component: "acalys.reviewer" },
  body: "Reviewed 4 files.",
  createdAt: at,
  ...overrides,
});

describe("ReviewSummary (P0.txt §33, §34)", () => {
  it("exists for a change with no findings", () => {
    // A summary is an orientation, not a roll-up: a clean change still needs
    // one, which a finding-derived summary could not produce.
    expect(reviewSummarySchema.safeParse(summary()).success).toBe(true);
  });

  it("may complete without a verdict", () => {
    // Publication can be suppressed by policy, and a working-tree target has
    // nothing to approve (§112).
    const parsed = reviewSummarySchema.parse(summary());
    expect(parsed.decision).toBeUndefined();
  });

  it("uses a provider-neutral decision vocabulary (§1, §34)", () => {
    expect([...REVIEW_DECISIONS]).toEqual([
      "approve",
      "request_changes",
      "comment",
      "neutral",
    ]);
    // GitHub's own vocabulary must not appear in the platform.
    expect(REVIEW_DECISIONS).not.toContain("REQUEST_CHANGES");
  });

  it("separates 'no opinion' from 'remarks only'", () => {
    for (const decision of ["neutral", "comment"] as const) {
      expect(reviewSummarySchema.safeParse(summary({ decision })).success).toBe(
        true,
      );
    }
    expect(
      reviewSummarySchema.safeParse(summary({ decision: "lgtm" })).success,
    ).toBe(false);
  });

  it("rejects a future schema version rather than misreading it", () => {
    expect(
      reviewSummarySchema.safeParse(summary({ schemaVersion: 2 })).success,
    ).toBe(false);
  });

  describe("finding counts", () => {
    it("tallies severities so the summary cannot disagree with the findings", () => {
      const counts = summarizeFindingCounts(["high", "high", "low", "info"]);

      expect(counts.total).toBe(4);
      expect(counts.bySeverity.high).toBe(2);
      expect(counts.bySeverity.critical).toBe(0);
      expect(findingCountsAreConsistent(counts)).toBe(true);
    });

    it("covers every severity in the taxonomy", () => {
      // A severity added to the taxonomy without a counter would silently
      // vanish from every summary.
      expect(Object.keys(EMPTY_FINDING_COUNTS.bySeverity).sort()).toEqual(
        [...FINDING_SEVERITIES].sort(),
      );
    });

    it("allows a total above the enumerated counts, for a truncated review", () => {
      const truncated = {
        total: 500,
        bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      };

      expect(
        reviewSummarySchema.safeParse(summary({ findingCounts: truncated }))
          .success,
      ).toBe(true);
      expect(findingCountsAreConsistent(truncated)).toBe(false);
    });

    it("rejects a negative count", () => {
      const negative = {
        total: 0,
        bySeverity: { critical: -1, high: 0, medium: 0, low: 0, info: 0 },
      };
      expect(
        reviewSummarySchema.safeParse(summary({ findingCounts: negative }))
          .success,
      ).toBe(false);
    });
  });
});

describe("ReviewComment (P0.txt §35)", () => {
  it("has platform identity before it has provider identity", () => {
    // A comment exists before it exists on GitHub. Keying on the provider's id
    // would leave an unpublished comment with no identity, and a retry would
    // duplicate rather than update.
    const unpublished = reviewCommentSchema.parse(comment());

    expect(unpublished.id).toBe(commentId);
    expect(unpublished.providerReference).toBeUndefined();
    expect(isPublished(unpublished)).toBe(false);
  });

  it("reports publication once the provider accepts it", () => {
    const published = reviewCommentSchema.parse(
      comment({
        providerReference: {
          kind: "comment",
          provider: "github",
          externalId: "1234567890",
        },
      }),
    );

    expect(isPublished(published)).toBe(true);
  });

  it("requires a finding comment to name its finding", () => {
    // Without it the comment cannot be reconciled against a later run, so the
    // same issue is re-posted on every push.
    expect(
      reviewCommentSchema.safeParse(comment({ kind: "finding" })).success,
    ).toBe(false);
    expect(
      reviewCommentSchema.safeParse(comment({ kind: "finding", findingId }))
        .success,
    ).toBe(true);
  });

  it("refuses to anchor a summary comment to a finding or a line", () => {
    expect(
      reviewCommentSchema.safeParse(comment({ kind: "summary", findingId }))
        .success,
    ).toBe(false);
  });

  it("refuses a location belonging to another repository", () => {
    const foreign = {
      repositoryId: unsafeBrand<RepositoryId>(uuid("99")),
      path: repositoryPath("src/a.ts"),
    };
    expect(
      reviewCommentSchema.safeParse(
        comment({ kind: "finding", findingId, location: foreign }),
      ).success,
    ).toBe(false);
  });

  it("refuses an update recorded before creation", () => {
    expect(
      reviewCommentSchema.safeParse(
        comment({ updatedAt: timestamp("2026-08-16T09:00:00.000Z") }),
      ).success,
    ).toBe(false);
  });
});

describe("ReviewConversation (P0.txt §36)", () => {
  const conversation = (overrides: Record<string, unknown> = {}) => ({
    id: conversationId,
    organizationId,
    repositoryId,
    messageIds: [messageId],
    state: "open" as const,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });

  it("holds message ids, not messages", () => {
    // A long thread would otherwise make every read fetch every message, and a
    // reply could not be appended without rewriting the thread (§97).
    const parsed = reviewConversationSchema.parse(conversation());
    expect(parsed.messageIds).toEqual([messageId]);
  });

  it("distinguishes a participant resolving a thread from the platform archiving it", () => {
    // The same distinction `dismissed` and `stale` carry for findings: whether
    // a human agreed, or the world moved on.
    for (const state of ["open", "resolved", "archived"] as const) {
      expect(
        reviewConversationSchema.safeParse(conversation({ state })).success,
      ).toBe(true);
    }
  });

  it("rejects duplicate message ids", () => {
    expect(
      reviewConversationSchema.safeParse(
        conversation({ messageIds: [messageId, messageId] }),
      ).success,
    ).toBe(false);
  });

  it("works with no pull request, for a local review (§112)", () => {
    const parsed = reviewConversationSchema.parse(conversation());
    expect(parsed.pullRequestId).toBeUndefined();
  });
});

describe("SuggestedFix (P0.txt §37)", () => {
  const edit = (operations: readonly unknown[], blobSha?: string) => ({
    path: repositoryPath("src/auth.ts"),
    ...(blobSha === undefined ? {} : { baseBlobSha: blobSha }),
    operations,
  });

  const fix = (overrides: Record<string, unknown> = {}) => ({
    id: fixId,
    findingId,
    description: "Use a parameterized query.",
    edits: [
      edit([
        { kind: "replace_lines", lines: { start: 10, end: 12 }, text: "…" },
      ]),
    ],
    validation: { level: "unvalidated" as const },
    createdAt: at,
    ...overrides,
  });

  it("is structured edits, not an opaque patch", () => {
    // §37: a fix must be checkable before it is applied, which a unified diff
    // blob is not.
    const parsed = suggestedFixSchema.parse(fix());
    const operation = parsed.edits[0]?.operations[0];
    expect(operation?.kind).toBe("replace_lines");
  });

  it("anchors to a blob sha, not a commit sha", () => {
    // A commit sha changes when any file changes, which would invalidate every
    // fix in the change on every push. A blob sha changes only when this file
    // does.
    const parsed = suggestedFixSchema.parse(
      fix({
        edits: [
          edit(
            [{ kind: "delete_lines", lines: { start: 4, end: 4 } }],
            "a".repeat(40),
          ),
        ],
      }),
    );
    expect(parsed.edits[0]?.baseBlobSha).toBe("a".repeat(40));
  });

  it("rejects a malformed blob sha", () => {
    expect(
      suggestedFixSchema.safeParse(
        fix({
          edits: [
            edit(
              [{ kind: "delete_lines", lines: { start: 1, end: 1 } }],
              "abc",
            ),
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects overlapping operations, whose result would depend on order", () => {
    const overlapping = fileEditSchema.safeParse(
      edit([
        { kind: "replace_lines", lines: { start: 10, end: 20 }, text: "a" },
        { kind: "replace_lines", lines: { start: 15, end: 25 }, text: "b" },
      ]),
    );
    expect(overlapping.success).toBe(false);
  });

  it("rejects two insertions at the same point, which are equally ambiguous", () => {
    const ambiguous = fileEditSchema.safeParse(
      edit([
        { kind: "insert_before", line: 10, text: "a" },
        { kind: "insert_before", line: 10, text: "b" },
      ]),
    );
    expect(ambiguous.success).toBe(false);
  });

  it("accepts adjacent, non-overlapping operations", () => {
    expect(
      fileEditSchema.safeParse(
        edit([
          { kind: "replace_lines", lines: { start: 1, end: 5 }, text: "a" },
          { kind: "replace_lines", lines: { start: 6, end: 9 }, text: "b" },
        ]),
      ).success,
    ).toBe(true);
  });

  it("treats an insertion as a zero-width point", () => {
    expect(
      operationRange({ kind: "insert_before", line: 7, text: "x" }),
    ).toEqual({
      start: 7,
      end: 7,
    });
  });

  it("rejects the same file appearing twice", () => {
    const duplicated = fix({
      edits: [
        edit([{ kind: "delete_lines", lines: { start: 1, end: 1 } }]),
        edit([{ kind: "delete_lines", lines: { start: 5, end: 5 } }]),
      ],
    });
    expect(suggestedFixSchema.safeParse(duplicated).success).toBe(false);
  });

  it("rejects a 0-based line", () => {
    expect(
      fileEditSchema.safeParse(
        edit([{ kind: "insert_before", line: 0, text: "x" }]),
      ).success,
    ).toBe(false);
  });

  describe("auto-apply safety", () => {
    const build = (
      level: "unvalidated" | "applies_cleanly" | "compiles" | "tests_pass",
      blobSha: string | undefined,
    ): SuggestedFix =>
      suggestedFixSchema.parse(
        fix({
          validation:
            level === "unvalidated" ? { level } : { level, validatedAt: at },
          edits: [
            edit(
              [{ kind: "delete_lines", lines: { start: 1, end: 1 } }],
              blobSha,
            ),
          ],
        }),
      );

    it("requires both passing tests and an anchor", () => {
      // Passing tests say the result is correct; the anchor says it will land
      // on the file it was computed against rather than corrupting one that
      // has since changed. Either alone is insufficient.
      expect(isSafeToAutoApply(build("tests_pass", "a".repeat(40)))).toBe(true);
      expect(isSafeToAutoApply(build("tests_pass", undefined))).toBe(false);
      expect(isSafeToAutoApply(build("compiles", "a".repeat(40)))).toBe(false);
      expect(isSafeToAutoApply(build("applies_cleanly", "a".repeat(40)))).toBe(
        false,
      );
      expect(isSafeToAutoApply(build("unvalidated", "a".repeat(40)))).toBe(
        false,
      );
    });
  });

  it("requires a validation time once validated, and forbids one before", () => {
    expect(
      suggestedFixSchema.safeParse(fix({ validation: { level: "compiles" } }))
        .success,
    ).toBe(false);
    expect(
      suggestedFixSchema.safeParse(
        fix({ validation: { level: "unvalidated", validatedAt: at } }),
      ).success,
    ).toBe(false);
  });
});

describe("Output vocabularies stay distinct from the finding lifecycle", () => {
  it("does not reuse lifecycle state names for conversation states", () => {
    // A shared word across two machines is how a consumer ends up switching on
    // the wrong one. `resolved` is the sole deliberate overlap, and it means
    // the same thing in both: a human decided it is finished.
    const overlap = ["open", "resolved", "archived"].filter((state) =>
      (FINDING_LIFECYCLE_STATES as readonly string[]).includes(state),
    );
    expect(overlap).toEqual(["resolved"]);
  });
});
