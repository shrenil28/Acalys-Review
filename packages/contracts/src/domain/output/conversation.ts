/**
 * Comments and threaded discussion (P0.txt §35, §36).
 *
 * Two identities are kept apart throughout (§35):
 *
 *     CommentId                  the platform's own, minted before publication
 *     ProviderCommentReference   the provider's, known only after it succeeds
 *
 * The order matters: a comment exists in the platform *before* it exists on
 * GitHub, and publication can fail or be retried. Keying on the provider's id
 * would mean an unpublished comment has no identity, and a retry would create
 * a duplicate rather than updating the original.
 *
 * # Comments versus conversations
 *
 *     ReviewComment       one message the platform posted, usually for a finding
 *     ReviewConversation  a thread: the comment, plus every reply
 *
 * A finding has at most one *primary* comment (§35) — the one that reports it
 * — while the discussion that follows can run to any length. Modelling replies
 * as more `ReviewComment` rows attached to the finding would lose which one
 * was the original claim.
 *
 * Nothing here is coupled to the future Chat Agent (§36). A conversation
 * message is authored by an {@link Actor}, and whether that actor is a human
 * or an agent is a property of the actor, not of the thread.
 */

import { z } from "zod";
import {
  commentIdSchema,
  conversationIdSchema,
  conversationMessageIdSchema,
  findingIdSchema,
  organizationIdSchema,
  pullRequestIdSchema,
  repositoryIdSchema,
  reviewRunIdSchema,
  type CommentId,
  type ConversationId,
  type ConversationMessageId,
  type FindingId,
  type OrganizationId,
  type PullRequestId,
  type RepositoryId,
  type ReviewRunId,
} from "../identity/ids.js";
import {
  providerCommentReferenceSchema,
  type ProviderCommentReference,
} from "../provider/provider.js";
import {
  sourceLocationSchema,
  type SourceLocation,
} from "../location/source-location.js";
import { actorSchema, type Actor } from "../actor/actor.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { TEXT_LIMITS } from "../primitives/limits.js";

/**
 * What a comment is for.
 *
 * Publication needs the distinction: a `summary` comment is posted once per
 * run at the top of the change, while `finding` comments are anchored inline
 * and must be reconciled against previous runs so the same issue is not
 * re-posted on every push.
 */
export const REVIEW_COMMENT_KINDS = ["summary", "finding", "reply"] as const;
export type ReviewCommentKind = (typeof REVIEW_COMMENT_KINDS)[number];
export const reviewCommentKindSchema = z.enum(REVIEW_COMMENT_KINDS);

/**
 * A comment the platform authored.
 *
 * `providerReference` is absent until publication succeeds, which is exactly
 * what makes "posted or not?" answerable without asking the provider.
 */
export interface ReviewComment {
  readonly id: CommentId;
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
  readonly reviewRunId: ReviewRunId;
  readonly kind: ReviewCommentKind;
  /** The finding this reports. Absent for a summary comment. */
  readonly findingId?: FindingId | undefined;
  /** Set once the provider accepted it. Absent means unpublished. */
  readonly providerReference?: ProviderCommentReference | undefined;
  readonly author: Actor;
  readonly body: string;
  /** Where it is anchored. Absent for a summary comment. */
  readonly location?: SourceLocation | undefined;
  readonly createdAt: Timestamp;
  readonly updatedAt?: Timestamp | undefined;
}

