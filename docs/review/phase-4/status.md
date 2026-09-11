# Phase 4 status

## Checkpoint 4.1 — live data foundation + repository/knowledge surfaces

Status: **SOURCE FROZEN**
Date: **2026-09-09**
Base: **Phase 3 FINAL implementation-complete full archive**

This checkpoint is the first of at most five substantial Phase-4 checkpoints. It establishes the dashboard integration boundary without redesigning the existing Acalys UI and without fabricating backend capabilities that belong to later phases.

### Delivered

- Complete rendered page → capability → owning-phase → current-backing inventory for every route declared by `apps/web/src/router.tsx`.
- Explicit Phase-4 plan capped at five checkpoints.
- A reusable live dashboard adapter for repository and knowledge reads using the frozen Phase-3 API contracts.
- A four-way live result boundary that preserves transport, contract, rejected/auth/throttle, and misconfiguration failures instead of collapsing them into empty data.
- Ref-counted shared request pooling for read-only dashboard data:
  - concurrent consumers deduplicate onto one request;
  - a pending request is aborted only after its final consumer releases it;
  - successful results may be reused for a short TTL;
  - failed results are not retained for the success TTL.
- Explicit fixture mode preserved through dynamic imports; connected production/API-mode surfaces do not statically import fixtures.
- Live repository data wired into:
  - `/review/repositories`;
  - `/review/repositories/:name`;
  - `/security/repositories`;
  - shared analytics repository filtering.
- Live knowledge data wired into:
  - `/review/learnings`;
  - repository detail knowledge presentation;
  - `/analytics/pr-reviews/knowledge-base`.
- Knowledge `organization`, `repository`, and `path` scopes preserved semantically.
- Later-owned analytics/security values are represented as unavailable (`—` / explicit unavailable state) rather than synthesized from fixtures in API mode.
- Controls that have no live mutation contract in the frozen API are disabled rather than pretending to persist.
- Fixture-heavy analytics/repository fragments used by connected surfaces are isolated into demo-only lazy chunks.
- Reusable loading, failure, misconfigured, empty, and filtered-empty state components established for live surfaces.

### Source acceptance evidence

Executed from the frozen Checkpoint-4.1 tree:

- `node scripts/probe-phase4-live-foundation.mjs` — **PASS**
  - 57 router path declarations inventoried;
  - 6 connected production surfaces checked for fixture/transport/contract-boundary violations;
  - 5/5 live-adapter semantic witnesses present.
- `node scripts/accept-phase3.mjs --preflight-only` — **PASS**
  - all frozen Phase-3 source invariants and all 15 Phase-3 preflights remain green.
