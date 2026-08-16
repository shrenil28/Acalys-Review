import { describe, expect, it } from "vitest";
import {
  COMMAND_SCHEMAS,
  COMMAND_TYPES,
  DOMAIN_EVENT_SCHEMAS,
  DOMAIN_EVENT_TYPES,
  anyCommandSchema,
  anyDomainEventSchema,
  causedBy,
  commandEnvelopeShape,
  eventEnvelopeShape,
  idempotencyScope,
  isRootEvent,
  startsChain,
  traceContextSchema,
  type AnyCommand,
  type AnyDomainEvent,
} from "../../src/internal/index.js";
import { unsafeBrand } from "../../src/domain/primitives/brand.js";
import { timestamp } from "../../src/domain/primitives/timestamp.js";
import type {
  CommandId,
  EventId,
  OrganizationId,
  RepositoryId,
  ReviewRunId,
} from "../../src/domain/identity/ids.js";

const uuid = (suffix: string) =>
  `0192f8a1-0000-7000-8000-${suffix.padStart(12, "0")}`;
const organizationId = unsafeBrand<OrganizationId>(uuid("1"));
const repositoryId = unsafeBrand<RepositoryId>(uuid("2"));
const reviewRunId = unsafeBrand<ReviewRunId>(uuid("3"));
const eventId = unsafeBrand<EventId>(uuid("a"));
const parentEventId = unsafeBrand<EventId>(uuid("b"));
const commandId = unsafeBrand<CommandId>(uuid("c"));
const at = timestamp("2026-08-16T10:00:00.000Z");

const rootTrace = {
  correlationId: uuid("a"),
  origin: "provider_webhook" as const,
};
const childTrace = { correlationId: uuid("a"), causationId: uuid("b") };

const event = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: eventId,
  type: "review.run.started" as const,
  occurredAt: at,
  organizationId,
  trace: childTrace,
  payload: { repositoryId, reviewRunId },
  ...overrides,
});

const command = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: commandId,
  type: "review.cancel" as const,
  issuedAt: at,
  organizationId,
  issuedBy: { kind: "human" as const, displayName: "shrenil" },
  idempotencyKey: "cancel-run-3",
  trace: childTrace,
  payload: { repositoryId, reviewRunId },
  ...overrides,
});

describe("Correlation policy (P0.txt §49)", () => {
  it("requires correlationId with no exception", () => {
    // An event that cannot be tied to the work that produced it is unusable
    // exactly when it matters — reconstructing a review during an incident.
    expect(
      traceContextSchema.safeParse({ causationId: uuid("b") }).success,
    ).toBe(false);
  });

  it("allows a missing causationId only at a declared ingress", () => {
    // A webhook was caused by something outside the platform. Inventing a
    // parent id for it would be a lie in the audit trail.
    expect(traceContextSchema.safeParse(rootTrace).success).toBe(true);
    expect(
      traceContextSchema.safeParse({ correlationId: uuid("a") }).success,
    ).toBe(false);
  });

  it("refuses a message that is both caused and an ingress", () => {
    expect(
      traceContextSchema.safeParse({
        correlationId: uuid("a"),
        causationId: uuid("b"),
        origin: "api_request",
      }).success,
    ).toBe(false);
  });

  it("treats traceId as genuinely optional", () => {
    // A worker with no OpenTelemetry SDK must still emit correct events;
    // forging a trace id it cannot join would be worse than omitting one.
    expect(traceContextSchema.safeParse(childTrace).success).toBe(true);
    expect(
      traceContextSchema.safeParse({
        ...childTrace,
        traceId: "0af7651916cd43dd",
      }).success,
    ).toBe(true);
  });

  describe("chain construction", () => {
    it("starts a chain with the event's own id as the correlation", () => {
      const trace = startsChain(eventId, "provider_webhook");

      expect(trace.correlationId).toBe(eventId);
      expect(trace.causationId).toBeUndefined();
      expect(traceContextSchema.safeParse(trace).success).toBe(true);
    });

    it("continues a chain by naming the parent as the cause", () => {
      // The mistake this exists to prevent: copying correlationId and
      // forgetting causationId, leaving a trace that groups correctly and
      // orders wrongly.
      const parent = {
        id: parentEventId,
        trace: startsChain(parentEventId, "api_request"),
      };
      const trace = causedBy(parent);

      expect(trace.correlationId).toBe(parentEventId);
      expect(trace.causationId).toBe(parentEventId);
      expect(trace.origin).toBeUndefined();
      expect(traceContextSchema.safeParse(trace).success).toBe(true);
    });

    it("carries traceId down the chain but never invents one", () => {
      const withTrace = causedBy({
        id: parentEventId,
        trace: startsChain(parentEventId, "cli", { traceId: "abc123" }),
      });
      expect(withTrace.traceId).toBe("abc123");

      const without = causedBy({
        id: parentEventId,
        trace: startsChain(parentEventId, "cli"),
      });
      expect(without.traceId).toBeUndefined();
    });

    it("keeps one correlationId across a whole chain", () => {
      const root = {
        id: eventId,
        trace: startsChain(eventId, "provider_webhook"),
      };
      const child = { id: parentEventId, trace: causedBy(root) };
      const grandchild = causedBy(child);

      expect(grandchild.correlationId).toBe(root.trace.correlationId);
      expect(grandchild.causationId).toBe(child.id);
    });
  });

  it("identifies a root event", () => {
    expect(
      isRootEvent(anyDomainEventSchema.parse(event({ trace: rootTrace }))),
    ).toBe(true);
    expect(isRootEvent(anyDomainEventSchema.parse(event()))).toBe(false);
  });
});

