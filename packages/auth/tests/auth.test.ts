import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { UnauthorizedError, ValidationError } from "@acalys/contracts/domain";
import { type AuthStore } from "@acalys/database";
import {
  AuthService,
  CredentialRing,
  GithubOAuthService,
  GitlabOAuthService,
  requireScope,
  type ApiScope,
} from "../src/index.js";

const NOW = new Date("2026-09-09T00:00:00.000Z");
const ORG = "0192f8a1-0000-7000-8000-000000000101";
const USER = "0192f8a1-0000-7000-8000-000000000201";
const SESSION = "0192f8a1-0000-7000-8000-000000000301";
const KEY = "0192f8a1-0000-7000-8000-000000000401";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asStore(overrides: Record<string, unknown>): AuthStore {
  return overrides as unknown as AuthStore;
}

describe("CredentialRing", () => {
  it("keeps active and previous credentials out of ordinary serialization and inspection", () => {
    const ring = new CredentialRing(
      "active-secret-marker",
      [{ value: "previous-secret-marker", validUntil: new Date(NOW.getTime() + 60_000) }],
      () => NOW,
    );

    const observable = [String(ring), JSON.stringify(ring), inspect(ring)].join("\n");
    expect(observable).not.toContain("active-secret-marker");
    expect(observable).not.toContain("previous-secret-marker");
    expect(observable).toContain("REDACTED");
    expect(ring.verificationCandidates()).toEqual([
      "active-secret-marker",
      "previous-secret-marker",
    ]);
  });

  it("drops previous credentials immediately after their grace deadline", () => {
    const ring = new CredentialRing(
      "active",
      [
        { value: "expired", validUntil: new Date(NOW.getTime() - 1) },
        { value: "live", validUntil: new Date(NOW.getTime() + 1) },
      ],
      () => NOW,
    );
    expect(ring.verificationCandidates()).toEqual(["active", "live"]);
  });
});

