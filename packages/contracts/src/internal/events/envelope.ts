/**
 * The domain event envelope (P0.txt §48, §49).
 *
 * An event says **this already happened** (§77). It is a fact, and facts do
 * not fail: nothing that receives one can reject it, and nothing that emits
 * one waits for an answer. That is the entire difference from a
 * {@link Command}, and it is why the two have separate envelopes rather than
 * one generic message model with a `kind` field.
 *
 * # Correlation policy, stated rather than left optional (§49)
 *
 * §49's instruction is explicit: "do not make them optional everywhere without
 * thought — define when they are required." Optional-everywhere is how a trace
 * ends up with a hole in the middle, discovered during an incident.
 *
 * | Field | Required? | Meaning |
 * | --- | --- | --- |
 * | `correlationId` | **always** | the whole causal chain this belongs to |
 * | `causationId` | **except at ingress** | the id of the message that caused this one |
 * | `traceId` | optional | an OpenTelemetry trace, when one exists |
 *
 * `correlationId` is required with no exception because an event that cannot
 * be tied to the work that produced it is unusable exactly when it matters —
 * during an incident, reconstructing what a review did.
 *
 * `causationId` is required *except* on a root event, and a root is a real
 * thing rather than a convenience: a webhook arriving from GitHub was caused
 * by something outside the platform, and inventing a parent id for it would be
 * a lie in the audit trail. {@link isRootEvent} is how the exception is
 * expressed, and the schema enforces it.
 *
 *     GitHub webhook  ─────►  review.requested        root: no causationId
 *                                    │
 *                                    ├──►  review.run.queued
 *                                    │            │
 *                                    │            └──►  review.run.started
 *                                    └──►  finding.published
 *
 *     every arrow: causationId = the id of the event it came from
 *     every node:  correlationId = the same value throughout
 *
 * `traceId` is optional because tracing is infrastructure: a worker running
 * without an OpenTelemetry SDK must still emit correct events, and forging a
 * trace id it cannot join is worse than admitting there isn't one.
 *
 * # This layer is private
 *
 * `@acalys/contracts/internal` is not exported to `apps/web`, enforced by
 * dependency-cruiser (§100). A UI that consumed events directly would be
 * coupled to worker internals — the invariant the whole monorepo shape exists
 * to hold.
 */

import { z } from "zod";
import {
  eventIdSchema,
  organizationIdSchema,
  type EventId,
  type OrganizationId,
} from "../../domain/identity/ids.js";
import {
  timestampSchema,
  type Timestamp,
} from "../../domain/primitives/timestamp.js";
import { TEXT_LIMITS } from "../../domain/primitives/limits.js";
import type { JsonSerializableObject } from "../../domain/primitives/json.js";

/** Schema version for this durable contract (§7). */
export const DOMAIN_EVENT_SCHEMA_VERSION = 1;

/**
 * A correlation or causation identifier.
 *
 * A plain bounded string rather than a branded id, because these values cross
 * the platform's boundary: a `traceId` comes from OpenTelemetry, and a
 * `correlationId` may be adopted from an inbound request header. Branding them
 * would claim the platform minted them when it did not.
 */
export const correlationIdSchema = z
  .string()
  .min(1)
  .max(TEXT_LIMITS.identifier);

/**
 * Where an event's causal chain begins.
 *
 * A root event is caused by something outside the platform, so it has no
 * `causationId` to record. Naming the ingress explicitly — rather than
 * treating "no parent" as an unexplained absence — is what makes a missing
 * `causationId` elsewhere detectable as the bug it is.
 */
export const EVENT_ORIGINS = [
  "provider_webhook",
  "api_request",
  "scheduler",
  "cli",
  "internal",
] as const;

export type EventOrigin = (typeof EVENT_ORIGINS)[number];
export const eventOriginSchema = z.enum(EVENT_ORIGINS);

/**
 * Trace context carried alongside every message.
 *
 * Grouped into one object rather than three loose fields, so a producer
 * forwards causality with one spread — `{ ...causedBy(parent) }` — instead of
 * copying three fields and forgetting one.
 */
export interface TraceContext {
  readonly correlationId: string;
  /** Absent only on a root event; see {@link isRootEvent}. */
  readonly causationId?: string | undefined;
  readonly traceId?: string | undefined;
  /** Why this chain began. Present only at ingress. */
  readonly origin?: EventOrigin | undefined;
}