describe("Domain event taxonomy (P0.txt §48)", () => {
  it("declares every type §48 lists", () => {
    expect([...DOMAIN_EVENT_TYPES]).toEqual([
      "review.requested",
      "review.run.queued",
      "review.run.started",
      "review.run.state_changed",
      "review.run.completed",
      "review.run.failed",
      "repository.revision.created",
      "change_manifest.created",
      "finding.candidate_created",
      "finding.verified",
      "finding.rejected",
      "finding.published",
      "finding.resolved",
      "finding.dismissed",
      "finding.superseded",
      "conversation.message_created",
      "premerge.check_completed",
    ]);
  });

  it("registers a schema for every type, and no others", () => {
    expect(Object.keys(DOMAIN_EVENT_SCHEMAS).sort()).toEqual(
      [...DOMAIN_EVENT_TYPES].sort(),
    );
  });

  it("names every type in past tense", () => {
    // An event is a fact that already happened (§77). An imperative name would
    // read as a command, which is the conflation the two envelopes prevent.
    const imperativeEndings = [
      ".start",
      ".queue",
      ".complete",
      ".publish",
      ".create",
    ];
    for (const type of DOMAIN_EVENT_TYPES) {
      for (const ending of imperativeEndings) {
        expect(type.endsWith(ending), `${type} reads as a command`).toBe(false);
      }
    }
  });

  it("attributes every event to a tenant", () => {
    // An event that cannot be filtered by tenant is one a tenant can read
    // another's activity through (§9).
    expect(Object.keys(eventEnvelopeShape)).toContain("organizationId");
    expect(
      anyDomainEventSchema.safeParse(event({ organizationId: undefined }))
        .success,
    ).toBe(false);
  });

  it("narrows the payload when narrowed on type", () => {
    const parsed: AnyDomainEvent = anyDomainEventSchema.parse(
      event({
        type: "review.run.state_changed",
        payload: { repositoryId, reviewRunId, from: "queued", to: "preparing" },
      }),
    );

    if (parsed.type !== "review.run.state_changed")
      throw new Error("wrong type");
    // Compile-time proof the discriminated union narrows: `from` exists only
    // on this variant's payload.
    expect(parsed.payload.from).toBe("queued");
  });

  it("rejects a payload belonging to a different event type", () => {
    expect(
      anyDomainEventSchema.safeParse(
        event({
          type: "review.run.started",
          payload: { from: "queued", to: "preparing" },
        }),
      ).success,
    ).toBe(false);
  });

  it("carries references, not entities", () => {
    // Embedding a ReviewFinding would freeze a copy that is wrong the moment
    // the finding is resolved, and would put megabytes in every subscriber's
    // queue forever.
    const published = anyDomainEventSchema.parse(
      event({
        type: "finding.published",
        payload: {
          repositoryId,
          reviewRunId,
          findingId: uuid("4"),
          severity: "high",
          category: "security",
        },
      }),
    );

    const keys = Object.keys(published.payload);
    expect(keys).not.toContain("explanation");
    expect(keys).not.toContain("evidence");
    expect(keys).not.toContain("location");
  });

  it("reports a rejected candidate without minting a finding", () => {
    // A rejected candidate never became a finding; giving it a FindingId would
    // put a finding nobody should see into every consumer's store (§27, §107).
    const rejected = anyDomainEventSchema.parse(
      event({
        type: "finding.rejected",
        payload: {
          repositoryId,
          reviewRunId,
          candidateFindingId: uuid("5"),
          reason: "No supporting evidence.",
        },
      }),
    );

    expect(Object.keys(rejected.payload)).not.toContain("findingId");
  });

  it("carries an error code on failure, never a message or a stack (§125)", () => {
    const failed = anyDomainEventSchema.parse(
      event({
        type: "review.run.failed",
        payload: {
          repositoryId,
          reviewRunId,
          errorCode: "acalys.error.provider-timeout",
          retryability: "retryable",
        },
      }),
    );

    const keys = Object.keys(failed.payload);
    expect(keys).not.toContain("stack");
    expect(keys).not.toContain("message");
    expect(keys).not.toContain("cause");
  });

  it("rejects a future schemaVersion rather than misreading it", () => {
    expect(
      anyDomainEventSchema.safeParse(event({ schemaVersion: 2 })).success,
    ).toBe(false);
  });

  it("rejects unknown envelope keys", () => {
    expect(
      anyDomainEventSchema.safeParse({ ...event(), workerId: "w-1" }).success,
    ).toBe(false);
  });
});

