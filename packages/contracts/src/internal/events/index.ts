export {
  DOMAIN_EVENT_SCHEMA_VERSION,
  EVENT_ORIGINS,
  type DomainEvent,
  type EventOrigin,
  type TraceContext,
  causedBy,
  correlationIdSchema,
  domainEventSchema,
  eventEnvelopeShape,
  eventOriginSchema,
  isRootEvent,
  startsChain,
  traceContextSchema,
} from "./envelope.js";
export * from "./taxonomy.js";