export const reviewCommentSchema = z
  .strictObject({
    id: commentIdSchema,
    organizationId: organizationIdSchema,
    repositoryId: repositoryIdSchema,
    reviewRunId: reviewRunIdSchema,
    kind: reviewCommentKindSchema,
    findingId: findingIdSchema.optional(),
    providerReference: providerCommentReferenceSchema.optional(),
    author: actorSchema,
    body: z.string().min(1).max(TEXT_LIMITS.commentBody),
    location: sourceLocationSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema.optional(),
  })
  .superRefine((comment, ctx) => {
    // A finding comment that names no finding cannot be reconciled against a
    // later run, so the same issue would be re-posted on every push.
    if (comment.kind === "finding" && comment.findingId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["findingId"],
        message: "A 'finding' comment must name the finding it reports",
      });
    }
    // A summary comment covers the whole change; anchoring it to a finding or
    // a line would misrepresent its scope.
    if (comment.kind === "summary" && comment.findingId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["findingId"],
        message: "A 'summary' comment covers the change, not a single finding",
      });
    }
    if (comment.kind === "summary" && comment.location !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["location"],
        message: "A 'summary' comment is not anchored to a location",
      });
    }
    if (
      comment.location !== undefined &&
      comment.location.repositoryId !== comment.repositoryId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["location", "repositoryId"],
        message:
          "A comment's location must belong to the repository it was posted on",
      });
    }
    if (
      comment.updatedAt !== undefined &&
      comment.updatedAt < comment.createdAt
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "A comment cannot be updated before it is created",
      });
    }
  });

/** Whether the provider has accepted this comment. */
export function isPublished(comment: ReviewComment): boolean {
  return comment.providerReference !== undefined;
}

/**
 * One message in a thread.
 *
 * Immutable. An edit is a new message rather than a mutation, so the record of
 * what was said and when survives — the same rule as evidence and revisions
 * (§71).
 */
export interface ConversationMessage {
  readonly id: ConversationMessageId;
  readonly conversationId: ConversationId;
  readonly author: Actor;
  readonly body: string;
  readonly providerReference?: ProviderCommentReference | undefined;
  readonly createdAt: Timestamp;
}

export const conversationMessageSchema = z.strictObject({
  id: conversationMessageIdSchema,
  conversationId: conversationIdSchema,
  author: actorSchema,
  body: z.string().min(1).max(TEXT_LIMITS.commentBody),
  providerReference: providerCommentReferenceSchema.optional(),
  createdAt: timestampSchema,
});

/**
 * Whether a thread still needs attention.
 *
 * `resolved` is a participant's decision that the discussion is finished.
 * `archived` is the platform closing a thread nobody can act on any more — the
 * pull request merged, or the file it discussed is gone. Merging them would
 * lose whether a human agreed or the world moved on, which is the same
 * distinction `dismissed` and `stale` carry in the finding lifecycle.
 */
export const CONVERSATION_STATES = ["open", "resolved", "archived"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];
export const conversationStateSchema = z.enum(CONVERSATION_STATES);

/**
 * A thread of discussion.
 *
 * Holds message *ids*, not messages: a long thread would otherwise make every
 * read of the conversation fetch every message, and a message must be
 * appendable without rewriting the thread (§97).
 */
export interface ReviewConversation {
  readonly id: ConversationId;
  readonly organizationId: OrganizationId;
  readonly repositoryId: RepositoryId;
  /** The change this thread lives on. Absent for a local review (§112). */
  readonly pullRequestId?: PullRequestId | undefined;
  /** The finding under discussion, when the thread began from one. */
  readonly findingId?: FindingId | undefined;
  /** The comment that started it. */
  readonly rootCommentId?: CommentId | undefined;
  readonly messageIds: readonly ConversationMessageId[];
  readonly state: ConversationState;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export const reviewConversationSchema = z
  .strictObject({
    id: conversationIdSchema,
    organizationId: organizationIdSchema,
    repositoryId: repositoryIdSchema,
    pullRequestId: pullRequestIdSchema.optional(),
    findingId: findingIdSchema.optional(),
    rootCommentId: commentIdSchema.optional(),
    messageIds: z.array(conversationMessageIdSchema).max(1_000),
    state: conversationStateSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((conversation, ctx) => {
    if (conversation.updatedAt < conversation.createdAt) {
      ctx.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "A conversation cannot be updated before it is created",
      });
    }
    if (
      new Set(conversation.messageIds).size !== conversation.messageIds.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["messageIds"],
        message: "Message ids must be unique",
      });
    }
  });

/** Whether the thread still needs a response. */
export function isOpenConversation(conversation: ReviewConversation): boolean {
  return conversation.state === "open";
}
