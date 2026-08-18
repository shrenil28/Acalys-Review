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

export {
  ReviewIngestionStore,
  type ReviewRequestInput,
  type RevisionInput,
  type StoredReviewRequest,
  type StoredReviewRun,
  type StoredRevision,
  type TenantScope,
  type TransitionOutcome,
} from "./review/ingestion-store.js";

export {
  ReviewStageStore,
  type CandidateFindingRow,
  type AnalysisCoverage,
  type PublicationIntentRow,
  type StageFaultInjector,
  type StageOutcome,
  type StageWork,
  type VerificationRow,
} from "./review/stage-store.js";
export {
  PublicationContentConflict,
  PublicationStore,
  findLifecycleViolations,
  type AttemptFailure,
  type LedgerOutcome,
  type ProviderObservation,
  type PublicationIntent,
} from "./review/publication-store.js";
export {
  PUBLICATION_STATES,
  canTransitionPublication,
  isTerminalPublicationState,
  legalPublicationTransitions,
  type PublicationState,
} from "./review/publication-state.js";
export {
  VerificationStore,
  type AttemptRecord,
  type PromotionRecord,
  type StoredAttempt,
} from "./review/verification-store.js";
