import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson } from "@acalys/contracts/domain";
import { z } from "zod";

import { MODEL_UNKNOWN_REASONS } from "./types.js";
import type { ModelProvider, ProviderOutcome } from "./types.js";

const providerOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    text: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative().optional(),
    providerRequestId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("failed"),
    retryable: z.boolean(),
    reason: z.enum(["rate_limited", "provider_rejected"]),
    detail: z.string(),
  }),
  z.object({
    kind: z.literal("unknown"),
    reason: z.enum(MODEL_UNKNOWN_REASONS),
    detail: z.string(),
  }),
]);

const cassetteDocumentSchema = z.object({
  version: z.literal(1),
  entries: z.array(
    z.object({
      version: z.literal(1),
      requestDigest: z.string().min(1),
      provider: z.enum(["openai", "anthropic"]),
      modelId: z.string().min(1),
      outcome: providerOutcomeSchema,
    }),
  ),
});

export interface CassetteEntry {
  readonly version: 1;
  readonly requestDigest: string;
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly outcome: ProviderOutcome;
}

export interface CassetteStore {
  read(requestDigest: string): Promise<CassetteEntry | undefined>;
  write(entry: CassetteEntry): Promise<void>;
}

export class MemoryCassetteStore implements CassetteStore {
  readonly #entries = new Map<string, CassetteEntry>();

  public constructor(entries: readonly CassetteEntry[] = []) {
    for (const entry of entries) this.#entries.set(entry.requestDigest, entry);
  }

  public read(requestDigest: string): Promise<CassetteEntry | undefined> {
    return Promise.resolve(this.#entries.get(requestDigest));
  }

  public write(entry: CassetteEntry): Promise<void> {
    const previous = this.#entries.get(entry.requestDigest);
    if (
      previous !== undefined &&
      canonicalJson(previous) !== canonicalJson(entry)
    ) {
      return Promise.reject(
        new Error(
          `cassette digest ${entry.requestDigest} already identifies different provider output`,
        ),
      );
    }
    this.#entries.set(entry.requestDigest, entry);
    return Promise.resolve();
  }

  public entries(): readonly CassetteEntry[] {
    return [...this.#entries.values()].sort((a, b) =>
      a.requestDigest.localeCompare(b.requestDigest),
    );
  }
}

async function sleep(millis: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, millis));
}

/**
 * Canonical JSON cassette persisted with cross-process exclusion and a durable
 * atomic replace. An abandoned lock fails closed: automatically deleting a
 * lock whose owner may still be alive can corrupt the deterministic artifact.
 */
export class JsonCassetteStore implements CassetteStore {
  readonly #path: string;
  readonly #lockTimeoutMs: number;

  public constructor(
    path: string,
    options: { readonly lockTimeoutMs?: number } = {},
  ) {
    this.#path = path;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  async #load(): Promise<Map<string, CassetteEntry>> {
    try {
      const parsed = cassetteDocumentSchema.parse(
        JSON.parse(await readFile(this.#path, "utf8")) as unknown,
      );
      return new Map(
        parsed.entries.map((entry) => [entry.requestDigest, entry]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
  }

  async #acquireLock(): Promise<Awaited<ReturnType<typeof open>>> {
    const lockPath = `${this.#path}.lock`;
    const deadline = Date.now() + this.#lockTimeoutMs;
    for (;;) {
      try {
        return await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new Error(
            `cassette lock ${lockPath} is held; refusing unsafe stale-lock removal`,
          );
        }
        await sleep(25);
      }
    }
  }

  public async read(requestDigest: string): Promise<CassetteEntry | undefined> {
    return (await this.#load()).get(requestDigest);
  }

  public async write(entry: CassetteEntry): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const lockPath = `${this.#path}.lock`;
    const lock = await this.#acquireLock();
    const temp = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      // Reload while holding the lock. A process-local cache would overwrite a
      // cassette entry another evaluator committed after this process started.
      const entries = await this.#load();
      const previous = entries.get(entry.requestDigest);
      if (
        previous !== undefined &&
        canonicalJson(previous) !== canonicalJson(entry)
      ) {
        throw new Error(
          `cassette digest ${entry.requestDigest} already identifies different provider output`,
        );
      }
      entries.set(entry.requestDigest, entry);
      const payload = `${canonicalJson({
        version: 1,
        entries: [...entries.values()].sort((a, b) =>
          a.requestDigest.localeCompare(b.requestDigest),
        ),
      })}\n`;

      const tempHandle = await open(temp, "wx", 0o600);
      try {
        await tempHandle.writeFile(payload, "utf8");
        await tempHandle.sync();
      } finally {
        await tempHandle.close();
      }
      await rename(temp, this.#path);

      // Persist the rename itself, not only the file contents.
      const directory = await open(dirname(this.#path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

export type ReplayMode = "off" | "record" | "replay";
