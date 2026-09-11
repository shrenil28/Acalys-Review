import {
  dashboardApiKeysResponseSchema,
  dashboardAuthConfigSchema,
  dashboardExchangeResponseSchema,
  dashboardIssuedApiKeySchema,
  dashboardLogoutResponseSchema,
  dashboardMemberSchema,
  dashboardMembersResponseSchema,
  dashboardInvitationsResponseSchema,
  dashboardIssuedInvitationSchema,
  dashboardCancelInvitationResponseSchema,
  dashboardRemoveMemberResponseSchema,
  dashboardProviderConnectionsResponseSchema,
  dashboardIntegrationsResponseSchema,
  dashboardIntegrationMutationResponseSchema,
  dashboardLinearAuthorizeResponseSchema,
  dashboardJiraChallengeResponseSchema,
  dashboardRevokeApiKeyResponseSchema,
  dashboardRotateResponseSchema,
  dashboardSessionSchema,
  dashboardOrganizationReviewSettingsSchema,
  dashboardRepositoryReviewSettingsSchema,
  dashboardReviewCachesResponseSchema,
  dashboardDeleteReviewCachesResponseSchema,
  type DashboardReviewCache,
  dashboardSecurityFindingsResponseSchema,
  type DashboardSecurityFindingsResponse,
  dashboardNotificationPreferencesSchema,
  type DashboardNotificationPreferences,
  dashboardRepositoryMetricsResponseSchema,
  dashboardRepositoryOverviewSchema,
  dashboardAnalyticsResponseSchema,
  dashboardReportsResponseSchema,
  dashboardReportDefinitionSchema,
  dashboardDeleteReportResponseSchema,
  dashboardReportRunSchema,
  type DashboardAnalyticsResponse,
  type DashboardCreateReportBody,
  type DashboardReportDefinition,
  type DashboardReportRun,
  type DashboardRepositoryMetric,
  type DashboardRepositoryOverview,
  type DashboardRole,
  type DashboardScope,
  type DashboardIntegration,
  type DashboardOrganizationReviewConfig,
  type DashboardOrganizationReviewSettings,
  type DashboardRepositoryReviewSettings,
} from "@acalys/contracts/dashboard/v1";
import { createApiClient } from "./client.js";
import { browserAuthorization } from "./browserSession.js";
import type { ApiResult } from "./result.js";
import { resolveDataConfig } from "./config.js";

export type AdminResult<T> = ApiResult<T> | { readonly kind: "misconfigured"; readonly detail: string };
export type DashboardIntegrationView = DashboardIntegration;
export type { DashboardOrganizationReviewConfig, DashboardOrganizationReviewSettings, DashboardRepositoryReviewSettings, DashboardReviewCache, DashboardSecurityFindingsResponse, DashboardNotificationPreferences, DashboardRepositoryMetric, DashboardRepositoryOverview, DashboardAnalyticsResponse, DashboardCreateReportBody, DashboardReportDefinition, DashboardReportRun };

function apiBase(): AdminResult<string> {
  const config = resolveDataConfig();
  if (config.kind === "api") return { kind: "ok", value: config.baseUrl };
  return { kind: "misconfigured", detail: config.kind === "misconfigured" ? config.detail : "Dashboard administration is only live in API mode" };
}
function client(baseUrl: string, withAuthorization = true) {
  return createApiClient({ baseUrl, ...(withAuthorization ? { authorization: browserAuthorization } : {}) });
}
async function withBase<T>(work: (baseUrl: string) => Promise<ApiResult<T>>): Promise<AdminResult<T>> {
  const base = apiBase();
  if (base.kind !== "ok") return base;
  return work(base.value);
}