- TypeScript/TSX parser audit using the installed TypeScript parser — **541 files parsed, 0 syntax diagnostics**.
- `package-lock.json` SHA-256 remains:
  - `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- Generated dependency/build artifacts retained in the checkpoint tree — **0** (`node_modules`, `dist`, `build`, `.next`, `coverage`, `*.tsbuildinfo`).
- No Phase-3 API route/contract/database migration change is part of Checkpoint 4.1.

### Executable acceptance limitation in this container

A real workspace dependency installation was retried:

```text
npm ci --offline --ignore-scripts --no-audit --no-fund
→ ENOTCACHED: yallist
```

The container therefore still lacks the repository's frontend dependency tree needed to execute Vitest/Vite/React typecheck/build/Playwright here. Checkpoint 4.1 does **not** claim those executable gates. The source probes are fail-closed and the missing executable evidence is intentionally deferred to the Phase-4 acceptance checkpoint in an environment with the locked dependencies available.

### Checkpoint boundary

Checkpoint 4.1 intentionally does **not** invent or implement later-phase product backends. The following remain owned by later Phase-4 checkpoints or later product phases, as recorded in `page-capability-inventory.md`:

- core PR/review/SSE workflow wiring — Checkpoint 4.2;
- browser/admin auth, membership, API-key and settings integration — Checkpoint 4.3 subject to an approved contract;
- production fixture firewall for all remaining later-owned pages — Checkpoint 4.4;
- executable UI/CDP/Playwright/performance acceptance — Checkpoint 4.5;
- feature data owned by Phases 5–14 remains deferred rather than fabricated.

**PHASE 4 — CHECKPOINT 4.1 SOURCE FROZEN.**

## Checkpoint 4.2 — core review workflow

Status: **SOURCE FROZEN**
Date: **2026-09-09**
Base: **Phase 4 Checkpoint 4.1 full archive**

This checkpoint connects the core review path end to end against the frozen Phase-3 contract while preserving the existing Acalys visual system and keeping later-owned analytics explicitly unavailable.

### Delivered

- Production/API-mode `/review/triage` no longer statically imports review fixtures; explicit fixture mode lazy-loads the original triage implementation.
- Live pull-request discovery across connected repositories, with exhaustive cursor traversal and repository fan-out capped at four concurrent collectors.
- Reusable review-workflow adapter above the centralized validated API client; pages do not call the transport or import HTTP DTO schemas directly.
- Live review mutations with per-operation `Idempotency-Key` values:
  - create review;
  - cancel review;
  - dismiss a published finding with a non-empty reason;
  - resolve an open conversation.
- Authenticated browser SSE using `fetch` streaming rather than `EventSource`, preserving bearer authorization and `Last-Event-ID` resumption.
- SSE parser and reconnect policy that:
  - ignores heartbeat comments;
  - validates every product frame;
  - rejects a foreign review-run ID;
  - resumes from the last durable event ID;
  - retries transport/429/server failures with bounded backoff;
  - fails closed on contract failures and non-retryable 4xx responses.
- Review run ID persisted in the triage URL and rehydrated through `GET /reviews/:id` after reload; repository/pull-request ownership is checked before accepting the run.
- Review queueing blocked while URL-backed run rehydration is in flight, preventing duplicate user starts during reload recovery.
- Settled artifact loading for summary, findings, pre-merge checks and pull-request conversations.
- Pre-merge check `status` and `blocking` retained as separate meanings; an empty check set renders merge permission as unknown rather than approved.
- Conservative stale-result warning when the live pull request was updated after the run was created. Exact revision comparison is not claimed because the frozen public frontend contract does not expose a review revision ID.
- Loading, misconfigured, failed, true-empty and filtered-empty triage states.
- Unsupported risk, priority, reviewer assignment, diff-statistics and effort fields remain explicitly unavailable rather than sourced from fixtures.

Detailed transport/lifecycle decisions are recorded in `docs/review/phase-4/core-review-workflow.md`.

### Source acceptance evidence

Executed from the final Checkpoint-4.2 source tree:

- `node scripts/probe-phase4-review-workflow.mjs` — **PASS**
  - 13 adapter invariants;
  - 9 focused transport/workflow witness anchors;
  - five-state live triage present;
  - URL-backed review-run persistence present.
- `node scripts/probe-phase4-live-foundation.mjs` — **PASS**
  - Checkpoint-4.1 live-data boundary remains intact.
- `node scripts/accept-phase3.mjs --preflight-only` — **PASS**
  - frozen backend/API source invariants remain intact.
- TypeScript/TSX parser audit using the installed TypeScript 5.8.3 parser — **547 files parsed, 0 syntax diagnostics**.
- API-mode triage/review adapter fixture-firewall scan — **PASS**.
- `package-lock.json` remains byte-identical to Checkpoint 4.1 with SHA-256:
  - `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- No Phase-3 API route, DTO, database migration or review-worker implementation was changed by Checkpoint 4.2.

### Executable acceptance limitation in this container

A real workspace dependency installation was reproduced after the final workflow implementation:

```text
npm ci --offline --ignore-scripts --no-audit --no-fund
→ ENOTCACHED: yallist
```

The repository's React/Vite/Vitest dependency tree is therefore unavailable in this container. The new Vitest source cannot be honestly claimed as executed here, and full TypeScript/Vite/Playwright gates remain reserved for Checkpoint 4.5 in an environment with the locked dependency artifacts available. The source probes are dependency-free and fail closed.

### Known contract limitation

If `POST /reviews` returns `409`, the frozen Phase-3 public error contract does not include the ID of the already-active review. The dashboard surfaces the conflict but cannot attach to that run from the conflict response alone. A successfully created/known run is reload-safe through the URL-backed review ID described above. No unapproved API field or route was added to work around this.

