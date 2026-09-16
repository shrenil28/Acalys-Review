import { useEffect, useMemo, useState } from "react";
import {
  conversationDtoSchema,
  findingDtoSchema,
  pageDtoSchema,
  preMergeCheckDtoSchema,
  pullRequestSummaryDtoSchema,
  reviewProgressEventSchema,
  reviewRunDtoSchema,
  reviewSummaryDtoSchema,
  type ConversationDto,
  type FindingDto,
  type PreMergeCheckDto,
  type PullRequestSummaryDto,
  type ReviewProgressEvent,
  type ReviewRunDto,
  type ReviewSummaryDto,
} from "@acalys/contracts/api/v1";

import { useRepositoryDirectory, type LiveFailure, type LiveState, type RepositoryView } from "./liveDashboard.js";
import { createApiClient, type ApiClient } from "./client.js";
import { resolveDataMode } from "./config.js";
import type { ApiResult } from "./result.js";
import { browserAuthorization, newIdempotencyKey } from "./browserSession.js";
import { SharedRequestPool } from "./sharedRequest.js";

const pullRequestPageSchema = pageDtoSchema(pullRequestSummaryDtoSchema);
const findingPageSchema = pageDtoSchema(findingDtoSchema);
const checkPageSchema = pageDtoSchema(preMergeCheckDtoSchema);
const conversationPageSchema = pageDtoSchema(conversationDtoSchema);
const reviewPool = new SharedRequestPool(15_000);