export function loadAuthConfig(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl, false).get("/dashboard/v1/auth/config", dashboardAuthConfigSchema, { signal }));
}
export function redeemLoginExchange(exchange: string, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl, false).post("/dashboard/v1/auth/exchange", dashboardExchangeResponseSchema, { signal, body: { exchange } }));
}
export function loadDashboardSession(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/session", dashboardSessionSchema, { signal }));
}
export function rotateDashboardSession(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post("/dashboard/v1/session/rotate", dashboardRotateResponseSchema, { signal }));
}
export function logoutDashboardSession(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post("/dashboard/v1/session/logout", dashboardLogoutResponseSchema, { signal }));
}
export function loadNotificationPreferences(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/notifications", dashboardNotificationPreferencesSchema, { signal }));
}
export function updateNotificationPreferences(input: Omit<DashboardNotificationPreferences, "updatedAt">, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("PUT", "/dashboard/v1/notifications", dashboardNotificationPreferencesSchema, { signal, body: {
    expectedRevision: input.revision, reviewComplete: input.reviewComplete, criticalFinding: input.criticalFinding, weeklyDigest: input.weeklyDigest, productUpdates: input.productUpdates,
  } }));
}
export function loadDashboardMembers(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/members", dashboardMembersResponseSchema, { signal }));
}
export function updateDashboardMemberRole(memberId: string, role: DashboardRole, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("PATCH", `/dashboard/v1/members/${encodeURIComponent(memberId)}`, dashboardMemberSchema, { signal, body: { role } }));
}
export function updateDashboardMemberAnalyticsTeam(memberId: string, team: string | null, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).put(`/dashboard/v1/members/${encodeURIComponent(memberId)}/analytics-team`, dashboardMemberSchema, { signal, body: { team } }));
}
export function loadDashboardInvitations(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/invitations", dashboardInvitationsResponseSchema, { signal }));
}
export function createDashboardInvitation(email: string, role: DashboardRole, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post("/dashboard/v1/invitations", dashboardIssuedInvitationSchema, { signal, body: { email, role } }));
}
export function cancelDashboardInvitation(invitationId: string, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("DELETE", `/dashboard/v1/invitations/${encodeURIComponent(invitationId)}`, dashboardCancelInvitationResponseSchema, { signal }));
}
export function removeDashboardMember(memberId: string, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("DELETE", `/dashboard/v1/members/${encodeURIComponent(memberId)}`, dashboardRemoveMemberResponseSchema, { signal }));
}
export function loadDashboardApiKeys(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/api-keys", dashboardApiKeysResponseSchema, { signal }));
}
export function createDashboardApiKey(input: {
  readonly name: string;
  readonly scopes: readonly DashboardScope[];
  readonly ownerKind: "organization" | "user";
  readonly role?: DashboardRole | undefined;
  readonly expiresAt?: string | undefined;
}, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post("/dashboard/v1/api-keys", dashboardIssuedApiKeySchema, { signal, body: input }));
}
export function revokeDashboardApiKey(apiKeyId: string, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("DELETE", `/dashboard/v1/api-keys/${encodeURIComponent(apiKeyId)}`, dashboardRevokeApiKeyResponseSchema, { signal }));
}

export function loadOrganizationReviewSettings(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/settings/review", dashboardOrganizationReviewSettingsSchema, { signal }));
}

export function updateOrganizationReviewSettings(
  expectedRevision: number,
  config: DashboardOrganizationReviewConfig,
  signal?: AbortSignal,
) {
  return withBase((baseUrl) => client(baseUrl).put("/dashboard/v1/settings/review", dashboardOrganizationReviewSettingsSchema, { signal, body: { expectedRevision, config } }));
}

export function loadRepositoryReviewSettings(repositoryId: string, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get(`/dashboard/v1/repositories/${encodeURIComponent(repositoryId)}/settings`, dashboardRepositoryReviewSettingsSchema, { signal }));
}

export function updateRepositoryReviewSettings(
  repositoryId: string,
  input: { readonly expectedRevision: number; readonly inherit: boolean; readonly instructions: string; readonly ignorePaths: readonly string[] },
  signal?: AbortSignal,
) {
  return withBase((baseUrl) => client(baseUrl).put(`/dashboard/v1/repositories/${encodeURIComponent(repositoryId)}/settings`, dashboardRepositoryReviewSettingsSchema, { signal, body: input }));
}

export function updateRepositoryReviewLifecycle(
  repositoryId: string,
  expectedRevision: number,
  lifecycle: "enabled" | "paused",
  signal?: AbortSignal,
) {
  return withBase((baseUrl) => client(baseUrl).put(`/dashboard/v1/repositories/${encodeURIComponent(repositoryId)}/reviews`, dashboardRepositoryReviewSettingsSchema, { signal, body: { expectedRevision, lifecycle } }));
}

