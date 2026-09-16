import { describe, expect, it } from "vitest";
import request from "supertest";
import type { AuthService } from "@acalys/auth";
import type {
  ApiMutationStore,
  ApiStore,
  DashboardAdminStore,
  DashboardNotificationStore,
  DashboardRepositoryStore,
} from "@acalys/database";
import { createApiApp } from "../src/app.js";

const ORG = "0192f8a1-4200-7000-8000-000000000101",
  USER = "0192f8a1-4200-7000-8000-000000000201",
  MEMBER = "0192f8a1-4200-7000-8000-000000000301",
  SESSION = "0192f8a1-4200-7000-8000-000000000401",
  REPO = "0192f8a1-4200-7000-8000-000000000501",
  RUN = "0192f8a1-4200-7000-8000-000000000601";
function app(
  notificationStore: Partial<DashboardNotificationStore> = {},
  repositoryStore: Partial<DashboardRepositoryStore> = {},
) {
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
        expiresAt: new Date("2026-09-12T00:00:00Z"),
      };
    },
  } as unknown as DashboardAdminStore;
  return createApiApp({
    auth,
    api: {} as ApiStore,
    mutations: {} as ApiMutationStore,
    cursorSecrets: ["phase4-notifications-repository-test-secret-000000000000"],
    consumeRate: async () => true,
    dashboard: {
      auth,
      store,
      notificationStore: notificationStore as DashboardNotificationStore,
      repositoryStore: repositoryStore as DashboardRepositoryStore,
      organizationId: ORG,
      webOrigin: "https://app.acalys.test",
      cookieSecure: false,
    },
  });
}

describe("Phase 4 notification and repository dashboard HTTP boundary", () => {
  it("reads and revision-writes personal notification preferences using authenticated identity", async () => {
    let updateInput: unknown;
    const notifications = {
      async getForUser(org: string, user: string) {
        expect([org, user]).toEqual([ORG, USER]);
        return {
          revision: 0,
          reviewComplete: true,
          criticalFinding: true,
          weeklyDigest: false,
          productUpdates: false,
          updatedAt: null,
        };
      },
      async updateForUser(input: unknown) {
        updateInput = input;
        return {
          kind: "updated" as const,
          value: {
            revision: 1,
            reviewComplete: false,
            criticalFinding: true,
            weeklyDigest: true,
            productUpdates: false,
            updatedAt: new Date("2026-09-11T01:00:00Z"),
          },
        };
      },
    };
    await request(app(notifications))
      .get("/dashboard/v1/notifications")
      .set("authorization", "Bearer test")
      .expect(200)
      .expect((res) => expect(res.body.revision).toBe(0));
    const response = await request(app(notifications))
      .put("/dashboard/v1/notifications")
      .set("authorization", "Bearer test")
      .send({
        expectedRevision: 0,
        reviewComplete: false,
        criticalFinding: true,
        weeklyDigest: true,
        productUpdates: false,
      })
      .expect(200);
    expect(updateInput).toEqual({
      organizationId: ORG,
      userId: USER,
      expectedRevision: 0,
      reviewComplete: false,
      criticalFinding: true,
      weeklyDigest: true,
      productUpdates: false,
    });
    expect(response.body).toMatchObject({ revision: 1, weeklyDigest: true });
  });
  it("rejects malformed notification bodies before persistence", async () => {
    let calls = 0;
    await request(
      app({
        async updateForUser() {
          calls++;
          return { kind: "not_found" as const };
        },
      }),
    )
      .put("/dashboard/v1/notifications")
      .set("authorization", "Bearer test")
      .send({ expectedRevision: -1, reviewComplete: "yes" })
      .expect(400);
    expect(calls).toBe(0);
  });
  it("returns batched repository metrics and an exact repository overview", async () => {
    let metricOrg: string | undefined;
    let overviewInput: unknown;
    const repos = {
      async listMetrics(org: string) {
        metricOrg = org;
        return [
          {
            repositoryId: REPO,
            openPullRequests: 3,
            reviewsLast30Days: 8,
            publishedCommentsLast30Days: 13,
            lastReviewAt: new Date("2026-09-11T02:00:00Z"),
          },
        ];
      },
      async overview(org: string, repo: string) {
        overviewInput = [org, repo];
        return {
          repositoryId: REPO,
          metrics: {
            repositoryId: REPO,
            openPullRequests: 3,
            reviewsLast30Days: 8,
            publishedCommentsLast30Days: 13,
            lastReviewAt: new Date("2026-09-11T02:00:00Z"),
          },
          trend: [{ day: "2026-09-11", reviews: 2 }],
          recentActivity: [
            {
              reviewRunId: RUN,
              pullRequestNumber: 17,
              pullRequestTitle: "Harden auth",
              state: "completed" as const,
              trigger: "push",
              createdAt: new Date("2026-09-11T02:00:00Z"),
              completedAt: new Date("2026-09-11T02:05:00Z"),
              publishedComments: 4,
            },
          ],
        };
      },
    };
    const metrics = await request(app({}, repos))
      .get("/dashboard/v1/repositories/metrics")
      .set("authorization", "Bearer test")
      .expect(200);
    expect(metricOrg).toBe(ORG);
    expect(metrics.body.items[0]).toMatchObject({
      repositoryId: REPO,
      reviewsLast30Days: 8,
      publishedCommentsLast30Days: 13,
    });
    const overview = await request(app({}, repos))
      .get(`/dashboard/v1/repositories/${REPO}/overview`)
      .set("authorization", "Bearer test")
      .expect(200);
    expect(overviewInput).toEqual([ORG, REPO]);
    expect(overview.body.recentActivity[0]).toMatchObject({
      reviewRunId: RUN,
      publishedComments: 4,
    });
  });
  it("rejects malformed repository ids before overview storage", async () => {
    let calls = 0;
    await request(
      app(
        {},
        {
          async overview() {
            calls++;
            return undefined;
          },
        },
      ),
    )
      .get("/dashboard/v1/repositories/not-a-uuid/overview")
      .set("authorization", "Bearer test")
      .expect(400);
    expect(calls).toBe(0);
  });
});
