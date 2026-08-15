/**
 * References to what the reviewer knew (P0.txt §43, §116).
 *
 * A review is only as good as its context: the repository's conventions, a
 * learning from a previous review, the linked issue that explains *why* the
 * change exists. This module names those sources so a finding can cite them.
 *
 * **Retrieval is not implemented here** (§43), and neither is storage. In
 * particular there is no embedding, no vector, and no similarity score
 * anywhere in this contract: how knowledge is *found* is an implementation
 * detail of the knowledge subsystem, and baking a retrieval strategy into the
 * domain would make swapping it a schema change (§116).
 *
 * What a `KnowledgeReference` provides is provenance — "this finding cites the
 * team's rule about direct SQL" — which is what makes a review's reasoning
 * auditable and what lets a user correct a bad learning at its source.
 */

import { z } from "zod";
import {
  organizationIdSchema,
  repositoryIdSchema,
  type OrganizationId,
  type RepositoryId,
} from "../identity/ids.js";
import {
  repositoryPathSchema,
  type RepositoryPath,
} from "../primitives/repository-path.js";
import { timestampSchema, type Timestamp } from "../primitives/timestamp.js";
import { TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/**
 * Where a piece of knowledge came from (§43).
 *
 * The distinctions carry different authority, which is why the vocabulary is
 * closed rather than a free-form label: an `organization_instruction` is a
 * standing rule a human wrote, while a `learning` was inferred by the platform
 * and may be wrong. A reviewer weighing them equally would let its own past
 * mistakes harden into policy.
 */
export const KNOWLEDGE_SOURCE_TYPES = [
  "repository_instruction",
  "organization_instruction",
  "path_instruction",
  "learning",
  "pull_request",
  "issue",
  "external_document",
  "mcp",
  "web",
] as const;

export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export const knowledgeSourceTypeSchema = z.enum(KNOWLEDGE_SOURCE_TYPES);

/**
 * How far a piece of knowledge applies.
 *
 * Scope is what stops one team's convention leaking into another's review. A
 * `path` learning about the migrations directory must not be applied to the
 * frontend, and an `organization` rule must reach every repository.
 */
export const KNOWLEDGE_SCOPES = ["organization", "repository", "path"] as const;

export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number];

export const knowledgeScopeSchema = z.enum(KNOWLEDGE_SCOPES);

/**
 * A citation of something the reviewer consulted.
 *
 * `sourceId` is namespaced and opaque to the domain: it identifies the item
 * within whichever store owns it, and only that store interprets it.
 *
 * `summary` is a short human-readable recap, never the knowledge itself. Full
 * text lives in the knowledge store — inlining it would put a team's entire
 * conventions document into every finding that cited it (§65).
 */
export interface KnowledgeReference {
  readonly sourceType: KnowledgeSourceType;
  readonly scope: KnowledgeScope;
  /** Identity within the owning store, e.g. `learning.0192f8a1`. */
  readonly sourceId: NamespacedId;
  readonly organizationId: OrganizationId;
  /** Present when scope is `repository` or `path`. */
  readonly repositoryId?: RepositoryId | undefined;
  /** The path or glob this applies to. Present when scope is `path`. */
  readonly path?: RepositoryPath | undefined;
  /** Short recap. Never the full text. */
  readonly summary: string;
  /** When the cited version was written, for staleness checks. */
  readonly recordedAt?: Timestamp | undefined;
}

export const knowledgeReferenceSchema = z
  .strictObject({
    sourceType: knowledgeSourceTypeSchema,
    scope: knowledgeScopeSchema,
    sourceId: namespacedIdSchema,
    organizationId: organizationIdSchema,
    repositoryId: repositoryIdSchema.optional(),
    path: repositoryPathSchema.optional(),
    summary: z.string().min(1).max(TEXT_LIMITS.summary),
    recordedAt: timestampSchema.optional(),
  })
  .superRefine((reference, ctx) => {
    // Scope and the fields that realize it must agree, or the reference claims
    // a reach it cannot substantiate — the leak this vocabulary prevents.
    if (
      reference.scope !== "organization" &&
      reference.repositoryId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["repositoryId"],
        message: `A '${reference.scope}'-scoped reference must name its repository`,
      });
    }
    if (
      reference.scope === "organization" &&
      reference.repositoryId !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["repositoryId"],
        message:
          "An organization-scoped reference applies to every repository and must not name one",
      });
    }
    if (reference.scope === "path" && reference.path === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "A path-scoped reference must name its path",
      });
    }
    if (reference.scope !== "path" && reference.path !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: `A path is only meaningful for a path-scoped reference, not '${reference.scope}'`,
      });
    }
  });

/**
 * Whether a source is a standing human instruction rather than something the
 * platform inferred.
 *
 * Authored rules are authoritative; learnings are the platform's own
 * inference and must never be allowed to override them, or a single bad
 * inference becomes permanent policy (§116).
 */
export function isAuthoredInstruction(
  sourceType: KnowledgeSourceType,
): boolean {
  return (
    sourceType === "organization_instruction" ||
    sourceType === "repository_instruction" ||
    sourceType === "path_instruction"
  );
}
