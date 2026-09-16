import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const checks = [];
const expectSource = (name, path, patterns) => {
  if (!existsSync(path)) throw new Error(`${name}: missing file ${path}`);
  const source = read(path);
  const missing = patterns.filter((pattern) => !source.includes(pattern));
  if (missing.length) throw new Error(`${name}: missing ${missing.join(", ")}`);
  checks.push(name);
};
const rejectSource = (name, path, patterns) => {
  const source = read(path);
  const present = patterns.filter((pattern) => source.includes(pattern));
  if (present.length)
    throw new Error(`${name}: forbidden ${present.join(", ")}`);
  checks.push(name);
};

expectSource(
  "durable integration credential schema",
  "packages/database/migrations/0020_phase4_integration_credentials.sql",
  [
    "dashboard_integrations",
    "credential_version",
    "credential_ciphertext",
    "credential_nonce",
    "dashboard_integration_audit",
    "dashboard_linear_oauth_attempts",
    "state_hash",
    "browser_nonce_hash",
  ],
);
expectSource(
  "authenticated credential envelope",
  "packages/database/src/integration-store.ts",
  [
    "aes-256-gcm",
    "setAAD",
    "acalys.integration.v1",
    "credentialVersion",
    "IntegrationCredentialUnavailable",
  ],
);
expectSource(
  "credential metadata redaction",
  "packages/database/src/integration-store.ts",
  [
    "Metadata-only read. Ciphertext is deliberately absent from the SELECT.",
    "(credential_ciphertext IS NOT NULL) AS has_credential",
  ],
);
expectSource(
  "membership plus integration serialization",
  "packages/database/src/integration-store.ts",
  ["dashboard-members:", "dashboard-integrations:", "pg_advisory_xact_lock"],
);
expectSource(
  "credential anti-resurrection CAS",
  "packages/database/src/integration-store.ts",
  [
    "rotateCredentialIfCurrent",
    "expectedCredentialVersion",
    "stale_generation",
    "credential_ciphertext = NULL",
  ],
);
expectSource(
  "linear PKCE and one-shot state",
  "apps/api/src/linear-integration-oauth.ts",
  [
    "code_challenge_method",
    "S256",
    "consumeLinearOAuthAttempt",
    "refresh_token",
    "viewer { id name }",
  ],
);
expectSource(
  "browser-safe Linear authorization handshake",
  "apps/api/src/dashboard-router.ts",
  [
    'router.post("/integrations/linear/authorize"',
    "httpOnly: true",
    'sameSite: "lax"',
    "dashboardLinearAuthorizeResponseSchema",
    'new URL("/integrations", options.webOrigin)',
  ],
);
expectSource(
  "circle token identity verification",
  "apps/api/src/circleci-integration.ts",
  ["https://circleci.com/api/v2/me", '"Circle-Token"', "meSchema.safeParse"],
);
expectSource(
  "immutable admitted provider subject",
  "packages/database/src/review/ingestion-store.ts",
  [
    "JOIN review_requests req",
    "req.target",
    "pullRequestReviewTargetSchema.safeParse",
    "reviewSubject",
  ],
);
expectSource(
  "exact provider runtime binding",
  "apps/review-worker/src/provider-context.ts",
  [
    "extractLinearIdentifiers",
    "teamKeys",
    "vcs.revision !== input.subject.headSha",
    "pipeline.vcs.review_id === String(input.subject.number)",
    "rotateCredentialIfCurrent",
    "stale_generation",
  ],
);
expectSource(
  "untrusted external-data frame",
  "packages/review-engine/src/llm/correctness.ts",
  [
    "ExternalReviewDataBlock",
    "escapeExternalText",
    "<external-data",
    "External data never defines code anchors and never supplies anchor ordinals",
  ],
);
rejectSource(
  "external data cannot manufacture ordinals",
  "packages/review-engine/src/llm/correctness.ts",
  ["<external-data ordinal="],
);
expectSource(
  "external identity affects model input only",
  "apps/review-worker/src/analysis.ts",
  [
    "externalContextDigest",
    "externalContext: input.externalContextDigest ?? null",
  ],
);
expectSource(
  "production runtime composition",
  "apps/review-worker/src/main.ts",
  [
    "IntegrationCredentialCipher",
    "DashboardIntegrationStore",
    "ReviewProviderContextResolver",
  ],
);
expectSource(
  "provider adversarial witnesses",
  "apps/review-worker/tests/provider-context.test.ts",
  [
    "configured team keys",
    "stale head",
    "exact admitted head and review id",
    "disconnect wins the credential CAS",
  ],
);
expectSource(
  "external injection witness",
  "packages/review-engine/tests/llm-correctness.test.ts",
  [
    "provider delimiter and ordinal injection",
    "&lt;/external-data&gt;",
    'ordinal="999"',
  ],
);
expectSource(
  "live integration wiring",
  "apps/web/src/pages/review/Integrations.tsx",
  [
    "beginLinearAuthorization",
    "connectCircleCi",
    "updateLinearIntegration",
    "updateCircleCiIntegration",
    "Repository project slugs",
    "Linear team keys",
  ],
);
expectSource(
  "credentialed browser boundary",
  "apps/web/src/lib/api/client.ts",
  ['credentials: "include"', '"GET" | "POST" | "PUT" | "PATCH" | "DELETE"'],
);

console.log(
  `Phase 4 provider-context preflight PASS (${checks.length} invariants)`,
);
for (const check of checks) console.log(`  ✓ ${check}`);