**PHASE 4 — CHECKPOINT 4.2 SOURCE FROZEN.**

## Checkpoint 4.3 — browser/admin auth, membership and API-key integration

Status: **SOURCE FROZEN**
Date: **2026-09-09**
Base: **Phase 4 Checkpoint 4.2 full archive**

Checkpoint 4.3 adds the browser/admin contract required by the existing login/account/settings surfaces without changing the frozen Phase-3 product API. The dashboard bridge is a separate `/dashboard/v1` surface and remains optional for product-API-only deployments.

### Delivered

- A separately frozen **13-route `/dashboard/v1` browser/admin contract**; the Phase-3 `/api/v1` manifest remains exactly 14 routes.
- GitHub browser sign-in bridge with:
  - provider OAuth state + HttpOnly nonce binding;
  - application-relative `returnTo` validation;
  - pre-provisioned membership requirement (no implicit user/membership onboarding);
  - high-entropy one-time exchange handles;
  - persistence of only the exchange SHA-256 hash plus exact organization/user/membership provenance;
  - database-clock expiry;
  - single-use redemption under row lock;
  - no recoverable session credential stored in the exchange table;
  - durable session issuance only after successful exchange redemption.
- Migration `0019_phase4_dashboard_admin.sql` for `dashboard_login_exchanges`.
- Authenticated dashboard shell gate in API mode:
  - exchange redemption;
  - browser session validation;
  - unauthorized redirect to `/login` with return path;
  - session token held in `sessionStorage`, not persistent `localStorage`;
  - durable logout/revocation + browser-token clearing.
- Optional dashboard deployment configuration:
  - Phase-3 product API still boots without dashboard variables;
  - organization ID and web origin must be configured together when dashboard administration is enabled;
  - partial GitHub OAuth configuration fails startup.
- Strict browser CORS for the configured dashboard web origin.
- Dashboard responses marked `Cache-Control: no-store`, `Pragma: no-cache`, and `X-Content-Type-Options: nosniff`, including one-time session/API-key material.
- Dashboard body/UUID validation fails as `400 VALIDATION_ERROR` before persistence instead of surfacing PostgreSQL UUID failures as `500`.
- Live `/settings` identity/organization projection; provider-owned identity remains read-only and notifications remain disabled because no durable preference model exists.
- Live `/settings/team` membership/RBAC:
  - owner/admin mutation authority evaluated from the live membership in the transaction;
  - organization-scoped advisory serialization;
  - admins cannot alter/promote owners;
  - final owner cannot be demoted;
  - invitations remain unavailable without an approved invitation contract.
- Live `/settings/api-keys` against the Phase-3 credential ledger:
  - list visibility scoped by live actor role/ownership;
  - full token returned only once;
  - hash-only persistence;
  - organization-owned creation limited to owner/admin actors;
  - key role cannot exceed the live actor membership role;
  - read-only browser members are not offered write scopes;
  - tenant-safe actor-authorized revocation.
- Live `/integrations` projection of already persisted provider connections; adding providers remains owned by later integration phases.
- `/organization/settings/*` explicitly read-only in API mode because review/cache/pre-merge/specialized settings do not yet have an approved durable contract. Browser-local settings are not presented as organization truth.
- Original fixture/demo implementations for login/team/API-keys/account settings/integrations preserved behind explicit demo-mode lazy wrappers.

The contract/security rationale and deployment variables are documented in `docs/review/phase-4/dashboard-admin.md`.

### Source acceptance evidence

Executed from the final Checkpoint-4.3 source tree:

- `node scripts/probe-phase4-dashboard-admin.mjs` — **PASS**
  - **20** dashboard/admin invariants;
  - exact **13-route** dashboard contract;
  - one-time hash-only exchange boundary;
  - membership RBAC/last-owner guard;
  - transactional API-key authorization + role ceiling;
  - strict CORS, no-store and validation boundary;
  - authenticated shell/page adapter fixture firewall;
  - frozen 14-route product API remains unchanged;
  - dashboard HTTP/Postgres witness source present.
