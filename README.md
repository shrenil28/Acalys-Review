# Acalys Review

Acalys Review is a multi-tenant GitHub/GitLab code-review platform. It accepts signed
provider webhooks, schedules asynchronous reviews, runs evidence-backed AI review
agents, verifies findings, publishes results, and exposes an authenticated dashboard.

The repository currently implements Phases 0–4: canonical contracts, persistence and
queueing, provider ingestion, the review pipeline, and the live dashboard/admin surface.
Future roadmap items are intentionally outside this release boundary.

## Production acceptance

Node.js 22 and PostgreSQL 16 are the supported baseline. Docker is required by the full
acceptance suite because integration tests use a real disposable PostgreSQL instance.

```bash
npm ci
ACALYS_REQUIRE_POSTGRES=1 npm run accept:phase4
```

The acceptance command is fail-closed and covers types, lint, formatting, dependency
boundaries, generated schemas, clean production builds, export conformance, source
invariants, and the complete PostgreSQL-backed test suite. CI runs the same command on
the repository's `master` branch and uploads diagnostics on failure.

Useful individual gates:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run depcruise
npm run test:ci
npm run build:clean
```

## Configuration

Copy `.env.example` to `.env` and replace every placeholder. Production secrets must be
provided by the deployment platform's secret manager, never committed. Startup fails
when required configuration is absent or malformed.

Important settings include:

- `DATABASE_URL` and `ACALYS_API_CURSOR_SECRET`
- GitHub App and/or GitLab OAuth credentials
- `GITHUB_WEBHOOK_SECRET` (and optionally
  `ACALYS_GITHUB_WEBHOOK_PREVIOUS_SECRETS` during rotation)
- model-provider, replay, and worker-polling settings
- `ACALYS_INTEGRATION_CREDENTIAL_KEYS_JSON` when encrypted integration credentials are enabled
- the OAuth callback/web origins and `VITE_ACALYS_API_URL`

See [.env.example](.env.example) for the complete implemented surface.

## Database migrations

Build and apply migrations before starting a new release:

```bash
npm run build --workspace=@acalys/database
npm run build --workspace=@acalys/api
DATABASE_URL=postgresql://... npm run migrate --workspace=@acalys/api
```

Migrations are applied in filename order under a PostgreSQL advisory lock. Applied
versions and SHA-256 checksums are recorded in `acalys_schema_migrations`; changing an
already-applied migration is rejected.

For a new installation, create the first organization and owner after migrating. The
owner provider id must match the immutable GitHub/GitLab user id returned by OAuth:

```bash
DATABASE_URL=postgresql://... \
ACALYS_BOOTSTRAP_ORGANIZATION_ID=00000000-0000-7000-8000-000000000001 \
ACALYS_BOOTSTRAP_ORGANIZATION_SLUG=example \
ACALYS_BOOTSTRAP_ORGANIZATION_NAME=Example \
ACALYS_BOOTSTRAP_OWNER_PROVIDER=github \
ACALYS_BOOTSTRAP_OWNER_PROVIDER_USER_ID=123456 \
npm run bootstrap --workspace=@acalys/api
```

## Running services

After `npm run build:clean`, start each implemented process independently:

```bash
npm run start --workspace=@acalys/api
npm run start --workspace=@acalys/webhook-gateway
npm run start --workspace=@acalys/review-worker
npm run preview --workspace=apps/web
```

The API and webhook gateway expose `/healthz` for liveness and `/readyz` for dependency
readiness. They use bounded request/shutdown timeouts and drain connections on SIGTERM or
SIGINT. The worker is an asynchronous process and exits non-zero on startup failure.

For a local production-shaped stack:

```bash
cp .env.example .env
# Replace all placeholder secrets and provider credentials.
docker compose up --build
```

The Compose stack runs PostgreSQL, applies migrations once, then starts the API, webhook
gateway, review worker, and the nginx-served production dashboard. The web container is
published at `http://localhost:8082`, the API at `http://localhost:8080`, and webhooks at
`http://localhost:8081`.

## Architecture

Provider-specific representations terminate at adapters. All internal services exchange
canonical contracts from `@acalys/contracts`:

```text
GitHub PR / GitLab MR
        │
        ▼
webhook-gateway → PostgreSQL inbox/queue → review-worker → verification/publication
                                              │
                                              ▼
                                  API → authenticated web dashboard
```

Long-running review work never blocks an HTTP request. Tenant identity is carried through
database and queue boundaries, provider credentials are encrypted at rest, webhook
signatures are verified before persistence, and publication is idempotent.

## Repository layout

```text
apps/api                 authenticated HTTP API and OAuth callbacks
apps/webhook-gateway     signed provider-webhook ingress
apps/review-worker       review orchestration worker
apps/web                 React/Vite dashboard
packages/contracts       canonical domain, API, and internal contracts
packages/database        PostgreSQL repositories and migrations
packages/providers       GitHub/GitLab adapters
packages/review-engine   review pipeline and agent orchestration
packages/model-gateway   model routing, limits, and replay protection
```

Architectural boundaries are enforced by dependency-cruiser and TypeScript project
references. Generated JSON schemas are checked into source and verified for drift.

## Release note

Phase 4 is merged into the local `master` history. Before declaring an externally
deployed release, the accepted commit must be pushed to the protected remote `master`
branch and deployment-specific secrets, TLS, backups, monitoring, and alerting must be
configured in the target environment.