export function archiveRepositoryReviewSettings(repositoryId: string, expectedRevision: number, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("DELETE", `/dashboard/v1/repositories/${encodeURIComponent(repositoryId)}`, dashboardRepositoryReviewSettingsSchema, { signal, headers: { "If-Match-Revision": String(expectedRevision) } }));
}

export type OrganizationReviewSettingsView = DashboardOrganizationReviewSettings;
export type RepositoryReviewSettingsView = DashboardRepositoryReviewSettings;


export function loadProviderConnections(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/provider-connections", dashboardProviderConnectionsResponseSchema, { signal }));
}

export function loadDashboardIntegrations(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/integrations", dashboardIntegrationsResponseSchema, { signal }));
}

export function beginLinearAuthorization(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post("/dashboard/v1/integrations/linear/authorize", dashboardLinearAuthorizeResponseSchema, { signal }));
}

export function updateLinearIntegration(input: { readonly expectedRevision: number; readonly teamKeys: readonly string[] }, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("PATCH", "/dashboard/v1/integrations/linear", dashboardIntegrationMutationResponseSchema, { signal, body: input }));
}

export function connectCircleCi(input: { readonly expectedRevision: number; readonly token: string; readonly projectSlugs: Readonly<Record<string, string>> }, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).put("/dashboard/v1/integrations/circleci", dashboardIntegrationMutationResponseSchema, { signal, body: input }));
}

export function updateCircleCiIntegration(input: { readonly expectedRevision: number; readonly projectSlugs: Readonly<Record<string, string>> }, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("PATCH", "/dashboard/v1/integrations/circleci", dashboardIntegrationMutationResponseSchema, { signal, body: input }));
}

export function disconnectDashboardIntegration(key: "linear" | "circleci" | "mcp" | "jira", expectedRevision: number, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post(`/dashboard/v1/integrations/${encodeURIComponent(key)}/disconnect`, dashboardIntegrationMutationResponseSchema, { signal, body: { expectedRevision } }));
}

export interface McpServerMutationInput {
  readonly label: string;
  readonly url: string;
  readonly guidance: string;
  readonly auth: "none" | "api_key";
  readonly apiKey?: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
}

export function createMcpServer(expectedRevision: number, server: McpServerMutationInput, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post("/dashboard/v1/integrations/mcp/servers", dashboardIntegrationMutationResponseSchema, { signal, body: { expectedRevision, server } }));
}

export function updateMcpServer(serverId: string, expectedRevision: number, server: McpServerMutationInput, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).put(`/dashboard/v1/integrations/mcp/servers/${encodeURIComponent(serverId)}`, dashboardIntegrationMutationResponseSchema, { signal, body: { expectedRevision, server } }));
}

export function removeMcpServer(serverId: string, expectedRevision: number, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("DELETE", `/dashboard/v1/integrations/mcp/servers/${encodeURIComponent(serverId)}`, dashboardIntegrationMutationResponseSchema, { signal, body: { expectedRevision } }));
}

export function createJiraInstallationChallenge(expectedRevision: number, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post("/dashboard/v1/integrations/jira/challenge", dashboardJiraChallengeResponseSchema, { signal, body: { expectedRevision } }));
}

export function githubLoginStartUrl(baseUrl: string, returnTo: string, invite?: string): string {
  const query = new URLSearchParams({ returnTo });
  if (invite !== undefined && invite.length > 0) query.set("invite", invite);
  return `${baseUrl}/dashboard/v1/auth/github/start?${query.toString()}`;
}
export function gitlabLoginStartUrl(baseUrl: string, returnTo: string, invite?: string): string {
  const query = new URLSearchParams({ returnTo });
  if (invite !== undefined && invite.length > 0) query.set("invite", invite);
  return `${baseUrl}/dashboard/v1/auth/gitlab/start?${query.toString()}`;
}

export const dashboardScopeOptions = [
  "repositories:read",
  "reviews:read",
  "reviews:write",
  "findings:read",
  "findings:write",
  "conversations:read",
  "conversations:write",
  "knowledge:read",
] as const;
export type DashboardScopeValue = (typeof dashboardScopeOptions)[number];

