import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { JsonCassetteStore, MemoryCassetteStore } from "../src/replay.js";

const entry = {
  version: 1 as const,
  requestDigest: "a".repeat(64),
  provider: "openai" as const,
  modelId: "configured-model",
  outcome: {
    kind: "ok" as const,
    text: '{"answer":"yes"}',
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
};

describe("cassette persistence", () => {
  it("rejects one digest identifying two different provider outcomes", async () => {
    const store = new MemoryCassetteStore();
    await store.write(entry);
    await expect(
      store.write({
        ...entry,
        outcome: { ...entry.outcome, text: '{"answer":"different"}' },
      }),
    ).rejects.toThrow(/already identifies different provider output/);
  });

  it("writes and reads one canonical durable JSON document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acalys-cassette-"));
    const path = join(directory, "review.json");
    const store = new JsonCassetteStore(path);
    await store.write(entry);
    await expect(store.read(entry.requestDigest)).resolves.toEqual(entry);
  });

  it("fails closed when another process owns the cassette lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acalys-cassette-lock-"));
    const path = join(directory, "review.json");
    await writeFile(`${path}.lock`, "external-owner", "utf8");
    const store = new JsonCassetteStore(path, { lockTimeoutMs: 25 });
    await expect(store.write(entry)).rejects.toThrow(
      /refusing unsafe stale-lock removal/,
    );
  });
});