export const traceContextSchema = z
  .strictObject({
    correlationId: correlationIdSchema,
    causationId: correlationIdSchema.optional(),
    traceId: correlationIdSchema.optional(),
    origin: eventOriginSchema.optional(),
  })
  .superRefine((context, ctx) => {
    // A message that both names a parent and claims to be an ingress point is
    // describing two different chains; the audit trail would branch wrongly.
    if (context.origin !== undefined && context.causationId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["origin"],
        message:
          "A message with a causationId was caused inside the platform and has no origin",
      });
    }
    if (context.origin === undefined && context.causationId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["causationId"],
        message:
          "A message with no causationId is a root and must declare where the chain began",
      });
    }
  });

/**
 * The envelope every domain event shares.
 *
 * Generic over its `type` and `payload` so a consumer narrowing on `type` gets
 * the matching payload type for free (§85). The discriminated union in
 * `taxonomy.ts` is what makes that narrowing exhaustive.
 *
 * `organizationId` is required rather than §48's optional, with one exception
 * handled by the taxonomy: every event in this platform happens *to* a tenant,
 * and an event that cannot be attributed to one cannot be filtered by one
 * either — which is how a tenant ends up reading another's activity (§9).
 */
export interface DomainEvent<
  TType extends string = string,
  TPayload extends JsonSerializableObject = JsonSerializableObject,
> {
  readonly schemaVersion: number;
  readonly id: EventId;
  readonly type: TType;
  readonly occurredAt: Timestamp;
  readonly organizationId: OrganizationId;
  readonly trace: TraceContext;
  readonly payload: TPayload;
}

/**
 * The envelope fields every event shares, as schemas.
 *
 * Spread into each event's own `strictObject` by {@link domainEventSchema}.
 * Written once so the envelope's rules — version bounds, trace policy, tenant
 * attribution — cannot drift between the thirty-odd events in the taxonomy.
 */
export const eventEnvelopeShape = {
  schemaVersion: z
    .number()
    .int()
    .positive()
    .max(DOMAIN_EVENT_SCHEMA_VERSION, {
      error: `Unsupported DomainEvent schemaVersion; this build understands up to ${String(DOMAIN_EVENT_SCHEMA_VERSION)}`,
    }),
  id: eventIdSchema,
  occurredAt: timestampSchema,
  organizationId: organizationIdSchema,
  trace: traceContextSchema,
} as const;

/**
 * Builds a schema for one event type.
 *
 * The return type is deliberately left to inference rather than annotated as
 * `ZodType<DomainEvent<…>>`. Under `exactOptionalPropertyTypes`, Zod cannot
 * prove a *generic* payload schema is non-optional, so the annotation forces a
 * cast — and a cast in the one place every event is built would hide exactly
 * the drift this factory exists to prevent. Inference resolves concretely at
 * each call site, and `tests/schema-conformance.test.ts` asserts the result
 * matches {@link DomainEvent} for real event types.
 */
export function domainEventSchema<
  TType extends string,
  TPayloadSchema extends z.ZodType<JsonSerializableObject>,
>(type: TType, payload: TPayloadSchema) {
  return z.strictObject({
    ...eventEnvelopeShape,
    type: z.literal(type),
    payload,
  });
}

/** Whether this message begins its causal chain. */
export function isRootEvent(event: DomainEvent): boolean {
  return event.trace.causationId === undefined;
}

/**
 * Trace context for a message caused by `parent`.
 *
 * The one sanctioned way to continue a chain. Written by hand, the mistake is
 * always the same: copying `correlationId` and forgetting `causationId`, which
 * leaves a trace that groups correctly and orders wrongly.
 */
export function causedBy(parent: {
  readonly id: EventId;
  readonly trace: TraceContext;
}): TraceContext {
  return {
    correlationId: parent.trace.correlationId,
    causationId: parent.id,
    ...(parent.trace.traceId === undefined
      ? {}
      : { traceId: parent.trace.traceId }),
  };
}

/**
 * Trace context for a chain that starts here.
 *
 * `correlationId` defaults to the event's own id, so the first event of a
 * chain is trivially findable by the id everything downstream carries.
 */
export function startsChain(
  eventId: EventId,
  origin: EventOrigin,
  options: { readonly traceId?: string | undefined } = {},
): TraceContext {
  return {
    correlationId: eventId,
    origin,
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
  };
}
