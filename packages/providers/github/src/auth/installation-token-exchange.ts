import { z } from "zod";

import type { AppJwtSigner } from "./jwt.js";
import {
  InstallationAuthError,
  type InstallationTokenExchange,
  type InstallationTokenRequest,
} from "./installation-token.js";

type FetchLike = typeof fetch;

const tokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
  permissions: z.record(z.string(), z.string()),
  repository_selection: z.string().optional(),
  repositories: z
    .array(
      z.object({
        id: z.number().int().positive(),
      }),
    )
    .optional(),
});

export interface GithubInstallationTokenExchangeOptions {
  readonly signer: Pick<AppJwtSigner, "sign">;
  readonly fetch?: FetchLike | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

function assertRequestedScope(
  request: InstallationTokenRequest,
  response: z.infer<typeof tokenResponseSchema>,
): void {
  if (request.repositoryIds !== undefined) {
    const actual = response.repositories?.map((repository) => repository.id);
    if (actual === undefined) {
      throw new InstallationAuthError(
        request.installationId,
        "GitHub omitted repository scope from a repository-restricted token response",
      );
    }
    const expectedSorted = [...new Set(request.repositoryIds)].sort(
      (a, b) => a - b,
    );
    const actualSorted = [...new Set(actual)].sort((a, b) => a - b);
    if (
      expectedSorted.length !== actualSorted.length ||
      expectedSorted.some((id, index) => id !== actualSorted[index])
    ) {
      throw new InstallationAuthError(
        request.installationId,
        "GitHub returned a token for a different repository scope than requested",
      );
    }
  }

  if (request.permissions !== undefined) {
    for (const [name, level] of Object.entries(request.permissions)) {
      if (response.permissions[name] !== level) {
        throw new InstallationAuthError(
          request.installationId,
          `GitHub did not grant requested permission ${name}=${level}`,
        );
      }
    }
  }
}

/**
 * Production GitHub App installation-token exchange.
 *
 * The App JWT and returned bearer token never enter error messages. Provider
 * error bodies are ignored, and repository restrictions are verified against
 * the successful response before the token is admitted to the cache.
 */
export function createGithubInstallationTokenExchange(
  options: GithubInstallationTokenExchangeOptions,
): InstallationTokenExchange {
  const requestFetch = options.fetch ?? fetch;
  const baseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
    /\/$/,
    "",
  );
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new TypeError(
      "GitHub token exchange timeout must be at least 1000ms",
    );
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError(
      "GitHub token response limit must be a positive safe integer",
    );
  }

  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const jwt = options.signer.sign();
      let response: Response;
      try {
        response = await requestFetch(
          `${baseUrl}/app/installations/${encodeURIComponent(String(request.installationId))}/access_tokens`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${jwt.token}`,
              "content-type": "application/json",
              "x-github-api-version": "2022-11-28",
            },
            body: JSON.stringify({
              ...(request.repositoryIds === undefined
                ? {}
                : { repository_ids: [...request.repositoryIds] }),
              ...(request.permissions === undefined
                ? {}
                : { permissions: request.permissions }),
            }),
            signal: controller.signal,
          },
        );
      } catch (error) {
        const reason =
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
            ? "GitHub installation-token exchange timed out"
            : "GitHub installation-token exchange transport failed";
        throw new InstallationAuthError(request.installationId, reason);
      }

      if (!response.ok) {
        throw new InstallationAuthError(
          request.installationId,
          `GitHub installation-token exchange returned status ${String(response.status)}`,
        );
      }

      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        const declared = Number(declaredLength);
        if (Number.isFinite(declared) && declared > maxResponseBytes) {
          throw new InstallationAuthError(
            request.installationId,
            "GitHub installation-token response exceeds configured byte limit",
          );
        }
      }

      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxResponseBytes) {
        throw new InstallationAuthError(
          request.installationId,
          "GitHub installation-token response exceeds configured byte limit",
        );
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        throw new InstallationAuthError(
          request.installationId,
          "GitHub installation-token response is not valid JSON",
        );
      }
      const parsed = tokenResponseSchema.safeParse(raw);
      if (!parsed.success || Number.isNaN(Date.parse(parsed.data.expires_at))) {
        throw new InstallationAuthError(
          request.installationId,
          "GitHub installation-token response has an invalid shape",
        );
      }

      assertRequestedScope(request, parsed.data);
      return {
        token: parsed.data.token,
        expiresAt: parsed.data.expires_at,
        permissions: parsed.data.permissions,
        ...(parsed.data.repository_selection === undefined
          ? {}
          : { repositorySelection: parsed.data.repository_selection }),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
