import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ModelGateway } from "../src/gateway.js";
import { MemoryCassetteStore } from "../src/replay.js";
import { StaticModelRouter } from "../src/routing.js";
import type {
  GatewayLogger,
  ModelBudgetReservationPort,
  ModelInteractionObservation,
  ModelProviderAdapter,
  ModelUsagePort,
} from "../src/types.js";

class MemoryUsage implements ModelUsagePort {
  readonly observations: ModelInteractionObservation[] = [];

  public async usageForRun(_reviewRunId: string) {
    const live = this.observations.filter((entry) => entry.providerDispatched);
    return {
      calls: live.length,
      costMicroUsd: this.observations.reduce(
        (sum, entry) => sum + (entry.usage?.costMicroUsd ?? 0),
        0,
      ),
    };
  }

  public async usageForOrganization(_organizationId: string, _since: Date) {
    return this.usageForRun("");
  }

  public async record(observation: ModelInteractionObservation) {
    this.observations.push(observation);
  }
}

class MemoryReservations implements ModelBudgetReservationPort {
  readonly requested: number[] = [];
  released = 0;
  dispatchMarked = 0;
  deny = false;

  public async reserve(input: Parameters<ModelBudgetReservationPort["reserve"]>[0]) {
    this.requested.push(input.requestedCostMicroUsd);
    if (this.deny) return { kind: "budget_exceeded" as const };
    return {
      kind: "reserved" as const,
      reservation: {
        markDispatched: async () => {
          this.dispatchMarked += 1;
        },
        release: async () => {
          this.released += 1;
        },
      },
    };
  }
}

const router = new StaticModelRouter("route-v1", {
  triage: {
    provider: "openai",
    modelId: "configured-cheap",
    tier: "cheap",
    maxOutputTokens: 256,
    promptCaching: false,
    inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000,
  },
  correctness: {
    provider: "openai",
    modelId: "configured-strong",
    tier: "strong",
    maxOutputTokens: 512,
    promptCaching: true,
    inputMicroUsdPerMillion: 2_000_000,
    outputMicroUsdPerMillion: 4_000_000,
    cachedInputMicroUsdPerMillion: 500_000,
  },
  verification: {
    provider: "anthropic",
    modelId: "configured-verifier",
    tier: "strong",
    maxOutputTokens: 256,
    promptCaching: true,
    inputMicroUsdPerMillion: 2_000_000,
    outputMicroUsdPerMillion: 4_000_000,
  },
  summary: {
    provider: "openai",
    modelId: "configured-summary",
    tier: "cheap",
    maxOutputTokens: 512,
    promptCaching: false,
    inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000,
  },
});

function gateway(
  adapter: ModelProviderAdapter,
  usage = new MemoryUsage(),
  overrides: Partial<ConstructorParameters<typeof ModelGateway>[0]> = {},
) {
  const reservations = new MemoryReservations();
  return {
    usage,
    reservations,
    gateway: new ModelGateway({
      router,
      adapters: new Map([[adapter.provider, adapter]]),
      usage,
      reservations,
      budget: {
        maxCallsPerRun: 20,
        maxCostMicroUsdPerCall: 1_000_000,
        maxCostMicroUsdPerRun: 5_000_000,
        maxCostMicroUsdPerOrganization: 50_000_000,
        organizationWindowMs: 60 * 60 * 1000,
      },
      credentials: {
        openai: {
          credentialId: "openai-primary",
          maxConcurrency: 2,
          requestsPerMinute: 100,
          leaseMillis: 120_000,
        },
        anthropic: {
          credentialId: "anthropic-primary",
          maxConcurrency: 2,
          requestsPerMinute: 100,
          leaseMillis: 120_000,
        },
      },
      retries: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
      ...overrides,
    }),
  };
}

const request = {
  scope: { organizationId: "org", reviewRunId: "run" },
  taskClass: "correctness" as const,
  promptTemplateVersion: "prompt-v1",
  system: "SYSTEM",
  input: "repository source",
  schemaName: "answer",
  schema: z.object({ answer: z.string() }),
  timeoutMs: 5_000,
};

