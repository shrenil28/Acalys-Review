import { describe, expect, it } from "vitest";
import request from "supertest";
import type { AuthService } from "@acalys/auth";
import type {
  ApiMutationStore,
  ApiStore,
  DashboardAdminStore,
  DashboardAnalyticsStore,
  DashboardReportStore,
} from "@acalys/database";
import { createApiApp } from "../src/app.js";

const ORG = "0192f8a1-4000-7000-8000-000000000101";
const USER = "0192f8a1-4000-7000-8000-000000000201";
const MEMBER = "0192f8a1-4000-7000-8000-000000000301";
const SESSION = "0192f8a1-4000-7000-8000-000000000401";
const REPO = "0192f8a1-4000-7000-8000-000000000501";
const REPORT = "0192f8a1-4000-7000-8000-000000000601";
const snapshot = {
  bucketSeconds: 86400,
  summary: {
    reviews: 2,
    completed: 2,
    failed: 0,
    cancelled: 0,
    findings: 3,
    resolvedFindings: 1,
    repositories: 1,
    authors: 1,
    averageDurationSeconds: 42,
  },
  trends: [],
  severities: [],
  categories: [],
  checks: { total: 0, passed: 0, failed: 0, inconclusive: 0, skipped: 0 },
  knowledge: { total: 0, newInRange: 0, byRepository: [] },
  repositories: [],
  authors: [],
  dimensions: { usernames: ["alice"], teams: ["platform"] },
};
function app(
  options: {
    analyticsStore?: Partial<DashboardAnalyticsStore>;
    reportStore?: Partial<DashboardReportStore>;
    store?: Partial<DashboardAdminStore>;
  } = {},
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
    ...options.store,
  } as unknown as DashboardAdminStore;
  return createApiApp({
    auth,
    api: {} as ApiStore,
    mutations: {} as ApiMutationStore,
    cursorSecrets: ["phase4-analytics-report-secret-000000000000000000"],
    consumeRate: async () => true,
    dashboard: {
      auth,
      store,
      organizationId: ORG,
      webOrigin: "https://app.acalys.test",
      cookieSecure: false,
      ...(options.analyticsStore
        ? { analyticsStore: options.analyticsStore as DashboardAnalyticsStore }
        : {}),
      ...(options.reportStore
        ? { reportStore: options.reportStore as DashboardReportStore }
        : {}),
    },
  });
}

