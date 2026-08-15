/**
 * Who did it (P0.txt §13, §62).
 *
 * Reviews are triggered, findings are produced, comments are written, and
 * fixes are proposed — each by someone, and "someone" is not always a person.
 * A single `Actor` union covers every originator so that audit logs, comment
 * attribution, and policy decisions have one shape to read:
 *
 * | Variant       | Example |
 * | ------------- | ------- |
 * | `human`       | a developer typing `/review` on a PR |
 * | `system`      | the scheduler starting a nightly run |
 * | `integration` | an API client acting under a tenant's key |
 * | `agent`       | the reviewer model producing a candidate finding |
 *
 * The spec calls this `ActorReference` at some call sites. It is one type, not
 * two: actors are small, embedded by value, and never need a separate lookup —
 * splitting them into an entity and a reference would create exactly the
 * duplicate-concept drift §105 warns about.
 *
 * **PII is deliberately minimal.** An actor carries a display name and a
 * handle, never an email address, IP, or token. Attribution needs to say
 * *who*; it does not need contact details, and every field here ends up in
 * events, logs, and published comments (§63, §70).
 */

import { z } from "zod";
import { userIdSchema, type UserId } from "../identity/ids.js";
import {
  providerUserReferenceSchema,
  type ProviderUserReference,
} from "../provider/provider.js";
import { TEXT_LIMITS } from "../primitives/limits.js";
import {
  namespacedIdSchema,
  type NamespacedId,
} from "../primitives/namespaced-id.js";

/**
 * Provider-neutral model identity, for provenance only (§62).
 *
 * Records which model produced a candidate finding so a regression can be
 * traced to a model change. It is **metadata, not routing**: nothing in Phase 0
 * selects a model, and no model SDK type appears anywhere in these contracts
 * (§61).
 */
export interface ModelReference {
  /** Vendor, e.g. `anthropic`. Free-form to avoid a closed vendor list. */
  readonly provider: string;
  /** Model identifier as the vendor names it. */
  readonly model: string;
  /** Optional snapshot/version, when the vendor exposes one. */
  readonly revision?: string | undefined;
}

export const modelReferenceSchema = z.strictObject({
  provider: z.string().min(1).max(TEXT_LIMITS.identifier),
  model: z.string().min(1).max(TEXT_LIMITS.identifier),
  revision: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
});

/**
 * A person.
 *
 * Both identifiers are optional, and the reason is worth stating: a PR author
 * may have no Acalys account (`userId` absent) because they never signed in,
 * and a local CLI user may have no provider account (`provider` absent). The
 * platform must attribute either way rather than refuse the review.
 */
export interface HumanActor {
  readonly kind: "human";
  /** Acalys account, when this person has one. */
  readonly userId?: UserId | undefined;
  /** Provider account, when the action came through a provider. */
  readonly provider?: ProviderUserReference | undefined;
  /** Name for display. Never used as an identifier. */
  readonly displayName?: string | undefined;
}

/**
 * A platform component acting on its own initiative.
 *
 * Used when no user requested the work: the scheduler firing a nightly run, a
 * retry policy re-queuing a failed job, a migration backfilling revisions.
 */
export interface SystemActor {
  readonly kind: "system";
  /** Which component, e.g. `acalys.scheduler`, `acalys.webhook-gateway`. */
  readonly component: NamespacedId;
}

/**
 * A machine client acting under a tenant's credentials — an API key, a CI
 * job, a bot. Distinct from `system` because the tenant, not the platform,
 * is accountable for what it does.
 */
export interface IntegrationActor {
  readonly kind: "integration";
  readonly integrationId: NamespacedId;
  readonly displayName?: string | undefined;
}

/** Which pipeline stage an agent was performing (§30). */
export const AGENT_TYPES = [
  "reviewer",
  "verifier",
  "chat",
  "premerge",
  "fix",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * A model-backed agent.
 *
 * `agentRunId` distinguishes concurrent agents of the same type — the point of
 * `/deep-review`, where several reviewers examine one change and their
 * candidate findings must stay attributable to the specific agent that raised
 * them before aggregation merges them (§113).
 */
export interface AgentActor {
  readonly kind: "agent";
  readonly agentType: AgentType;
  /** Distinguishes one agent instance within a run. */
  readonly agentRunId?: string | undefined;
  /** Which model produced the output. Provenance only (§62). */
  readonly model?: ModelReference | undefined;
}

/** Everything that can originate an action. */
export type Actor = HumanActor | SystemActor | IntegrationActor | AgentActor;

export const humanActorSchema = z.strictObject({
  kind: z.literal("human"),
  userId: userIdSchema.optional(),
  provider: providerUserReferenceSchema.optional(),
  displayName: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
});

export const systemActorSchema = z.strictObject({
  kind: z.literal("system"),
  component: namespacedIdSchema,
});

export const integrationActorSchema = z.strictObject({
  kind: z.literal("integration"),
  integrationId: namespacedIdSchema,
  displayName: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
});

export const agentActorSchema = z.strictObject({
  kind: z.literal("agent"),
  agentType: z.enum(AGENT_TYPES),
  agentRunId: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  model: modelReferenceSchema.optional(),
});

export const actorSchema = z.discriminatedUnion("kind", [
  humanActorSchema,
  systemActorSchema,
  integrationActorSchema,
  agentActorSchema,
]);

/**
 * Where a mutation came from, for audit trails (§68).
 *
 * Attached at mutation boundaries — an API handler, a webhook consumer, a
 * worker step — never carried on every value object. Turning every entity into
 * an audit record is the failure mode §68 explicitly calls out.
 */
export const AUDIT_SOURCES = [
  "api",
  "webhook",
  "cli",
  "web",
  "worker",
  "system",
] as const;

export type AuditSource = (typeof AUDIT_SOURCES)[number];

export interface AuditContext {
  readonly actor: Actor;
  /** Correlates the mutation with the request that caused it. */
  readonly requestId?: string | undefined;
  readonly source: AuditSource;
}

export const auditContextSchema = z.strictObject({
  actor: actorSchema,
  requestId: z.string().min(1).max(TEXT_LIMITS.identifier).optional(),
  source: z.enum(AUDIT_SOURCES),
});

/**
 * Short label for logs and UI.
 *
 * Falls back through the identifiers each variant actually has, so it never
 * returns an empty string, and never invents one.
 */
export function describeActor(actor: Actor): string {
  switch (actor.kind) {
    case "human":
      return (
        actor.displayName ??
        actor.provider?.handle ??
        actor.userId ??
        "unknown user"
      );
    case "system":
      return actor.component;
    case "integration":
      return actor.displayName ?? actor.integrationId;
    case "agent":
      return actor.agentRunId === undefined
        ? `${actor.agentType} agent`
        : `${actor.agentType} agent (${actor.agentRunId})`;
  }
}
