import { describe, expect, it, vi } from "vitest";

import { SharedRequestPool } from "../src/lib/api/sharedRequest.js";

describe("SharedRequestPool", () => {
  it("deduplicates concurrent consumers of the same live read", async () => {
    const pool = new SharedRequestPool();
    const load = vi.fn(async () => ["repo-a", "repo-b"] as const);

    const first = pool.acquire("repositories", load);
    const second = pool.acquire("repositories", load);

    await expect(first.promise).resolves.toEqual(["repo-a", "repo-b"]);
    await expect(second.promise).resolves.toEqual(["repo-a", "repo-b"]);
    expect(load).toHaveBeenCalledTimes(1);

    first.release();
    second.release();
  });

  it("aborts a pending fetch only after the last consumer releases it", async () => {
    const pool = new SharedRequestPool();
    let observedSignal: AbortSignal | undefined;
    const load = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        }),
    );

    const first = pool.acquire("knowledge", load);
    const second = pool.acquire("knowledge", load);
    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(false);

    first.release();
    expect(observedSignal?.aborted).toBe(false);

    second.release();
    expect(observedSignal?.aborted).toBe(true);
    await expect(first.promise).rejects.toThrow("aborted");
  });

  it("does not retain a settled result the caller marks non-reusable", async () => {
    const pool = new SharedRequestPool();
    type Result =
      | { readonly kind: "ok"; readonly value: string }
      | { readonly kind: "rejected"; readonly status: number };
    const load = vi.fn(async (): Promise<Result> => ({ kind: "rejected", status: 503 }));

    const first = pool.acquire("repositories", load, (value) => value.kind === "ok");
    await expect(first.promise).resolves.toMatchObject({ kind: "rejected" });
    first.release();

    const second = pool.acquire("repositories", load, (value) => value.kind === "ok");
    await expect(second.promise).resolves.toMatchObject({ kind: "rejected" });
    second.release();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reuses a settled result only inside the configured TTL", async () => {
    let now = 1_000;
    const pool = new SharedRequestPool(100, () => now);
    const load = vi.fn(async () => `value-${String(now)}`);

    const first = pool.acquire("repositories", load);
    await expect(first.promise).resolves.toBe("value-1000");
    first.release();

    now = 1_050;
    const cached = pool.acquire("repositories", load);
    await expect(cached.promise).resolves.toBe("value-1000");
    cached.release();
    expect(load).toHaveBeenCalledTimes(1);

    now = 1_101;
    const refreshed = pool.acquire("repositories", load);
    await expect(refreshed.promise).resolves.toBe("value-1101");
    refreshed.release();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