describe("Phase 4 analytics/report dashboard HTTP boundary", () => {
  it("forwards absolute instants and repeated repository/user/team filters without widening them", async () => {
    let captured: unknown;
    const response = await request(
      app({
        analyticsStore: {
          async snapshot(input) {
            captured = input;
            return snapshot;
          },
        },
      }),
    )
      .get(
        `/dashboard/v1/analytics/reviews?from=2026-09-01T00%3A00%3A00%2B05%3A30&to=2026-09-02T00%3A00%3A00%2B05%3A30&repositoryId=${REPO}&username=alice&team=platform`,
      )
      .set("authorization", "Bearer test")
      .expect(200);
    expect(captured).toMatchObject({
      organizationId: ORG,
      repositoryIds: [REPO],
      usernames: ["alice"],
      teams: ["platform"],
    });
    expect((captured as { from: Date }).from.toISOString()).toBe(
      "2026-08-31T18:30:00.000Z",
    );
    expect(response.body.summary.reviews).toBe(2);
  });
  it("rejects ranges longer than five years before analytics storage", async () => {
    let calls = 0;
    await request(
      app({
        analyticsStore: {
          async snapshot() {
            calls += 1;
            return snapshot;
          },
        },
      }),
    )
      .get(
        "/dashboard/v1/analytics/reviews?from=2020-01-01T00%3A00%3A00Z&to=2026-09-01T00%3A00%3A00Z",
      )
      .set("authorization", "Bearer test")
      .expect(400);
    expect(calls).toBe(0);
  });
  it("persists the admin-selected analytics team through the membership boundary", async () => {
    let captured: unknown;
    const response = await request(
      app({
        store: {
          async updateMemberAnalyticsTeamAuthorized(input) {
            captured = input;
            return {
              kind: "updated",
              member: {
                id: MEMBER,
                userId: USER,
                displayName: "Owner",
                primaryEmail: "owner@example.test",
                provider: "github",
                providerUserId: "42",
                role: "owner",
                analyticsTeam: "platform",
                createdAt: new Date("2026-09-01T00:00:00.000Z"),
                updatedAt: new Date("2026-09-11T00:00:00.000Z"),
              },
            };
          },
        },
      }),
    )
      .put(`/dashboard/v1/members/${MEMBER}/analytics-team`)
      .set("authorization", "Bearer test")
      .send({ team: " platform " })
      .expect(200);
    expect(captured).toEqual({
      organizationId: ORG,
      actorUserId: USER,
      memberId: MEMBER,
      team: "platform",
    });
    expect(response.body.analyticsTeam).toBe("platform");
  });
  it("keeps recurring report automation/delivery truth explicit on list responses", async () => {
    const response = await request(
      app({
        reportStore: {
          async list() {
            return [
              {
                id: REPORT,
                kind: "recurring",
                name: "Weekly",
                revision: 1,
                enabled: true,
                schedule: {
                  frequency: "week",
                  every: 1,
                  weekdays: ["Mon"],
                  monthDays: [],
                  time: "09:00",
                  timezone: "UTC",
                },
                range: { kind: "relative", days: 7 },
                parameters: { repositoryIds: [], usernames: [], teams: [] },
                prompt: "",
                groupBy: "none",
                destination: {
                  channel: "email",
                  emails: ["team@example.test"],
                },
                createdAt: "2026-09-01T00:00:00.000Z",
                updatedAt: "2026-09-01T00:00:00.000Z",
                lastGeneratedAt: null,
                lastDeliveredAt: null,
                automationStatus: "dispatcher_unavailable",
                deliveryStatus: "not_delivered",
              },
            ];
          },
        },
      }),
    )
      .get("/dashboard/v1/reports")
      .set("authorization", "Bearer test")
      .expect(200);
    expect(response.body.items[0]).toMatchObject({
      automationStatus: "dispatcher_unavailable",
      deliveryStatus: "not_delivered",
      lastDeliveredAt: null,
    });
  });
  it("forwards expected revision to manual generation and returns the immutable snapshot run", async () => {
    let captured: unknown;
    const response = await request(
      app({
        reportStore: {
          async generateAuthorized(input) {
            captured = input;
            return {
              kind: "generated",
              run: {
                id: "0192f8a1-4000-7000-8000-000000000701",
                reportId: REPORT,
                from: "2026-09-01T00:00:00.000Z",
                to: "2026-09-08T00:00:00.000Z",
                generatedAt: "2026-09-08T00:00:01.000Z",
                snapshot: {
                  range: {
                    from: "2026-09-01T00:00:00.000Z",
                    to: "2026-09-08T00:00:00.000Z",
                    bucketSeconds: 86400,
                  },
                  ...snapshot,
                },
                deliveryStatus: "not_delivered",
              },
            };
          },
        },
      }),
    )
      .post(`/dashboard/v1/reports/${REPORT}/generate`)
      .set("authorization", "Bearer test")
      .send({ expectedRevision: 3 })
      .expect(201);
    expect(captured).toEqual({
      organizationId: ORG,
      actorUserId: USER,
      reportId: REPORT,
      expectedRevision: 3,
    });
    expect(response.body.deliveryStatus).toBe("not_delivered");
  });
  it("validates report definitions before persistence", async () => {
    let calls = 0;
    await request(
      app({
        reportStore: {
          async createAuthorized() {
            calls += 1;
            throw new Error("should not run");
          },
        },
      }),
    )
      .post("/dashboard/v1/reports")
      .set("authorization", "Bearer test")
      .send({
        kind: "recurring",
        name: "Bad",
        range: { kind: "relative", days: 7 },
        parameters: { repositoryIds: [], usernames: [], teams: [] },
        prompt: "",
        groupBy: "none",
        destination: { channel: "email", emails: [] },
        schedule: {
          frequency: "week",
          every: 1,
          weekdays: [],
          monthDays: [],
          time: "09:00",
          timezone: "UTC",
        },
      })
      .expect(400);
    expect(calls).toBe(0);
  });

  it("returns a stable conflict when the organization report-definition cap is reached", async () => {
    const response = await request(
      app({
        reportStore: {
          async createAuthorized() {
            return { kind: "limit_reached" };
          },
        },
      }),
    )
      .post("/dashboard/v1/reports")
      .set("authorization", "Bearer test")
      .send({
        kind: "ondemand",
        name: "Overflow",
        range: { kind: "relative", days: 1 },
        parameters: { repositoryIds: [], usernames: [], teams: [] },
        prompt: "",
        groupBy: "none",
        destination: { channel: "email", emails: ["team@example.test"] },
        schedule: null,
      })
      .expect(409);
    expect(response.body).toMatchObject({ code: "REPORT_LIMIT_REACHED" });
  });
});
