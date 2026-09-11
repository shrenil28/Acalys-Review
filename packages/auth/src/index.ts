export {
  AUTH_ROLES,
  API_SCOPES,
  AuthService,
  mapGithubPermissionsToRole,
  requireScope,
  type ApiScope,
  type AuthServiceOptions,
  type EstablishedGithubSession,
  type IssuedCredential,
  type Principal,
  type Role,
  type VerifiedGithubIdentity,
} from "./service.js";
export { CredentialRing, type CredentialVersion } from "./credential-ring.js";
export {
  GithubOAuthService,
  type GithubOAuthIdentity,
  type GithubOAuthOptions,
} from "./github-oauth.js";

export {
  GitlabOAuthService,
  type GitlabOAuthIdentity,
  type GitlabOAuthOptions,
} from "./gitlab-oauth.js";
