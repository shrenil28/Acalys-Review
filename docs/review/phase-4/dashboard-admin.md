# Phase 4 dashboard/browser administration contract

Checkpoint: **4.3 — browser/admin integration**

This contract is intentionally separate from the frozen Phase-3 public product API. The product manifest remains exactly 14 `/api/v1` routes. Browser-only identity, membership and credential administration is mounted below `/dashboard/v1` and may be disabled entirely in API-only deployments.

## Route surface

The frozen Checkpoint-4.3 dashboard surface contains 13 routes:

| Method | Route | Purpose |
|---|---|---|
| GET | `/dashboard/v1/auth/config` | Live organization identity + whether GitHub sign-in is configured. |
| GET | `/dashboard/v1/auth/github/start` | Issue OAuth state/nonce and redirect to GitHub. |
| GET | `/dashboard/v1/auth/github/callback` | Verify state/nonce, provider identity and provisioned membership; issue one-time exchange handle. |
| POST | `/dashboard/v1/auth/exchange` | Redeem the one-time exchange and issue the real browser session. |
| GET | `/dashboard/v1/session` | Project current live user/organization/membership state. |
| POST | `/dashboard/v1/session/rotate` | Rotate the current bearer session. |
| POST | `/dashboard/v1/session/logout` | Revoke the current bearer session. |
| GET | `/dashboard/v1/members` | List live organization members. |
| PATCH | `/dashboard/v1/members/:id` | Owner/admin role management with last-owner protection. |
| GET | `/dashboard/v1/api-keys` | List visible active API keys without hashes/secrets. |
| POST | `/dashboard/v1/api-keys` | Create a membership-authorized scoped key; full token returned once. |
| DELETE | `/dashboard/v1/api-keys/:id` | Tenant-safe, actor-authorized revocation. |
| GET | `/dashboard/v1/provider-connections` | Read live provider connection registrations already persisted by the backend. |

The dashboard router validates request bodies and UUID parameters before persistence and marks every dashboard response `Cache-Control: no-store`, `Pragma: no-cache`, and `X-Content-Type-Options: nosniff`.

## Browser login model

GitHub browser sign-in does **not** auto-provision a user or membership. The GitHub provider identity must already map to a live membership for `ACALYS_DASHBOARD_ORGANIZATION_ID`. This keeps the browser bridge from becoming an unreviewed invitation/provisioning system.

The callback never puts the durable session token in a redirect URL. Instead it creates a high-entropy `acalys_exchange_*` handle and persists only its SHA-256 hash plus exact organization/user/membership provenance in `dashboard_login_exchanges`.

Properties of the exchange:

- database-clock creation and expiry;
- short lived (2 minutes by default in the router);
- exact membership provenance;
- one-time redemption under row lock;
- membership deletion makes the exchange unusable;
- no recoverable session credential is persisted;
- the durable browser session is issued only after successful exchange redemption.

The web app stores the resulting bearer session in browser `sessionStorage`, not persistent `localStorage`, and routes all API-mode authenticated pages through `DashboardSessionGate`. Logout revokes the durable session and clears the browser copy.

## Membership/RBAC rules

- Any live session can read the organization member list.
- Only `owner` and `admin` actors may change roles.
- An admin cannot change an owner or promote anyone to owner.
- The final owner cannot be demoted.
- Role writes are serialized per organization with a Postgres advisory transaction lock.
- Mutation authority is evaluated from the live membership inside the write transaction.

Invitations and automatic membership onboarding are intentionally unavailable in Checkpoint 4.3 because no approved durable invitation contract exists yet.

## API-key administration

The dashboard uses the Phase-3 credential ledger rather than a parallel key store.

- Full API-key tokens are generated once and only the SHA-256 hash is persisted.
- Non-admin users see only their own user-bound keys.
- Owners/admins may also see organization and member keys.
- Organization-owned key creation requires a live owner/admin membership.
- No actor may mint a key role above their live membership role.
- Read-only members are not offered write scopes by the browser UI.
- Authentication still intersects stored scopes with the key's effective role, preserving the Phase-3 role ceiling.
- Revocation is tenant scoped and authorized from live membership state inside the transaction.
- The full token is returned only in the successful creation response and dashboard responses are explicitly `no-store`.

## Provider connections and settings

`/integrations` reads already persisted `provider_connections` records. Adding new provider connections remains owned by the later provider-integration phases.

`/settings` projects the live provider identity and organization. Notification preferences do not yet have a durable backend model and remain disabled.

`/organization/settings/*` retains the existing visual design in fixture/demo mode. In API mode it is intentionally read-only because review policy, cache, pre-merge and specialized feature settings belong to later backend phases. The page does not save browser-local state and present it as organization truth.

## Deployment configuration

Dashboard administration is optional. Product-API-only deployments continue to boot without dashboard variables.

To enable the dashboard bridge, both of these must be configured together:

- `ACALYS_DASHBOARD_ORGANIZATION_ID`
- `ACALYS_DASHBOARD_WEB_ORIGIN`

GitHub sign-in is optional inside that bridge. If any GitHub OAuth variable is set, all four are required:

- `ACALYS_GITHUB_OAUTH_CLIENT_ID`
- `ACALYS_GITHUB_OAUTH_CLIENT_SECRET`
- `ACALYS_GITHUB_OAUTH_STATE_SECRET`
- `ACALYS_GITHUB_OAUTH_CALLBACK_URL`

`ACALYS_DASHBOARD_COOKIE_SECURE` defaults to `true`. Production deployments should keep it enabled.

## Acceptance boundary

Checkpoint 4.3 freezes the dashboard source contract and source/Postgres witness suites. This container still cannot install the complete locked workspace dependency tree or launch Docker/Postgres, so Vitest/Postgres/Playwright execution is not claimed here. The executable UI/browser acceptance remains Checkpoint 4.5.
