/**
 * The command envelope (P0.txt §77, §78).
 *
 * §77 is explicit: "do not use one generic message model for both without
 * semantics." A command and an event are not two flavours of message — they
 * differ in every property that matters to the code handling them.
 *
 * |  | Command | Event |
 * | --- | --- | --- |
 * | Means | *please do this* | *this already happened* |
 * | Tense | imperative — `RequestReview` | past — `review.run.completed` |
 * | Can be refused? | **yes** — validation, authorization, policy | no; a fact cannot be rejected |
 * | Recipients | exactly one handler | any number of subscribers |
 * | Who acts | the receiver decides | nobody; each subscriber reacts |
 *
 * The consequences are the fields. A command carries an {@link Actor} — someone
 * asked for this, and whether they were allowed to is a question only a command
 * raises. It carries an idempotency key, because "please do this" delivered
 * twice must not do it twice, while an event delivered twice is the same fact
 * restated. And it has no `occurredAt`, because nothing has occurred yet — it
 * has an `issuedAt`, which is when someone asked.
 *
 * Merging the two would put an optional `actor` and an optional
 * `idempotencyKey` on every event, and consumers would have to know which
 * events happened to be commands in disguise.
 *
 * # Commands are not the HTTP API
 *
 * `POST /api/v1/reviews` is a *request*; the command is what the API layer
 * constructs from it after authenticating and authorizing (§76). Keeping them
 * apart is what lets the same command arrive from a webhook, a CLI, or a
 * scheduler without any of them speaking HTTP.
 */

import { z } from "zod";
import {
  commandIdSchema,
  conversationIdSchema,
  findingIdSchema,
  organizationIdSchema,
  pullRequestIdSchema,
  repositoryIdSchema,
  reviewRunIdSchema,
  type CommandId,
  type OrganizationId,
} from "../../domain/identity/ids.js";
import { actorSchema, type Actor } from "../../domain/actor/actor.js";
import {
  timestampSchema,
  type Timestamp,
} from "../../domain/primitives/timestamp.js";
import { TEXT_LIMITS } from "../../domain/primitives/limits.js";
import type { JsonSerializableObject } from "../../domain/primitives/json.js";
import { traceContextSchema, type TraceContext } from "../events/envelope.js";
import { requestOverridesSchema } from "../../domain/configuration/resolution.js";
import { reviewTargetSchema } from "../../domain/review-target/review-target.js";

/** Schema version for this durable contract (§7). */
export const COMMAND_SCHEMA_VERSION = 1;

/**
 * The envelope every command shares.
 *
 * `idempotencyKey` is **required**, not optional (§47). A command that can be
 * retried without one is a command that can be executed twice, and the two
 * common paths — a webhook redelivery and a queue's at-least-once guarantee —
 * both retry by default. Making the key optional means the safe case is the
 * one you have to remember.
 */
export interface Command<
  TType extends string = string,
  TPayload extends JsonSerializableObject = JsonSerializableObject,
> {
  readonly schemaVersion: number;
  readonly id: CommandId;
  readonly type: TType;
  /** When it was asked for — not when anything happened. */
  readonly issuedAt: Timestamp;
  readonly organizationId: OrganizationId;
  /** Who asked. The field an event has no use for. */
  readonly issuedBy: Actor;
  /** Deduplication key within `(organizationId, type)` (§47). */
  readonly idempotencyKey: string;
  readonly trace: TraceContext;
  readonly payload: TPayload;
}

/**
 * The envelope fields every command shares, as schemas.
 *
 * Deliberately *not* shared with the event envelope, even though four fields
 * coincide. A shared base would make the two converge under maintenance —
 * someone adds a field "to the envelope" and it lands on both — which is
 * exactly the single generic message model §77 forbids.
 */
export const commandEnvelopeShape = {
  schemaVersion: z
    .number()
    .int()
    .positive()
    .max(COMMAND_SCHEMA_VERSION, {
      error: `Unsupported Command schemaVersion; this build understands up to ${String(COMMAND_SCHEMA_VERSION)}`,
    }),
  id: commandIdSchema,
  issuedAt: timestampSchema,
  organizationId: organizationIdSchema,
  issuedBy: actorSchema,
  idempotencyKey: z.string().min(1).max(TEXT_LIMITS.identifier),
  trace: traceContextSchema,
} as const;

/**
 * Builds a schema for one command type.
 *
 * The return type is left to inference for the same reason as
 * {@link domainEventSchema}: annotating it would require a cast that hides
 * drift in the one place every command is built.
 */
export function commandSchema<
  TType extends string,
  TPayloadSchema extends z.ZodType<JsonSerializableObject>,
>(type: TType, payload: TPayloadSchema) {
  return z.strictObject({
    ...commandEnvelopeShape,
    type: z.literal(type),
    payload,
  });
}

