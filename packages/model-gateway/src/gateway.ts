import { createHash, randomInt } from "node:crypto";

import { canonicalJson } from "@acalys/contracts/domain";

import { CredentialLimiter } from "./limits.js";
import type { CassetteStore, ReplayMode } from "./replay.js";
import type {
  CredentialPolicy,
  GatewayLogger,
  ModelAdmissionPort,
  ModelBudgetConfig,
  ModelBudgetReservation,
  ModelBudgetReservationPort,
  ModelExecutionIdentity,
  ModelInteractionObservation,
  ModelOutcome,
  ModelPort,
  ModelProvider,
  ModelProviderAdapter,
  ModelRequest,
  ModelRouteDecision,
  ModelRoutingPolicy,
  ModelUsage,
  ModelUsagePort,
  ProviderOutcome,
  RetryPolicy,
} from "./types.js";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export const MODEL_GATEWAY_ENVELOPE_VERSION = "structured-json-v1";

function providerInputFor(input: string, schemaName: string): string {
  return `${input}\n\nReturn exactly one JSON value matching schema ${schemaName}. Do not use markdown fences.`;
}

function conservativeWorstCaseCost(
  route: ModelRouteDecision,
  system: string,
  providerInput: string,
): number {
  // Both supported providers tokenize UTF-8 text. Counting one token per byte is
  // deliberately pessimistic but gives a provider-independent upper bound
  // without importing a provider tokenizer into the canonical gateway.
  const inputUpperBound = Buffer.byteLength(system, "utf8") + Buffer.byteLength(providerInput, "utf8");
  const highestInputRate = Math.max(
    route.inputMicroUsdPerMillion,
    route.cachedInputMicroUsdPerMillion ?? route.inputMicroUsdPerMillion,
    route.cacheCreationInputMicroUsdPerMillion ?? route.inputMicroUsdPerMillion,
  );
  return Math.ceil(
    (inputUpperBound * highestInputRate +
      route.maxOutputTokens * route.outputMicroUsdPerMillion) /
      1_000_000,
  );
}

function usageFor(
  route: ModelRouteDecision,
  raw: Extract<ProviderOutcome, { readonly kind: "ok" }>,
): ModelUsage {
  const cacheCreationInputTokens = raw.cacheCreationInputTokens ?? 0;
  const uncachedInput = Math.max(
    0,
    raw.inputTokens - raw.cachedInputTokens - cacheCreationInputTokens,
  );
  const cachedRate =
    route.cachedInputMicroUsdPerMillion ?? route.inputMicroUsdPerMillion;
  const cacheCreationRate =
    route.cacheCreationInputMicroUsdPerMillion ?? route.inputMicroUsdPerMillion;
  const costMicroUsd = Math.round(
    (uncachedInput * route.inputMicroUsdPerMillion +
      raw.cachedInputTokens * cachedRate +
      cacheCreationInputTokens * cacheCreationRate +
      raw.outputTokens * route.outputMicroUsdPerMillion) /
      1_000_000,
  );
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cachedInputTokens: raw.cachedInputTokens,
    cacheCreationInputTokens,
    cacheHit: raw.cachedInputTokens > 0,
    costMicroUsd,
  };
}

const NOOP_LOGGER: GatewayLogger = {
  info: () => undefined,
  warn: () => undefined,
};

