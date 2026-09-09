import { describe, expect, it } from "vitest";

import {
  InstallationAuthError,
  createGithubInstallationTokenExchange,
} from "../src/index.js";

function response(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const signer = {
  sign: () => ({
    token: "app-jwt-secret",
    claims: { iat: 1, exp: 2, iss: "client" },
  }),
};

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("GitHub installation token exchange", () => {
  it("requests the exact repository and permission scope and normalizes the token", async () => {
    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const exchange = createGithubInstallationTokenExchange({
      signer,
      fetch: async (input, init) => {
        calls.push({ url: requestUrl(input), init });
        return response({
          token: "installation-secret",
          expires_at: "2026-09-08T15:00:00Z",
          permissions: { contents: "read", metadata: "read" },
          repository_selection: "selected",
          repositories: [{ id: 123 }],
        });
      },
    });

    const token = await exchange({
      installationId: 99,
      repositoryIds: [123],
      permissions: { contents: "read" },
    });

    expect(token).toEqual({
      token: "installation-secret",
      expiresAt: "2026-09-08T15:00:00Z",
      permissions: { contents: "read", metadata: "read" },
      repositorySelection: "selected",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/app/installations/99/access_tokens",
    );
    const requestBody = calls[0]?.init?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") {
      throw new TypeError("expected the request body to be JSON text");
    }
    expect(JSON.parse(requestBody)).toEqual({
      repository_ids: [123],
      permissions: { contents: "read" },
    });
    expect(
      (calls[0]?.init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer app-jwt-secret");
  });

  it("fails closed when GitHub returns a different repository scope", async () => {
    const exchange = createGithubInstallationTokenExchange({
      signer,
      fetch: async () =>
        response({
          token: "installation-secret",
          expires_at: "2026-09-08T15:00:00Z",
          permissions: { contents: "read" },
          repositories: [{ id: 456 }],
        }),
    });

    await expect(
      exchange({
        installationId: 99,
        repositoryIds: [123],
        permissions: { contents: "read" },
      }),
    ).rejects.toBeInstanceOf(InstallationAuthError);
  });

  it("never includes the provider error body or credentials in its surfaced error", async () => {
    const exchange = createGithubInstallationTokenExchange({
      signer,
      fetch: async () =>
        new Response("token=provider-secret and key material", { status: 500 }),
    });

    let message = "";
    try {
      await exchange({ installationId: 99 });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("status 500");
    expect(message).not.toContain("provider-secret");
    expect(message).not.toContain("app-jwt-secret");
  });
});