export interface DashboardMemberView {
  readonly id: string; readonly userId: string; readonly displayName: string | null;
  readonly email: string | null; readonly provider: string; readonly providerUserId: string;
  readonly role: "owner" | "admin" | "member" | "read_only"; readonly analyticsTeam: string | null; readonly createdAt: string; readonly updatedAt: string;
}
export interface DashboardInvitationView {
  readonly id: string; readonly email: string; readonly role: "owner" | "admin" | "member" | "read_only";
  readonly createdBy: string; readonly createdAt: string; readonly expiresAt: string;
}
export interface DashboardApiKeyView {
  readonly id: string; readonly name: string; readonly prefix: string;
  readonly role: "owner" | "admin" | "member" | "read_only"; readonly scopes: readonly DashboardScopeValue[];
  readonly ownerKind: "organization" | "user"; readonly userId: string | null;
  readonly createdAt: string; readonly expiresAt: string | null; readonly lastUsedAt: string | null;
}

export interface DashboardSessionView {
  readonly sessionId: string;
  readonly user: { readonly id: string; readonly provider: string; readonly providerUserId: string; readonly displayName: string | null; readonly email: string | null };
  readonly organization: { readonly id: string; readonly slug: string; readonly name: string };
  readonly membershipId: string;
  readonly role: "owner" | "admin" | "member" | "read_only";
  readonly expiresAt: string;
}

export function loadDashboardAnalytics(input: {
  readonly from: string;
  readonly to: string;
  readonly repositoryIds?: readonly string[];
  readonly usernames?: readonly string[];
  readonly teams?: readonly string[];
}, signal?: AbortSignal) {
  const query = new URLSearchParams({ from: input.from, to: input.to });
  for (const value of input.repositoryIds ?? []) query.append("repositoryId", value);
  for (const value of input.usernames ?? []) query.append("username", value);
  for (const value of input.teams ?? []) query.append("team", value);
  return withBase((baseUrl) => client(baseUrl).get(`/dashboard/v1/analytics/reviews?${query.toString()}`, dashboardAnalyticsResponseSchema, { signal }));
}

export function loadDashboardReports(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/reports", dashboardReportsResponseSchema, { signal }));
}
export function createDashboardReport(input: DashboardCreateReportBody, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post("/dashboard/v1/reports", dashboardReportDefinitionSchema, { signal, body: input }));
}
export function deleteDashboardReport(reportId: string, expectedRevision: number, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("DELETE", `/dashboard/v1/reports/${encodeURIComponent(reportId)}`, dashboardDeleteReportResponseSchema, { signal, body: { expectedRevision } }));
}
export function generateDashboardReport(reportId: string, expectedRevision: number, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).post(`/dashboard/v1/reports/${encodeURIComponent(reportId)}/generate`, dashboardReportRunSchema, { signal, body: { expectedRevision } }));
}

export function loadRepositoryMetrics(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/repositories/metrics", dashboardRepositoryMetricsResponseSchema, { signal }));
}
export function loadRepositoryOverview(repositoryId: string, signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get(`/dashboard/v1/repositories/${encodeURIComponent(repositoryId)}/overview`, dashboardRepositoryOverviewSchema, { signal }));
}

export function loadReviewCaches(signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).get("/dashboard/v1/caches", dashboardReviewCachesResponseSchema, { signal }));
}

export function deleteReviewCaches(ids: readonly string[], signal?: AbortSignal) {
  return withBase((baseUrl) => client(baseUrl).request("DELETE", "/dashboard/v1/caches", dashboardDeleteReviewCachesResponseSchema, { signal, body: { ids } }));
}

export function loadSecurityFindings(input: {
  readonly repositoryIds?: readonly string[];
  readonly severities?: readonly string[];
  readonly lifecycle?: readonly string[];
  readonly limit?: number;
} = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  for (const value of input.repositoryIds ?? []) query.append("repositoryId", value);
  for (const value of input.severities ?? []) query.append("severity", value);
  for (const value of input.lifecycle ?? []) query.append("lifecycle", value);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return withBase((baseUrl) => client(baseUrl).get(`/dashboard/v1/security/findings${suffix}`, dashboardSecurityFindingsResponseSchema, { signal }));
}
