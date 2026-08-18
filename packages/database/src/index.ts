/**
 * @acalys/database — persistence.
 *
 * Domain contracts never import this package; the dependency runs one way, and
 * dependency-cruiser enforces it (§60). The tables live in `migrations/`, and
 * the SQL is the source of truth for the schema — not an ORM model that
 * generates it.
 */
export {
  DELIVERY_STATES,
  deliveryStateSchema,
  digestBody,
  type AuthenticatedDelivery,
  type DeliveryState,
  type IngestOutcome,
  type JobRequest,
  type ScheduledJob,
  type WebhookDelivery,
  type WebhookInbox,
} from "./webhook/inbox.js";

export {
  PostgresWebhookInbox,
  type InboxFaultInjector,
  type PgClient,
  type PgPool,
  type PgQueryResult,
  type PostgresWebhookInboxOptions,
} from "./webhook/postgres-inbox.js";
