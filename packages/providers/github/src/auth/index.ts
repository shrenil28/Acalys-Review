/**
 * GitHub App authentication.
 *
 * Three credentials with three lifetimes, kept as three types rather than one
 * `Credential` abstraction — they differ in scope, storage, rotation, and
 * failure mode, and merging them loses every one of those distinctions:
 *
 *     GithubAppPrivateKey        long-lived, rotated by hand
 *            │ signs
 *     AppJwtSigner               ≤ 10 minutes, stateless, never cached
 *            │ authorizes
 *     InstallationTokenProvider  1 hour, per installation, cached
 *            │ authorizes
 *     repository operations
 */
export {
  GithubAppPrivateKey,
  PrivateKeyError,
  REDACTED,
} from "./private-key.js";

export {
  AppJwtSigner,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_JWT_LIFETIME_SECONDS,
  JwtSigningError,
  MAX_JWT_LIFETIME_SECONDS,
  decodeUnverifiedJwtAlgorithm,
  decodeUnverifiedJwtClaims,
  type AppJwtClaims,
  type AppJwtSignerOptions,
  type SignedAppJwt,
} from "./jwt.js";

export {
  DEFAULT_EXPIRY_MARGIN_SECONDS,
  InstallationAuthError,
  InstallationTokenProvider,
  cacheKeyFor,
  isAuthenticationFailure,
  redactToken,
  withInstallationAuth,
  type AuthenticatedAttempt,
  type InstallationToken,
  type InstallationTokenExchange,
  type InstallationTokenProviderOptions,
  type InstallationTokenRequest,
} from "./installation-token.js";
