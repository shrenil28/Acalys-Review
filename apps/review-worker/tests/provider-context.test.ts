import { describe, expect, it } from "vitest";

import type {
  CredentialRotationOutcome,
  DashboardIntegrationKey,
  DashboardIntegrationRow,
  StoredIntegrationCredential,
} from "@acalys/database";

import {
  ReviewProviderContextResolver,
  type ProviderIntegrationStore,
  type ReviewProviderSubject,
} from "../src/provider-context.js";

const now = new Date("2026-09-11T00:00:00.000Z");
const organizationId = "11111111-1111-4111-8111-111111111111";
const repositoryId = "22222222-2222-4222-8222-222222222222";

function integration(
  key: DashboardIntegrationKey,
  config: Readonly<Record<string, unknown>>,
  credentialVersion = 3,
): DashboardIntegrationRow {
  return {
    id: key === "linear" ? "33333333-3333-4333-8333-333333333333" : "44444444-4444-4444-8444-444444444444",
    organizationId,
    key,
    status: "connected",
    revision: 4,
    credentialVersion,
    config,
    hasCredential: true,
    createdAt: now,
    updatedAt: now,
  };
}

function subject(overrides: Partial<ReviewProviderSubject> = {}): ReviewProviderSubject {
  return {
    repositoryId,
    repositoryOwner: "acalys",
    repositoryName: "review",
    headSha: "abc123",
    headRef: "feature/provider-context",
    number: 42,
    title: "Fix ENG-123 without touching OPS-9",
    description: "Implements ENG-123.",
    ...overrides,
  };
}

class FakeStore implements ProviderIntegrationStore {
  readonly credentials = new Map<DashboardIntegrationKey, StoredIntegrationCredential<object>>();
  rotations: Array<{ key: DashboardIntegrationKey; version: number; credential: object }> = [];
  rotationOutcome: CredentialRotationOutcome = {
    kind: "stale_generation",
  };
  rereadAfterRotation: StoredIntegrationCredential<object> | undefined;
  #rotated = false;

  async readCredential<TCredential extends object>(
    _organizationId: string,
    key: DashboardIntegrationKey,
  ): Promise<StoredIntegrationCredential<TCredential> | undefined> {
    if (this.#rotated && key === "linear") {
      return this.rereadAfterRotation as StoredIntegrationCredential<TCredential> | undefined;
    }
    return this.credentials.get(key) as StoredIntegrationCredential<TCredential> | undefined;
  }

  async rotateCredentialIfCurrent(input: {
    readonly organizationId: string;
    readonly key: DashboardIntegrationKey;
    readonly expectedCredentialVersion: number;
    readonly credential: object;
  }): Promise<CredentialRotationOutcome> {
    this.rotations.push({
      key: input.key,
      version: input.expectedCredentialVersion,
      credential: input.credential,
    });
    this.#rotated = true;
    return this.rotationOutcome;
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("review provider context", () => {
  it("resolves only Linear identifiers belonging to configured team keys", async () => {
    const store = new FakeStore();
    store.credentials.set("linear", {
      integration: integration("linear", { teamKeys: ["ENG"] }),
      credential: {
        accessToken: "linear-access",
        refreshToken: "linear-refresh",
        expiresAt: "2026-09-12T00:00:00.000Z",
      },
    });
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://api.linear.app/graphql");
      const body = JSON.parse(String(init?.body)) as { variables: { id: string } };
      requested.push(body.variables.id);
      return json({
        data: {
          issue: {
            id: "issue-123",
            identifier: body.variables.id,
            title: "Pinned issue",
            description: "Third-party evidence",
            state: { name: "In Progress" },
          },
        },
      });
    };

    const resolved = await new ReviewProviderContextResolver({ integrations: store, fetch: fetchImpl, now: () => now })
      .resolve({ organizationId, subject: subject() });

    expect(requested).toEqual(["ENG-123"]);
    expect(resolved.blocks).toHaveLength(1);
    expect(resolved.blocks[0]).toMatchObject({ source: "linear", status: "complete" });
    expect(resolved.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects CircleCI evidence from a stale head even when it belongs to the same branch", async () => {
    const store = new FakeStore();
    store.credentials.set("circleci", {
      integration: integration("circleci", { projectSlugs: { [repositoryId]: "gh/acalys/review" } }),
      credential: { token: "circle-token" },
    });
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return json({
        items: [{
          id: "pipeline-old",
          number: 10,
          vcs: { revision: "old-sha", review_id: "42", branch: "feature/provider-context" },
        }],
      });
    };

    const resolved = await new ReviewProviderContextResolver({ integrations: store, fetch: fetchImpl })
      .resolve({ organizationId, subject: subject() });

    expect(calls).toBe(1);
    expect(resolved.blocks).toEqual([
      expect.objectContaining({ source: "circleci", status: "incomplete" }),
    ]);
  });

  it("accepts CircleCI workflows only for the exact admitted head and review id", async () => {
    const store = new FakeStore();
    store.credentials.set("circleci", {
      integration: integration("circleci", { projectSlugs: { [repositoryId]: "gh/acalys/review" } }),
      credential: { token: "circle-token" },
    });
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/pipeline?")) {
        return json({
          items: [
            { id: "wrong-pr", vcs: { revision: "abc123", review_id: "41" } },
            { id: "right", number: 12, vcs: { revision: "abc123", review_id: "42" } },
          ],
        });
      }
      return json({ items: [{ id: "workflow-1", name: "test", status: "success" }] });
    };

    const resolved = await new ReviewProviderContextResolver({ integrations: store, fetch: fetchImpl })
      .resolve({ organizationId, subject: subject() });

    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("/pipeline/right/workflow");
    expect(resolved.blocks).toEqual([
      expect.objectContaining({
        source: "circleci",
        status: "complete",
        identity: "circleci:right:abc123:42",
      }),
    ]);
  });

  it("never writes a stale Linear refresh result after disconnect wins the credential CAS", async () => {
    const store = new FakeStore();
    store.credentials.set("linear", {
      integration: integration("linear", { teamKeys: ["ENG"] }, 7),
      credential: {
        accessToken: "expired-access",
        refreshToken: "old-refresh",
        expiresAt: "2026-09-10T23:59:00.000Z",
      },
    });
    store.rotationOutcome = { kind: "stale_generation" };
    store.rereadAfterRotation = undefined;
    let tokenCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === "https://api.linear.app/oauth/token") {
        tokenCalls += 1;
        return json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      throw new Error("issue lookup must not happen after disconnect wins");
    };

    const resolved = await new ReviewProviderContextResolver({
      integrations: store,
      fetch: fetchImpl,
      linearClientId: "linear-client",
      now: () => now,
    }).resolve({ organizationId, subject: subject() });

    expect(tokenCalls).toBe(1);
    expect(store.rotations).toHaveLength(1);
    expect(store.rotations[0]).toMatchObject({ key: "linear", version: 7 });
    expect(resolved.blocks).toEqual([]);
  });
});
