import { afterEach, describe, expect, it, vi } from "vitest";
import {
  followReviewProgress,
  parseSseBlock,
  queueReview,
  type LivePullRequest,
} from "../src/lib/api/reviewWorkflow.js";

const pr: LivePullRequest = {
  id: "pr-1",
  repositoryId: "repo-1",
  repositoryName: "acalys/review",
  number: 17,
  title: "Harden review streaming",
  author: "ada",
  state: "open",
  draft: false,
  labels: ["backend"],
  createdAt: "2026-09-09T06:00:00.000Z",
  updatedAt: "2026-09-09T06:00:00.000Z",
};

const run = {
  id: "run-1",
  repositoryId: "repo-1",
  pullRequestId: "pr-1",
  state: "queued",
  settled: false,
  createdAt: "2026-09-09T06:01:00.000Z",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Phase-4 review workflow", () => {
  it("parses SSE comments away and joins multi-line data", () => {
    expect(parseSseBlock(": heartbeat\nid: 7\nevent: review.progress\ndata: {\"a\":\ndata: 1}"))
      .toEqual({ id: "7", event: "review.progress", data: '{"a":\n1}' });
  });

  it("queues exactly the selected repository + pull request with one stable mutation key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(run), { status: 202, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const result = await queueReview("https://api.test", pr, "review:stable-operation");
    expect(result.kind).toBe("ok");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ repositoryId: "repo-1", pullRequestId: "pr-1" }));
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("review:stable-operation");
  });

  it("follows a terminal SSE frame and validates it against the public progress contract", async () => {
    const frame = [
      "id: 9",
      "event: review.done",
      `data: ${JSON.stringify({
        reviewRunId: "run-1",
        state: "completed",
        phase: "finished",
        progress: 1,
        findingCount: 2,
        occurredAt: "2026-09-09T06:02:00.000Z",
      })}`,
      "",
      "",
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(frame, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      ),
    );
    const controller = new AbortController();
    const seen: string[] = [];
    const result = await followReviewProgress("https://api.test", "run-1", {
      signal: controller.signal,
      onProgress: (event) => seen.push(event.state),
    });
    expect(result).toMatchObject({ kind: "ok", value: { state: "completed", findingCount: 2 } });
    expect(seen).toEqual(["completed"]);
  });


  it("fails closed on an SSE contract response instead of reconnecting forever", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not an event stream", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const result = await followReviewProgress("https://api.test", "run-1", {
      signal: new AbortController().signal,
      onProgress: () => { throw new Error("must not publish invalid progress"); },
    });
    expect(result.kind).toBe("contract");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resumes a dropped stream from the last durable event id", async () => {
    vi.useFakeTimers();
    const progress = `id: 4\nevent: review.progress\ndata: ${JSON.stringify({
      reviewRunId: "run-1",
      state: "reviewing",
      phase: "working",
      progress: 0.6,
      findingCount: 1,
      occurredAt: "2026-09-09T06:02:00.000Z",
    })}\n\n`;
    const done = `id: 5\nevent: review.done\ndata: ${JSON.stringify({
      reviewRunId: "run-1",
      state: "completed",
      phase: "finished",
      progress: 1,
      findingCount: 2,
      occurredAt: "2026-09-09T06:03:00.000Z",
    })}\n\n`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(progress, { status: 200, headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(new Response(done, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchImpl);

    const following = followReviewProgress("https://api.test", "run-1", {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await following;
    expect(result).toMatchObject({ kind: "ok", value: { state: "completed" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect((secondInit.headers as Record<string, string>)["Last-Event-ID"]).toBe("4");
    vi.useRealTimers();
  });

  it("rejects an event for another review instead of painting stale progress", async () => {
    const frame = `id: 1\nevent: review.progress\ndata: ${JSON.stringify({
      reviewRunId: "other-run",
      state: "reviewing",
      phase: "working",
      progress: 0.6,
      occurredAt: "2026-09-09T06:02:00.000Z",
    })}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(frame, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      ),
    );
    const result = await followReviewProgress("https://api.test", "run-1", {
      signal: new AbortController().signal,
      onProgress: () => { throw new Error("must not publish stale progress"); },
    });
    expect(result.kind).toBe("contract");
  });
});