- `node scripts/probe-phase4-review-workflow.mjs` — **PASS** (4.2 remains intact).
- `node scripts/probe-phase4-live-foundation.mjs` — **PASS** (4.1 remains intact).
- `npm run accept:phase3:preflight --silent` — **PASS**; all frozen Phase-3 source invariants remain green.
- TypeScript/TSX parser audit using installed TypeScript 5.8.3 — **561 files parsed, 0 syntax diagnostics**.
- `package-lock.json` remains byte-identical to Checkpoint 4.2 with SHA-256:
  - `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- No generated dependency/build artifacts are retained in the frozen tree.

Focused executable witness source added in this checkpoint:

- API HTTP boundary: **4 cases** (`apps/api/tests/dashboard-admin.test.ts`);
- Postgres dashboard administration: **4 cases** (`packages/database/tests/phase4-dashboard-admin.test.ts`);
- browser adapter: **2 cases** (`apps/web/tests/dashboard-admin.test.ts`).

### Executable acceptance limitation in this container

The locked workspace dependency installation was reproduced after final hardening:

```text
npm ci --offline --ignore-scripts --no-audit --no-fund
→ ENOTCACHED: yallist
```

The repository's local Vitest/Vite/React dependency tree therefore remains unavailable, and Docker/Postgres is not available in this environment. The new HTTP/Postgres/web Vitest sources are not falsely claimed as executed. Their execution plus browser/Playwright/CDP validation remains part of Phase-4 Checkpoint 4.5.

### Checkpoint boundary

Checkpoint 4.3 deliberately does not implement invitation workflows, SAML, notification preference persistence, organization review-policy persistence, or provider onboarding that belongs to later phases. It provides only the browser/admin capabilities backed by existing Phase-3 identity/credential state plus the minimal one-time browser exchange ledger.

**PHASE 4 — CHECKPOINT 4.3 SOURCE FROZEN.**

## Checkpoint 4.4 — production fixture firewall + remaining supported page wiring

Status: **SOURCE FROZEN**
Date: **2026-09-09**
Base: **Phase 4 Checkpoint 4.3 full archive**

Checkpoint 4.4 closes the production fixture boundary across the remaining dashboard without implementing later-phase product backends. Existing demo interfaces are preserved, but they are now lazy fixture-only modules; API mode renders truthful deferred/read-only states and the authenticated shell projects live session identity instead of demo identity.

### Delivered

- Shared `DeferredFeaturePage` boundary for later-owned routes:
  - explicit fixture mode lazy-loads the original UI;
  - API mode renders an unavailable/deferred state naming the owning roadmap phase;
  - misconfigured production renders the existing fail-closed configuration state;
  - no later-owned route substitutes fixture facts for missing live contracts.
- **19 later-owned wrapper modules** now isolate the original fixture UI, covering overview, analytics, reports, review cache, security, Slack/Discord and planner groups.
- **35 later-owned route declarations** remain present and are explicitly accounted for rather than removed from navigation/router coverage.
- Organization review settings keep the Checkpoint-4.3 API-mode read-only contract while the original editable demo implementation is now lazy fixture-only.
- Authenticated shell fixture cleanup:
  - live user identity/role/organization in `UserMenu`;
  - live current organization in `WorkspaceSwitcher`, with no fabricated multi-org switching;
  - live organization breadcrumb label;
  - demo session/workspace data reachable only through fixture-mode lazy/dynamic imports.
- Repaired a latent Checkpoint-4.3 named-export defect: `resolveDataConfig` now aliases the canonical fail-closed `resolveDataMode` implementation rather than leaving browser/admin imports unresolved.
- Added a dependency-free production import-graph firewall probe and focused Vitest configuration witnesses.
- Original Acalys fixture screens remain available for explicitly authorized demo mode; the checkpoint does not redesign or delete them.

Detailed route/shell decisions are recorded in `docs/review/phase-4/production-fixture-firewall.md` and `page-capability-inventory.md`.

### Source acceptance evidence

Executed from the final Checkpoint-4.4 source tree:

- `node scripts/probe-phase4-fixture-firewall.mjs` — **PASS (7 invariants)**:
  - production static graph fixture-free (**81 modules**);
  - **19** later-owned wrappers lazy + deferred;
  - authenticated shell free of static demo identity imports;
  - organization settings fixture isolated behind the API read-only boundary;
  - 4.3 `resolveDataConfig` regression repaired;
  - **35** later-owned route declarations accounted for;
  - **28** fixture UI modules isolated from the production static graph.
- `node scripts/probe-phase4-dashboard-admin.mjs` — **PASS (20 invariants)**.
- `node scripts/probe-phase4-review-workflow.mjs` — **PASS**; 4.2 workflow boundary remains intact.
- `node scripts/probe-phase4-live-foundation.mjs` — **PASS**; 4.1 live-data boundary remains intact.
- `node scripts/accept-phase3.mjs --preflight-only` — **PASS**; all frozen Phase-3 source/preflight invariants remain green.
- TypeScript/TSX syntax parser audit using installed TypeScript 5.8.3 — **584 files parsed, 0 syntax diagnostics**.
- `package-lock.json` remains byte-identical to Checkpoint 4.3 with SHA-256:
  - `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- No Phase-3 product API route, `/dashboard/v1` route, database migration, or package-lock dependency change is part of Checkpoint 4.4.

