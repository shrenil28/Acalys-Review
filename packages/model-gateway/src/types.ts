import type { ZodType } from "zod";

export const MODEL_PROVIDERS = ["openai", "anthropic"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_TASK_CLASSES = [
  "triage",
  "correctness",
  "verification",
  "summary",
] as const;
export type ModelTaskClass = (typeof MODEL_TASK_CLASSES)[number];

export type ModelTier = "cheap" | "strong";

export interface ModelRoute {
  readonly provider: ModelProvider;
  /** Exact provider model id, supplied by deployment configuration. */
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly maxOutputTokens: number;
  readonly promptCaching: boolean;
  /** Integer micro-US-dollars per one million tokens. */
  readonly inputMicroUsdPerMillion: number;
  readonly outputMicroUsdPerMillion: number;
  readonly cachedInputMicroUsdPerMillion?: number | undefined;
  readonly cacheCreationInputMicroUsdPerMillion?: number | undefined;
}

export interface ModelRouteDecision extends ModelRoute {
  readonly taskClass: ModelTaskClass;
  readonly routingPolicyVersion: string;
}

export interface ModelRoutingPolicy {
  readonly version: string;
  route(taskClass: ModelTaskClass): ModelRouteDecision;
}

export interface ModelScope {
  readonly organizationId: string;
  readonly reviewRunId: string;
}

export interface ModelRequest<T> {
  readonly scope: ModelScope;
  readonly taskClass: ModelTaskClass;
  /** Stable prompt identity; changing prompt bytes must change this value. */
  readonly promptTemplateVersion: string;
  readonly system: string;
  readonly input: string;
  readonly schemaName: string;
  readonly schema: ZodType<T>;
  readonly timeoutMs: number;
  /** Safe operational tags only. Repository text must not be put here. */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheHit: boolean;
  /** Measured provider cost for a response whose usage was available. */
  readonly costMicroUsd: number;
}

export interface ModelExecutionIdentity {
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly taskClass: ModelTaskClass;
  readonly routingPolicyVersion: string;
  readonly promptTemplateVersion: string;
  readonly requestDigest: string;
}

export interface ModelSuccess<T> {
  readonly kind: "ok";
  readonly value: T;
  readonly usage: ModelUsage;
  readonly identity: ModelExecutionIdentity;
  readonly replayed: boolean;
  readonly providerRequestId?: string | undefined;
}

export const MODEL_FAILURE_REASONS = [
  "budget_exceeded",
  "rate_limited",
  "provider_rejected",
  "retry_exhausted",
  "invalid_response",
  "cassette_missing",
  "configuration",
] as const;
export type ModelFailureReason = (typeof MODEL_FAILURE_REASONS)[number];

export interface ModelFailure {
  readonly kind: "failed";
  readonly reason: ModelFailureReason;
  readonly identity: ModelExecutionIdentity;
  readonly retryable: boolean;
  readonly replayed: boolean;
  /** Operational detail only; never provider body or repository content. */
  readonly detail: string;
}

export const MODEL_UNKNOWN_REASONS = [
  "timeout_after_dispatch",
  "connection_lost_after_dispatch",
  "provider_ambiguous",
  "local_commit_unknown",
] as const;
export type ModelUnknownReason = (typeof MODEL_UNKNOWN_REASONS)[number];

export interface ModelUnknown {
  readonly kind: "unknown";
  readonly reason: ModelUnknownReason;
  readonly identity: ModelExecutionIdentity;
  readonly replayed: boolean;
  readonly detail: string;
}

export type ModelOutcome<T> = ModelSuccess<T> | ModelFailure | ModelUnknown;

/** Provider-neutral model execution seam consumed by analyzers/verifiers. */
export interface ModelPort {
  complete<T>(request: ModelRequest<T>): Promise<ModelOutcome<T>>;
}

export interface ProviderInvocation {
  readonly modelId: string;
  readonly system: string;
  readonly input: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly schemaName: string;
  readonly promptCaching: boolean;
}

export interface ProviderSuccess {
  readonly kind: "ok";
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens?: number | undefined;
  readonly providerRequestId?: string | undefined;
}

export interface ProviderKnownFailure {
  readonly kind: "failed";
  readonly retryable: boolean;
  readonly reason: "rate_limited" | "provider_rejected";
  readonly detail: string;
}

export interface ProviderUnknown {
  readonly kind: "unknown";
  readonly reason: ModelUnknownReason;
  readonly detail: string;
}

export type ProviderOutcome =
  ProviderSuccess | ProviderKnownFailure | ProviderUnknown;

export interface ModelProviderAdapter {
  readonly provider: ModelProvider;
  invoke(request: ProviderInvocation): Promise<ProviderOutcome>;
}

export interface ModelInteractionObservation {
  readonly scope: ModelScope;
  readonly identity: ModelExecutionIdentity;
  readonly outcome: "ok" | "failed" | "unknown" | "invalid_response";
  readonly usage?: ModelUsage | undefined;
  /**
   * Cost charged to budgets. Equals measured cost when known; ambiguous live
   * execution uses the reserved per-call ceiling instead of pretending zero.
   */
  readonly accountedCostMicroUsd: number;
  readonly replayed: boolean;
  /** Whether a live provider request was dispatched for this observation. */
  readonly providerDispatched: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export interface ModelUsageSnapshot {
  readonly calls: number;
  readonly costMicroUsd: number;
}

/** Persistence/read seam for the durable model-call ledger. */
export interface ModelUsagePort {
  usageForRun(reviewRunId: string): Promise<ModelUsageSnapshot>;
  usageForOrganization(
    organizationId: string,
    since: Date,
  ): Promise<ModelUsageSnapshot>;
  record(observation: ModelInteractionObservation): Promise<void>;
}

export interface ModelBudgetConfig {
  readonly maxCallsPerRun: number;
  readonly maxCostMicroUsdPerCall: number;
  readonly maxCostMicroUsdPerRun: number;
  readonly maxCostMicroUsdPerOrganization: number;
  /** Rolling window for the organization-level spend ceiling. */
  readonly organizationWindowMs: number;
}

export interface ModelBudgetReservation {
  /** Persist intent before the first live provider dispatch. */
  markDispatched(): Promise<void>;
  /** Release only after the corresponding interaction has been durably recorded. */
  release(): Promise<void>;
}

export interface ModelBudgetReservationPort {
  reserve(input: {
    readonly scope: ModelScope;
    readonly limits: ModelBudgetConfig;
    /** Conservative live-dispatch reservation; normally the per-call ceiling. */
    readonly requestedCostMicroUsd: number;
    readonly at: Date;
  }): Promise<
    | {
        readonly kind: "reserved";
        readonly reservation: ModelBudgetReservation;
      }
    | { readonly kind: "budget_exceeded" }
  >;
}

export interface CredentialPolicy {
  /** Stable opaque name such as `openai-primary`, never the credential itself. */
  readonly credentialId: string;
  readonly maxConcurrency: number;
  readonly requestsPerMinute: number;
  /** Recover a slot if its worker dies without releasing it. */
  readonly leaseMillis: number;
}

export interface ModelAdmissionPort {
  enter(
    policy: CredentialPolicy,
  ): Promise<
    | { readonly kind: "entered"; readonly release: () => Promise<void> }
    | { readonly kind: "rate_limited" }
  >;
}

export interface GatewayLogger {
  info(event: string, fields: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields: Readonly<Record<string, unknown>>): void;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}
