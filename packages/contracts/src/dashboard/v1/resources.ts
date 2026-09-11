import { z } from "zod";

export const dashboardRoleSchema = z.enum(["owner", "admin", "member", "read_only"]);
export const dashboardScopeSchema = z.enum([
  "repositories:read",
  "reviews:read",
  "reviews:write",
  "findings:read",
  "findings:write",
  "conversations:read",
  "conversations:write",
  "knowledge:read",
]);
export const dashboardIdSchema = z.string().uuid();
const id = dashboardIdSchema;
const iso = z.string().datetime({ offset: true });

export const dashboardOrganizationSchema = z.object({
  id,
  slug: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
});
export const dashboardUserSchema = z.object({
  id,
  provider: z.string().min(1).max(64),
  providerUserId: z.string().min(1).max(200),
  displayName: z.string().max(300).nullable(),
  email: z.string().email().nullable(),
});
export const dashboardSessionSchema = z.object({
  sessionId: id,
  user: dashboardUserSchema,
  organization: dashboardOrganizationSchema,
  membershipId: id,
  role: dashboardRoleSchema,
  expiresAt: iso,
});
export const dashboardAuthConfigSchema = z.object({
  organization: dashboardOrganizationSchema,
  githubEnabled: z.boolean(),
  gitlabEnabled: z.boolean(),
});
export const dashboardExchangeBodySchema = z.object({ exchange: z.string().min(32).max(512) });
export const dashboardExchangeResponseSchema = z.object({ token: z.string().min(32), expiresAt: iso });
export const dashboardRotateResponseSchema = dashboardExchangeResponseSchema;
export const dashboardLogoutResponseSchema = z.object({ revoked: z.literal(true) });

export const dashboardMemberSchema = z.object({
  id,
  userId: id,
  displayName: z.string().max(300).nullable(),
  email: z.string().email().nullable(),
  provider: z.string().min(1).max(64),
  providerUserId: z.string().min(1).max(200),
  role: dashboardRoleSchema,
  analyticsTeam: z.string().trim().min(1).max(100).nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export const dashboardMembersResponseSchema = z.object({ items: z.array(dashboardMemberSchema).max(500) });
export const dashboardUpdateMemberBodySchema = z.object({ role: dashboardRoleSchema });

export const dashboardInvitationSchema = z.object({
  id,
  email: z.string().email().max(320),
  role: dashboardRoleSchema,
  createdBy: id,
  createdAt: iso,
  expiresAt: iso,
});
export const dashboardInvitationsResponseSchema = z.object({
  items: z.array(dashboardInvitationSchema).max(500),
});
export const dashboardCreateInvitationBodySchema = z.object({
  email: z.string().trim().email().max(320),
  role: dashboardRoleSchema.default("member"),
});
export const dashboardInvitationTokenSchema = z.string().regex(/^acalys_invite_[A-Za-z0-9_-]{40,100}$/u);
export const dashboardIssuedInvitationSchema = z.object({
  invitation: dashboardInvitationSchema,
  token: dashboardInvitationTokenSchema,
});
export const dashboardCancelInvitationResponseSchema = z.object({ cancelled: z.literal(true) });
export const dashboardRemoveMemberResponseSchema = z.object({
  removed: z.literal(true),
  revokedSessions: z.number().int().nonnegative(),
  revokedApiKeys: z.number().int().nonnegative(),
});

export const dashboardApiKeySchema = z.object({
  id,
  name: z.string().min(1).max(200),
  prefix: z.string().min(1).max(100),
  role: dashboardRoleSchema,
  scopes: z.array(dashboardScopeSchema).max(32),
  ownerKind: z.enum(["organization", "user"]),
  userId: id.nullable(),
  createdAt: iso,
  expiresAt: iso.nullable(),
  lastUsedAt: iso.nullable(),
});
export const dashboardApiKeysResponseSchema = z.object({ items: z.array(dashboardApiKeySchema).max(500) });
export const dashboardCreateApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(dashboardScopeSchema).min(1).max(32).refine((value) => new Set(value).size === value.length),
  ownerKind: z.enum(["organization", "user"]).default("user"),
  role: dashboardRoleSchema.optional(),
  expiresAt: iso.optional(),
});
export const dashboardIssuedApiKeySchema = z.object({ key: dashboardApiKeySchema, token: z.string().min(32) });
export const dashboardRevokeApiKeyResponseSchema = z.object({ revoked: z.literal(true) });

