import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";

import type { AuthService } from "@acalys/auth";
import type { ApiMutationStore, ApiStore, DashboardAdminStore } from "@acalys/database";
import { createApiApp } from "../src/app.js";

const ORG = "0192f8a1-4000-7000-8000-000000000101";
const USER = "0192f8a1-4000-7000-8000-000000000201";
const SESSION = "0192f8a1-4000-7000-8000-000000000401";
const MEMBER = "0192f8a1-4000-7000-8000-000000000301";

function dashboardApp(overrides: Partial<DashboardAdminStore> = {}) {
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
    async issueSession() {
      return { id: SESSION, token: "acalys_session_test_credential_abcdefghijklmnopqrstuvwxyz", expiresAt: new Date("2026-09-10T00:00:00.000Z") };
    },
    async rotateSession() {
      return { id: SESSION, token: "acalys_session_rotated_credential_abcdefghijklmnopqrstuvwxyz", expiresAt: new Date("2026-09-10T00:00:00.000Z") };
    },
    async revokeSession() { return true; },
  } as unknown as AuthService;

  const store = {
    async getOrganization() { return { id: ORG, slug: "acme", name: "Acme" }; },
    async getSession() {
      return {
        sessionId: SESSION, userId: USER, provider: "github", providerUserId: "42",
        primaryEmail: "owner@example.test", displayName: "Owner", organizationId: ORG,
        organizationSlug: "acme", organizationName: "Acme", membershipId: MEMBER,
        role: "owner", expiresAt: new Date("2026-09-10T00:00:00.000Z"),
      };
    },
    async listMembers() { return []; },
    async updateMemberRole() { return { kind: "not_found" as const }; },
    async listApiKeys() { return []; },
    async createApiKeyAuthorized() { return "created" as const; },
    async revokeApiKeyAuthorized() { return false; },
    async listProviderConnections() { return []; },
    async redeemLoginExchange() { return undefined; },
    ...overrides,
  } as unknown as DashboardAdminStore;

  return createApiApp({
    auth,
    api: {} as ApiStore,
    mutations: {} as ApiMutationStore,
    cursorSecrets: ["phase4-dashboard-test-pagination-secret-000000000000000000"],
    consumeRate: async () => true,
    dashboard: {
      auth,
      store,
      organizationId: ORG,
      webOrigin: "https://app.acalys.test",
      cookieSecure: false,
    },
  });
}

describe("Phase 4 dashboard administration HTTP boundary", () => {
  it("marks dashboard responses no-store, including public auth configuration", async () => {
    const response = await request(dashboardApp()).get("/dashboard/v1/auth/config").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["pragma"]).toBe("no-cache");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects malformed member identifiers before persistence", async () => {
    let calls = 0;
    const app = dashboardApp({
      async updateMemberRole() { calls += 1; return { kind: "not_found" }; },
    } as Partial<DashboardAdminStore>);
    const response = await request(app)
      .patch("/dashboard/v1/members/not-a-uuid")
      .set("authorization", "Bearer acalys_session_test")
      .send({ role: "admin" })
      .expect(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(calls).toBe(0);
  });

  it("classifies malformed dashboard bodies as validation errors instead of internal failures", async () => {
    const response = await request(dashboardApp())
      .patch(`/dashboard/v1/members/${MEMBER}`)
      .set("authorization", "Bearer acalys_session_test")
      .send({ role: "superadmin" })
      .expect(400);
    expect(response.body).toEqual({ code: "VALIDATION_ERROR", message: "Dashboard request validation failed" });
  });

  it("rejects malformed API-key identifiers before revocation persistence", async () => {
    let calls = 0;
    const app = dashboardApp({
      async revokeApiKeyAuthorized() { calls += 1; return false; },
    } as Partial<DashboardAdminStore>);
    await request(app)
      .delete("/dashboard/v1/api-keys/not-a-uuid")
      .set("authorization", "Bearer acalys_session_test")
      .expect(400);
    expect(calls).toBe(0);
  });


  it("returns an invitation bearer capability once while persisting only its digest", async () => {
    let persistedHash = "";
    const app = dashboardApp({
      async createInvitationAuthorized(input) {
        persistedHash = input.inviteHash;
        return { kind: "created", invitation: {
          id: "0192f8a1-4000-7000-8000-000000000701", organizationId: ORG,
          email: "invitee@example.test", role: "member", createdBy: USER,
          createdAt: new Date("2026-09-09T10:00:00.000Z"), expiresAt: new Date("2026-09-16T10:00:00.000Z"),
        } };
      },
    } as Partial<DashboardAdminStore>);
    const response = await request(app)
      .post("/dashboard/v1/invitations")
      .set("authorization", "Bearer acalys_session_test")
      .send({ email: "invitee@example.test", role: "member" })
      .expect(201);
    expect(response.body.token).toMatch(/^acalys_invite_[A-Za-z0-9_-]{40,100}$/u);
    expect(persistedHash).toBe(createHash("sha256").update(response.body.token, "utf8").digest("hex"));
    expect(JSON.stringify(response.body.invitation)).not.toContain(response.body.token);
  });

  it("reports credential revocation counts when an administrator removes a membership", async () => {
    const app = dashboardApp({
      async removeMemberAuthorized() { return { kind: "removed", revokedSessions: 2, revokedApiKeys: 3 }; },
    } as Partial<DashboardAdminStore>);
    const response = await request(app)
      .delete(`/dashboard/v1/members/${MEMBER}`)
      .set("authorization", "Bearer acalys_session_test")
      .expect(200);
    expect(response.body).toEqual({ removed: true, revokedSessions: 2, revokedApiKeys: 3 });
  });
});
