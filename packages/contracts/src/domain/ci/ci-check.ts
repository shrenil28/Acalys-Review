/**
 * References to existing CI results (P0.txt §42).
 *
 * The platform should consume CI a repository already runs rather than
 * re-running everything itself: the project's own test suite is stronger
 * evidence than anything an analyzer can infer, and it has already executed.
 *
 * This is a **reference, not a result model**. It carries enough to attribute
 * and display a check — and nothing more. Modelling the full CI payload would
 * mean tracking every provider's job graph, matrix expansion, artifacts, and
 * annotations, all of which belong to the CI ingestion subsystem in a later
 * phase.
 *
 * Statuses are provider-neutral. GitHub emits `queued|in_progress|completed`
 * with a separate conclusion; GitLab emits `pending|running|success|failed|
 * canceled|skipped|manual` as one field. Adapters map both onto the two
 * vocabularies below, so no consumer branches on provider (§42, §1).
 */

import { z } from "zod";
import {
  providerCheckReferenceSchema,
  type ProviderCheckReference,
} from "../provider/provider.js";
import { gitObjectIdSchema, type GitObjectId } from "../git/git-refs.js";

/** Where the check is in its lifecycle. Says nothing about the outcome. */
export const CI_CHECK_STATUSES = [
  "queued",
  "in_progress",
  "completed",
] as const;
export type CiCheckStatus = (typeof CI_CHECK_STATUSES)[number];
export const ciCheckStatusSchema = z.enum(CI_CHECK_STATUSES);

/**
 * How a completed check turned out.
 *
 * Separate from status because "finished" and "passed" are different facts,
 * and a single merged vocabulary loses the in-flight case. Only meaningful
 * once `status` is `completed`, which the schema enforces.
 *
 * `timed_out` and `cancelled` are kept distinct from `failure` for the same
 * reason as tool runs: they mean coverage is unknown, not that something is
 * wrong with the code.
 */
export const CI_CHECK_CONCLUSIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
  "action_required",
  "skipped",
] as const;

export type CiCheckConclusion = (typeof CI_CHECK_CONCLUSIONS)[number];
export const ciCheckConclusionSchema = z.enum(CI_CHECK_CONCLUSIONS);

/**
 * A CI check that ran against a specific commit.
 *
 * `commit` is required and typed as a {@link GitObjectId}: a check result is
 * only evidence about the code it actually ran on. A CI run against an older
 * commit says nothing about the current revision, and without the commit there
 * is no way to tell.
 */
export interface CiCheckReference {
  /** Provider-side identity of the check run. */
  readonly check: ProviderCheckReference;
  readonly status: CiCheckStatus;
  /** Present only once `status` is `completed`. */
  readonly conclusion?: CiCheckConclusion | undefined;
  /** The commit the check ran against. */
  readonly commit: GitObjectId;
}

export const ciCheckReferenceSchema = z
  .strictObject({
    check: providerCheckReferenceSchema,
    status: ciCheckStatusSchema,
    conclusion: ciCheckConclusionSchema.optional(),
    commit: gitObjectIdSchema,
  })
  .superRefine((reference, ctx) => {
    // Neither half of this pair may exist without the other: a conclusion on an
    // in-flight check is a contradiction, and a completed check with no
    // conclusion is unusable as evidence (§C18).
    if (
      reference.status === "completed" &&
      reference.conclusion === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["conclusion"],
        message: "A completed CI check must record its conclusion",
      });
    }
    if (
      reference.status !== "completed" &&
      reference.conclusion !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["conclusion"],
        message: `A conclusion is only meaningful once the check is completed, not while '${reference.status}'`,
      });
    }
  });

/**
 * Whether this check is settled evidence about the commit it ran on.
 *
 * `neutral` and `skipped` complete without asserting anything, so they carry
 * no evidential weight — treating them as passes would let a skipped test
 * suite read as a green one.
 */
export function isConclusiveCheck(reference: CiCheckReference): boolean {
  return (
    reference.status === "completed" &&
    (reference.conclusion === "success" || reference.conclusion === "failure")
  );
}