export const dashboardProviderConnectionSchema = z.object({
  id,
  provider: z.string().min(1).max(64),
  externalAccountId: z.string().min(1).max(300),
  installationRef: z.string().max(300).nullable(),
  status: z.enum(["active", "suspended", "revoked"]),
  createdAt: iso,
  updatedAt: iso,
});
export const dashboardProviderConnectionsResponseSchema = z.object({ items: z.array(dashboardProviderConnectionSchema).max(100) });

export type DashboardRole = z.infer<typeof dashboardRoleSchema>;
export type DashboardScope = z.infer<typeof dashboardScopeSchema>;
export type DashboardSession = z.infer<typeof dashboardSessionSchema>;
export type DashboardMember = z.infer<typeof dashboardMemberSchema>;
export type DashboardInvitation = z.infer<typeof dashboardInvitationSchema>;
export type DashboardApiKey = z.infer<typeof dashboardApiKeySchema>;
export type DashboardProviderConnection = z.infer<typeof dashboardProviderConnectionSchema>;

export const dashboardIntegrationKeySchema = z.enum(["linear", "circleci", "mcp", "jira"]);
export const dashboardIntegrationStatusSchema = z.enum(["connected", "disconnected", "error"]);
export const dashboardIntegrationSchema = z.object({
  id,
  key: dashboardIntegrationKeySchema,
  status: dashboardIntegrationStatusSchema,
  revision: z.number().int().positive(),
  credentialVersion: z.number().int().nonnegative(),
  config: z.record(z.string(), z.unknown()),
  hasCredential: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
});
export const dashboardIntegrationsResponseSchema = z.object({
  items: z.array(dashboardIntegrationSchema).max(16),
});
export const dashboardCircleCiConnectBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  token: z.string().trim().min(1).max(8_192),
  projectSlugs: z.record(dashboardIdSchema, z.string().trim().min(1).max(500)).default({}),
});
export const dashboardCircleCiSettingsBodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  projectSlugs: z.record(dashboardIdSchema, z.string().trim().min(1).max(500)),
});
export const dashboardLinearSettingsBodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  teamKeys: z.array(z.string().trim().regex(/^[A-Z][A-Z0-9]{0,20}$/)).max(50)
    .refine((value) => new Set(value).size === value.length),
});
export const dashboardDisconnectIntegrationBodySchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export const dashboardLinearAuthorizeResponseSchema = z.object({
  url: z.string().url(),
});
export const dashboardMcpAuthMethodSchema = z.enum(["none", "api_key"]);
export const dashboardMcpServerInputSchema = z.object({
  label: z.string().trim().min(1).max(200),
  url: z.string().url().max(2_000),
  guidance: z.string().max(10_000).default(""),
  auth: dashboardMcpAuthMethodSchema,
  apiKey: z.string().max(8_192).optional(),
  headers: z.record(z.string().min(1).max(200), z.string().max(4_096)).default({}),
});
export const dashboardMcpCreateServerBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  server: dashboardMcpServerInputSchema,
});
export const dashboardMcpUpdateServerBodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  server: dashboardMcpServerInputSchema,
});
export const dashboardMcpRemoveServerBodySchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export const dashboardJiraChallengeBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
});
export const dashboardJiraChallengeResponseSchema = z.object({
  secret: z.string().regex(/^acl_jira_[A-Za-z0-9_-]{40,100}$/u),
  expiresAt: iso,
});
export const dashboardJiraRedeemBodySchema = z.object({
  secret: z.string().regex(/^acl_jira_[A-Za-z0-9_-]{40,100}$/u),
  siteUrl: z.string().url().max(2_000),
  cloudId: z.string().uuid(),
  installationToken: z.string().min(1).max(16_384),
});
export const dashboardIntegrationMutationResponseSchema = z.object({
  integration: dashboardIntegrationSchema,
});

export type DashboardIntegration = z.infer<typeof dashboardIntegrationSchema>;
export type DashboardIntegrationKey = z.infer<typeof dashboardIntegrationKeySchema>;