describe("GithubOAuthService", () => {
  const clientSecrets = new CredentialRing("client-secret");

  it("accepts a state signed by the previous secret only inside its rotation grace window", () => {
    const old = new GithubOAuthService({
      clientId: "client",
      clientSecrets,
      stateSecrets: new CredentialRing("old-state-secret"),
      callbackUrl: "https://app.example.test/oauth/github/callback",
      appSlug: "acalys-review",
      now: () => NOW,
    });
    const { state } = old.createAuthorization({
      organizationId: ORG,
      nonce: "browser-nonce",
      returnTo: "/repositories",
    });

    const rotating = new GithubOAuthService({
      clientId: "client",
      clientSecrets,
      stateSecrets: new CredentialRing(
        "new-state-secret",
        [{ value: "old-state-secret", validUntil: new Date(NOW.getTime() + 60_000) }],
        () => NOW,
      ),
      callbackUrl: "https://app.example.test/oauth/github/callback",
      appSlug: "acalys-review",
      now: () => NOW,
    });

    expect(rotating.verifyState(state, "browser-nonce")).toMatchObject({
      organizationId: ORG,
      nonce: "browser-nonce",
      returnTo: "/repositories",
    });
    expect(rotating.installationUrl(state)).toContain("/apps/acalys-review/installations/new");
  });

  it("rejects backslash-based cross-origin return paths", () => {
    const oauth = new GithubOAuthService({
      clientId: "client",
      clientSecrets,
      stateSecrets: new CredentialRing("state-secret"),
      callbackUrl: "https://app.example.test/oauth/github/callback",
      now: () => NOW,
    });
    expect(() =>
      oauth.createAuthorization({
        organizationId: ORG,
        nonce: "browser-nonce",
        returnTo: "/\\evil.example",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an empty verification generation in the OAuth state secret ring", () => {
    expect(
      () =>
        new GithubOAuthService({
          clientId: "client",
          clientSecrets,
          stateSecrets: new CredentialRing("state-secret", [
            { value: "", validUntil: new Date(NOW.getTime() + 60_000) },
          ]),
          callbackUrl: "https://app.example.test/oauth/github/callback",
          now: () => NOW,
        }),
    ).toThrow(ValidationError);
  });

  it("rejects a state replayed into a different browser nonce", () => {
    const oauth = new GithubOAuthService({
      clientId: "client",
      clientSecrets,
      stateSecrets: new CredentialRing("state-secret"),
      callbackUrl: "https://app.example.test/oauth/github/callback",
      now: () => NOW,
    });
    const { state } = oauth.createAuthorization({
      organizationId: ORG,
      nonce: "browser-a",
      returnTo: "/",
    });
    expect(() => oauth.verifyState(state, "browser-b")).toThrow(UnauthorizedError);
  });

  it("requests email scope and returns only provider-verified GitHub emails", async () => {
    const requests: string[] = [];
    const oauth = new GithubOAuthService({
      clientId: "client",
      clientSecrets,
      stateSecrets: new CredentialRing("state-secret"),
      callbackUrl: "https://app.example.test/oauth/github/callback",
      now: () => NOW,
      fetchImpl: (async (input: URL | Request | string) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
        if (url.includes("/user/emails")) return new Response(JSON.stringify([
          { email: "Verified@Example.test", verified: true },
          { email: "unverified@example.test", verified: false },
          { email: "verified@example.test", verified: true },
        ]), { status: 200 });
        return new Response(JSON.stringify({ id: 42, login: "octocat", name: "Octo", email: "public@example.test" }), { status: 200 });
      }) as typeof fetch,
    });
    const authorization = oauth.createAuthorization({ organizationId: ORG, nonce: "browser-nonce", returnTo: "/" });
    expect(new URL(authorization.url).searchParams.get("scope")).toBe("user:email");
    const exchanged = await oauth.exchangeCode("code");
    expect(exchanged.identity.verifiedEmails).toEqual(["verified@example.test"]);
    expect(exchanged.identity.verifiedEmails).not.toContain("unverified@example.test");
    expect(requests.some((url) => url.includes("/user/emails"))).toBe(true);
  });

  it("rejects an invalid application slug instead of constructing an ambiguous installation URL", () => {
    expect(
      () =>
        new GithubOAuthService({
          clientId: "client",
          clientSecrets,
          stateSecrets: new CredentialRing("state-secret"),
          callbackUrl: "https://app.example.test/oauth/github/callback",
          appSlug: "../other-app",
          now: () => NOW,
        }),
    ).toThrow(ValidationError);
  });
});

describe("GitlabOAuthService", () => {
  it("uses read_user, browser-bound state, and only confirmed GitLab email addresses", async () => {
    const oauth = new GitlabOAuthService({
      clientId: "gitlab-client",
      clientSecrets: new CredentialRing("gitlab-secret"),
      stateSecrets: new CredentialRing("gitlab-state"),
      callbackUrl: "https://app.example.test/dashboard/v1/auth/gitlab/callback",
      now: () => NOW,
      fetchImpl: (async (input: URL | Request | string) => {
        const url = String(input);
        if (url.endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "gitlab-token" }), { status: 200 });
        if (url.endsWith("/api/v4/user/emails")) return new Response(JSON.stringify([
          { id: 1, email: "Confirmed@Example.test", confirmed_at: "2026-09-01T00:00:00Z" },
          { id: 2, email: "pending@example.test", confirmed_at: null },
        ]), { status: 200 });
        return new Response(JSON.stringify({ id: 84, username: "gitlab-user", name: "GitLab User", email: "profile@example.test" }), { status: 200 });
      }) as typeof fetch,
    });
    const authorization = oauth.createAuthorization({ organizationId: ORG, nonce: "gitlab-browser", returnTo: "/repositories" });
    const url = new URL(authorization.url);
    expect(url.origin).toBe("https://gitlab.com");
    expect(url.searchParams.get("scope")).toBe("read_user");
    expect(url.searchParams.get("gl_auth_type")).toBe("login");
    expect(oauth.verifyState(authorization.state, "gitlab-browser").organizationId).toBe(ORG);
    expect(() => oauth.verifyState(authorization.state, "other-browser")).toThrow(UnauthorizedError);
    const exchanged = await oauth.exchangeCode("code");
    expect(exchanged.identity).toMatchObject({ providerUserId: "84", username: "gitlab-user" });
    expect(exchanged.identity.verifiedEmails).toEqual(["confirmed@example.test"]);
  });
});