### Executable acceptance limitation in this container

The known locked-dependency limitation remains unchanged: the offline workspace install lacks cached `yallist`, so Vitest/React/Vite/project typecheck/build/Playwright cannot be honestly claimed as executed here. PostgreSQL/Docker execution is likewise unavailable. Checkpoint 4.4 therefore distinguishes source-probe **PASS** from dependency-backed/browser **UNVERIFIED** gates.

The focused `apps/web/tests/fixture-firewall.test.ts` witness source is authored but unexecuted here. Checkpoint 4.5 is intentionally reserved for dependency-backed executable acceptance, Playwright/CDP visual comparison, five-state/browser flow coverage, cancellation/dedup validation and performance measurement.

### Checkpoint boundary

No Phase 5–14 feature backend was implemented. In particular, Phase 13 analytics/report aggregation, cache operations, deep security tooling, Slack/Discord runtime behavior, and the planner roadmap gap remain owned by their recorded future phases. The only remaining Phase-4 checkpoint is **4.5 — final executable/browser/Playwright/CDP/performance acceptance**.

**PHASE 4 — CHECKPOINT 4.4 SOURCE FROZEN.**

## Checkpoint 4.5 — acceptance attempt / scope re-opened

Status: **SUPERSEDED BY 4.6 PRODUCTION COMPLETION**  
Date: **2026-09-10**

Checkpoint 4.5 had originally been reserved as a dependency-backed/browser-only acceptance pass over the 4.4 boundary. During recovery and end-to-end dashboard verification, that assumption proved too narrow: multiple pages that were intentionally deferred in 4.4 now had approved durable contracts and production implementations available. Rather than certify a knowingly incomplete dashboard, Phase 4 was re-opened as Checkpoint 4.6 and the new backend-backed surfaces were implemented and hardened there. The historical 4.1–4.4 statements remain accurate for their frozen source snapshots; 4.6 intentionally supersedes their then-deferred product boundary where a real contract now exists.

No standalone 4.5 source freeze is treated as the canonical Phase-4 endpoint.

## Checkpoint 4.6 — production completion + recovery hardening

Status: **FINAL SOURCE CANDIDATE — EXECUTABLE/BROWSER RELEASE WITNESSES PENDING**  
Date: **2026-09-11**  
Base: **Phase 4 Checkpoint 4.4 plus recovered 4.6 implementation**

Checkpoint 4.6 converts the recovered/in-progress tree into a fail-closed production source candidate. It does not turn unavailable infrastructure into a green check: dependency-backed unit/integration/build gates and browser/CDP validation remain explicitly pending until run in an environment with the locked npm dependency tree and Docker/Postgres.

### Delivered beyond the 4.4 boundary

