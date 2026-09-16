import { describe, expect, it } from "vitest";
import request from "supertest";
import type { AuthService } from "@acalys/auth";
import type {
  ApiMutationStore,
  ApiStore,
  DashboardAdminStore,
  ReviewAnalysisCacheStore,
} from "@acalys/database";
import { createApiApp } from "../src/app.js";

const ORG = "0192f8a1-4000-7000-8000-000000000101";
const USER = "0192f8a1-4000-7000-8000-000000000201";
const MEMBER = "0192f8a1-4000-7000-8000-000000000301";
const SESSION = "0192f8a1-4000-7000-8000-000000000401";
const REPO = "0192f8a1-4000-7000-8000-000000000501";
const CACHE = "0192f8a1-4000-7000-8000-000000000601";

function app(cacheStore: Partial<ReviewAnalysisCacheStore>) {
  const auth = {
    async authenticateBearer() {
      return {
        kind: "session",
        id: SESSION,
        userId: USER,
        organizationId: ORG,
        role: "owner",
        scopes: new Set(),
      };
    },
  } as unknown as AuthService;
  const store = {
    async getSession() {
      return {
        sessionId: SESSION,
        userId: USER,
        provider: "github",
        providerUserId: "42",
        primaryEmail: "owner@example.test",
        displayName: "Owner",
        organizationId: ORG,
        organizationSlug: "acme",
        organizationName: "Acme",
        membershipId: MEMBER,
        role: "owner",
        expiresAt: new Date("2026-09-12T00:00:00.000Z"),
      };
    },
  } as unknown as DashboardAdminStore;
  return createApiApp({
    auth,
    api: {} as ApiStore,
    mutations: {} as ApiMutationStore,
    cursorSecrets: ["phase4-cache-test-pagination-secret-000000000000000000"],
    consumeRate: async () => true,
    dashboard: {
      auth,
      store,
      cacheStore: cacheStore as ReviewAnalysisCacheStore,
      organizationId: ORG,
      webOrigin: "https://app.acalys.test",
      cookieSecure: false,
    },
  });
}

describe("Phase 4 review-cache dashboard HTTP boundary", () => {
  it("returns metadata only and never cached finding payloads", async () => {
    const response = await request(
      app({
        async listMetadata() {
          return [
            {
              id: CACHE,
              repositoryId: REPO,
              repositoryName: "acalys",
              fingerprint: "a".repeat(64),
              payloadBytes: 321,
              createdAt: new Date("2026-09-11T00:00:00Z"),
              updatedAt: new Date("2026-09-11T00:01:00Z"),
              lastUsedAt: new Date("2026-09-11T00:02:00Z"),
              expiresAt: new Date("2026-09-18T00:01:00Z"),
            },
          ];
        },
      }),
    )
      .get("/dashboard/v1/caches")
      .set("authorization", "Bearer test")
      .expect(200);
    expect(response.body.items[0]).toMatchObject({
      id: CACHE,
      repositoryId: REPO,
      repositoryName: "acalys",
      workflow: "review",
      sizeBytes: 321,
    });
    expect(JSON.stringify(response.body)).not.toContain("findings");
    expect(JSON.stringify(response.body)).not.toContain("payload");
  });

  it("validates cache ids before invoking destructive persistence", async () => {
    let calls = 0;
    await request(
      app({
        async deleteAuthorized() {
          calls += 1;
          return { kind: "deleted", count: 0 };
        },
      }),
    )
      .delete("/dashboard/v1/caches")
      .set("authorization", "Bearer test")
      .send({ ids: ["not-a-uuid"] })
      .expect(400);
    expect(calls).toBe(0);
  });

  it("forwards the live actor and selected ids to authorized physical deletion", async () => {
    let captured: unknown;
    const response = await request(
      app({
        async deleteAuthorized(input) {
          captured = input;
          return { kind: "deleted", count: 1 };
        },
      }),
    )
      .delete("/dashboard/v1/caches")
      .set("authorization", "Bearer test")
      .send({ ids: [CACHE] })
      .expect(200);
    expect(captured).toEqual({
      organizationId: ORG,
      actorUserId: USER,
      ids: [CACHE],
    });
    expect(response.body).toEqual({ deleted: 1 });
  });
});
