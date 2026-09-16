import { describe, expect, it } from "vitest";

import { AnthropicAdapter } from "../src/adapters/anthropic.js";
import { OpenAIAdapter } from "../src/adapters/openai.js";

const invocation = {
  modelId: "configured-model",
  system: "system",
  input: "provider-visible input",
  maxOutputTokens: 128,
  timeoutMs: 5_000,
  schemaName: "acalys_test_v1",
  promptCaching: true,
};

function fakeFetch(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}

describe("provider adapters", () => {
  it("normalizes OpenAI response usage without exposing provider response shapes", async () => {
    const adapter = new OpenAIAdapter("test-key", {
      fetch: fakeFetch(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: '{"answer":"yes"}' }],
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 40 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    });

    await expect(adapter.invoke(invocation)).resolves.toEqual({
      kind: "ok",
      text: '{"answer":"yes"}',
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      cacheCreationInputTokens: 0,
      providerRequestId: "resp_1",
    });
  });

  it("normalizes Anthropic cache-read and cache-creation usage into total input", async () => {
    const adapter = new AnthropicAdapter("test-key", {
      fetch: fakeFetch(
        new Response(
          JSON.stringify({
            id: "msg_1",
            content: [{ type: "text", text: '{"answer":"yes"}' }],
            usage: {
              input_tokens: 60,
              output_tokens: 20,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 10,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    });

    await expect(adapter.invoke(invocation)).resolves.toEqual({
      kind: "ok",
      text: '{"answer":"yes"}',
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      cacheCreationInputTokens: 10,
      providerRequestId: "msg_1",
    });
  });

  it("treats a provider 5xx as ambiguous rather than a safe retry", async () => {
    const adapter = new OpenAIAdapter("test-key", {
      fetch: fakeFetch(new Response("upstream error", { status: 503 })),
    });
    await expect(adapter.invoke(invocation)).resolves.toMatchObject({
      kind: "unknown",
      reason: "provider_ambiguous",
    });
  });
});
