import { useEffect, useMemo, useState } from "react";
import {
  knowledgeItemDtoSchema,
  pageDtoSchema,
  repositoryDtoSchema,
} from "@acalys/contracts/api/v1";
import type { KnowledgeItemDto, RepositoryDto } from "@acalys/contracts/api/v1";

import { createApiClient } from "./client.js";
import { resolveDataMode } from "./config.js";
import type { ApiResult } from "./result.js";
import { SharedRequestPool } from "./sharedRequest.js";
import { browserAuthorization } from "./browserSession.js";
import { loadRepositoryMetrics } from "./dashboardAdmin.js";

export type LiveFailure = Exclude<ApiResult<never>, { readonly kind: "ok"; readonly value: never }>;

export type LiveState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T; readonly source: "fixtures" | "api" }
  | { readonly status: "failed"; readonly failure: LiveFailure }
  | { readonly status: "misconfigured"; readonly detail: string };

export interface RepositoryView {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly visibility: "Public" | "Private" | "Internal" | "Unknown";
  readonly defaultBranch: string;
  readonly reviewsEnabled: boolean;
  readonly updatedAt: string;
  /** Phase 13 analytics. `null` means the live API does not expose it yet. */
  readonly language: string | null;
  readonly openPrs: number | null;
  readonly reviewsLast30d: number | null;
  readonly commentsLast30d: number | null;
  readonly lastReviewAt: string | null;
  readonly security: {
    readonly deepScan: number | null;
    readonly dependencies: number | null;
    readonly secrets: number | null;
    readonly lastScanAt: string | null;
  };
}

export interface KnowledgeView {
  readonly id: string;
  readonly scope: "Organization" | "Repository" | "Path";
  readonly repositoryId?: string | undefined;
  readonly repo?: string | undefined;
  readonly path?: string | undefined;
  readonly content: string;
  readonly source: string;
  readonly authored: boolean;
  readonly createdAt?: string | undefined;
  /** Usage metrics are Phase 13; absent rather than fabricated in API mode. */
  readonly appliedCount: number | null;
  readonly author: string | null;
}

const repositoryPageSchema = pageDtoSchema(repositoryDtoSchema);
const knowledgePageSchema = pageDtoSchema(knowledgeItemDtoSchema);

function failureFrom<T>(result: ApiResult<T>): LiveFailure | undefined {
  if (result.kind === "ok") return undefined;
  return result as LiveFailure;
}


function apiClient(baseUrl: string, authorization = browserAuthorization()) {
  return createApiClient({
    baseUrl,
    authorization: () => authorization,
  });
}

const sharedRequests = new SharedRequestPool(30_000);

function liveCacheKey(kind: string, baseUrl: string, refreshToken: number = 0): string {
  return `${kind}\u0000${baseUrl}\u0000${browserAuthorization() ?? "anonymous"}\u0000${String(refreshToken)}`;
}

function visibilityLabel(value: RepositoryDto["visibility"]): RepositoryView["visibility"] {
  switch (value) {
    case "public":
      return "Public";
    case "private":
      return "Private";
    case "internal":
      return "Internal";
    case "unknown":
      return "Unknown";
  }
}

export function repositoryFromApi(repo: RepositoryDto): RepositoryView {
  return {
    id: repo.id,
    name: repo.name,
    provider: repo.provider,
    visibility: visibilityLabel(repo.visibility),
    defaultBranch: repo.defaultBranch ?? "—",
    reviewsEnabled: repo.reviewsEnabled,
    updatedAt: repo.updatedAt,
    language: null,
    openPrs: null,
    reviewsLast30d: null,
    commentsLast30d: null,
    lastReviewAt: null,
    security: {
      deepScan: null,
      dependencies: null,
      secrets: null,
      lastScanAt: null,
    },
  };
}

type RepositoryFixture = (typeof import("@/data/repos"))["repositories"][number];
type LearningFixture = (typeof import("@/data/review"))["learnings"][number];

function repositoryFromFixture(
  repo: RepositoryFixture,
  index: number,
): RepositoryView {
  return {
    id: `fixture-repository-${String(index + 1)}`,
    name: repo.name,
    provider: repo.provider,
    visibility: repo.visibility,
    defaultBranch: repo.defaultBranch,
    reviewsEnabled: repo.reviewsEnabled,
    updatedAt: repo.lastReviewAt ?? new Date(0).toISOString(),
    language: repo.language,
    openPrs: repo.openPrs,
    reviewsLast30d: repo.reviewsLast30d,
    commentsLast30d: repo.commentsLast30d,
    lastReviewAt: repo.lastReviewAt,
    security: repo.security,
  };
}

