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
  WebhookJobClaimLost,
  type InboxFaultInjector,
  type PgClient,
  type PgPool,
  type PgQueryResult,
  type PostgresWebhookInboxOptions,
} from "./webhook/postgres-inbox.js";

export {
  ReviewIngestionStore,
  type ReviewRequestInput,
  type ReviewRunExecutionContext,
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
  AttemptClaimConflict,
  AttemptIdentityConflict,
  AttemptResultConflict,
  VerificationStore,
  type AttemptRecord,
  type PromotionRecord,
  type ReconciliationRow,
  type StoredAttempt,
} from "./review/verification-store.js";
export {
  INVOCATION_REASONS,
  InvocationKeyConflict,
  StaleVerificationClaim,
  VerificationScheduler,
  type ClaimOutcome,
  type InvocationReason,
  type ScheduleRequest,
  type ScheduledInvocation,
  type VerificationClaim,
} from "./review/verification-scheduler.js";
export {
  ModelCredentialAdmissionStore,
  type ModelAdmissionOutcome,
  type ModelCredentialPolicy,
} from "./review/model-admission-store.js";
export {
  ModelUsageStore,
  type ModelInteractionRecord,
  type ModelUsageSnapshot,
} from "./review/model-usage-store.js";
export {
  ModelBudgetReservationStore,
  type ModelBudgetLimits,
  type ModelBudgetReserveOutcome,
  type ModelBudgetScope,
} from "./review/model-budget-store.js";
export {
  PUBLICATION_SURFACE,
  PolicyDecisionConflict,
  PolicyDecisionStore,
  PreMergeStore,
  type CheckRecord,
  type DecisionRecord,
  type StoredCheck,
  type StoredDecision,
} from "./review/policy-store.js";
export {
  AuthStore,
  type AuthRole,
  type EstablishOAuthSessionInput,
  type StoredApiKeyPrincipal,
  type StoredSessionPrincipal,
  type MembershipInput,
  type OAuthIdentityInput,
} from "./auth-store.js";
export {
  ApiStore,
  type ApiPage,
  type ApiTenantScope,
  type FindingFilters,
  type IdempotencyAcquire,
} from "./api-store.js";

export { createPostgresPool, type CloseablePgPool } from "./pool.js";

export {
  defaultMigrationDirectory,
  runMigrations,
  type AppliedMigration,
  type MigrationResult,
} from "./migrations.js";

export {
  ReviewDispatchStore,
  StaleReviewDispatchClaim,
  type ReviewDispatchClaim,
  type ReviewDispatchExecutionGuard,
  type ReviewDispatchGuardAcquisition,
  type ReviewDispatchReplay,
} from "./review/api-dispatch-store.js";

export {
  ApiMutationStore,
  type IdempotencyIdentity,
  type IdempotentMutationOutcome,
} from "./api-mutation-store.js";

export {
  DashboardAdminStore,
  type DashboardApiKeyRow,
  type DashboardInvitationRow,
  type DashboardMemberRow,
  type DashboardOrganizationRow,
  type DashboardProviderConnectionRow,
  type DashboardProvisionedIdentity,
  type DashboardSessionRow,
  type InvitationCancellationOutcome,
  type InvitationCreationOutcome,
  type InvitationRedemptionOutcome,
  type MemberRemovalOutcome,
  type MembershipRoleUpdate,
} from "./dashboard-admin-store.js";

export {
  DashboardIntegrationStore,
  IntegrationCredentialCipher,
  IntegrationCredentialUnavailable,
  type CredentialRotationOutcome,
  type DashboardIntegrationKey,
  type DashboardIntegrationRow,
  type DashboardIntegrationStatus,
  type IntegrationCredentialKeyring,
  type IntegrationMutationOutcome,
  type JiraChallengeCreationOutcome,
  type JiraChallengeRedemptionOutcome,
  type LinearOAuthAttempt,
  type StoredIntegrationCredential,
} from "./integration-store.js";

export {
  DashboardSettingsStore,
  type EffectiveReviewPolicyEnvelope,
  type OrganizationReviewSettingsRow,
  type RepositoryReviewSettingsRow,
  type ReviewSettingsMutationOutcome,
} from "./dashboard-settings-store.js";

export {
  DashboardAnalyticsStore,
  type DashboardAnalyticsFilters,
  type DashboardAnalyticsSnapshot,
} from "./dashboard-analytics-store.js";

export {
  ReviewAnalysisCacheStore,
  REVIEW_ANALYSIS_CACHE_TTL_MILLIS,
  REVIEW_ANALYSIS_CACHE_MAX_PAYLOAD_BYTES,
  REVIEW_ANALYSIS_CACHE_MAX_WRITE_ENTRIES,
  REVIEW_ANALYSIS_CACHE_MAX_PRELOAD_BYTES,
  REVIEW_ANALYSIS_CACHE_MAX_METADATA_ENTRIES,
  type PersistedReviewAnalysisCacheEntry,
  type ReviewAnalysisCacheDeleteOutcome,
  type ReviewAnalysisCacheMetadata,
} from "./review-analysis-cache-store.js";

export * from "./dashboard-notification-store.js";

export * from "./dashboard-repository-store.js";

export * from "./dashboard-security-store.js";

export {
  DashboardReportStore,
  type DashboardReportCreateOutcome,
  type DashboardReportDeleteOutcome,
  type DashboardReportGenerateOutcome,
} from "./dashboard-report-store.js";
