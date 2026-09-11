import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  API_SCOPES,
  AuthService,
  GithubOAuthService,
  GitlabOAuthService,
  type ApiScope,
  type Principal,
} from "@acalys/auth";
import {
  dashboardApiKeysResponseSchema,
  dashboardAuthConfigSchema,
  dashboardCreateApiKeyBodySchema,
  dashboardExchangeBodySchema,
  dashboardExchangeResponseSchema,
  dashboardIdSchema,
  dashboardIntegrationKeySchema,
  dashboardIntegrationMutationResponseSchema,
  dashboardIntegrationsResponseSchema,
  dashboardCircleCiConnectBodySchema,
  dashboardCircleCiSettingsBodySchema,
  dashboardLinearSettingsBodySchema,
  dashboardDisconnectIntegrationBodySchema,
  dashboardLinearAuthorizeResponseSchema,
  dashboardMcpCreateServerBodySchema,
  dashboardMcpUpdateServerBodySchema,
  dashboardMcpRemoveServerBodySchema,
  dashboardJiraChallengeBodySchema,
  dashboardJiraChallengeResponseSchema,
  dashboardJiraRedeemBodySchema,
  dashboardIssuedApiKeySchema,
  dashboardLogoutResponseSchema,
  dashboardMemberSchema,
  dashboardMembersResponseSchema,
  dashboardProviderConnectionsResponseSchema,
  dashboardRevokeApiKeyResponseSchema,
  dashboardRotateResponseSchema,
  dashboardSessionSchema,
  dashboardUpdateMemberBodySchema,
  dashboardInvitationTokenSchema,
  dashboardInvitationsResponseSchema,
  dashboardCreateInvitationBodySchema,
  dashboardIssuedInvitationSchema,
  dashboardCancelInvitationResponseSchema,
  dashboardRemoveMemberResponseSchema,
  dashboardOrganizationReviewSettingsSchema,
  dashboardUpdateOrganizationReviewSettingsBodySchema,
  dashboardRepositoryReviewSettingsSchema,
  dashboardUpdateRepositoryReviewSettingsBodySchema,
  dashboardRepositoryLifecycleBodySchema,
  DASHBOARD_REVIEW_CAPABILITIES,
  dashboardReviewCachesResponseSchema,
  dashboardDeleteReviewCachesBodySchema,
  dashboardDeleteReviewCachesResponseSchema,
  dashboardSecurityFindingsQuerySchema,
  dashboardSecurityFindingsResponseSchema,
  dashboardNotificationPreferencesSchema,
  dashboardUpdateNotificationPreferencesBodySchema,
  dashboardRepositoryMetricsResponseSchema,
  dashboardRepositoryOverviewSchema,
  dashboardAnalyticsQuerySchema,
  dashboardAnalyticsResponseSchema,
  dashboardUpdateMemberAnalyticsTeamBodySchema,
  dashboardCreateReportBodySchema,
  dashboardReportDefinitionSchema,
  dashboardReportsResponseSchema,
  dashboardDeleteReportBodySchema,
  dashboardDeleteReportResponseSchema,
  dashboardGenerateReportBodySchema,
  dashboardReportRunSchema,
} from "@acalys/contracts/dashboard/v1";
import { DashboardAdminStore, DashboardIntegrationStore, DashboardSettingsStore, ReviewAnalysisCacheStore, DashboardSecurityStore, DashboardNotificationStore, DashboardRepositoryStore, DashboardAnalyticsStore, DashboardReportStore, type DashboardIntegrationRow } from "@acalys/database";
import { CircleCiIntegrationService } from "./circleci-integration.js";
import { LinearIntegrationOAuthService } from "./linear-integration-oauth.js";
import { McpIntegrationService, type ValidatedMcpServer } from "./mcp-integration.js";
import { JiraIntegrationService } from "./jira-integration.js";

export interface DashboardRouterOptions {
  readonly auth: AuthService;
  readonly store: DashboardAdminStore;
  readonly organizationId: string;
  readonly webOrigin: string;
  readonly githubOAuth?: GithubOAuthService | undefined;
  readonly gitlabOAuth?: GitlabOAuthService | undefined;
  readonly integrationStore?: DashboardIntegrationStore | undefined;
  readonly settingsStore?: DashboardSettingsStore | undefined;
  readonly cacheStore?: ReviewAnalysisCacheStore | undefined;
  readonly securityStore?: DashboardSecurityStore | undefined;
  readonly notificationStore?: DashboardNotificationStore | undefined;
  readonly repositoryStore?: DashboardRepositoryStore | undefined;
  readonly analyticsStore?: DashboardAnalyticsStore | undefined;
  readonly reportStore?: DashboardReportStore | undefined;
  readonly linearOAuth?: LinearIntegrationOAuthService | undefined;
  readonly circleCi?: CircleCiIntegrationService | undefined;
  readonly mcp?: McpIntegrationService | undefined;
  readonly jira?: JiraIntegrationService | undefined;
  readonly cookieSecure?: boolean | undefined;
  readonly exchangeTtlMillis?: number | undefined;
  readonly invitationTtlMillis?: number | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function cookieValue(request: Request, name: string): string | undefined {
  const raw = request.header("cookie");
  if (raw === undefined) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}
function safeReturnTo(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const origin = new URL("https://acalys.invalid/");
    return new URL(value, origin).origin === origin.origin ? value : "/";
  } catch {
    return "/";
  }
}
function bearerToken(request: Request): string | undefined {
  const value = request.header("authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}
function iso(value: Date | null): string | null { return value === null ? null : value.toISOString(); }
function queryStrings(request: Request, key: string): string[] {
  const value = request.query[key];
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    if (typeof item !== "string") {
      const error = new Error("DASHBOARD_QUERY_PARAMETER_INVALID");
      error.name = "ValidationError";
      throw error;
    }
    return item;
  });
}

async function sessionPrincipal(
  auth: AuthService,
  request: Request,
  expectedOrganizationId: string,
): Promise<Principal & { readonly kind: "session"; readonly userId: string }> {
  const principal = await auth.authenticateBearer(request.header("authorization"));
  if (
    principal.kind !== "session" ||
    principal.userId === undefined ||
    principal.organizationId !== expectedOrganizationId
  ) throw new Error("DASHBOARD_SESSION_REQUIRED");
  return principal as Principal & { readonly kind: "session"; readonly userId: string };
}
function errorStatus(error: unknown): number {
  if (error instanceof Error) {
    if (error.name === "ZodError") return 400;
    if (error.message === "DASHBOARD_SESSION_REQUIRED") return 401;
    if (error.name === "UnauthorizedError") return 401;
    if (error.name === "ForbiddenError") return 403;
    if (error.name === "ValidationError") return 400;
  }
  return 500;
}
function sendFailure(response: Response, error: unknown): void {
  const status = errorStatus(error);
  response.status(status).json({
    code: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : status === 400 ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
    message: status === 500 ? "The dashboard request could not be completed" : status === 401 ? "A browser session is required" : status === 403 ? "This account cannot perform that action" : "Dashboard request validation failed",
  });
}