/**
 * Every command the platform accepts (§78).
 *
 * §78 asks for "the foundational contract pattern, not necessarily every
 * future command". These seven are the ones the domain already models — each
 * corresponds to a transition that exists in a state machine written in
 * Checkpoints B and C — so none of them is speculative (§131). A command for a
 * capability that does not exist yet would be a guess about its shape.
 */
export const COMMAND_TYPES = [
  "review.request",
  "review.cancel",
  "review.rerun",
  "finding.dismiss",
  "conversation.resolve",
  "fix.request",
  "premerge.run_check",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];
export const commandTypeSchema = z.enum(COMMAND_TYPES);

export const requestReviewCommandSchema = commandSchema(
  "review.request",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    target: reviewTargetSchema,
    /** Adjustments the requester asked for. Honoured only if policy allows. */
    overrides: requestOverridesSchema.optional(),
  }),
);

export const cancelReviewCommandSchema = commandSchema(
  "review.cancel",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    reviewRunId: reviewRunIdSchema,
    reason: z.string().min(1).max(TEXT_LIMITS.summary).optional(),
  }),
);

export const rerunReviewCommandSchema = commandSchema(
  "review.rerun",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    /** The run to redo. A rerun is a new run of the same request (§20). */
    reviewRunId: reviewRunIdSchema,
  }),
);

export const dismissFindingCommandSchema = commandSchema(
  "finding.dismiss",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    findingId: findingIdSchema,
    // Required here though optional on the event: a human dismissing a finding
    // is making a judgement, and an unexplained dismissal is unreviewable
    // later. The event records what happened; the command records the ask.
    reason: z.string().min(1).max(TEXT_LIMITS.summary),
  }),
);

export const resolveConversationCommandSchema = commandSchema(
  "conversation.resolve",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    conversationId: conversationIdSchema,
  }),
);

export const requestFixCommandSchema = commandSchema(
  "fix.request",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    findingId: findingIdSchema,
  }),
);

export const runPreMergeCheckCommandSchema = commandSchema(
  "premerge.run_check",
  z.strictObject({
    repositoryId: repositoryIdSchema,
    pullRequestId: pullRequestIdSchema,
    /** Empty means every check the resolved config enables. */
    checkIds: z.array(z.string().min(1).max(TEXT_LIMITS.identifier)).max(200),
  }),
);

/**
 * Every command, as one discriminated union.
 *
 * Same reason as the event union: a dispatcher switching on `type` is made
 * exhaustive at compile time, so adding a command breaks every dispatcher that
 * has not handled it (§85).
 */
export const anyCommandSchema = z.discriminatedUnion("type", [
  requestReviewCommandSchema,
  cancelReviewCommandSchema,
  rerunReviewCommandSchema,
  dismissFindingCommandSchema,
  resolveConversationCommandSchema,
  requestFixCommandSchema,
  runPreMergeCheckCommandSchema,
]);

export type AnyCommand = z.output<typeof anyCommandSchema>;

/** One command, narrowed by its type. */
export type CommandOf<TType extends CommandType> = Extract<
  AnyCommand,
  { readonly type: TType }
>;

export type RequestReviewCommand = CommandOf<"review.request">;
export type CancelReviewCommand = CommandOf<"review.cancel">;
export type RerunReviewCommand = CommandOf<"review.rerun">;
export type DismissFindingCommand = CommandOf<"finding.dismiss">;
export type ResolveConversationCommand = CommandOf<"conversation.resolve">;
export type RequestFixCommand = CommandOf<"fix.request">;
export type RunPreMergeCheckCommand = CommandOf<"premerge.run_check">;

/**
 * Every command schema, keyed by type.
 *
 * `satisfies Record<CommandType, unknown>` makes the registry exhaustive: a
 * command added to {@link COMMAND_TYPES} without a schema here is a compile
 * error, so the union and the registry cannot drift.
 */
export const COMMAND_SCHEMAS = Object.freeze({
  "review.request": requestReviewCommandSchema,
  "review.cancel": cancelReviewCommandSchema,
  "review.rerun": rerunReviewCommandSchema,
  "finding.dismiss": dismissFindingCommandSchema,
  "conversation.resolve": resolveConversationCommandSchema,
  "fix.request": requestFixCommandSchema,
  "premerge.run_check": runPreMergeCheckCommandSchema,
} satisfies Record<CommandType, unknown>);

/**
 * The idempotency scope a command deduplicates within (§47).
 *
 * Scoped by tenant *and* type rather than by key alone: two organizations may
 * legitimately generate the same key, and a global key space would let one
 * tenant's retry silently suppress another's command — a cross-tenant leak
 * through a deduplication table (§9).
 */
export function idempotencyScope(command: Command): string {
  return `${command.organizationId}:${command.type}`;
}
