import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const checks = [];
const expect = (name, path, patterns) => {
  const source = read(path);
  const missing = patterns.filter((pattern) => !source.includes(pattern));
  if (missing.length) throw new Error(`${name}: missing ${missing.join(", ")}`);
  checks.push(name);
};

if (!existsSync("packages/database/migrations/0022_phase4_membership_invitations.sql")) throw new Error("membership invitation migration missing");
expect("hash-only invitation persistence", "packages/database/migrations/0022_phase4_membership_invitations.sql", [
  "invite_hash", "cancelled_at", "redeemed_at", "expires_at", "dashboard_membership_invitations_org_live_idx",
]);
const migration = read("packages/database/migrations/0022_phase4_membership_invitations.sql");
if (migration.includes("invite_token") || migration.includes("raw_token")) throw new Error("recoverable raw invitation field present");
checks.push("invitation schema has no recoverable raw bearer field");
expect("membership mutation serialization", "packages/database/src/dashboard-admin-store.ts", [
  "dashboard-members:", "createInvitationAuthorized", "cancelInvitationAuthorized", "removeMemberAuthorized", "last_owner",
]);
expect("global invited identity serialization", "packages/database/src/dashboard-admin-store.ts", [
  "dashboard-user-provider:", "dashboard-user-email:", "identity_conflict", "already_member", "email_mismatch",
]);
expect("removal revokes exact membership credentials first", "packages/database/src/dashboard-admin-store.ts", [
  "membership_id = $1", "UPDATE auth_sessions", "UPDATE api_keys", "DELETE FROM memberships",
]);
expect("provider-verified GitHub email boundary", "packages/auth/src/github-oauth.ts", [
  'scope", "user:email"', "/user/emails?per_page=100", 'record["verified"] === true', "verifiedEmails",
]);
expect("provider-confirmed GitLab email boundary", "packages/auth/src/gitlab-oauth.ts", [
  'scope", "read_user"', "/api/v4/user/emails", 'record["confirmed_at"] === "string"', "verifiedEmails",
]);
expect("invite capability stays out of OAuth state", "apps/api/src/dashboard-router.ts", [
  "acalys_membership_invite", "httpOnly: true", "redeemInvitationForVerifiedIdentity", "dashboardInvitationTokenSchema",
]);
const githubStateSource = read("packages/auth/src/github-oauth.ts");
if (githubStateSource.slice(githubStateSource.indexOf("interface OAuthStatePayload"), githubStateSource.indexOf("export interface GithubOAuthIdentity")).includes("invite")) {
  throw new Error("raw invitation capability leaked into authenticated-but-readable OAuth state");
}
checks.push("OAuth state contains no invitation capability");
expect("exchange redemption tenant re-pin", "apps/api/src/dashboard-router.ts", [
  "redeemed.organizationId !== options.organizationId", "EXCHANGE_INVALID",
]);
expect("explicit invitation/removal HTTP contract", "apps/api/src/dashboard-router.ts", [
  'router.get("/invitations"', 'router.post("/invitations"', 'router.delete("/invitations/:id"', 'router.delete("/members/:id"',
]);
expect("GitLab browser OAuth bridge", "apps/api/src/dashboard-router.ts", [
  'router.get("/auth/gitlab/start"', 'router.get("/auth/gitlab/callback"', 'provider: "gitlab"', "gitlabNonceCookie",
]);
expect("live team invitation and removal UX", "apps/web/src/pages/account/Team.tsx", [
  "createDashboardInvitation", "cancelDashboardInvitation", "removeDashboardMember", "shown again", "reports this email as verified",
]);
expect("invitation-aware login", "apps/web/src/pages/Login.tsx", [
  'params.get("invite")', "invitation_email_mismatch", "invitation_identity_conflict", "githubLoginStartUrl(baseUrl, returnTo, invite)",
]);
expect("HTTP invitation witnesses", "apps/api/tests/dashboard-admin.test.ts", [
  "returns an invitation bearer capability once", "persisting only its digest", "credential revocation counts",
]);
expect("Postgres invitation/removal witnesses", "packages/database/tests/phase4-dashboard-admin.test.ts", [
  "stores only an invitation digest", "pre-existing email identity collisions", "revokes membership-bound sessions and user keys",
]);
expect("GitHub verified-email witness", "packages/auth/tests/auth.test.ts", [
  "returns only provider-verified GitHub emails", "unverified@example.test", 'scope")).toBe("user:email")',
]);
expect("GitLab confirmed-email witness", "packages/auth/tests/auth.test.ts", [
  "only confirmed GitLab email addresses", "pending@example.test", 'scope")).toBe("read_user")',
]);
expect("GitLab production composition", "apps/api/src/main.ts", [
  "ACALYS_GITLAB_OAUTH_CLIENT_ID", "ACALYS_GITLAB_OAUTH_CLIENT_SECRET", "ACALYS_GITLAB_OAUTH_STATE_SECRET", "ACALYS_GITLAB_OAUTH_CALLBACK_URL", "gitlabOAuth",
]);

console.log(`Phase 4 auth-membership preflight PASS (${checks.length} invariants)`);
for (const check of checks) console.log(`  ✓ ${check}`);