export function knowledgeFromApi(
  item: KnowledgeItemDto,
  repositories: readonly RepositoryView[],
): KnowledgeView {
  const repository =
    item.repositoryId === undefined
      ? undefined
      : repositories.find((entry) => entry.id === item.repositoryId);
  return {
    id: item.id,
    scope:
      item.scope === "organization"
        ? "Organization"
        : item.scope === "path"
          ? "Path"
          : "Repository",
    ...(item.repositoryId === undefined ? {} : { repositoryId: item.repositoryId }),
    ...(repository === undefined ? {} : { repo: repository.name }),
    ...(item.path === undefined ? {} : { path: item.path }),
    content: item.summary,
    source: item.sourceType.replaceAll("_", " "),
    authored: item.authored,
    ...(item.recordedAt === undefined ? {} : { createdAt: item.recordedAt }),
    appliedCount: null,
    author: null,
  };
}

function knowledgeFromFixture(item: LearningFixture): KnowledgeView {
  return {
    id: item.id,
    scope: item.scope,
    ...(item.repo === undefined ? {} : { repo: item.repo }),
    content: item.content,
    source: item.source,
    authored: item.source === "Manual",
    createdAt: item.createdAt,
    appliedCount: item.appliedCount,
    author: item.author,
  };
}

async function loadRepositoryFixtures(): Promise<readonly RepositoryView[]> {
  const { repositories } = await import("@/data/repos");
  return repositories.map(repositoryFromFixture);
}

async function loadKnowledgeFixtures(): Promise<readonly KnowledgeView[]> {
  const { learnings } = await import("@/data/review");
  return learnings.map(knowledgeFromFixture);
}

async function collectRepositories(
  baseUrl: string,
  signal: AbortSignal,
): Promise<ApiResult<readonly RepositoryView[]>> {
  const client = apiClient(baseUrl);
  const items: RepositoryView[] = [];
  let cursor: string | undefined;

  let finished = false;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const result = await client.get(`/repositories?${query.toString()}`, repositoryPageSchema, { signal });
    if (result.kind !== "ok") return result;
    items.push(...result.value.items.map(repositoryFromApi));
    cursor = result.value.nextCursor;
    if (cursor === undefined) { finished = true; break; }
  }
  if (!finished) return { kind: "contract", detail: "repository pagination exceeded the dashboard safety bound" };

  const metrics = await loadRepositoryMetrics(signal);
  if (metrics.kind === "misconfigured") return { kind: "contract", detail: metrics.detail };
  if (metrics.kind !== "ok") return metrics;
  const byRepository = new Map(metrics.value.items.map((item) => [item.repositoryId, item]));
  return { kind: "ok", value: items.map((repository) => {
    const metric = byRepository.get(repository.id);
    return metric === undefined ? repository : {
      ...repository,
      openPrs: metric.openPullRequests,
      reviewsLast30d: metric.reviewsLast30Days,
      commentsLast30d: metric.publishedCommentsLast30Days,
      lastReviewAt: metric.lastReviewAt,
    };
  }) };
}

async function collectKnowledge(
  baseUrl: string,
  repositories: readonly RepositoryView[],
  signal: AbortSignal,
): Promise<ApiResult<readonly KnowledgeView[]>> {
  const client = apiClient(baseUrl);
  const items: KnowledgeView[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const result = await client.get(`/knowledge?${query.toString()}`, knowledgePageSchema, {
      signal,
    });
    if (result.kind !== "ok") return result;
    items.push(...result.value.items.map((entry) => knowledgeFromApi(entry, repositories)));
    cursor = result.value.nextCursor;
    if (cursor === undefined) return { kind: "ok", value: items };
  }

  return {
    kind: "contract",
    detail: "knowledge pagination exceeded the dashboard safety bound",
  };
}

export function failureSentence(failure: LiveFailure): string {
  switch (failure.kind) {
    case "transport":
      return "Couldn’t reach Acalys. Check the connection and retry.";
    case "contract":
      return "Acalys returned data this dashboard version can’t understand.";
    case "rejected":
      switch (failure.category) {
        case "unauthorized":
          return "Your session is no longer authorized. Sign in again.";
        case "forbidden":
          return "Your account does not have access to this data.";
        case "absent":
          return "This resource no longer exists or is no longer available to you.";
        case "conflict":
          return "The resource changed while this view was loading. Refresh and try again.";
        case "throttled":
          return "Acalys is receiving too many requests for this workspace. Try again shortly.";
        case "server":
          return "Acalys could not load this data because the server failed.";
        case "other":
          return `Acalys rejected this request (${String(failure.status)}).`;
      }
  }
}