describe("Commands are not events (P0.txt §77)", () => {
  it("declares the commands the domain already models (§78)", () => {
    expect([...COMMAND_TYPES]).toEqual([
      "review.request",
      "review.cancel",
      "review.rerun",
      "finding.dismiss",
      "conversation.resolve",
      "fix.request",
      "premerge.run_check",
    ]);
    expect(Object.keys(COMMAND_SCHEMAS).sort()).toEqual(
      [...COMMAND_TYPES].sort(),
    );
  });

  it("names commands imperatively and events in past tense", () => {
    // The vocabularies must not overlap, or a dispatcher cannot tell an
    // instruction from a fact by its name alone.
    const overlap = (COMMAND_TYPES as readonly string[]).filter((type) =>
      (DOMAIN_EVENT_TYPES as readonly string[]).includes(type),
    );
    expect(overlap).toEqual([]);
  });

  it("carries who asked — a field an event has no use for", () => {
    expect(Object.keys(commandEnvelopeShape)).toContain("issuedBy");
    expect(Object.keys(eventEnvelopeShape)).not.toContain("issuedBy");
  });

  it("requires an idempotency key, because a retry must not act twice (§47)", () => {
    expect(
      anyCommandSchema.safeParse(command({ idempotencyKey: undefined }))
        .success,
    ).toBe(false);
    expect(Object.keys(eventEnvelopeShape)).not.toContain("idempotencyKey");
  });

  it("records when it was asked for, not when something happened", () => {
    // A command describes an intent; nothing has occurred yet.
    expect(Object.keys(commandEnvelopeShape)).toContain("issuedAt");
    expect(Object.keys(commandEnvelopeShape)).not.toContain("occurredAt");
    expect(Object.keys(eventEnvelopeShape)).toContain("occurredAt");
  });

  it("keeps the two envelopes structurally distinct", () => {
    // A shared base would converge them under maintenance — someone adds a
    // field "to the envelope" and it lands on both.
    const eventOnly = Object.keys(eventEnvelopeShape).filter(
      (key) => !(key in commandEnvelopeShape),
    );
    const commandOnly = Object.keys(commandEnvelopeShape).filter(
      (key) => !(key in eventEnvelopeShape),
    );

    expect(eventOnly).toEqual(["occurredAt"]);
    expect(commandOnly.sort()).toEqual([
      "idempotencyKey",
      "issuedAt",
      "issuedBy",
    ]);
  });

  it("scopes idempotency by tenant and type", () => {
    // A global key space would let one tenant's retry suppress another's
    // command — a cross-tenant leak through a deduplication table (§9).
    const parsed: AnyCommand = anyCommandSchema.parse(command());
    expect(idempotencyScope(parsed)).toBe(`${organizationId}:review.cancel`);
  });

  it("requires a reason to dismiss a finding", () => {
    // A human dismissing a finding is making a judgement, and an unexplained
    // dismissal is unreviewable later.
    expect(
      anyCommandSchema.safeParse(
        command({
          type: "finding.dismiss",
          payload: { repositoryId, findingId: uuid("4") },
        }),
      ).success,
    ).toBe(false);
    expect(
      anyCommandSchema.safeParse(
        command({
          type: "finding.dismiss",
          payload: {
            repositoryId,
            findingId: uuid("4"),
            reason: "Intentional.",
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("limits request overrides to the three-field allow-list", () => {
    // This input comes from a PR body or a comment — anyone with push access.
    // The allow-list is the security boundary, so egress and tool policy must
    // be rejected outright rather than ignored.
    const target = {
      kind: "commit",
      schemaVersion: 1,
      repositoryId,
      commit: {
        name: "main",
        objectId: { algorithm: "sha1", value: "a".repeat(40) },
      },
    };

    expect(
      anyCommandSchema.safeParse(
        command({
          type: "review.request",
          payload: { repositoryId, target, overrides: { depth: "thorough" } },
        }),
      ).success,
    ).toBe(true);

    expect(
      anyCommandSchema.safeParse(
        command({
          type: "review.request",
          payload: {
            repositoryId,
            target,
            overrides: { useExternalSources: true },
          },
        }),
      ).success,
    ).toBe(false);
  });
});
