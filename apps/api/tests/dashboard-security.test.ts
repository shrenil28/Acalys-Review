import { describe, expect, it } from "vitest";
import request from "supertest";
import type { AuthService } from "@acalys/auth";
import type {
  ApiMutationStore,
  ApiStore,
  DashboardAdminStore,
  DashboardSecurityStore,
} from "@acalys/database";
import { createApiApp } from "../src/app.js";

const ORG = "0192f8a1-4000-7000-8000-000000000101";
const USER = "0192f8a1-4000-7000-8000-000000000201";
const MEMBER = "0192f8a1-4000-7000-8000-000000000301";
const SESSION = "0192f8a1-4000-7000-8000-000000000401";
const REPO_A = "0192f8a1-4000-7000-8000-000000000501";
const REPO_B = "0192f8a1-4000-7000-8000-000000000502";
const RUN = "0192f8a1-4000-7000-8000-000000000601";
const FINDING = "0192f8a1-4000-7000-8000-000000000701";

function app(securityStore: Partial<DashboardSecurityStore>) {
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
    cursorSecrets: ["phase4-security-test-pagination-secret-00000000000000"],
    consumeRate: async () => true,
    dashboard: {
      auth,
      store,
      securityStore: securityStore as DashboardSecurityStore,
      organizationId: ORG,
      webOrigin: "https://app.acalys.test",
      cookieSecure: false,
    },
  });
}

const emptySummary = {
  total: 0,
  active: 0,
  criticalHighActive: 0,
  verified: 0,
  published: 0,
  resolved: 0,
  dismissed: 0,
  stale: 0,
  superseded: 0,
  repositoriesWithFindings: 0,
};

describe("Phase 4 security findings dashboard HTTP boundary", () => {
  it("forwards repeated repository/severity/lifecycle filters inside the authenticated tenant", async () => {
    let captured: unknown;
    const response = await request(
      app({
        async snapshot(input) {
          captured = input;
          return {
            summary: {
              ...emptySummary,
              total: 1,
              active: 1,
              criticalHighActive: 1,
              published: 1,
              repositoriesWithFindings: 1,
            },
            items: [
              {
                id: FINDING,
                repositoryId: REPO_A,
                repositoryName: "api",
                reviewRunId: RUN,
                pullRequestId: null,
                pullRequestNumber: null,
                pullRequestTitle: null,
                author: null,
                pullRequestState: null,
                severity: "high",
                lifecycle: "published",
                title: "Security issue",
                explanation: "Evidence",
                path: "src/auth.ts",
                startLine: 10,
                endLine: 12,
                createdAt: new Date("2026-09-11T00:00:00.000Z"),
                updatedAt: new Date("2026-09-11T00:01:00.000Z"),
              },
            ],
          };
        },
      }),
    )
      .get("/dashboard/v1/security/findings")
      .set("authorization", "Bearer test")
      .query({
        repositoryId: [REPO_A, REPO_B],
        severity: ["critical", "high"],
        lifecycle: ["verified", "published"],
        limit: "25",
      })
      .expect(200);

    expect(captured).toEqual({
      organizationId: ORG,
      repositoryIds: [REPO_A, REPO_B],
      severities: ["critical", "high"],
      lifecycle: ["verified", "published"],
      limit: 25,
    });
    expect(response.body.items[0]).toMatchObject({
      id: FINDING,
      repositoryId: REPO_A,
      severity: "high",
      lifecycle: "published",
    });
  });

  it("rejects invalid filter enums and limits before invoking storage", async () => {
    let calls = 0;
    const securityStore = {
      async snapshot() {
        calls += 1;
        return { summary: emptySummary, items: [] };
      },
    };
    await request(app(securityStore))
      .get("/dashboard/v1/security/findings")
      .set("authorization", "Bearer test")
      .query({ severity: "unknown" })
      .expect(400);
    await request(app(securityStore))
      .get("/dashboard/v1/security/findings")
      .set("authorization", "Bearer test")
      .query({ lifecycle: "queued" })
      .expect(400);
    await request(app(securityStore))
      .get("/dashboard/v1/security/findings")
      .set("authorization", "Bearer test")
      .query({ limit: "1001" })
      .expect(400);
    expect(calls).toBe(0);
  });

  it("never accepts a caller-supplied organization id as tenant authority", async () => {
    let captured: { organizationId?: string } | undefined;
    await request(
      app({
        async snapshot(input) {
          captured = input;
          return { summary: emptySummary, items: [] };
        },
      }),
    )
      .get("/dashboard/v1/security/findings")
      .set("authorization", "Bearer test")
      .query({ organizationId: "0192f8a1-4000-7000-8000-999999999999" })
      .expect(200);
    expect(captured?.organizationId).toBe(ORG);
  });
});