export function useRepositoryDirectory(refreshToken = 0): LiveState<readonly RepositoryView[]> {
  const [state, setState] = useState<LiveState<readonly RepositoryView[]>>({ status: "loading" });

  useEffect(() => {
    const mode = resolveDataMode();
    if (mode.kind === "misconfigured") {
      setState({ status: "misconfigured", detail: mode.detail });
      return;
    }
    if (mode.kind === "fixtures") {
      let active = true;
      setState({ status: "loading" });
      void loadRepositoryFixtures()
        .then((value) => {
          if (active) setState({ status: "ready", source: "fixtures", value });
        })
        .catch((error: unknown) => {
          if (!active) return;
          setState({
            status: "failed",
            failure: {
              kind: "transport",
              detail: error instanceof Error ? error.message : "fixture bundle failed to load",
            },
          });
        });
      return () => {
        active = false;
      };
    }

    const request = sharedRequests.acquire(
      liveCacheKey("repositories", mode.baseUrl, refreshToken),
      (signal) => collectRepositories(mode.baseUrl, signal),
      (result) => result.kind === "ok",
    );
    let active = true;
    setState({ status: "loading" });
    void request.promise
      .then((result) => {
        if (!active) return;
        const failure = failureFrom(result);
        setState(
          failure === undefined
            ? { status: "ready", source: "api", value: result.value }
            : { status: "failed", failure },
        );
      })
      .catch((error: unknown) => {
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
      request.release();
    };
  }, [refreshToken]);

  return state;
}

export function useKnowledgeDirectory(): LiveState<readonly KnowledgeView[]> {
  const repositoriesState = useRepositoryDirectory();
  const [state, setState] = useState<LiveState<readonly KnowledgeView[]>>({ status: "loading" });

  useEffect(() => {
    const mode = resolveDataMode();
    if (mode.kind === "misconfigured") {
      setState({ status: "misconfigured", detail: mode.detail });
      return;
    }
    if (mode.kind === "fixtures") {
      let active = true;
      setState({ status: "loading" });
      void loadKnowledgeFixtures()
        .then((value) => {
          if (active) setState({ status: "ready", source: "fixtures", value });
        })
        .catch((error: unknown) => {
          if (!active) return;
          setState({
            status: "failed",
            failure: {
              kind: "transport",
              detail: error instanceof Error ? error.message : "fixture bundle failed to load",
            },
          });
        });
      return () => {
        active = false;
      };
    }

    if (repositoriesState.status === "loading") {
      setState({ status: "loading" });
      return;
    }
    if (repositoriesState.status === "misconfigured") {
      setState(repositoriesState);
      return;
    }
    if (repositoriesState.status === "failed") {
      setState(repositoriesState);
      return;
    }

    const request = sharedRequests.acquire(
      liveCacheKey("knowledge", mode.baseUrl),
      (signal) => collectKnowledge(mode.baseUrl, repositoriesState.value, signal),
      (result) => result.kind === "ok",
    );
    let active = true;
    setState({ status: "loading" });
    void request.promise
      .then((result) => {
        if (!active) return;
        const failure = failureFrom(result);
        setState(
          failure === undefined
            ? { status: "ready", source: "api", value: result.value }
            : { status: "failed", failure },
        );
      })
      .catch((error: unknown) => {
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
      request.release();
    };
  }, [repositoriesState]);

  return state;
}

export function useRepositoryByName(name: string | undefined): {
  readonly directory: LiveState<readonly RepositoryView[]>;
  readonly repository: RepositoryView | undefined;
} {
  const directory = useRepositoryDirectory();
  const repository = useMemo(
    () =>
      directory.status === "ready" && name !== undefined
        ? directory.value.find((entry) => entry.name === name)
        : undefined,
    [directory, name],
  );
  return { directory, repository };
}
export function useDashboardFilterDimensions(): {
  readonly repositoryDirectory: LiveState<readonly RepositoryView[]>;
  readonly repositoryOptions: readonly string[];
  readonly usernameOptions: readonly string[];
  readonly teamOptions: readonly string[];
} {
  const repositoryDirectory = useRepositoryDirectory();
  const [demoDimensions, setDemoDimensions] = useState<{
    readonly usernameOptions: readonly string[];
    readonly teamOptions: readonly string[];
  }>({ usernameOptions: [], teamOptions: [] });

  useEffect(() => {
    if (repositoryDirectory.status !== "ready" || repositoryDirectory.source !== "fixtures") {
      setDemoDimensions({ usernameOptions: [], teamOptions: [] });
      return;
    }
    let active = true;
    void import("@/data/analytics").then(({ usernameOptions, teamOptions }) => {
      if (!active) return;
      setDemoDimensions({
        usernameOptions: usernameOptions.filter((entry) => entry !== "All"),
        teamOptions: teamOptions.filter((entry) => entry !== "All"),
      });
    });
    return () => {
      active = false;
    };
  }, [repositoryDirectory]);

  return {
    repositoryDirectory,
    repositoryOptions:
      repositoryDirectory.status === "ready"
        ? repositoryDirectory.value.map((entry) => entry.name)
        : [],
    usernameOptions: demoDimensions.usernameOptions,
    teamOptions: demoDimensions.teamOptions,
  };
}

