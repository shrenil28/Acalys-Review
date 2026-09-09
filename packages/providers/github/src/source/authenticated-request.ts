import {
  InstallationTokenProvider,
  withInstallationAuth,
} from "../auth/installation-token.js";
import type { GithubRepositoryRequest } from "./repository-reader.js";

type FetchLike = typeof fetch;

class GithubReadAuthenticationFailure extends Error {
  public override readonly name = "GithubReadAuthenticationFailure";
  public constructor(public readonly status: number) {
    super(`GitHub repository authentication failed (${String(status)})`);
  }
}

export interface GithubRepositoryRequestOptions {
  readonly tokens: InstallationTokenProvider;
  readonly fetch?: FetchLike | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly maxResponseBytes?: number | undefined;
}

/**
 * Native-fetch implementation for repository reads.
 *
 * Tokens are restricted to the one repository and `contents: read`. Absolute
 * URLs are refused so provider-controlled data can never turn this client into
 * a generic SSRF primitive. Provider error bodies are never returned or logged.
 */
export function createAuthenticatedGithubRepositoryRequest(
  options: GithubRepositoryRequestOptions,
): GithubRepositoryRequest {
  const requestFetch = options.fetch ?? fetch;
  const baseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError("maxResponseBytes must be a positive safe integer");
  }

  return async (input) => {
    if (!input.path.startsWith("/") || input.path.startsWith("//") || input.path.includes("://")) {
      throw new TypeError("GitHub repository request path must be an origin-relative API path");
    }

    const authenticated = await withInstallationAuth(
      options.tokens,
      {
        installationId: input.installationId,
        repositoryIds: [input.repositoryId],
        permissions: { contents: "read" },
      },
      async (token) => {
        const response = await requestFetch(`${baseUrl}${input.path}`, {
          method: "GET",
          redirect: "error",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token.token}`,
            "x-github-api-version": "2022-11-28",
          },
        });
        if (response.status === 401) {
          throw new GithubReadAuthenticationFailure(response.status);
        }
        const lengthHeader = response.headers.get("content-length");
        if (lengthHeader !== null) {
          const declared = Number(lengthHeader);
          if (Number.isFinite(declared) && declared > maxResponseBytes) {
            throw new Error("GitHub repository response exceeds configured byte limit");
          }
        }
        if (response.status !== 200) {
          return { status: response.status, body: undefined };
        }
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > maxResponseBytes) {
          throw new Error("GitHub repository response exceeds configured byte limit");
        }
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new Error("GitHub repository response is not valid JSON");
        }
        return { status: response.status, body };
      },
      (error) =>
        error instanceof GithubReadAuthenticationFailure && error.status === 401,
    );
    return authenticated.result;
  };
}
