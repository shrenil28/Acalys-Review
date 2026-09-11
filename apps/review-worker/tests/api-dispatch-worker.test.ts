import { describe, expect, it } from "vitest";
import type {
  ReviewDispatchClaim,
  ReviewDispatchExecutionGuard,
  ReviewDispatchStore,
} from "@acalys/database";
import { createApiDispatchWorker } from "../src/api-dispatch-worker.js";
import type { ReviewExecutionPort } from "../src/worker.js";

const CLAIM: ReviewDispatchClaim = {
  reviewRunId: "run",
  organizationId: "org",
  revisionId: "rev",
  pullRequestId: "pr",
  attempts: 1,
  claimGeneration: 7,
  claimedAt: new Date("2026-09-09T00:00:00.000Z"),
  leaseExpiresAt: new Date("2026-09-09T00:01:00.000Z"),
};

function ownedGuard(calls: string[], renew = true): ReviewDispatchExecutionGuard {
  return {
    async renew() {
      calls.push("renew");
      return renew;
    },
    async release() {
      calls.push("guard-release");
    },
  };
}

describe("API review dispatch", () => {
  it("defers peer-owned execution without treating it as a failure", async () => {
    const calls: string[] = [];
    const store = {
      async claim() {
        return [CLAIM];
      },
      async acquireExecutionGuard() {
        return { kind: "owned", guard: ownedGuard(calls) } as const;
      },
      async defer(_id: string, generation: number, delayMillis: number) {
        calls.push(`defer:${generation}:${delayMillis}`);
      },
      async complete() {
        calls.push("complete");
      },
      async release() {
        calls.push("failure-release");
      },
      async deadLetter() {
        calls.push("dead-letter");
      },
    } as unknown as ReviewDispatchStore;
    const execution = {
      async execute() {
        return { kind: "deferred", state: "verifying" } as const;
      },
    } satisfies ReviewExecutionPort;
    const worker = createApiDispatchWorker({
      store,
      reviewExecution: execution,
      pollIntervalMillis: 1,
    });

    expect(await worker.runOnce()).toBe(1);
    expect(calls).toEqual(["defer:7:1", "guard-release"]);
  });

  it("treats a live peer execution guard as coordination and never executes", async () => {
    const calls: string[] = [];
    const store = {
      async claim() {
        return [CLAIM];
      },
      async acquireExecutionGuard() {
        return { kind: "busy" } as const;
      },
    } as unknown as ReviewDispatchStore;
    const execution = {
      async execute() {
        calls.push("execute");
        return { kind: "settled", state: "completed" } as const;
      },
    } satisfies ReviewExecutionPort;

    const worker = createApiDispatchWorker({
      store,
      reviewExecution: execution,
      pollIntervalMillis: 11,
    });
    expect(await worker.runOnce()).toBe(1);
    expect(calls).toEqual([]);
  });

  it("drops a lifecycle-settled claim without entering review execution", async () => {
    const calls: string[] = [];
    const store = {
      async claim() {
        return [CLAIM];
      },
      async acquireExecutionGuard() {
        return { kind: "settled" } as const;
      },
      async complete(_id: string, generation: number) {
        calls.push(`complete:${generation}`);
      },
    } as unknown as ReviewDispatchStore;
    const execution = {
      async execute() {
        calls.push("execute");
        return { kind: "settled", state: "cancelled" } as const;
      },
    } satisfies ReviewExecutionPort;

    const worker = createApiDispatchWorker({ store, reviewExecution: execution });
    expect(await worker.runOnce()).toBe(1);
    expect(calls).toEqual(["complete:7"]);
  });

  it("does not settle after a heartbeat proves the generation is no longer current", async () => {
    const calls: string[] = [];
    const store = {
      async claim() {
        return [CLAIM];
      },
      async acquireExecutionGuard() {
        return { kind: "owned", guard: ownedGuard(calls, false) } as const;
      },
      async complete() {
        calls.push("complete");
      },
    } as unknown as ReviewDispatchStore;
    const execution = {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { kind: "settled", state: "completed" } as const;
      },
    } satisfies ReviewExecutionPort;

    const worker = createApiDispatchWorker({
      store,
      reviewExecution: execution,
      leaseMillis: 30,
    });
    expect(await worker.runOnce()).toBe(1);
    expect(calls).toContain("renew");
    expect(calls).toContain("guard-release");
    expect(calls).not.toContain("complete");
  });
});