describe("AuthService credential boundaries", () => {
  it("persists only a one-way session hash and authenticates through the atomic store operation", async () => {
    let created:
      | {
          id: string;
          userId: string;
          organizationId: string;
          tokenHash: string;
          ttlMillis: number;
        }
      | undefined;
    let authenticatedHash: string | undefined;
    const store = asStore({
      async createSession(input: NonNullable<typeof created>) {
        created = input;
        return { createdAt: NOW, expiresAt: new Date(NOW.getTime() + input.ttlMillis) };
      },
      async authenticateSessionByHash(hash: string) {
        authenticatedHash = hash;
        return {
          sessionId: created?.id ?? SESSION,
          userId: USER,
          organizationId: ORG,
          role: "member",
          expiresAt: new Date(NOW.getTime() + 60_000),
          revokedAt: null,
          rotatedAt: null,
        };
      },
    });
    const auth = new AuthService({ store, now: () => NOW });

    const issued = await auth.issueSession(USER, ORG);
    expect(created?.tokenHash).toBe(sha256(issued.token));
    expect(JSON.stringify(created)).not.toContain(issued.token);

    const principal = await auth.authenticateSession(issued.token);
    expect(authenticatedHash).toBe(sha256(issued.token));
    expect(principal).toMatchObject({ kind: "session", userId: USER, organizationId: ORG, role: "member" });
  });

  it("does not record last-used through a separate touch after failed authentication", async () => {
    let attempts = 0;
    const store = asStore({
      async authenticateSessionByHash() {
        attempts += 1;
        return undefined;
      },
    });
    const auth = new AuthService({ store, now: () => NOW });

    await expect(auth.authenticateSession("acalys_session_missing")).rejects.toThrow(UnauthorizedError);
    expect(attempts).toBe(1);
  });

  it("stores API keys by hash, enforces the role ceiling on scopes, and exposes tenant-scoped revocation", async () => {
    let created: Record<string, unknown> | undefined;
    let revoked: readonly unknown[] | undefined;
    const store = asStore({
      async createApiKey(input: Record<string, unknown>) {
        created = input;
        return "created";
      },
      async authenticateApiKeyByHash(hash: string) {
        expect(hash).toBe(created?.["hash"]);
        return {
          apiKeyId: KEY,
          userId: null,
          organizationId: ORG,
          role: "read_only",
          scopes: ["repositories:read", "reviews:write"],
          expiresAt: null,
          revokedAt: null,
        };
      },
      async revokeApiKey(id: string, organizationId: string) {
        revoked = [id, organizationId];
        return true;
      },
    });
    const auth = new AuthService({ store, now: () => NOW });

    const issued = await auth.issueApiKey({
      organizationId: ORG,
      name: " CI key ",
      role: "member",
      scopes: ["repositories:read", "reviews:write"],
    });
    expect(created?.["hash"]).toBe(sha256(issued.token));
    expect(created?.["role"]).toBe("member");
    expect(created?.["name"]).toBe("CI key");
    expect(JSON.stringify(created)).not.toContain(issued.token);

    const principal = await auth.authenticateApiKey(issued.token);
    expect([...principal.scopes]).toEqual(["repositories:read"]);
    expect(() => requireScope(principal, "reviews:write")).toThrow();

    await expect(auth.revokeApiKey(KEY, ORG)).resolves.toBe(true);
    expect(revoked).toEqual([KEY, ORG]);
  });

  it("rejects an unknown API-key scope at runtime even when a caller bypasses TypeScript", async () => {
    const auth = new AuthService({ store: asStore({}), now: () => NOW });
    await expect(
      auth.issueApiKey({
        organizationId: ORG,
        name: "bad",
        scopes: ["root:all" as ApiScope],
      }),
    ).rejects.toThrow(ValidationError);
  });


  it("keeps credential liveness and rotation independent from the API replica clock", async () => {
    const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
    const databaseExpiry = new Date("2026-09-09T12:00:00.000Z");
    const store = asStore({
      async createSession(...args: readonly unknown[]) {
        calls.push({ method: "createSession", args });
        return { createdAt: NOW, expiresAt: databaseExpiry };
      },
      async authenticateSessionByHash(...args: readonly unknown[]) {
        calls.push({ method: "authenticateSessionByHash", args });
        return {
          sessionId: SESSION,
          userId: USER,
          organizationId: ORG,
          role: "member",
          expiresAt: databaseExpiry,
          revokedAt: null,
          rotatedAt: null,
        };
      },
      async rotateSessionByHash(...args: readonly unknown[]) {
        calls.push({ method: "rotateSessionByHash", args });
        return { expiresAt: databaseExpiry };
      },
      async revokeSession(...args: readonly unknown[]) {
        calls.push({ method: "revokeSession", args });
        return true;
      },
    });
    const wildlyFastReplicaClock = new Date("2099-01-01T00:00:00.000Z");
    const auth = new AuthService({ store, now: () => wildlyFastReplicaClock, sessionTtlMillis: 60_000 });

    const issued = await auth.issueSession(USER, ORG);
    expect(issued.expiresAt).toEqual(databaseExpiry);
    await auth.authenticateSession(issued.token);
    const rotated = await auth.rotateSession(issued.token);
    expect(rotated.expiresAt).toEqual(databaseExpiry);
    await auth.revokeSession(SESSION, ORG);

    expect(calls.find((call) => call.method === "authenticateSessionByHash")?.args).toHaveLength(1);
    expect(calls.find((call) => call.method === "rotateSessionByHash")?.args).toHaveLength(1);
    expect(calls.find((call) => call.method === "revokeSession")?.args).toEqual([SESSION, ORG]);
    expect((calls.find((call) => call.method === "createSession")?.args[0] as { ttlMillis: number }).ttlMillis).toBe(60_000);
  });

  it("lets the database reject expired or membership-less API-key issuance", async () => {
    const expiredStore = asStore({
      async createApiKey() {
        return "invalid_expiry";
      },
    });
    const auth = new AuthService({ store: expiredStore, now: () => new Date("2000-01-01T00:00:00.000Z") });
    await expect(
      auth.issueApiKey({
        organizationId: ORG,
        name: "expired",
        scopes: ["repositories:read"],
        expiresAt: new Date("2026-09-09T00:00:00.000Z"),
      }),
    ).rejects.toThrow(ValidationError);

    const noMembershipStore = asStore({
      async createApiKey() {
        return "membership_missing";
      },
    });
    const membershipAuth = new AuthService({ store: noMembershipStore, now: () => NOW });
    await expect(
      membershipAuth.issueApiKey({
        organizationId: ORG,
        userId: USER,
        name: "user key",
        scopes: ["repositories:read"],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("commits GitHub identity, membership role, and first session through one store operation", async () => {
    let commitInput: Record<string, unknown> | undefined;
    const databaseExpiry = new Date(NOW.getTime() + 60_000);
    const store = asStore({
      async establishOAuthSession(input: Record<string, unknown>) {
        commitInput = input;
        return {
          userId: USER,
          membershipId: "0192f8a1-0000-7000-8000-000000000501",
          role: "member",
          createdAt: NOW,
          expiresAt: databaseExpiry,
        };
      },
    });
    const auth = new AuthService({ store, now: () => new Date("2099-01-01T00:00:00.000Z") });

    const established = await auth.establishGithubSession({
      organizationId: ORG,
      identity: { providerUserId: "42", displayName: "Ada" },
      organizationOwner: false,
      permissions: { pull_requests: "write" },
    });

    expect(established.userId).toBe(USER);
    expect(established.role).toBe("member");
    expect(established.credential.expiresAt).toEqual(databaseExpiry);
    expect(commitInput).toMatchObject({
      organizationId: ORG,
      provider: "github",
      providerUserId: "42",
      displayName: "Ada",
      role: "member",
    });
    expect(commitInput?.["tokenHash"]).toBe(sha256(established.credential.token));
    expect(commitInput).not.toHaveProperty("now");
  });
});
