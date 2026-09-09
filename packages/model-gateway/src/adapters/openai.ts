import type {
  ModelProviderAdapter,
  ProviderInvocation,
  ProviderOutcome,
} from "../types.js";

type FetchLike = typeof fetch;

interface OpenAIResponseBody {
  readonly id?: unknown;
  readonly output_text?: unknown;
  readonly output?: unknown;
  readonly usage?: unknown;
}

function outputText(body: OpenAIResponseBody): string | undefined {
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) return undefined;
  const pieces: string[] = [];
  for (const item of body.output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { readonly content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const typed = block as {
        readonly type?: unknown;
        readonly text?: unknown;
      };
      if (typed.type === "output_text" && typeof typed.text === "string") {
        pieces.push(typed.text);
      }
    }
  }
  return pieces.length === 0 ? undefined : pieces.join("");
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export class OpenAIAdapter implements ModelProviderAdapter {
  public readonly provider = "openai" as const;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  public constructor(
    apiKey: string,
    options: { readonly fetch?: FetchLike; readonly baseUrl?: string } = {},
  ) {
    if (apiKey.trim() === "") throw new Error("OpenAI API key is required");
    this.#apiKey = apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
  }

  public async invoke(request: ProviderInvocation): Promise<ProviderOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    timer.unref?.();
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: request.modelId,
            instructions: request.system,
            input: request.input,
            max_output_tokens: request.maxOutputTokens,
            ...(request.promptCaching
              ? { prompt_cache_key: `${request.schemaName}:${request.modelId}` }
              : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          return {
            kind: "unknown",
            reason: "timeout_after_dispatch",
            detail:
              "OpenAI request timed out after dispatch; provider execution is unknown",
          };
        }
        return {
          kind: "unknown",
          reason: "connection_lost_after_dispatch",
          detail:
            "OpenAI connection failed after dispatch; provider execution is unknown",
        };
      }

      if (response.status === 429) {
        return {
          kind: "failed",
          retryable: true,
          reason: "rate_limited",
          detail:
            "OpenAI rejected the request because the credential is rate limited",
        };
      }
      if (response.status >= 400 && response.status < 500) {
        return {
          kind: "failed",
          retryable: false,
          reason: "provider_rejected",
          detail: `OpenAI rejected the request (${String(response.status)})`,
        };
      }
      if (!response.ok) {
        return {
          kind: "unknown",
          reason: "provider_ambiguous",
          detail: `OpenAI returned ${String(response.status)} after dispatch; execution is unknown`,
        };
      }

      let body: OpenAIResponseBody;
      try {
        body = (await response.json()) as OpenAIResponseBody;
      } catch {
        return {
          kind: "unknown",
          reason: "provider_ambiguous",
          detail:
            "OpenAI returned a successful status with an unreadable response body",
        };
      }
      const text = outputText(body);
      if (text === undefined) {
        return {
          kind: "unknown",
          reason: "provider_ambiguous",
          detail: "OpenAI returned a successful status without output text",
        };
      }

      const usage =
        typeof body.usage === "object" && body.usage !== null
          ? (body.usage as {
              readonly input_tokens?: unknown;
              readonly output_tokens?: unknown;
              readonly input_tokens_details?: unknown;
            })
          : {};
      const details =
        typeof usage.input_tokens_details === "object" &&
        usage.input_tokens_details !== null
          ? (usage.input_tokens_details as { readonly cached_tokens?: unknown })
          : {};
      return {
        kind: "ok",
        text,
        inputTokens: nonNegativeInteger(usage.input_tokens),
        outputTokens: nonNegativeInteger(usage.output_tokens),
        cachedInputTokens: nonNegativeInteger(details.cached_tokens),
        cacheCreationInputTokens: 0,
        ...(typeof body.id === "string" && body.id.trim() !== ""
          ? { providerRequestId: body.id }
          : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