type McpStoredServer = ValidatedMcpServer["config"];
type McpAggregateCredential = {
  readonly servers: Readonly<Record<string, { readonly apiKey?: string | undefined; readonly headers: Readonly<Record<string, string>> }>>;
};

function storedMcpServers(integration: DashboardIntegrationRow | undefined): McpStoredServer[] {
  const raw = integration?.config["servers"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item["id"] !== "string" || typeof item["label"] !== "string" ||
      typeof item["url"] !== "string" || typeof item["guidance"] !== "string" ||
      (item["auth"] !== "none" && item["auth"] !== "api_key") ||
      !Array.isArray(item["headerNames"]) || item["headerNames"].some((name) => typeof name !== "string")
    ) return [];
    return [{
      id: item["id"], label: item["label"], url: item["url"], guidance: item["guidance"], auth: item["auth"],
      headerNames: item["headerNames"] as string[],
    }];
  });
}

function mcpCredentialWith(
  existing: McpAggregateCredential | undefined,
  serverId: string,
  secret: ValidatedMcpServer["secret"] | undefined,
): McpAggregateCredential | undefined {
  const servers = { ...(existing?.servers ?? {}) };
  delete servers[serverId];
  if (secret !== undefined) servers[serverId] = secret;
  return Object.keys(servers).length === 0 ? undefined : { servers };
}