function sanitized(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const lowered = key.toLowerCase();
    if (
      lowered.includes("secret") ||
      lowered.includes("apikey") ||
      lowered.includes("api_key") ||
      lowered.includes("credential") ||
      lowered === "input" ||
      lowered === "output" ||
      lowered === "system" ||
      lowered.includes("source")
    ) {
      safe[key] = "[REDACTED]";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export interface ModelGatewayOptions {
  readonly router: ModelRoutingPolicy;
  readonly adapters: ReadonlyMap<ModelProvider, ModelProviderAdapter>;
  readonly usage: ModelUsagePort;
  readonly reservations: ModelBudgetReservationPort;
  readonly budget: ModelBudgetConfig;
  readonly credentials: Readonly<Record<ModelProvider, CredentialPolicy>>;
  readonly retries: RetryPolicy;
  readonly admission?: ModelAdmissionPort | undefined;
  readonly cassette?: CassetteStore | undefined;
  readonly replayMode?: ReplayMode | undefined;
  readonly logger?: GatewayLogger | undefined;
  readonly sleep?: ((millis: number) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly jitter?: ((maxInclusive: number) => number) | undefined;
}

export class ModelGateway implements ModelPort {
  readonly #router: ModelRoutingPolicy;
  readonly #adapters: ReadonlyMap<ModelProvider, ModelProviderAdapter>;
  readonly #usage: ModelUsagePort;
  readonly #reservations: ModelBudgetReservationPort;
  readonly #budget: ModelBudgetConfig;
  readonly #credentials: Readonly<Record<ModelProvider, CredentialPolicy>>;
  readonly #retries: RetryPolicy;
  readonly #admission: ModelAdmissionPort;
  readonly #cassette: CassetteStore | undefined;
  readonly #replayMode: ReplayMode;
  readonly #logger: GatewayLogger;
  readonly #sleep: (millis: number) => Promise<void>;
  readonly #now: () => Date;
  readonly #jitter: (maxInclusive: number) => number;

  public constructor(options: ModelGatewayOptions) {
    this.#router = options.router;
    this.#adapters = options.adapters;
    this.#usage = options.usage;
    this.#reservations = options.reservations;
    this.#budget = options.budget;
    this.#credentials = options.credentials;
    this.#retries = options.retries;
    this.#admission = options.admission ?? new CredentialLimiter();
    this.#cassette = options.cassette;
    this.#replayMode = options.replayMode ?? "off";
    this.#logger = options.logger ?? NOOP_LOGGER;
    this.#sleep = options.sleep ?? ((millis) => new Promise((resolve) => setTimeout(resolve, millis)));
    this.#now = options.now ?? (() => new Date());
    this.#jitter = options.jitter ?? ((maxInclusive) => randomInt(0, maxInclusive + 1));

    if (this.#retries.maxAttempts < 1 || !Number.isInteger(this.#retries.maxAttempts)) {
      throw new Error("retry maxAttempts must be a positive integer");
    }
    if (this.#budget.organizationWindowMs < 1_000) {
      throw new Error("organization budget window must be at least 1000ms");
    }
    if (
      !Number.isSafeInteger(this.#budget.maxCostMicroUsdPerCall) ||
      this.#budget.maxCostMicroUsdPerCall < 0
    ) {
      throw new Error("per-call model budget must be a non-negative safe integer");
    }
    if (this.#replayMode !== "off" && this.#cassette === undefined) {
      throw new Error("replay/record mode requires a cassette store");
    }
  }

  public async complete<T>(request: ModelRequest<T>): Promise<ModelOutcome<T>> {
    const route = this.#router.route(request.taskClass);
    const providerInput = providerInputFor(request.input, request.schemaName);
    const requestDigest = digest({
      taskClass: request.taskClass,
      promptTemplateVersion: request.promptTemplateVersion,
      envelopeVersion: MODEL_GATEWAY_ENVELOPE_VERSION,
      system: request.system,
      input: providerInput,
      schemaName: request.schemaName,
      provider: route.provider,
      modelId: route.modelId,
      tier: route.tier,
      routingPolicyVersion: route.routingPolicyVersion,
      maxOutputTokens: route.maxOutputTokens,
      promptCaching: route.promptCaching,
    });
    const identity: ModelExecutionIdentity = {
      provider: route.provider,
      modelId: route.modelId,
      tier: route.tier,
      taskClass: route.taskClass,
      routingPolicyVersion: route.routingPolicyVersion,
      promptTemplateVersion: request.promptTemplateVersion,
      requestDigest,
    };
    const startedAt = this.#now();

    const logInfo = (event: string, fields: Readonly<Record<string, unknown>>): void => {
      this.#logger.info(event, sanitized(fields));
    };
    const logWarn = (event: string, fields: Readonly<Record<string, unknown>>): void => {
      this.#logger.warn(event, sanitized(fields));
    };

    const record = async (
      outcome: ModelInteractionObservation["outcome"],
      replayed: boolean,
      usage: ModelUsage | undefined,
      providerDispatched: boolean,
      accountedCostMicroUsd: number,
    ): Promise<void> => {
      await this.#usage.record({
        scope: request.scope,
        identity,
        outcome,
        ...(usage === undefined ? {} : { usage }),
        accountedCostMicroUsd,
        replayed,
        providerDispatched,
        startedAt,
        finishedAt: this.#now(),
      });
    };

    const failedResult = (
      reason: Extract<ModelOutcome<never>, { kind: "failed" }>["reason"],
      detail: string,
      retryable: boolean,
      replayed: boolean,
    ): ModelOutcome<T> => ({
      kind: "failed",
      reason,
      identity,
      retryable,
      replayed,
      detail,
    });

    const unknownResult = (
      raw: Extract<ProviderOutcome, { kind: "unknown" }>,
      replayed: boolean,
    ): ModelOutcome<T> => ({
      kind: "unknown",
      reason: raw.reason,
      identity,
      replayed,
      detail: raw.detail,
    });

    const parseSuccess = async (
      raw: Extract<ProviderOutcome, { kind: "ok" }>,
      replayed: boolean,
      accountedCostOverride?: number,
    ): Promise<ModelOutcome<T>> => {
      const usage = usageFor(route, raw);
      let json: unknown;
      try {
        json = JSON.parse(raw.text) as unknown;
      } catch {
        await record(
          "invalid_response",
          replayed,
          usage,
          !replayed,
          replayed ? 0 : (accountedCostOverride ?? usage.costMicroUsd),
        );
        return failedResult(
          "invalid_response",
          "provider returned text that was not JSON",
          false,
          replayed,
        );
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) {
        await record(
          "invalid_response",
          replayed,
          usage,
          !replayed,
          replayed ? 0 : (accountedCostOverride ?? usage.costMicroUsd),
        );
        return failedResult(
          "invalid_response",
          `provider response failed ${request.schemaName} validation`,
          false,
          replayed,
        );
      }
      await record(
        "ok",
        replayed,
        usage,
        !replayed,
        replayed ? 0 : (accountedCostOverride ?? usage.costMicroUsd),
      );
      logInfo("model.call.ok", {
        provider: route.provider,
        modelId: route.modelId,
        taskClass: route.taskClass,
        requestDigest,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        costMicroUsd: usage.costMicroUsd,
        replayed,
      });
      return {
        kind: "ok",
        value: parsed.data,
        usage,
        identity,
        replayed,
        ...(raw.providerRequestId === undefined
          ? {}
          : { providerRequestId: raw.providerRequestId }),
      };
    };

    if (this.#replayMode === "replay") {
      const entry = await this.#cassette?.read(requestDigest);
      if (entry === undefined) {
        await record("failed", true, undefined, false, 0);
        return failedResult(
          "cassette_missing",
          "no cassette entry exists for this exact request",
          false,
          true,
        );
      }
      if (entry.provider !== route.provider || entry.modelId !== route.modelId) {
        await record("failed", true, undefined, false, 0);
        return failedResult(
          "configuration",
          "cassette route does not match the routing decision",
          false,
          true,
        );
      }
      if (entry.outcome.kind === "ok") return parseSuccess(entry.outcome, true);
      if (entry.outcome.kind === "unknown") {
        await record("unknown", true, undefined, false, 0);
        return unknownResult(entry.outcome, true);
      }
      await record("failed", true, undefined, false, 0);
      return failedResult(
        entry.outcome.reason,
        entry.outcome.detail,
        entry.outcome.retryable,
        true,
      );
    }

    const worstCaseCost = conservativeWorstCaseCost(route, request.system, providerInput);
    if (worstCaseCost > this.#budget.maxCostMicroUsdPerCall) {
      await record("failed", false, undefined, false, 0);
      return failedResult(
        "budget_exceeded",
        "provider-visible prompt can exceed the configured per-call ceiling",
        false,
        false,
      );
    }

    const adapter = this.#adapters.get(route.provider);
    if (adapter === undefined) {
      await record("failed", false, undefined, false, 0);
      return failedResult(
        "configuration",
        `no adapter configured for ${route.provider}`,
        false,
        false,
      );
    }

    const releaseReservationAfterCommit = async (
      reservation: ModelBudgetReservation | undefined,
      committed: boolean,
    ): Promise<void> => {
      if (!committed || reservation === undefined) return;
      try {
        await reservation.release();
      } catch {
        // Safe leak: a cleanup failure must not turn a completed stochastic
        // provider call into another call. Database reconciliation owns the
        // reservation after this point.
        logWarn("model.budget.release_failed", {
          provider: route.provider,
          modelId: route.modelId,
          taskClass: route.taskClass,
          requestDigest,
        });
      }
    };

    const commitObservation = async (
      outcome: ModelInteractionObservation["outcome"],
      usage: ModelUsage | undefined,
      providerDispatched: boolean,
      accountedCostMicroUsd: number,
    ): Promise<boolean> => {
      try {
        await record(
          outcome,
          false,
          usage,
          providerDispatched,
          accountedCostMicroUsd,
        );
        return true;
      } catch {
        // If a provider was dispatched, the reservation stays conservative.
        // If it was not, the caller is free to retry because no stochastic
        // side effect has occurred.
        logWarn("model.ledger.commit_unknown", {
          provider: route.provider,
          modelId: route.modelId,
          taskClass: route.taskClass,
          requestDigest,
          providerDispatched,
        });
        return false;
      }
    };

    let raw: ProviderOutcome | undefined;
    let finalReservation: ModelBudgetReservation | undefined;
    let finalProviderDispatched = false;
    let finalAttemptAlreadyRecorded = false;

    for (let attempt = 1; attempt <= this.#retries.maxAttempts; attempt += 1) {
      const credential = this.#credentials[route.provider];
      const admission = await this.#admission.enter(credential);

      if (admission.kind === "rate_limited") {
        // Local admission happened before a provider request, so it consumes no
        // provider-call slot and no spend reservation.
        raw = {
          kind: "failed",
          retryable: true,
          reason: "rate_limited",
          detail: "local credential request budget is exhausted",
        };
        finalReservation = undefined;
        finalProviderDispatched = false;
        finalAttemptAlreadyRecorded = false;
      } else {
        let attemptReservation: ModelBudgetReservation | undefined;
        let dispatchMarked = false;
        let budgetDenied = false;
        try {
          const reservationOutcome = await this.#reservations.reserve({
            scope: request.scope,
            limits: this.#budget,
            // One reservation per actual provider attempt. A retry is another
            // external request and therefore another call slot and another
            // possible per-call ceiling of spend.
            requestedCostMicroUsd: this.#budget.maxCostMicroUsdPerCall,
            at: this.#now(),
          });
          if (reservationOutcome.kind === "budget_exceeded") {
            budgetDenied = true;
          } else {
            attemptReservation = reservationOutcome.reservation;
            // Durable dispatch intent precedes the network call. If this
            // process dies after this line, the reservation remains
            // conservative until an operator/reconciler can prove the outcome.
            await attemptReservation.markDispatched();
            dispatchMarked = true;
            raw = await adapter.invoke({
              modelId: route.modelId,
              system: request.system,
              input: providerInput,
              maxOutputTokens: route.maxOutputTokens,
              timeoutMs: request.timeoutMs,
              schemaName: request.schemaName,
              promptCaching: route.promptCaching,
            });
          }
        } catch {
          if (dispatchMarked) {
            const committed = await commitObservation(
              "unknown",
              undefined,
              true,
              this.#budget.maxCostMicroUsdPerCall,
            );
            await releaseReservationAfterCommit(attemptReservation, committed);
            return {
              kind: "unknown",
              reason: "provider_ambiguous",
              identity,
              replayed: false,
              detail:
                "model adapter failed after durable dispatch intent; provider execution is unknown",
            };
          }
          // No provider side effect is possible. Best-effort cleanup is safe;
          // the original infrastructure error remains retryable by the caller.
          try {
            await attemptReservation?.release();
          } catch {
            // Pre-dispatch reservations expire by database time.
          }
          throw new Error("model dispatch preparation failed before provider execution");
        } finally {
          try {
            await admission.release();
          } catch {
            // The fleet-wide admission lease expires. Never repeat a provider
            // call merely because releasing local capacity failed.
            logWarn("model.admission.release_failed", {
              provider: route.provider,
              modelId: route.modelId,
              taskClass: route.taskClass,
              requestDigest,
            });
          }
        }

        if (budgetDenied) {
          const committed = await commitObservation("failed", undefined, false, 0);
          if (!committed) {
            throw new Error("model budget denial could not be recorded");
          }
          return failedResult(
            "budget_exceeded",
            "configured model budget would be exceeded",
            false,
            false,
          );
        }

        finalReservation = attemptReservation;
        finalProviderDispatched = dispatchMarked;
        finalAttemptAlreadyRecorded = false;

        // A known retryable provider response is itself a provider interaction.
        // Persist and settle this attempt before another one can be authorized.
        if (raw?.kind === "failed" && raw.retryable && dispatchMarked) {
          const committed = await commitObservation("failed", undefined, true, 0);
          if (!committed) {
            return {
              kind: "unknown",
              reason: "local_commit_unknown",
              identity,
              replayed: false,
              detail:
                "retryable provider failure occurred but its interaction ledger row did not commit",
            };
          }
          await releaseReservationAfterCommit(attemptReservation, true);
          finalReservation = undefined;
          finalAttemptAlreadyRecorded = true;
        }
      }

      // Unknown execution is never retried. A successful or non-retryable
      // response is also final. Only a known retryable failure loops.
      if (raw === undefined || raw.kind === "unknown" || raw.kind === "ok" || !raw.retryable) {
        break;
      }
      if (attempt < this.#retries.maxAttempts) {
        const ceiling = Math.min(
          this.#retries.maxDelayMs,
          this.#retries.baseDelayMs * 2 ** (attempt - 1),
        );
        const delay = ceiling <= 0 ? 0 : this.#jitter(ceiling);
        await this.#sleep(delay);
      }
    }

    if (raw === undefined) {
      const committed = await commitObservation("failed", undefined, false, 0);
      if (!committed) throw new Error("model gateway configuration failure was not recorded");
      return failedResult(
        "configuration",
        "retry policy allowed zero provider attempts",
        false,
        false,
      );
    }

    if (this.#replayMode === "record") {
      try {
        await this.#cassette?.write({
          version: 1,
          requestDigest,
          provider: route.provider,
          modelId: route.modelId,
          outcome: raw,
        });
      } catch {
        if (!finalAttemptAlreadyRecorded) {
          const usage = raw.kind === "ok" ? usageFor(route, raw) : undefined;
          const accountedCost =
            raw.kind === "ok"
              ? (usage?.costMicroUsd ?? 0)
              : raw.kind === "unknown" && finalProviderDispatched
                ? this.#budget.maxCostMicroUsdPerCall
                : 0;
          const committed = await commitObservation(
            "unknown",
            usage,
            finalProviderDispatched,
            accountedCost,
          );
          await releaseReservationAfterCommit(finalReservation, committed);
        } else {
          // The provider attempt is already durable; record the local cassette
          // failure as a non-provider observation so the logical call's failure
          // remains auditable without double-counting external requests.
          await commitObservation("unknown", undefined, false, 0);
        }
        return {
          kind: "unknown",
          reason: "local_commit_unknown",
          identity,
          replayed: false,
          detail:
            "provider execution completed but cassette persistence did not commit",
        };
      }
    }

    if (raw.kind === "ok") {
      const usage = usageFor(route, raw);
      let json: unknown;
      try {
        json = JSON.parse(raw.text) as unknown;
      } catch {
        const committed = await commitObservation(
          "invalid_response",
          usage,
          finalProviderDispatched,
          usage.costMicroUsd,
        );
        if (!committed) {
          return {
            kind: "unknown",
            reason: "local_commit_unknown",
            identity,
            replayed: false,
            detail:
              "provider executed but the local interaction ledger did not commit",
          };
        }
        await releaseReservationAfterCommit(finalReservation, true);
        return failedResult(
          "invalid_response",
          "provider returned text that was not JSON",
          false,
          false,
        );
      }
      const parsed = request.schema.safeParse(json);
      if (!parsed.success) {
        const committed = await commitObservation(
          "invalid_response",
          usage,
          finalProviderDispatched,
          usage.costMicroUsd,
        );
        if (!committed) {
          return {
            kind: "unknown",
            reason: "local_commit_unknown",
            identity,
            replayed: false,
            detail:
              "provider executed but the local interaction ledger did not commit",
          };
        }
        await releaseReservationAfterCommit(finalReservation, true);
        return failedResult(
          "invalid_response",
          `provider response failed ${request.schemaName} validation`,
          false,
          false,
        );
      }
      const committed = await commitObservation(
        "ok",
        usage,
        finalProviderDispatched,
        usage.costMicroUsd,
      );
      if (!committed) {
        return {
          kind: "unknown",
          reason: "local_commit_unknown",
          identity,
          replayed: false,
          detail:
            "provider executed but the local interaction ledger did not commit",
        };
      }
      await releaseReservationAfterCommit(finalReservation, true);
      logInfo("model.call.ok", {
        provider: route.provider,
        modelId: route.modelId,
        taskClass: route.taskClass,
        requestDigest,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        costMicroUsd: usage.costMicroUsd,
        replayed: false,
      });
      return {
        kind: "ok",
        value: parsed.data,
        usage,
        identity,
        replayed: false,
        ...(raw.providerRequestId === undefined
          ? {}
          : { providerRequestId: raw.providerRequestId }),
      };
    }

    if (raw.kind === "unknown") {
      const committed = await commitObservation(
        "unknown",
        undefined,
        finalProviderDispatched,
        finalProviderDispatched ? this.#budget.maxCostMicroUsdPerCall : 0,
      );
      if (!committed) {
        return {
          kind: "unknown",
          reason: "local_commit_unknown",
          identity,
          replayed: false,
          detail:
            "provider execution is ambiguous and the local interaction ledger did not commit",
        };
      }
      await releaseReservationAfterCommit(finalReservation, true);
      logWarn("model.call.unknown", {
        provider: route.provider,
        modelId: route.modelId,
        taskClass: route.taskClass,
        requestDigest,
        reason: raw.reason,
        replayed: false,
      });
      return unknownResult(raw, false);
    }

    if (!finalAttemptAlreadyRecorded) {
      const committed = await commitObservation(
        "failed",
        undefined,
        finalProviderDispatched,
        0,
      );
      if (!committed) {
        if (finalProviderDispatched) {
          return {
            kind: "unknown",
            reason: "local_commit_unknown",
            identity,
            replayed: false,
            detail:
              "provider returned a known failure but the local interaction ledger did not commit",
          };
        }
        throw new Error("pre-dispatch model failure could not be recorded");
      }
      await releaseReservationAfterCommit(finalReservation, true);
    }

    const reason = raw.retryable ? "retry_exhausted" : raw.reason;
    logWarn("model.call.failed", {
      provider: route.provider,
      modelId: route.modelId,
      taskClass: route.taskClass,
      requestDigest,
      reason,
      replayed: false,
    });
    return failedResult(reason, raw.detail, raw.retryable, false);
  }
}