export interface LivePullRequest {
  readonly id: string;
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly number?: number | undefined;
  readonly title: string;
  readonly author: string;
  readonly state: PullRequestSummaryDto["state"];
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewArtifacts {
  readonly summary?: ReviewSummaryDto | undefined;
  readonly findings: readonly FindingDto[];
  readonly checks: readonly PreMergeCheckDto[];
  readonly conversations: readonly ConversationDto[];
}

export type ReviewOperation<T> = ApiResult<T>;

function client(baseUrl: string): ApiClient {
  return createApiClient({
    baseUrl,
    authorization: browserAuthorization,
  });
}

function cacheKey(kind: string, baseUrl: string, suffix: string): string {
  return `${kind}\u0000${baseUrl}\u0000${browserAuthorization() ?? "anonymous"}\u0000${suffix}`;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function collectPullRequests(
  api: ApiClient,
  repository: RepositoryView,
  signal: AbortSignal,
): Promise<ApiResult<readonly LivePullRequest[]>> {
  const rows: LivePullRequest[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const result = await api.get(
      `/repositories/${encodeURIComponent(repository.id)}/pull-requests?${query.toString()}`,
      pullRequestPageSchema,
      { signal },
    );
    if (result.kind !== "ok") return result;
    rows.push(
      ...result.value.items.map((pr) => ({
        id: pr.id,
        repositoryId: pr.repositoryId,
        repositoryName: repository.name,
        ...(pr.number === undefined ? {} : { number: pr.number }),
        title: pr.title,
        author: pr.authorLabel,
        state: pr.state,
        draft: pr.draft,
        labels: pr.labels,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
      })),
    );
    cursor = result.value.nextCursor;
    if (cursor === undefined) return { kind: "ok", value: rows };
  }
  return { kind: "contract", detail: "pull-request pagination exceeded the dashboard safety bound" };
}

export function useLivePullRequests(refreshToken = 0): LiveState<readonly LivePullRequest[]> {
  const repositories = useRepositoryDirectory(refreshToken);
  const [state, setState] = useState<LiveState<readonly LivePullRequest[]>>({ status: "loading" });

  useEffect(() => {
    const mode = resolveDataMode();
    if (mode.kind === "misconfigured") {
      setState({ status: "misconfigured", detail: mode.detail });
      return;
    }
    if (mode.kind === "fixtures") {
      setState({
        status: "misconfigured",
        detail: "live pull-request workflow is not used in fixture mode",
      });
      return;
    }
    if (repositories.status === "loading") {
      setState({ status: "loading" });
      return;
    }
    if (repositories.status === "misconfigured" || repositories.status === "failed") {
      setState(repositories);
      return;
    }

    const key = cacheKey(
      "pull-requests",
      mode.baseUrl,
      `${String(refreshToken)}:${repositories.value.map((repo) => repo.id).join(",")}`,
    );
    const lease = reviewPool.acquire(
      key,
      async (signal) => {
        const api = client(mode.baseUrl);
        const results = await mapWithConcurrency(
          repositories.value,
          4,
          (repo) => collectPullRequests(api, repo, signal),
        );
        const failed = results.find((result) => result.kind !== "ok");
        if (failed !== undefined) return failed;
        return {
          kind: "ok" as const,
          value: results.flatMap((result) => (result.kind === "ok" ? result.value : [])),
        };
      },
      (result) => result.kind === "ok",
    );

    let active = true;
    setState({ status: "loading" });
    void lease.promise.then((result) => {
      if (!active) return;
      setState(
        result.kind === "ok"
          ? { status: "ready", source: "api", value: result.value }
          : { status: "failed", failure: result },
      );
    }).catch((error: unknown) => {
      if (!active) return;
      setState({
        status: "failed",
        failure: {
          kind: "transport",
          detail: error instanceof Error ? error.message : "request failed",
        },
      });
    });
    return () => {
      active = false;
      lease.release();
    };
  }, [repositories, refreshToken]);

  return state;
}

export async function queueReview(
  baseUrl: string,
  pullRequest: LivePullRequest,
  idempotencyKey = newIdempotencyKey("review"),
  signal?: AbortSignal,
): Promise<ReviewOperation<ReviewRunDto>> {
  return client(baseUrl).post("/reviews", reviewRunDtoSchema, {
    body: {
      repositoryId: pullRequest.repositoryId,
      pullRequestId: pullRequest.id,
    },
    headers: { "Idempotency-Key": idempotencyKey },
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function cancelReview(
  baseUrl: string,
  reviewRunId: string,
  reason = "Cancelled from dashboard",
  idempotencyKey = newIdempotencyKey("cancel-review"),
  signal?: AbortSignal,
): Promise<ReviewOperation<ReviewRunDto>> {
  return client(baseUrl).post(`/reviews/${encodeURIComponent(reviewRunId)}/cancel`, reviewRunDtoSchema, {
    body: { reason },
    headers: { "Idempotency-Key": idempotencyKey },
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function dismissFinding(
  baseUrl: string,
  findingId: string,
  reason: string,
  idempotencyKey = newIdempotencyKey("dismiss-finding"),
  signal?: AbortSignal,
): Promise<ReviewOperation<FindingDto>> {
  return client(baseUrl).post(`/findings/${encodeURIComponent(findingId)}/dismiss`, findingDtoSchema, {
    body: { reason },
    headers: { "Idempotency-Key": idempotencyKey },
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function resolveConversation(
  baseUrl: string,
  conversationId: string,
  idempotencyKey = newIdempotencyKey("resolve-conversation"),
  signal?: AbortSignal,
): Promise<ReviewOperation<ConversationDto>> {
  return client(baseUrl).post(`/conversations/${encodeURIComponent(conversationId)}/resolve`, conversationDtoSchema, {
    headers: { "Idempotency-Key": idempotencyKey },
    ...(signal === undefined ? {} : { signal }),
  });
}

async function collectReviewFindings(api: ApiClient, reviewRunId: string, signal: AbortSignal): Promise<ApiResult<readonly FindingDto[]>> {
  const rows: FindingDto[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const result = await api.get(`/reviews/${encodeURIComponent(reviewRunId)}/findings?${query.toString()}`, findingPageSchema, { signal });
    if (result.kind !== "ok") return result;
    rows.push(...result.value.items);
    cursor = result.value.nextCursor;
    if (cursor === undefined) return { kind: "ok", value: rows };
  }
  return { kind: "contract", detail: "finding pagination exceeded the dashboard safety bound" };
}

async function collectConversations(api: ApiClient, pullRequest: LivePullRequest, signal: AbortSignal): Promise<ApiResult<readonly ConversationDto[]>> {
  const rows: ConversationDto[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const result = await api.get(`/repositories/${encodeURIComponent(pullRequest.repositoryId)}/conversations?${query.toString()}`, conversationPageSchema, { signal });
    if (result.kind !== "ok") return result;
    rows.push(...result.value.items.filter((entry) => entry.pullRequestId === pullRequest.id));
    cursor = result.value.nextCursor;
    if (cursor === undefined) return { kind: "ok", value: rows };
  }
  return { kind: "contract", detail: "conversation pagination exceeded the dashboard safety bound" };
}

export async function loadReviewRun(
  baseUrl: string,
  reviewRunId: string,
  signal?: AbortSignal,
): Promise<ApiResult<ReviewRunDto>> {
  return client(baseUrl).get(`/reviews/${encodeURIComponent(reviewRunId)}`, reviewRunDtoSchema, {
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function loadReviewArtifacts(
  baseUrl: string,
  pullRequest: LivePullRequest,
  run: ReviewRunDto,
  signal: AbortSignal,
): Promise<ApiResult<ReviewArtifacts>> {
  const api = client(baseUrl);
  const [findings, checks, conversations] = await Promise.all([
    collectReviewFindings(api, run.id, signal),
    api.get(`/reviews/${encodeURIComponent(run.id)}/pre-merge-checks`, checkPageSchema, { signal }),
    collectConversations(api, pullRequest, signal),
  ]);
  const failed = [findings, checks, conversations].find((result) => result.kind !== "ok");
  if (failed !== undefined) return failed;

  let summary: ReviewSummaryDto | undefined;
  if (run.state === "completed") {
    const result = await api.get(`/reviews/${encodeURIComponent(run.id)}/summary`, reviewSummaryDtoSchema, { signal });
    if (result.kind !== "ok") return result;
    summary = result.value;
  }

  return {
    kind: "ok",
    value: {
      ...(summary === undefined ? {} : { summary }),
      findings: findings.kind === "ok" ? findings.value : [],
      checks: checks.kind === "ok" ? checks.value.items : [],
      conversations: conversations.kind === "ok" ? conversations.value : [],
    },
  };
}

interface SseFrame {
  readonly id?: string | undefined;
  readonly event?: string | undefined;
  readonly data?: string | undefined;
}

export function parseSseBlock(block: string): SseFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    let value = separator === -1 ? "" : rawLine.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (id === undefined && event === undefined && data.length === 0) return undefined;
  return {
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
    ...(data.length === 0 ? {} : { data: data.join("\n") }),
  };
}

export interface FollowReviewOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (event: ReviewProgressEvent) => void;
  readonly onReconnect?: ((attempt: number) => void) | undefined;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export async function followReviewProgress(
  baseUrl: string,
  reviewRunId: string,
  options: FollowReviewOptions,
): Promise<ApiResult<ReviewProgressEvent>> {
  const api = client(baseUrl);
  let lastEventId: string | undefined;
  let reconnect = 0;
  let lastProgress: ReviewProgressEvent | undefined;

  while (!options.signal.aborted) {
    const opened = await api.eventStream(`/reviews/${encodeURIComponent(reviewRunId)}/events`, {
      signal: options.signal,
      ...(lastEventId === undefined ? {} : { lastEventId }),
    });
    if (opened.kind !== "ok") {
      if (opened.kind === "contract") return opened;
      if (opened.kind === "rejected" && opened.status !== 429 && opened.status < 500) return opened;
      reconnect += 1;
      options.onReconnect?.(reconnect);
      try {
        await sleep(Math.min(5_000, 250 * 2 ** Math.min(reconnect, 4)), options.signal);
      } catch {
        return { kind: "transport", detail: "event stream was cancelled" };
      }
      continue;
    }

    const reader = opened.value.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!options.signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        while (true) {
          const boundary = buffer.search(/\r?\n\r?\n/);
          if (boundary === -1) break;
          const match = buffer.slice(boundary).match(/^(?:\r?\n){2}/)?.[0] ?? "\n\n";
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + match.length);
          const frame = parseSseBlock(block);
          if (frame === undefined || frame.data === undefined) continue;
          let raw: unknown;
          try {
            raw = JSON.parse(frame.data);
          } catch {
            return { kind: "contract", detail: "review event data was not valid JSON" };
          }
          const parsed = reviewProgressEventSchema.safeParse(raw);
          if (!parsed.success || parsed.data.reviewRunId !== reviewRunId) {
            return { kind: "contract", detail: "review event did not match the progress contract" };
          }
          if (frame.id !== undefined) lastEventId = frame.id;
          lastProgress = parsed.data;
          options.onProgress(parsed.data);
          if (frame.event === "review.done") return { kind: "ok", value: parsed.data };
        }
      }
    } catch (error) {
      if (options.signal.aborted) return { kind: "transport", detail: "event stream was cancelled" };
      if (error instanceof Error && error.name === "AbortError") return { kind: "transport", detail: "event stream was cancelled" };
    } finally {
      try { await reader.cancel(); } catch { /* connection already gone */ }
    }

    if (lastProgress?.phase === "finished" || lastProgress?.phase === "errored") {
      return { kind: "ok", value: lastProgress };
    }
    reconnect += 1;
    options.onReconnect?.(reconnect);
    try {
      await sleep(Math.min(5_000, 250 * 2 ** Math.min(reconnect, 4)), options.signal);
    } catch {
      return { kind: "transport", detail: "event stream was cancelled" };
    }
  }

  return { kind: "transport", detail: "event stream was cancelled" };
}

export function useReviewRun(
  pullRequest: LivePullRequest | undefined,
  initialReviewRunId?: string  ,
): {
  readonly baseUrl?: string | undefined;
  readonly run?: ReviewRunDto | undefined;
  readonly progress?: ReviewProgressEvent | undefined;
  readonly streamReconnects: number;
  readonly operation: "idle" | "queueing" | "following" | "loading_results" | "ready";
  readonly failure?: LiveFailure | undefined;
  readonly artifacts?: ReviewArtifacts | undefined;
  readonly stale: boolean;
  readonly queue: () => void;
  readonly cancel: () => void;
  readonly refreshArtifacts: () => void;
} {
  const mode = resolveDataMode();
  const baseUrl = mode.kind === "api" ? mode.baseUrl : undefined;
  const [run, setRun] = useState<ReviewRunDto>();
  const [progress, setProgress] = useState<ReviewProgressEvent>();
  const [streamReconnects, setStreamReconnects] = useState(0);
  const [operation, setOperation] = useState<"idle" | "queueing" | "following" | "loading_results" | "ready">("idle");
  const [failure, setFailure] = useState<LiveFailure>();
  const [artifacts, setArtifacts] = useState<ReviewArtifacts>();
  const [artifactEpoch, setArtifactEpoch] = useState(0);

  useEffect(() => {
    setRun(undefined);
    setProgress(undefined);
    setStreamReconnects(0);
    setFailure(undefined);
    setArtifacts(undefined);
    setOperation("idle");
  }, [pullRequest?.id]);

  useEffect(() => {
    if (baseUrl === undefined || pullRequest === undefined || initialReviewRunId === undefined || run !== undefined) return;
    const controller = new AbortController();
    setOperation("loading_results");
    void loadReviewRun(baseUrl, initialReviewRunId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind !== "ok") {
        setFailure(result);
        setOperation("idle");
        return;
      }
      if (result.value.repositoryId !== pullRequest.repositoryId || result.value.pullRequestId !== pullRequest.id) {
        setFailure({ kind: "contract", detail: "the persisted review does not belong to the selected pull request" });
        setOperation("idle");
        return;
      }
      setFailure(undefined);
      setRun(result.value);
      setOperation(result.value.settled ? "loading_results" : "following");
    });
    return () => controller.abort();
  }, [baseUrl, initialReviewRunId, pullRequest, run]);

  useEffect(() => {
    if (baseUrl === undefined || pullRequest === undefined || run === undefined || run.settled) return;
    const controller = new AbortController();
    setOperation("following");
    void followReviewProgress(baseUrl, run.id, {
      signal: controller.signal,
      onProgress: (event) => setProgress(event),
      onReconnect: (attempt) => setStreamReconnects(attempt),
    }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind !== "ok") {
        setFailure(result);
        return;
      }
      void loadReviewRun(baseUrl, run.id, controller.signal).then((latest) => {
        if (controller.signal.aborted) return;
        if (latest.kind === "ok") {
          setRun(latest.value);
          setArtifactEpoch((value) => value + 1);
        } else setFailure(latest);
      });
    });
    return () => controller.abort();
  }, [baseUrl, pullRequest, run?.id, run?.settled]);

  useEffect(() => {
    if (baseUrl === undefined || pullRequest === undefined || run === undefined || !run.settled) return;
    const controller = new AbortController();
    setOperation("loading_results");
    void loadReviewArtifacts(baseUrl, pullRequest, run, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ok") {
        setArtifacts(result.value);
        setFailure(undefined);
        setOperation("ready");
      } else {
        setFailure(result);
        setOperation("idle");
      }
    });
    return () => controller.abort();
  }, [artifactEpoch, baseUrl, pullRequest, run]);

  const queue = () => {
    if (baseUrl === undefined || pullRequest === undefined || operation === "queueing") return;
    const key = newIdempotencyKey("review");
    setOperation("queueing");
    setFailure(undefined);
    void queueReview(baseUrl, pullRequest, key).then((result) => {
      if (result.kind === "ok") {
        setRun(result.value);
        setProgress(undefined);
        setStreamReconnects(0);
        setOperation(result.value.settled ? "loading_results" : "following");
      } else {
        setFailure(result);
        setOperation("idle");
      }
    });
  };

  const cancel = () => {
    if (baseUrl === undefined || run === undefined || run.settled) return;
    const key = newIdempotencyKey("cancel-review");
    void cancelReview(baseUrl, run.id, "Cancelled from dashboard", key).then((result) => {
      if (result.kind === "ok") {
        setRun(result.value);
        setArtifactEpoch((value) => value + 1);
      } else setFailure(result);
    });
  };

  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(run === undefined ? {} : { run }),
    ...(progress === undefined ? {} : { progress }),
    streamReconnects,
    operation,
    ...(failure === undefined ? {} : { failure }),
    ...(artifacts === undefined ? {} : { artifacts }),
    stale:
      pullRequest !== undefined && run !== undefined
        ? Date.parse(pullRequest.updatedAt) > Date.parse(run.createdAt)
        : false,
    queue,
    cancel,
    refreshArtifacts: () => setArtifactEpoch((value) => value + 1),
  };
}

export function useLivePullRequestById(
  pullRequests: readonly LivePullRequest[],
  id: string | undefined,
): LivePullRequest | undefined {
  return useMemo(() => pullRequests.find((entry) => entry.id === id), [pullRequests, id]);
}