describe("ModelGateway", () => {
  it("validates structured output and records route, tokens, cache and cost", async () => {
    const adapter: ModelProviderAdapter = {
      provider: "openai",
      invoke: async () => ({
        kind: "ok",
        text: JSON.stringify({ answer: "yes" }),
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        providerRequestId: "req-1",
      }),
    };
    const built = gateway(adapter);
    const outcome = await built.gateway.complete(request);

    expect(outcome).toMatchObject({
      kind: "ok",
      value: { answer: "yes" },
      identity: {
        provider: "openai",
        modelId: "configured-strong",
        routingPolicyVersion: "route-v1",
        promptTemplateVersion: "prompt-v1",
      },
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        cacheCreationInputTokens: 0,
        cacheHit: true,
      },
    });
    expect(built.usage.observations).toHaveLength(1);
    expect(built.usage.observations[0]).toMatchObject({
      outcome: "ok",
      replayed: false,
      providerDispatched: true,
    });
  });

  it("treats schema-invalid provider output as a first-class failure", async () => {
    const built = gateway({
      provider: "openai",
      invoke: async () => ({
        kind: "ok",
        text: JSON.stringify({ wrong: true }),
        inputTokens: 5,
        outputTokens: 5,
        cachedInputTokens: 0,
      }),
    });
    await expect(built.gateway.complete(request)).resolves.toMatchObject({
      kind: "failed",
      reason: "invalid_response",
      retryable: false,
    });
    expect(built.usage.observations[0]).toMatchObject({
      outcome: "invalid_response",
      providerDispatched: true,
    });
  });

  it("never retries an ambiguous provider outcome", async () => {
    let calls = 0;
    const built = gateway({
      provider: "openai",
      invoke: async () => {
        calls += 1;
        return {
          kind: "unknown",
          reason: "timeout_after_dispatch",
          detail: "ambiguous timeout",
        };
      },
    });
    await expect(built.gateway.complete(request)).resolves.toMatchObject({
      kind: "unknown",
      reason: "timeout_after_dispatch",
    });
    expect(calls).toBe(1);
  });

  it("records then replays the exact request without dispatching a provider", async () => {
    let liveCalls = 0;
    const cassette = new MemoryCassetteStore();
    const live = gateway(
      {
        provider: "openai",
        invoke: async () => {
          liveCalls += 1;
          return {
            kind: "ok",
            text: JSON.stringify({ answer: "cassette" }),
            inputTokens: 8,
            outputTokens: 3,
            cachedInputTokens: 0,
          };
        },
      },
      new MemoryUsage(),
      { cassette, replayMode: "record" },
    );
    const recorded = await live.gateway.complete(request);
    expect(recorded.kind).toBe("ok");
    expect(liveCalls).toBe(1);

    const replayUsage = new MemoryUsage();
    const replay = gateway(
      {
        provider: "openai",
        invoke: async () => {
          throw new Error("replay must not call provider");
        },
      },
      replayUsage,
      { cassette, replayMode: "replay" },
    );
    const replayed = await replay.gateway.complete(request);
    expect(replayed).toMatchObject({ kind: "ok", replayed: true, value: { answer: "cassette" } });
    expect(replayUsage.observations[0]?.providerDispatched).toBe(false);
    if (recorded.kind === "ok" && replayed.kind === "ok") {
      expect(replayed.identity.requestDigest).toBe(recorded.identity.requestDigest);
      expect(replayed.value).toEqual(recorded.value);
    }
  });

  it("reserves the full per-call ceiling before live dispatch and releases after ledger commit", async () => {
    const built = gateway({
      provider: "openai",
      invoke: async () => ({
        kind: "ok",
        text: JSON.stringify({ answer: "yes" }),
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
      }),
    });

    await expect(built.gateway.complete(request)).resolves.toMatchObject({ kind: "ok" });
    expect(built.reservations.requested).toEqual([1_000_000]);
    expect(built.reservations.dispatchMarked).toBe(1);
    expect(built.reservations.released).toBe(1);
  });

  it("accounts every provider-dispatched retry as its own reserved interaction", async () => {
    let calls = 0;
    const built = gateway({
      provider: "openai",
      invoke: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            kind: "failed",
            retryable: true,
            reason: "rate_limited",
            detail: "provider rate limit",
          };
        }
        return {
          kind: "ok",
          text: JSON.stringify({ answer: "yes" }),
          inputTokens: 2,
          outputTokens: 1,
          cachedInputTokens: 0,
        };
      },
    });

    await expect(built.gateway.complete(request)).resolves.toMatchObject({
      kind: "ok",
      value: { answer: "yes" },
    });
    expect(calls).toBe(2);
    expect(built.reservations.requested).toEqual([1_000_000, 1_000_000]);
    expect(built.reservations.dispatchMarked).toBe(2);
    expect(built.reservations.released).toBe(2);
    expect(built.usage.observations).toHaveLength(2);
    expect(built.usage.observations[0]).toMatchObject({
      outcome: "failed",
      providerDispatched: true,
      accountedCostMicroUsd: 0,
    });
    expect(built.usage.observations[1]).toMatchObject({
      outcome: "ok",
      providerDispatched: true,
    });
  });

  it("does not spend a provider-call reservation while only local admission is throttled", async () => {
    let calls = 0;
    let admissions = 0;
    const built = gateway(
      {
        provider: "openai",
        invoke: async () => {
          calls += 1;
          return {
            kind: "ok",
            text: JSON.stringify({ answer: "yes" }),
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
          };
        },
      },
      new MemoryUsage(),
      {
        admission: {
          enter: async () => {
            admissions += 1;
            if (admissions === 1) return { kind: "rate_limited" as const };
            return {
              kind: "entered" as const,
              release: async () => undefined,
            };
          },
        },
      },
    );

    await expect(built.gateway.complete(request)).resolves.toMatchObject({ kind: "ok" });
    expect(admissions).toBe(2);
    expect(calls).toBe(1);
    expect(built.reservations.requested).toEqual([1_000_000]);
  });

  it("accounts the conservative ceiling and never retries ambiguous execution", async () => {
    let calls = 0;
    const built = gateway({
      provider: "openai",
      invoke: async () => {
        calls += 1;
        return {
          kind: "unknown",
          reason: "provider_ambiguous",
          detail: "provider returned an ambiguous 5xx",
        };
      },
    });

    await expect(built.gateway.complete(request)).resolves.toMatchObject({
      kind: "unknown",
      reason: "provider_ambiguous",
    });
    expect(calls).toBe(1);
    expect(built.usage.observations[0]).toMatchObject({
      outcome: "unknown",
      accountedCostMicroUsd: 1_000_000,
      providerDispatched: true,
    });
    expect(built.reservations.released).toBe(1);
  });

  it("fails before dispatch when the provider-visible prompt can exceed the per-call ceiling", async () => {
    let calls = 0;
    const built = gateway({
      provider: "openai",
      invoke: async () => {
        calls += 1;
        return {
          kind: "ok",
          text: JSON.stringify({ answer: "unexpected" }),
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
        };
      },
    });

    await expect(
      built.gateway.complete({ ...request, input: "x".repeat(600_000) }),
    ).resolves.toMatchObject({ kind: "failed", reason: "budget_exceeded" });
    expect(calls).toBe(0);
    expect(built.reservations.requested).toEqual([]);
  });

  it("never repeats a dispatched provider call when the local ledger commit fails", async () => {
    let calls = 0;
    const usage: ModelUsagePort = {
      usageForRun: async () => ({ calls: 0, costMicroUsd: 0 }),
      usageForOrganization: async () => ({ calls: 0, costMicroUsd: 0 }),
      record: async () => {
        throw new Error("ledger unavailable");
      },
    };
    const built = gateway(
      {
        provider: "openai",
        invoke: async () => {
          calls += 1;
          return {
            kind: "ok",
            text: JSON.stringify({ answer: "yes" }),
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
          };
        },
      },
      usage as MemoryUsage,
    );

    await expect(built.gateway.complete(request)).resolves.toMatchObject({
      kind: "unknown",
      reason: "local_commit_unknown",
    });
    expect(calls).toBe(1);
    expect(built.reservations.dispatchMarked).toBe(1);
    expect(built.reservations.released).toBe(0);
  });

  it("does not put repository source into structured logs", async () => {
    const events: unknown[] = [];
    const logger: GatewayLogger = {
      info: (_event, fields) => events.push(fields),
      warn: (_event, fields) => events.push(fields),
    };
    const built = gateway(
      {
        provider: "openai",
        invoke: async () => ({
          kind: "ok",
          text: JSON.stringify({ answer: "yes" }),
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
        }),
      },
      new MemoryUsage(),
      { logger },
    );
    await built.gateway.complete({ ...request, input: "SUPER_SECRET_REPOSITORY_BYTES" });
    expect(JSON.stringify(events)).not.toContain("SUPER_SECRET_REPOSITORY_BYTES");
  });
});