export function createDashboardRouter(options: DashboardRouterOptions): Router {
  const router = Router();
  const exchangeTtlMillis = options.exchangeTtlMillis ?? 2 * 60_000;
  const invitationTtlMillis = options.invitationTtlMillis ?? 7 * 24 * 60 * 60_000;
  const secure = options.cookieSecure ?? true;
  const oauthNonceCookie = "acalys_oauth_nonce";
  const invitationCookie = "acalys_membership_invite";
  const githubCallbackPath = "/dashboard/v1/auth/github/callback";
  const gitlabNonceCookie = "acalys_gitlab_oauth_nonce";
  const gitlabCallbackPath = "/dashboard/v1/auth/gitlab/callback";
  const linearNonceCookie = "acalys_linear_oauth_nonce";

  // Dashboard responses can carry one-time exchange/session/API-key material.
  // Never allow browser/proxy caches to retain them.
  router.use((_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("pragma", "no-cache");
    response.setHeader("x-content-type-options", "nosniff");
    next();
  });

  router.get("/auth/config", async (_request, response) => {
    try {
      const organization = await options.store.getOrganization(options.organizationId);
      if (organization === undefined) { response.status(503).json({ code: "DASHBOARD_NOT_CONFIGURED", message: "Dashboard organization is unavailable" }); return; }
      response.json(dashboardAuthConfigSchema.parse({ organization, githubEnabled: options.githubOAuth !== undefined, gitlabEnabled: options.gitlabOAuth !== undefined }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/auth/github/start", async (request, response) => {
    try {
      if (options.githubOAuth === undefined) { response.status(503).json({ code: "GITHUB_LOGIN_NOT_CONFIGURED", message: "GitHub login is unavailable" }); return; }
      const organization = await options.store.getOrganization(options.organizationId);
      if (organization === undefined) { response.status(503).json({ code: "DASHBOARD_NOT_CONFIGURED", message: "Dashboard organization is unavailable" }); return; }
      const nonce = randomBytes(24).toString("base64url");
      const returnTo = safeReturnTo(typeof request.query["returnTo"] === "string" ? request.query["returnTo"] : "/");
      const authorization = options.githubOAuth.createAuthorization({ organizationId: organization.id, nonce, returnTo });
      const suppliedInvite = typeof request.query["invite"] === "string" ? request.query["invite"] : undefined;
      const invite = suppliedInvite === undefined ? undefined : dashboardInvitationTokenSchema.parse(suppliedInvite);
      response.cookie(oauthNonceCookie, nonce, { httpOnly: true, sameSite: "lax", secure, maxAge: 10 * 60_000, path: githubCallbackPath });
      if (invite === undefined) response.clearCookie(invitationCookie, { path: githubCallbackPath });
      else response.cookie(invitationCookie, invite, { httpOnly: true, sameSite: "lax", secure, maxAge: 10 * 60_000, path: githubCallbackPath });
      response.redirect(302, authorization.url);
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/auth/github/callback", async (request, response) => {
    const loginUrl = new URL("/login", options.webOrigin);
    try {
      if (options.githubOAuth === undefined) throw new Error("GITHUB_LOGIN_NOT_CONFIGURED");
      const state = typeof request.query["state"] === "string" ? request.query["state"] : "";
      const code = typeof request.query["code"] === "string" ? request.query["code"] : "";
      const nonce = cookieValue(request, oauthNonceCookie);
      if (nonce === undefined) throw new Error("DASHBOARD_SESSION_REQUIRED");
      const verified = options.githubOAuth.verifyState(state, nonce);
      if (verified.organizationId !== options.organizationId) throw new Error("DASHBOARD_SESSION_REQUIRED");
      const exchanged = await options.githubOAuth.exchangeCode(code);
      const exchange = `acalys_exchange_${randomBytes(32).toString("base64url")}`;
      const invite = cookieValue(request, invitationCookie);
      let provisioned = false;
      if (invite !== undefined) {
        const validInvite = dashboardInvitationTokenSchema.parse(invite);
        const redeemed = await options.store.redeemInvitationForVerifiedIdentity({
          inviteHash: sha256(validInvite),
          provider: "github",
          providerUserId: exchanged.identity.providerUserId,
          displayName: exchanged.identity.displayName ?? exchanged.identity.login,
          verifiedEmails: exchanged.identity.verifiedEmails,
          proposedUserId: randomUUID(),
          proposedMembershipId: randomUUID(),
          exchangeId: randomUUID(),
          exchangeHash: sha256(exchange),
          exchangeTtlMillis,
        });
        if (redeemed.kind !== "redeemed") {
          const codeByKind = {
            invalid: "invitation_invalid",
            email_mismatch: "invitation_email_mismatch",
            identity_conflict: "invitation_identity_conflict",
            already_member: "invitation_already_member",
          } as const;
          loginUrl.searchParams.set("error", codeByKind[redeemed.kind]);
          response.clearCookie(oauthNonceCookie, { path: githubCallbackPath });
          response.clearCookie(invitationCookie, { path: githubCallbackPath });
          response.redirect(302, loginUrl.toString());
          return;
        }
        provisioned = redeemed.identity.organizationId === options.organizationId;
      } else {
        provisioned = await options.store.createLoginExchangeForProvisionedIdentity({
          id: randomUUID(),
          organizationId: options.organizationId,
          provider: "github",
          providerUserId: exchanged.identity.providerUserId,
          exchangeHash: sha256(exchange),
          ttlMillis: exchangeTtlMillis,
        });
      }
      if (!provisioned) {
        loginUrl.searchParams.set("error", "membership_required");
        response.clearCookie(oauthNonceCookie, { path: githubCallbackPath });
        response.clearCookie(invitationCookie, { path: githubCallbackPath });
        response.redirect(302, loginUrl.toString());
        return;
      }
      const redirect = new URL(safeReturnTo(verified.returnTo), options.webOrigin);
      redirect.searchParams.set("acalys_exchange", exchange);
      response.clearCookie(oauthNonceCookie, { path: githubCallbackPath });
      response.clearCookie(invitationCookie, { path: githubCallbackPath });
      response.redirect(302, redirect.toString());
    } catch {
      loginUrl.searchParams.set("error", "oauth_failed");
      response.clearCookie(oauthNonceCookie, { path: githubCallbackPath });
      response.clearCookie(invitationCookie, { path: githubCallbackPath });
      response.redirect(302, loginUrl.toString());
    }
  });

  router.get("/auth/gitlab/start", async (request, response) => {
    try {
      if (options.gitlabOAuth === undefined) { response.status(503).json({ code: "GITLAB_LOGIN_NOT_CONFIGURED", message: "GitLab login is unavailable" }); return; }
      const organization = await options.store.getOrganization(options.organizationId);
      if (organization === undefined) { response.status(503).json({ code: "DASHBOARD_NOT_CONFIGURED", message: "Dashboard organization is unavailable" }); return; }
      const nonce = randomBytes(24).toString("base64url");
      const returnTo = safeReturnTo(typeof request.query["returnTo"] === "string" ? request.query["returnTo"] : "/");
      const authorization = options.gitlabOAuth.createAuthorization({ organizationId: organization.id, nonce, returnTo });
      const suppliedInvite = typeof request.query["invite"] === "string" ? request.query["invite"] : undefined;
      const invite = suppliedInvite === undefined ? undefined : dashboardInvitationTokenSchema.parse(suppliedInvite);
      response.cookie(gitlabNonceCookie, nonce, { httpOnly: true, sameSite: "lax", secure, maxAge: 10 * 60_000, path: gitlabCallbackPath });
      if (invite === undefined) response.clearCookie(invitationCookie, { path: gitlabCallbackPath });
      else response.cookie(invitationCookie, invite, { httpOnly: true, sameSite: "lax", secure, maxAge: 10 * 60_000, path: gitlabCallbackPath });
      response.redirect(302, authorization.url);
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/auth/gitlab/callback", async (request, response) => {
    const loginUrl = new URL("/login", options.webOrigin);
    try {
      if (options.gitlabOAuth === undefined) throw new Error("GITLAB_LOGIN_NOT_CONFIGURED");
      const state = typeof request.query["state"] === "string" ? request.query["state"] : "";
      const code = typeof request.query["code"] === "string" ? request.query["code"] : "";
      const nonce = cookieValue(request, gitlabNonceCookie);
      if (nonce === undefined) throw new Error("DASHBOARD_SESSION_REQUIRED");
      const verified = options.gitlabOAuth.verifyState(state, nonce);
      if (verified.organizationId !== options.organizationId) throw new Error("DASHBOARD_SESSION_REQUIRED");
      const exchanged = await options.gitlabOAuth.exchangeCode(code);
      const exchange = `acalys_exchange_${randomBytes(32).toString("base64url")}`;
      const invite = cookieValue(request, invitationCookie);
      let provisioned = false;
      if (invite !== undefined) {
        const validInvite = dashboardInvitationTokenSchema.parse(invite);
        const redeemed = await options.store.redeemInvitationForVerifiedIdentity({
          inviteHash: sha256(validInvite),
          provider: "gitlab",
          providerUserId: exchanged.identity.providerUserId,
          displayName: exchanged.identity.displayName ?? exchanged.identity.username,
          verifiedEmails: exchanged.identity.verifiedEmails,
          proposedUserId: randomUUID(),
          proposedMembershipId: randomUUID(),
          exchangeId: randomUUID(),
          exchangeHash: sha256(exchange),
          exchangeTtlMillis,
        });
        if (redeemed.kind !== "redeemed") {
          const codeByKind = {
            invalid: "invitation_invalid",
            email_mismatch: "invitation_email_mismatch",
            identity_conflict: "invitation_identity_conflict",
            already_member: "invitation_already_member",
          } as const;
          loginUrl.searchParams.set("error", codeByKind[redeemed.kind]);
          response.clearCookie(gitlabNonceCookie, { path: gitlabCallbackPath });
          response.clearCookie(invitationCookie, { path: gitlabCallbackPath });
          response.redirect(302, loginUrl.toString());
          return;
        }
        provisioned = redeemed.identity.organizationId === options.organizationId;
      } else {
        provisioned = await options.store.createLoginExchangeForProvisionedIdentity({
          id: randomUUID(), organizationId: options.organizationId, provider: "gitlab",
          providerUserId: exchanged.identity.providerUserId, exchangeHash: sha256(exchange), ttlMillis: exchangeTtlMillis,
        });
      }
      if (!provisioned) {
        loginUrl.searchParams.set("error", "membership_required");
        response.clearCookie(gitlabNonceCookie, { path: gitlabCallbackPath });
        response.clearCookie(invitationCookie, { path: gitlabCallbackPath });
        response.redirect(302, loginUrl.toString());
        return;
      }
      const redirect = new URL(safeReturnTo(verified.returnTo), options.webOrigin);
      redirect.searchParams.set("acalys_exchange", exchange);
      response.clearCookie(gitlabNonceCookie, { path: gitlabCallbackPath });
      response.clearCookie(invitationCookie, { path: gitlabCallbackPath });
      response.redirect(302, redirect.toString());
    } catch {
      loginUrl.searchParams.set("error", "oauth_failed");
      response.clearCookie(gitlabNonceCookie, { path: gitlabCallbackPath });
      response.clearCookie(invitationCookie, { path: gitlabCallbackPath });
      response.redirect(302, loginUrl.toString());
    }
  });

  router.post("/auth/exchange", async (request, response) => {
    try {
      const body = dashboardExchangeBodySchema.parse(request.body);
      const redeemed = await options.store.redeemLoginExchange(sha256(body.exchange));
      if (redeemed === undefined || redeemed.organizationId !== options.organizationId) { response.status(401).json({ code: "EXCHANGE_INVALID", message: "Login exchange is invalid or expired" }); return; }
      const credential = await options.auth.issueSession(redeemed.userId, redeemed.organizationId);
      if (credential.expiresAt === undefined) throw new Error("Dashboard session issuance returned no expiry");
      response.json(dashboardExchangeResponseSchema.parse({ token: credential.token, expiresAt: credential.expiresAt.toISOString() }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/session", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const row = await options.store.getSession({ sessionId: principal.id, organizationId: principal.organizationId, userId: principal.userId });
      if (row === undefined) { response.status(401).json({ code: "UNAUTHORIZED", message: "Browser session is unavailable" }); return; }
      response.json(dashboardSessionSchema.parse({
        sessionId: row.sessionId,
        user: { id: row.userId, provider: row.provider, providerUserId: row.providerUserId, displayName: row.displayName, email: row.primaryEmail },
        organization: { id: row.organizationId, slug: row.organizationSlug, name: row.organizationName },
        membershipId: row.membershipId, role: row.role, expiresAt: row.expiresAt.toISOString(),
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/session/rotate", async (request, response) => {
    try {
      await sessionPrincipal(options.auth, request, options.organizationId);
      const token = bearerToken(request);
      if (token === undefined) throw new Error("DASHBOARD_SESSION_REQUIRED");
      const replacement = await options.auth.rotateSession(token);
      response.json(dashboardRotateResponseSchema.parse({ token: replacement.token, expiresAt: replacement.expiresAt?.toISOString() }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/session/logout", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      await options.auth.revokeSession(principal.id, principal.organizationId);
      response.json(dashboardLogoutResponseSchema.parse({ revoked: true }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/notifications", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.notificationStore === undefined) { response.status(503).json({ code: "NOTIFICATIONS_NOT_CONFIGURED", message: "Notification preference storage is unavailable" }); return; }
      const value = await options.notificationStore.getForUser(principal.organizationId, principal.userId);
      if (value === undefined) { response.status(404).json({ code: "NOT_FOUND", message: "Membership not found" }); return; }
      response.json(dashboardNotificationPreferencesSchema.parse({ ...value, updatedAt: iso(value.updatedAt) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.put("/notifications", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.notificationStore === undefined) { response.status(503).json({ code: "NOTIFICATIONS_NOT_CONFIGURED", message: "Notification preference storage is unavailable" }); return; }
      const body = dashboardUpdateNotificationPreferencesBodySchema.parse(request.body);
      const outcome = await options.notificationStore.updateForUser({ organizationId: principal.organizationId, userId: principal.userId, ...body });
      if (outcome.kind === "not_found") { response.status(404).json({ code: "NOT_FOUND", message: "Membership not found" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Notification preferences changed; reload and retry" }); return; }
      response.json(dashboardNotificationPreferencesSchema.parse({ ...outcome.value, updatedAt: iso(outcome.value.updatedAt) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/members", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const rows = await options.store.listMembers(principal.organizationId);
      response.json(dashboardMembersResponseSchema.parse({ items: rows.map((row) => ({
        id: row.id, userId: row.userId, displayName: row.displayName, email: row.primaryEmail,
        provider: row.provider, providerUserId: row.providerUserId, role: row.role, analyticsTeam: row.analyticsTeam,
        createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      })) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.patch("/members/:id", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const body = dashboardUpdateMemberBodySchema.parse(request.body);
      const memberId = dashboardIdSchema.parse(request.params["id"] ?? "");
      const outcome = await options.store.updateMemberRole({ organizationId: principal.organizationId, actorUserId: principal.userId, memberId, role: body.role });
      if (outcome.kind === "not_found") { response.status(404).json({ code: "NOT_FOUND", message: "Member not found" }); return; }
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot change that role" }); return; }
      if (outcome.kind === "last_owner") { response.status(409).json({ code: "LAST_OWNER", message: "The final organization owner cannot be demoted" }); return; }
      const row = outcome.member;
      response.json(dashboardMemberSchema.parse({ id: row.id, userId: row.userId, displayName: row.displayName, email: row.primaryEmail,
        provider: row.provider, providerUserId: row.providerUserId, role: row.role, analyticsTeam: row.analyticsTeam,
        createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
    } catch (error) { sendFailure(response, error); }
  });

  router.put("/members/:id/analytics-team", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const memberId = dashboardIdSchema.parse(request.params["id"] ?? "");
      const body = dashboardUpdateMemberAnalyticsTeamBodySchema.parse(request.body);
      const outcome = await options.store.updateMemberAnalyticsTeamAuthorized({ organizationId: principal.organizationId, actorUserId: principal.userId, memberId, team: body.team });
      if (outcome.kind === "not_found") { response.status(404).json({ code: "NOT_FOUND", message: "Member not found" }); return; }
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot update analytics teams" }); return; }
      const row = outcome.member;
      response.json(dashboardMemberSchema.parse({ id: row.id, userId: row.userId, displayName: row.displayName, email: row.primaryEmail,
        provider: row.provider, providerUserId: row.providerUserId, role: row.role, analyticsTeam: row.analyticsTeam,
        createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/invitations", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (principal.role !== "owner" && principal.role !== "admin") {
        response.status(403).json({ code: "FORBIDDEN", message: "This account cannot view invitations" }); return;
      }
      const rows = await options.store.listInvitations(principal.organizationId);
      response.json(dashboardInvitationsResponseSchema.parse({ items: rows.map((row) => ({
        id: row.id, email: row.email, role: row.role, createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
      })) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/invitations", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const body = dashboardCreateInvitationBodySchema.parse(request.body);
      const token = `acalys_invite_${randomBytes(32).toString("base64url")}`;
      const outcome = await options.store.createInvitationAuthorized({
        id: randomUUID(),
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        email: body.email,
        role: body.role,
        inviteHash: sha256(token),
        ttlMillis: invitationTtlMillis,
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot issue that invitation" }); return; }
      const row = outcome.invitation;
      response.status(201).json(dashboardIssuedInvitationSchema.parse({
        token,
        invitation: { id: row.id, email: row.email, role: row.role, createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() },
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.delete("/invitations/:id", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const invitationId = dashboardIdSchema.parse(request.params["id"] ?? "");
      const outcome = await options.store.cancelInvitationAuthorized({
        organizationId: principal.organizationId, actorUserId: principal.userId, invitationId,
      });
      if (outcome.kind === "not_found") { response.status(404).json({ code: "NOT_FOUND", message: "Invitation not found" }); return; }
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot cancel that invitation" }); return; }
      response.json(dashboardCancelInvitationResponseSchema.parse({ cancelled: true }));
    } catch (error) { sendFailure(response, error); }
  });

  router.delete("/members/:id", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const memberId = dashboardIdSchema.parse(request.params["id"] ?? "");
      const outcome = await options.store.removeMemberAuthorized({
        organizationId: principal.organizationId, actorUserId: principal.userId, memberId,
      });
      if (outcome.kind === "not_found") { response.status(404).json({ code: "NOT_FOUND", message: "Member not found" }); return; }
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot remove that member" }); return; }
      if (outcome.kind === "last_owner") { response.status(409).json({ code: "LAST_OWNER", message: "The final organization owner cannot be removed" }); return; }
      response.json(dashboardRemoveMemberResponseSchema.parse({
        removed: true, revokedSessions: outcome.revokedSessions, revokedApiKeys: outcome.revokedApiKeys,
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/api-keys", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const rows = await options.store.listApiKeys({ organizationId: principal.organizationId, actorUserId: principal.userId });
      response.json(dashboardApiKeysResponseSchema.parse({ items: rows.map((row) => ({ ...row, expiresAt: iso(row.expiresAt), lastUsedAt: iso(row.lastUsedAt), createdAt: row.createdAt.toISOString() })) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/api-keys", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const body = dashboardCreateApiKeyBodySchema.parse(request.body);
      const requestedRole = body.role ?? principal.role;
      const scopes = body.scopes.filter((scope): scope is ApiScope => (API_SCOPES as readonly string[]).includes(scope));
      const id = randomUUID();
      const prefix = randomBytes(6).toString("hex");
      const token = `acalys_key_${prefix}_${randomBytes(32).toString("base64url")}`;
      const createdOutcome = await options.store.createApiKeyAuthorized({
        id,
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        ownerKind: body.ownerKind,
        prefix,
        hash: sha256(token),
        name: body.name,
        role: requestedRole,
        scopes,
        ...(body.expiresAt === undefined ? {} : { expiresAt: new Date(body.expiresAt) }),
      });
      if (createdOutcome === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot create that key" }); return; }
      if (createdOutcome === "invalid_expiry") { response.status(400).json({ code: "VALIDATION_ERROR", message: "API key expiry must be in the future" }); return; }
      const rows = await options.store.listApiKeys({ organizationId: principal.organizationId, actorUserId: principal.userId });
      const created = rows.find((row) => row.id === id);
      if (created === undefined) throw new Error("Created API key could not be projected");
      response.status(201).json(dashboardIssuedApiKeySchema.parse({ token, key: { ...created, expiresAt: iso(created.expiresAt), lastUsedAt: iso(created.lastUsedAt), createdAt: created.createdAt.toISOString() } }));
    } catch (error) { sendFailure(response, error); }
  });

  router.delete("/api-keys/:id", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const id = dashboardIdSchema.parse(request.params["id"] ?? "");
      const revoked = await options.store.revokeApiKeyAuthorized({ organizationId: principal.organizationId, actorUserId: principal.userId, apiKeyId: id });
      if (!revoked) { response.status(404).json({ code: "NOT_FOUND", message: "API key not found" }); return; }
      response.json(dashboardRevokeApiKeyResponseSchema.parse({ revoked: true }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/integrations", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.integrationStore === undefined) {
        response.status(503).json({ code: "INTEGRATIONS_NOT_CONFIGURED", message: "Integration credential storage is unavailable" });
        return;
      }
      const rows = await options.integrationStore.listIntegrations(principal.organizationId);
      response.json(dashboardIntegrationsResponseSchema.parse({
        items: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/integrations/mcp/servers", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.integrationStore === undefined || options.mcp === undefined) {
        response.status(503).json({ code: "MCP_NOT_CONFIGURED", message: "MCP integration storage is unavailable" }); return;
      }
      const body = dashboardMcpCreateServerBodySchema.parse(request.body);
      const serverId = randomUUID();
      const validated = await options.mcp.validateRegistration({ id: serverId, ...body.server });
      const current = await options.integrationStore.getIntegration(principal.organizationId, "mcp");
      const servers = storedMcpServers(current);
      if (servers.some((server) => server.url === validated.config.url)) {
        response.status(409).json({ code: "MCP_SERVER_EXISTS", message: "That MCP endpoint is already registered" }); return;
      }
      const storedCredential = current?.hasCredential
        ? await options.integrationStore.readCredential<McpAggregateCredential>(principal.organizationId, "mcp")
        : undefined;
      const credential = mcpCredentialWith(storedCredential?.credential, serverId, validated.secret);
      const outcome = await options.integrationStore.connectAuthorized({
        organizationId: principal.organizationId, actorUserId: principal.userId, key: "mcp",
        expectedRevision: body.expectedRevision, config: { servers: [...servers, validated.config] },
        ...(credential === undefined ? {} : { credential }),
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot register MCP servers" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "MCP configuration changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "MCP integration not found" }); return; }
      response.json(dashboardIntegrationMutationResponseSchema.parse({ integration: {
        ...outcome.integration, createdAt: outcome.integration.createdAt.toISOString(), updatedAt: outcome.integration.updatedAt.toISOString(),
      } }));
    } catch (error) { sendFailure(response, error); }
  });

  router.put("/integrations/mcp/servers/:serverId", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.integrationStore === undefined || options.mcp === undefined) {
        response.status(503).json({ code: "MCP_NOT_CONFIGURED", message: "MCP integration storage is unavailable" }); return;
      }
      const serverId = dashboardIdSchema.parse(request.params["serverId"] ?? "");
      const body = dashboardMcpUpdateServerBodySchema.parse(request.body);
      const current = await options.integrationStore.getIntegration(principal.organizationId, "mcp");
      if (current === undefined || current.status !== "connected") { response.status(404).json({ code: "NOT_FOUND", message: "MCP integration not found" }); return; }
      const servers = storedMcpServers(current);
      if (!servers.some((server) => server.id === serverId)) { response.status(404).json({ code: "NOT_FOUND", message: "MCP server not found" }); return; }
      const validated = await options.mcp.validateRegistration({ id: serverId, ...body.server });
      if (servers.some((server) => server.id !== serverId && server.url === validated.config.url)) {
        response.status(409).json({ code: "MCP_SERVER_EXISTS", message: "That MCP endpoint is already registered" }); return;
      }
      const storedCredential = current.hasCredential
        ? await options.integrationStore.readCredential<McpAggregateCredential>(principal.organizationId, "mcp")
        : undefined;
      const credential = mcpCredentialWith(storedCredential?.credential, serverId, validated.secret);
      const outcome = await options.integrationStore.connectAuthorized({
        organizationId: principal.organizationId, actorUserId: principal.userId, key: "mcp",
        expectedRevision: body.expectedRevision,
        config: { servers: servers.map((server) => server.id === serverId ? validated.config : server) },
        ...(credential === undefined ? {} : { credential }),
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot update MCP servers" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "MCP configuration changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "MCP integration not found" }); return; }
      response.json(dashboardIntegrationMutationResponseSchema.parse({ integration: {
        ...outcome.integration, createdAt: outcome.integration.createdAt.toISOString(), updatedAt: outcome.integration.updatedAt.toISOString(),
      } }));
    } catch (error) { sendFailure(response, error); }
  });

  router.delete("/integrations/mcp/servers/:serverId", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.integrationStore === undefined) { response.status(503).json({ code: "MCP_NOT_CONFIGURED", message: "MCP integration storage is unavailable" }); return; }
      const serverId = dashboardIdSchema.parse(request.params["serverId"] ?? "");
      const body = dashboardMcpRemoveServerBodySchema.parse(request.body);
      const current = await options.integrationStore.getIntegration(principal.organizationId, "mcp");
      if (current === undefined || current.status !== "connected") { response.status(404).json({ code: "NOT_FOUND", message: "MCP integration not found" }); return; }
      const servers = storedMcpServers(current);
      if (!servers.some((server) => server.id === serverId)) { response.status(404).json({ code: "NOT_FOUND", message: "MCP server not found" }); return; }
      const remaining = servers.filter((server) => server.id !== serverId);
      const storedCredential = current.hasCredential
        ? await options.integrationStore.readCredential<McpAggregateCredential>(principal.organizationId, "mcp")
        : undefined;
      const credential = mcpCredentialWith(storedCredential?.credential, serverId, undefined);
      const outcome = remaining.length === 0
        ? await options.integrationStore.disconnectAuthorized({
            organizationId: principal.organizationId, actorUserId: principal.userId, key: "mcp",
            expectedRevision: body.expectedRevision, config: { servers: [] },
          })
        : await options.integrationStore.connectAuthorized({
            organizationId: principal.organizationId, actorUserId: principal.userId, key: "mcp",
            expectedRevision: body.expectedRevision, config: { servers: remaining },
            ...(credential === undefined ? {} : { credential }),
          });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot remove MCP servers" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "MCP configuration changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "MCP integration not found" }); return; }
      response.json(dashboardIntegrationMutationResponseSchema.parse({ integration: {
        ...outcome.integration, createdAt: outcome.integration.createdAt.toISOString(), updatedAt: outcome.integration.updatedAt.toISOString(),
      } }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/integrations/jira/challenge", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.integrationStore === undefined || options.jira === undefined) {
        response.status(503).json({ code: "JIRA_NOT_CONFIGURED", message: "Jira integration storage is unavailable" }); return;
      }
      const body = dashboardJiraChallengeBodySchema.parse(request.body);
      const secret = `acl_jira_${randomBytes(32).toString("base64url")}`;
      const outcome = await options.integrationStore.createJiraInstallationChallengeAuthorized({
        organizationId: principal.organizationId, actorUserId: principal.userId,
        expectedRevision: body.expectedRevision, secret, ttlMillis: 15 * 60_000,
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot install Jira" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Jira integration changed; reload and retry" }); return; }
      response.json(dashboardJiraChallengeResponseSchema.parse({ secret, expiresAt: outcome.expiresAt.toISOString() }));
    } catch (error) { sendFailure(response, error); }
  });

  // Server-to-server redemption. The random show-once challenge is the
  // capability; no dashboard bearer token is accepted or required here.
  router.post("/integrations/jira/redeem", async (request, response) => {
    try {
      if (options.integrationStore === undefined || options.jira === undefined) {
        response.status(503).json({ code: "JIRA_NOT_CONFIGURED", message: "Jira integration storage is unavailable" }); return;
      }
      const body = dashboardJiraRedeemBodySchema.parse(request.body);
      const installation = options.jira.validateInstallation(body);
      const outcome = await options.integrationStore.redeemJiraInstallationChallenge({
        secret: body.secret, config: installation.config, credential: installation.credential,
      });
      if (outcome.kind !== "updated") {
        response.status(409).json({ code: "JIRA_INSTALLATION_REJECTED", message: "The Jira installation capability is invalid, expired, superseded, or no longer authorized" }); return;
      }
      response.json(dashboardIntegrationMutationResponseSchema.parse({ integration: {
        ...outcome.integration, createdAt: outcome.integration.createdAt.toISOString(), updatedAt: outcome.integration.updatedAt.toISOString(),
      } }));
    } catch (error) { sendFailure(response, error); }
  });

  router.put("/integrations/circleci", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.integrationStore === undefined || options.circleCi === undefined) {
        response.status(503).json({ code: "CIRCLECI_NOT_CONFIGURED", message: "CircleCI integration is unavailable" });
        return;
      }
      const body = dashboardCircleCiConnectBodySchema.parse(request.body);
      const identity = await options.circleCi.verifyToken(body.token);
      const outcome = await options.integrationStore.connectAuthorized({
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        key: "circleci",
        expectedRevision: body.expectedRevision,
        config: {
          projectSlugs: body.projectSlugs,
          verifiedIdentity: identity,
        },
        credential: { token: body.token },
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot connect CircleCI" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "CircleCI integration changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "CircleCI integration not found" }); return; }
      response.json(dashboardIntegrationMutationResponseSchema.parse({ integration: {
        ...outcome.integration,
        createdAt: outcome.integration.createdAt.toISOString(),
        updatedAt: outcome.integration.updatedAt.toISOString(),
      } }));
    } catch (error) { sendFailure(response, error); }
  });

  router.patch("/integrations/circleci", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.integrationStore === undefined) { response.status(503).json({ code: "INTEGRATIONS_NOT_CONFIGURED", message: "Integration credential storage is unavailable" }); return; }
      const body = dashboardCircleCiSettingsBodySchema.parse(request.body);
      const current = await options.integrationStore.getIntegration(principal.organizationId, "circleci");
      if (current === undefined) { response.status(404).json({ code: "NOT_FOUND", message: "CircleCI integration not found" }); return; }
      const outcome = await options.integrationStore.updateConfigAuthorized({
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        key: "circleci",
        expectedRevision: body.expectedRevision,
        config: { ...current.config, projectSlugs: body.projectSlugs },
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot update CircleCI" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "CircleCI integration changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "CircleCI integration not found" }); return; }
      response.json(dashboardIntegrationMutationResponseSchema.parse({ integration: {
        ...outcome.integration,
        createdAt: outcome.integration.createdAt.toISOString(),
        updatedAt: outcome.integration.updatedAt.toISOString(),
      } }));
    } catch (error) { sendFailure(response, error); }
  });

  router.patch("/integrations/linear", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.integrationStore === undefined) { response.status(503).json({ code: "INTEGRATIONS_NOT_CONFIGURED", message: "Integration credential storage is unavailable" }); return; }
      const body = dashboardLinearSettingsBodySchema.parse(request.body);
      const current = await options.integrationStore.getIntegration(principal.organizationId, "linear");
      if (current === undefined) { response.status(404).json({ code: "NOT_FOUND", message: "Linear integration not found" }); return; }
      const outcome = await options.integrationStore.updateConfigAuthorized({
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        key: "linear",
        expectedRevision: body.expectedRevision,
        config: { ...current.config, teamKeys: body.teamKeys },
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot update Linear" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Linear integration changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "Linear integration not found" }); return; }
      response.json(dashboardIntegrationMutationResponseSchema.parse({ integration: {
        ...outcome.integration,
        createdAt: outcome.integration.createdAt.toISOString(),
        updatedAt: outcome.integration.updatedAt.toISOString(),
      } }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/integrations/:key/disconnect", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.integrationStore === undefined) { response.status(503).json({ code: "INTEGRATIONS_NOT_CONFIGURED", message: "Integration credential storage is unavailable" }); return; }
      const key = dashboardIntegrationKeySchema.parse(request.params["key"] ?? "");
      const body = dashboardDisconnectIntegrationBodySchema.parse(request.body);
      const outcome = await options.integrationStore.disconnectAuthorized({
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        key,
        expectedRevision: body.expectedRevision,
        ...(key === "mcp" ? { config: { servers: [] } } : {}),
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot disconnect that integration" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Integration changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "Integration not found" }); return; }
      response.json(dashboardIntegrationMutationResponseSchema.parse({ integration: {
        ...outcome.integration,
        createdAt: outcome.integration.createdAt.toISOString(),
        updatedAt: outcome.integration.updatedAt.toISOString(),
      } }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/integrations/linear/authorize", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.linearOAuth === undefined) { response.status(503).json({ code: "LINEAR_NOT_CONFIGURED", message: "Linear OAuth is unavailable" }); return; }
      const browserNonce = randomBytes(24).toString("base64url");
      const authorization = await options.linearOAuth.createAuthorization({
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        browserNonce,
      });
      response.cookie(linearNonceCookie, browserNonce, {
        httpOnly: true,
        sameSite: "lax",
        secure,
        maxAge: 10 * 60_000,
        path: "/dashboard/v1/integrations/linear/callback",
      });
      response.json(dashboardLinearAuthorizeResponseSchema.parse({ url: authorization.url }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/integrations/linear/callback", async (request, response) => {
    const redirect = new URL("/integrations", options.webOrigin);
    try {
      if (options.linearOAuth === undefined) throw new Error("LINEAR_NOT_CONFIGURED");
      const state = typeof request.query["state"] === "string" ? request.query["state"] : "";
      const code = typeof request.query["code"] === "string" ? request.query["code"] : "";
      const browserNonce = cookieValue(request, linearNonceCookie);
      if (browserNonce === undefined) throw new Error("DASHBOARD_SESSION_REQUIRED");
      await options.linearOAuth.exchangeAndConnect({
        organizationId: options.organizationId,
        state,
        code,
        browserNonce,
      });
      redirect.searchParams.set("linear", "connected");
    } catch {
      redirect.searchParams.set("linear", "failed");
    }
    response.clearCookie(linearNonceCookie, { path: "/dashboard/v1/integrations/linear/callback" });
    response.redirect(302, redirect.toString());
  });


  router.get("/settings/review", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.settingsStore === undefined) { response.status(503).json({ code: "SETTINGS_NOT_CONFIGURED", message: "Review settings storage is unavailable" }); return; }
      const value = await options.settingsStore.getOrganizationSettings(principal.organizationId);
      response.json(dashboardOrganizationReviewSettingsSchema.parse({
        revision: value.revision,
        config: value.config,
        capabilities: DASHBOARD_REVIEW_CAPABILITIES,
        updatedAt: iso(value.updatedAt),
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.put("/settings/review", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.settingsStore === undefined) { response.status(503).json({ code: "SETTINGS_NOT_CONFIGURED", message: "Review settings storage is unavailable" }); return; }
      const body = dashboardUpdateOrganizationReviewSettingsBodySchema.parse(request.body);
      const outcome = await options.settingsStore.updateOrganizationSettingsAuthorized({
        organizationId: principal.organizationId, actorUserId: principal.userId,
        expectedRevision: body.expectedRevision, config: body.config,
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot update organization review settings" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Organization review settings changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "Organization not found" }); return; }
      response.json(dashboardOrganizationReviewSettingsSchema.parse({
        revision: outcome.value.revision, config: outcome.value.config,
        capabilities: DASHBOARD_REVIEW_CAPABILITIES, updatedAt: iso(outcome.value.updatedAt),
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/repositories/:id/settings", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.settingsStore === undefined) { response.status(503).json({ code: "SETTINGS_NOT_CONFIGURED", message: "Review settings storage is unavailable" }); return; }
      const repositoryId = dashboardIdSchema.parse(request.params["id"] ?? "");
      const value = await options.settingsStore.getRepositorySettings(principal.organizationId, repositoryId);
      if (value === undefined) { response.status(404).json({ code: "NOT_FOUND", message: "Repository not found" }); return; }
      response.json(dashboardRepositoryReviewSettingsSchema.parse({ ...value, capabilities: DASHBOARD_REVIEW_CAPABILITIES, updatedAt: iso(value.updatedAt) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.put("/repositories/:id/settings", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.settingsStore === undefined) { response.status(503).json({ code: "SETTINGS_NOT_CONFIGURED", message: "Review settings storage is unavailable" }); return; }
      const repositoryId = dashboardIdSchema.parse(request.params["id"] ?? "");
      const body = dashboardUpdateRepositoryReviewSettingsBodySchema.parse(request.body);
      const outcome = await options.settingsStore.updateRepositorySettingsAuthorized({
        organizationId: principal.organizationId, repositoryId, actorUserId: principal.userId,
        expectedRevision: body.expectedRevision, inherit: body.inherit,
        instructions: body.instructions, ignorePaths: body.ignorePaths,
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot update repository review settings" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Repository review settings changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "Repository not found" }); return; }
      response.json(dashboardRepositoryReviewSettingsSchema.parse({ ...outcome.value, capabilities: DASHBOARD_REVIEW_CAPABILITIES, updatedAt: iso(outcome.value.updatedAt) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.put("/repositories/:id/reviews", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.settingsStore === undefined) { response.status(503).json({ code: "SETTINGS_NOT_CONFIGURED", message: "Review settings storage is unavailable" }); return; }
      const repositoryId = dashboardIdSchema.parse(request.params["id"] ?? "");
      const body = dashboardRepositoryLifecycleBodySchema.parse(request.body);
      const outcome = await options.settingsStore.updateRepositoryLifecycleAuthorized({
        organizationId: principal.organizationId, repositoryId, actorUserId: principal.userId,
        expectedRevision: body.expectedRevision, lifecycle: body.lifecycle,
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot change repository review lifecycle" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Repository review settings changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "Repository not found" }); return; }
      response.json(dashboardRepositoryReviewSettingsSchema.parse({ ...outcome.value, capabilities: DASHBOARD_REVIEW_CAPABILITIES, updatedAt: iso(outcome.value.updatedAt) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.delete("/repositories/:id", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.settingsStore === undefined) { response.status(503).json({ code: "SETTINGS_NOT_CONFIGURED", message: "Review settings storage is unavailable" }); return; }
      const repositoryId = dashboardIdSchema.parse(request.params["id"] ?? "");
      const rawRevision = request.header("if-match-revision");
      const expectedRevision = rawRevision === undefined ? Number.NaN : Number(rawRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) { response.status(400).json({ code: "VALIDATION_ERROR", message: "If-Match-Revision must be a non-negative integer" }); return; }
      const outcome = await options.settingsStore.updateRepositoryLifecycleAuthorized({
        organizationId: principal.organizationId, repositoryId, actorUserId: principal.userId,
        expectedRevision, lifecycle: "archived",
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot archive repositories" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Repository review settings changed; reload and retry" }); return; }
      if (outcome.kind !== "updated") { response.status(404).json({ code: "NOT_FOUND", message: "Repository not found" }); return; }
      response.json(dashboardRepositoryReviewSettingsSchema.parse({ ...outcome.value, capabilities: DASHBOARD_REVIEW_CAPABILITIES, updatedAt: iso(outcome.value.updatedAt) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/repositories/metrics", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.repositoryStore === undefined) { response.status(503).json({ code: "REPOSITORY_METRICS_NOT_CONFIGURED", message: "Repository metrics storage is unavailable" }); return; }
      const rows = await options.repositoryStore.listMetrics(principal.organizationId);
      response.json(dashboardRepositoryMetricsResponseSchema.parse({ items: rows.map((row) => ({ ...row, lastReviewAt: iso(row.lastReviewAt) })) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/repositories/:id/overview", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.repositoryStore === undefined) { response.status(503).json({ code: "REPOSITORY_METRICS_NOT_CONFIGURED", message: "Repository metrics storage is unavailable" }); return; }
      const repositoryId = dashboardIdSchema.parse(request.params["id"] ?? "");
      const value = await options.repositoryStore.overview(principal.organizationId, repositoryId);
      if (value === undefined) { response.status(404).json({ code: "NOT_FOUND", message: "Repository not found" }); return; }
      response.json(dashboardRepositoryOverviewSchema.parse({
        ...value, metrics: { ...value.metrics, lastReviewAt: iso(value.metrics.lastReviewAt) },
        recentActivity: value.recentActivity.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), completedAt: iso(row.completedAt) })),
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/analytics/reviews", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.analyticsStore === undefined) { response.status(503).json({ code: "ANALYTICS_NOT_CONFIGURED", message: "Analytics storage is unavailable" }); return; }
      const query = dashboardAnalyticsQuerySchema.parse({
        from: typeof request.query["from"] === "string" ? request.query["from"] : "",
        to: typeof request.query["to"] === "string" ? request.query["to"] : "",
        repositoryIds: queryStrings(request, "repositoryId"),
        usernames: queryStrings(request, "username"),
        teams: queryStrings(request, "team"),
      });
      const from = new Date(query.from); const to = new Date(query.to);
      const span = to.getTime() - from.getTime();
      if (!(span > 0) || span > 5 * 366 * 24 * 60 * 60_000) { const error = new Error("DASHBOARD_ANALYTICS_RANGE_INVALID"); error.name = "ValidationError"; throw error; }
      const snapshot = await options.analyticsStore.snapshot({ organizationId: principal.organizationId, from, to, repositoryIds: query.repositoryIds, usernames: query.usernames, teams: query.teams });
      response.json(dashboardAnalyticsResponseSchema.parse({
        range: { from: from.toISOString(), to: to.toISOString(), bucketSeconds: snapshot.bucketSeconds },
        summary: snapshot.summary, trends: snapshot.trends.map((item) => ({ ...item, start: item.start.toISOString() })),
        severities: snapshot.severities, categories: snapshot.categories, checks: snapshot.checks, knowledge: snapshot.knowledge,
        repositories: snapshot.repositories.map((item) => ({ ...item, lastReviewAt: item.lastReviewAt?.toISOString() ?? null })),
        authors: snapshot.authors, dimensions: snapshot.dimensions,
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/reports", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.reportStore === undefined) { response.status(503).json({ code: "REPORTS_NOT_CONFIGURED", message: "Report storage is unavailable" }); return; }
      response.json(dashboardReportsResponseSchema.parse({ items: await options.reportStore.list(principal.organizationId) }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/reports", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.reportStore === undefined) { response.status(503).json({ code: "REPORTS_NOT_CONFIGURED", message: "Report storage is unavailable" }); return; }
      const body = dashboardCreateReportBodySchema.parse(request.body);
      const outcome = await options.reportStore.createAuthorized({ organizationId: principal.organizationId, actorUserId: principal.userId, definition: body });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot create reports" }); return; }
      if (outcome.kind === "limit_reached") { response.status(409).json({ code: "REPORT_LIMIT_REACHED", message: "This organization has reached the 500-report limit" }); return; }
      response.status(201).json(dashboardReportDefinitionSchema.parse(outcome.report));
    } catch (error) { sendFailure(response, error); }
  });

  router.delete("/reports/:id", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.reportStore === undefined) { response.status(503).json({ code: "REPORTS_NOT_CONFIGURED", message: "Report storage is unavailable" }); return; }
      const reportId = dashboardIdSchema.parse(request.params["id"] ?? ""); const body = dashboardDeleteReportBodySchema.parse(request.body);
      const outcome = await options.reportStore.deleteAuthorized({ organizationId: principal.organizationId, actorUserId: principal.userId, reportId, expectedRevision: body.expectedRevision });
      if (outcome.kind === "not_found") { response.status(404).json({ code: "NOT_FOUND", message: "Report not found" }); return; }
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot delete reports" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Report changed; reload and retry" }); return; }
      response.json(dashboardDeleteReportResponseSchema.parse({ deleted: true }));
    } catch (error) { sendFailure(response, error); }
  });

  router.post("/reports/:id/generate", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.reportStore === undefined) { response.status(503).json({ code: "REPORTS_NOT_CONFIGURED", message: "Report storage is unavailable" }); return; }
      const reportId = dashboardIdSchema.parse(request.params["id"] ?? ""); const body = dashboardGenerateReportBodySchema.parse(request.body);
      const outcome = await options.reportStore.generateAuthorized({ organizationId: principal.organizationId, actorUserId: principal.userId, reportId, expectedRevision: body.expectedRevision });
      if (outcome.kind === "not_found") { response.status(404).json({ code: "NOT_FOUND", message: "Report not found" }); return; }
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot generate reports" }); return; }
      if (outcome.kind === "revision_conflict") { response.status(409).json({ code: "REVISION_CONFLICT", message: "Report changed; reload and retry" }); return; }
      response.status(201).json(dashboardReportRunSchema.parse(outcome.run));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/security/findings", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.securityStore === undefined) { response.status(503).json({ code: "SECURITY_NOT_CONFIGURED", message: "Security findings storage is unavailable" }); return; }
      const rawLimit = request.query["limit"];
      const query = dashboardSecurityFindingsQuerySchema.parse({
        repositoryIds: queryStrings(request, "repositoryId"),
        severities: queryStrings(request, "severity"),
        lifecycle: queryStrings(request, "lifecycle"),
        ...(rawLimit === undefined ? {} : { limit: Number(typeof rawLimit === "string" ? rawLimit : Number.NaN) }),
      });
      const snapshot = await options.securityStore.snapshot({ organizationId: principal.organizationId, ...query });
      response.json(dashboardSecurityFindingsResponseSchema.parse({
        summary: snapshot.summary,
        items: snapshot.items.map((item) => ({
          ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
        })),
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/caches", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.cacheStore === undefined) { response.status(503).json({ code: "CACHE_NOT_CONFIGURED", message: "Review cache storage is unavailable" }); return; }
      const rows = await options.cacheStore.listMetadata(principal.organizationId);
      response.json(dashboardReviewCachesResponseSchema.parse({
        items: rows.map((row) => ({
          id: row.id,
          repositoryId: row.repositoryId,
          repositoryName: row.repositoryName,
          workflow: "review",
          fingerprint: row.fingerprint,
          sizeBytes: row.payloadBytes,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          lastUsedAt: row.lastUsedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        })),
      }));
    } catch (error) { sendFailure(response, error); }
  });

  router.delete("/caches", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      if (options.cacheStore === undefined) { response.status(503).json({ code: "CACHE_NOT_CONFIGURED", message: "Review cache storage is unavailable" }); return; }
      const body = dashboardDeleteReviewCachesBodySchema.parse(request.body);
      const outcome = await options.cacheStore.deleteAuthorized({
        organizationId: principal.organizationId,
        actorUserId: principal.userId,
        ids: body.ids,
      });
      if (outcome.kind === "forbidden") { response.status(403).json({ code: "FORBIDDEN", message: "This account cannot delete review caches" }); return; }
      response.json(dashboardDeleteReviewCachesResponseSchema.parse({ deleted: outcome.count }));
    } catch (error) { sendFailure(response, error); }
  });

  router.get("/provider-connections", async (request, response) => {
    try {
      const principal = await sessionPrincipal(options.auth, request, options.organizationId);
      const rows = await options.store.listProviderConnections(principal.organizationId);
      response.json(dashboardProviderConnectionsResponseSchema.parse({ items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })) }));
    } catch (error) { sendFailure(response, error); }
  });

  return router;
}