- Durable integration credential/control plane for Linear, CircleCI, MCP and Jira configuration, with encrypted credential envelopes, credential-version compare-and-swap, provider identity verification where applicable, PKCE/state handling for Linear, and an untrusted external-data prompt boundary.
- Durable organization review policy plus repository overrides, effective-policy fingerprints, admission-time immutable snapshots, ignored-path enforcement, base-branch admission, repository pause/resume and abort-on-close publication fencing.
- Invitation-based membership provisioning, GitLab browser OAuth, live membership removal/revocation and organization-pinned browser sessions.
- Durable analytics team dimension and a shared live analytics read model spanning review, finding, pre-merge, knowledge, repository and author facts.
- Durable report definitions and immutable manual report snapshots while keeping recurring dispatch/delivery explicitly unavailable rather than simulated.
- Durable personal notification preferences with optimistic revision fencing.
- Database-authoritative repository metrics, 30-day trends and recent activity sourced from actual review/publication facts.
- Live security overview and persisted security findings with canonical finding dismissal lifecycle; deep scan remains a separate unimplemented capability.
- Durable deterministic review-analysis cache with runtime preload/write-through, metadata-only dashboard control and physical invalidation.

### Final hardening performed for source freeze

- Analytics list-shaped projections are now bounded in SQL to the exact public-contract maxima while summary counts continue to cover the complete filtered population. This prevents large organizations from converting valid database state into response-schema failures or unbounded process memory.
- Repository metric enumeration is bounded at the SQL boundary to the public 10,000-row contract maximum.
- Report definitions now have a serialized 500-definition organization cap and SQL-bounded listing. Manual report generation revalidates the actor's live owner/admin membership in the commit transaction after analytics snapshot computation, closing the authorization time-of-check/time-of-use window caused by a mid-generation demotion/removal.
- Cache payload size is now database-authoritative: migration `0028_phase4_analysis_cache_canonical_size.sql` repairs existing metadata and enforces `payload_bytes = octet_length(payload::text)` with a 1 MiB canonical JSONB ceiling. Application writes derive the persisted size from the exact JSONB value instead of trusting caller metadata.
- Cache preload uses a 32 MiB aggregate SQL budget in addition to the 1 MiB per-entry ceiling; metadata enumeration and touch/write batches are bounded; touch fingerprints are validated before reaching PostgreSQL.
- Added focused Postgres/HTTP witness source for report authorization revalidation, report-definition quota behavior, canonical cache-size enforcement and cache touch validation.
- Added one authoritative `scripts/accept-phase4.mjs` runner plus npm aliases for all eleven Phase-4 source probes. The runner chains the frozen Phase-3 preflight and fails closed in full mode unless Vitest, TypeScript, ESLint, Prettier, dependency-cruiser and Docker/Postgres are actually available.

### Source acceptance evidence

Executed from the final-source candidate tree:

- `node scripts/accept-phase4.mjs --preflight-only` — **PASS**.
  - all **11 Phase-4 probes** pass;
  - inherited `node scripts/accept-phase3.mjs --preflight-only` passes in full;
  - production fixture firewall remains green with **96 production modules** and zero static fixture reachability.
- TypeScript/TSX parser sweep using the available TypeScript parser — **626 files parsed, 0 syntax diagnostics**.
- Full `node scripts/accept-phase4.mjs` — **BLOCKED (exit 2), fail-closed before executable gates** because this container has no repository-local Vitest/dependency-cruiser/TypeScript/ESLint/Prettier installation and no Docker/Postgres runtime. No blocked gate is counted as passed.
- Locked offline npm installation remains unavailable because the local cache is missing `yallist`; a partial dependency tree is not retained in the source archive.

### Release boundary

The Phase-4 source implementation is frozen as a **final source candidate**, not falsely labeled fully release-accepted. Before production release, run:

```bash
npm ci
npm run accept:phase4
```

in the supported dependency/Docker environment, then perform the browser/CDP release witness over the built dashboard: authenticated login/session rehydration, live PR review + SSE reconnect/reload, cancellation/dedup, membership/invitation/API-key flows, organization/repository settings, integrations, analytics, reports, notifications, cache deletion and security finding dismissal. Browser validation must use API mode and must not enable fixture/demo mode.

If those external gates are green, this 4.6 source candidate is the intended Phase-4 completion baseline; failures must be fixed rather than waived.

**PHASE 4 — CHECKPOINT 4.6 FINAL SOURCE CANDIDATE.**
