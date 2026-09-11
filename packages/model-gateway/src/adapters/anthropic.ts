import type {
  ModelProviderAdapter,
  ProviderInvocation,
  ProviderOutcome,
} from "../types.js";

type FetchLike = typeof fetch;

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export class AnthropicAdapter implements ModelProviderAdapter {
  public readonly provider = "anthropic" as const;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  public constructor(
    apiKey: string,
    options: { readonly fetch?: FetchLike; readonly baseUrl?: string } = {},
  ) {
    if (apiKey.trim() === "") throw new Error("Anthropic API key is required");
    this.#apiKey = apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
  }

  public async invoke(request: ProviderInvocation): Promise<ProviderOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    timer.unref?.();
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": this.#apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: request.modelId,
            max_tokens: request.maxOutputTokens,
            system: request.promptCaching
              ? [
                  {
                    type: "text",
                    text: request.system,
                    cache_control: { type: "ephemeral" },
                  },
                ]
              : request.system,
            messages: [
              {
                role: "user",
                content: request.input,
              },
            ],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          return {
            kind: "unknown",
            reason: "timeout_after_dispatch",
            detail: "Anthropic request timed out after dispatch; provider execution is unknown",
          };
        }
        return {
          kind: "unknown",
          reason: "connection_lost_after_dispatch",
          detail: "Anthropic connection failed after dispatch; provider execution is unknown",
        };
      }

      if (response.status === 429) {
        return {
          kind: "failed",
          retryable: true,
          reason: "rate_limited",
          detail: "Anthropic rejected the request because the credential is rate limited",
        };
      }
      if (response.status >= 400 && response.status < 500) {
        return {
          kind: "failed",
          retryable: false,
          reason: "provider_rejected",
          detail: `Anthropic rejected the request (${String(response.status)})`,
        };
      }
      if (!response.ok) {
        return {
          kind: "unknown",
          reason: "provider_ambiguous",
          detail: `Anthropic returned ${String(response.status)} after dispatch; execution is unknown`,
        };
      }

      let body: {
        readonly id?: unknown;
        readonly content?: unknown;
        readonly usage?: unknown;
      };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        return {
          kind: "unknown",
          reason: "provider_ambiguous",
          detail: "Anthropic returned a successful status with an unreadable response body",
        };
      }
      if (!Array.isArray(body.content)) {
        return {
          kind: "unknown",
          reason: "provider_ambiguous",
          detail: "Anthropic returned a successful status without content blocks",
        };
      }
      const text = body.content
        .filter(
          (block): block is { readonly type: "text"; readonly text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as { readonly type?: unknown }).type === "text" &&
            typeof (block as { readonly text?: unknown }).text === "string",
        )
        .map((block) => block.text)
        .join("");
      if (text === "") {
        return {
          kind: "unknown",
          reason: "provider_ambiguous",
          detail: "Anthropic returned a successful status without text output",
        };
      }

      const usage =
        typeof body.usage === "object" && body.usage !== null
          ? (body.usage as {
              readonly input_tokens?: unknown;
              readonly output_tokens?: unknown;
              readonly cache_read_input_tokens?: unknown;
              readonly cache_creation_input_tokens?: unknown;
            })
          : {};
      const uncached = nonNegativeInteger(usage.input_tokens);
      const cached = nonNegativeInteger(usage.cache_read_input_tokens);
      const cacheCreation = nonNegativeInteger(usage.cache_creation_input_tokens);
      return {
        kind: "ok",
        text,
        inputTokens: uncached + cached + cacheCreation,
        outputTokens: nonNegativeInteger(usage.output_tokens),
        cachedInputTokens: cached,
        cacheCreationInputTokens: cacheCreation,
        ...(typeof body.id === "string" && body.id.trim() !== ""
          ? { providerRequestId: body.id }
          : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
