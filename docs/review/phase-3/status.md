# Phase 3 status

Phase 3 started from checkpoint `b0252db` plus the uncommitted Phase-2 working tree.

The frozen capability contract is `capability-contract.md`. Implementation must not add public HTTP routes outside the Phase-0 `API_ROUTES` + `REVIEW_EVENTS_STREAM` contract. The only known contract gap is the browser-facing GitHub OAuth start/callback surface: the Phase-3 brief asks for it, but the frozen route manifest does not define it. The auth service may be built now; mounting browser routes waits for an approved contract addition.

## Checkpoint 3.1 — API boundary + authentication/tenant foundation

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE BLOCKED BY LOCAL TOOLING**

### Established in source

- `apps/api` implements all 14 frozen `API_ROUTES` and the frozen review SSE endpoint; no new public v1 route was added.
- Inbound params/query/body and successful outbound responses are validated by the frozen route schemas.
- Authentication is bearer-only through `@acalys/auth`; tenant scope comes from the authenticated principal, never caller-controlled organization input.
- Per-principal and per-organization rate windows share Postgres authority.
- Mutating routes require idempotency keys. Create-review, cancellation, finding dismissal, and conversation resolution now commit the idempotency record, mutation, and stored response in one database transaction.
- API review creation atomically creates the review request, queued run, and fenced `review_dispatch_job`. A revision-scoped advisory lock suppresses duplicate API starts without adding a global uniqueness rule that would prohibit legitimate shadow/alternate review runs.
- API-originated jobs are consumed in `apps/review-worker` through the same Phase-2 `ReviewExecutionPort`; `apps/api` does not import worker internals.
- Dispatch claims are generation-fenced. Coordination deferral restores the failure-attempt budget. Exhausted/permanent dispatch work dead-letters and moves an owned non-publishing run to `failed`; a run already in `publishing` is left to publication recovery.
- Correlation ids are returned to the caller and persisted on API-originated review requests.
- Cancellation and finding-dismissal reasons are persisted.
- SSE uses durable transition sequence ids for resume, validates projected progress payloads, emits product event names only, sends heartbeats, handles backpressure, and tears down on disconnect.
- `apps/web/src` is unchanged from the frozen Phase-2 checkpoint.

### Semantic test source added

- `apps/api/tests/app.test.ts`: manifest count, malformed-query short circuit, outbound contract refusal, route-scope enforcement.
- `apps/review-worker/tests/api-dispatch-worker.test.ts`: peer-owned verification is deferred rather than counted as execution failure.
- `packages/database/tests/phase3-api.test.ts`: transactional create/replay convergence, concurrent API start suppression, cross-tenant read isolation, stale dispatch-claim fencing.

These tests are written but were not executed in this environment.

### Static freeze evidence — 2026-09-09

- affected TypeScript files parsed: **104**
- parser diagnostics: **0**
- frozen route manifest entries: **14**
- missing route handlers: **0**
- missing touched relative imports: **0**
- touched package/lock dependency mismatches: **0**
- `apps/api` imports of review-worker internals: **0**
- direct `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Phase-2 checkpoint: **0**
- dependency-cruiser configuration: **parses**
- `npm install --package-lock-only --offline`: **exit 0**
- packaged `node_modules` directories: **0**

### Executable evidence not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` exits non-zero because npm package `yallist` is not cached. Docker and `psql` are unavailable. Consequently this checkpoint does **not** claim successful repository typecheck, Vitest/Postgres execution, mutation kills, or the nine-gate acceptance run. The Postgres cases above therefore remain source evidence until run in an environment with the required dependencies and database runtime.

### Mutations

Planted/executed: **0 / 0**. No mutation result is claimed.

### UI delta

None. `apps/web/src` is byte-identical to the Phase-2 checkpoint.

### Explicit non-claims

- This is not full Phase 3 completion.
- Browser GitHub OAuth start/callback routes are not mounted because the frozen public route manifest has no such routes; adding them still requires a contract addition.
- The current runtime intentionally rejects `depth`, `categories`, and `reviewDrafts` overrides with `409 REVIEW_OVERRIDES_NOT_AVAILABLE` rather than accepting fields it cannot yet honor.
- `POST /reviews` currently requires `pullRequestId`; the frozen request contract provides no alternate commit/local-tree target representation.
- No gate, Postgres result, mutation kill, or performance number is fabricated from static evidence.

## Checkpoint 3.2 — authentication/security hardening

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.2 does not add or widen the frozen HTTP surface. It hardens the credential and authorization boundary that Checkpoint 3.1 introduced and adds the missing Phase-3 acceptance witnesses.

### Security/correctness changes established in source

- User-bound API keys now require a live membership at authentication time. Removing the membership therefore invalidates the key instead of falling back to `read_only` tenant access.
- Session and API-key liveness checks and `last_used_at` updates are one SQL operation. A credential that is revoked, rotated, expired, or loses membership while waiting for the relevant database lock is not returned as an authenticated principal and is not touched afterwards by a separate race-prone write.
- Session revocation is organization-scoped. API-key revocation remains organization-scoped.
- API keys persist an issuance role. For user-bound keys, effective authority is the lower of that issuance role and the current membership role; membership downgrade takes effect immediately and membership upgrade cannot silently widen an older key. Organization-owned CI/service keys use their explicit stored role.
- Existing API keys migrate with a fail-closed `read_only` role ceiling through migration `0014_phase3_auth_hardening.sql`.
- Repeated GitHub OAuth identity upserts return the canonical existing user id, so membership/session creation cannot continue using a newly proposed id that lost an identity uniqueness race.
- GitHub OAuth state verification supports a caller-bound nonce, revalidates the application-relative return path, validates issuance time, supports state-secret rotation grace, and validates the configured GitHub App slug before constructing installation URLs.
- Credential rings keep active/previous secret material in ECMAScript private fields and redact ordinary stringification, JSON serialization, and Node object inspection.
- GitHub webhook signature verification accepts an active secret plus grace-period predecessor candidates without short-circuiting on candidate position; an empty generation is rejected.
- API-key issuance rejects empty names, empty/duplicate/unknown scopes, and invalid roles before persistence.
- The existing same-key/same-canonical-request idempotency witness is now paired with the previously missing same-key/different-request conflict witness.

### Acceptance witness source added

- `packages/auth/tests/auth.test.ts`: **12** unit tests covering credential redaction/grace, OAuth state nonce/rotation/App-slug/redirect validation, one-way credential hashing, atomic session authentication, API-key scope/role ceilings, tenant revocation forwarding, unknown scope rejection, and canonical OAuth-user reuse.
- `packages/database/tests/phase3-auth-store.test.ts`: **5** Postgres tests covering canonical identity upsert, atomic session use plus rotation/revocation, membership-removal invalidation without failed-auth touching, issuance/current-role ceiling behavior, and organization-owned CI-key revocation.
- `packages/providers/github/tests/signature.test.ts`: **2** additional webhook-secret-rotation cases.
- `packages/database/tests/phase3-api.test.ts`: adds the explicit idempotency digest-conflict case required by the Phase-3 contract.
- `scripts/mutate-phase3.mjs`: four acceptance mutants, one each for authentication liveness, tenant-scoped reads, idempotency digest binding, and successful-response validation. `--preflight-only` requires every anchor to match exactly once and every witness suite to exist before execution.

### Checkpoint 3.2 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **527 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- missing touched relative imports: **0**
- `apps/api` direct imports of review-worker internals: **0**
- direct `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.1 baseline: **0**
- dependency-cruiser configuration: **parses**
- Phase-3 mutation manifest source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- package-lock dependency parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- dependency-free credential-ring runtime smoke: **pass**
- dependency-free rotated-webhook-secret runtime smoke: **pass**
- packaged `node_modules` directories: **0**

### Executable evidence still not claimed

A full offline install still cannot be completed from this environment's npm cache. The repository-wide `npm ci --offline --ignore-scripts --no-audit --no-fund` stops on uncached `yallist`; a narrower auth/database/provider/webhook workspace attempt stops on uncached `zod@4.4.3`. Docker, Podman, and `psql` are unavailable. Therefore the new Vitest/Postgres witnesses, mutation kills, formatting/typechecking/build gates, and the Phase-3 nine-gate acceptance contract are **not** reported as passing here.

Mutation definitions planted: **4**. Mutation executions/kills claimed: **0 / 0**. The harness deliberately treats an unrun/skipped/broken witness as invalid evidence rather than as a kill.

### Checkpoint 3.2 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route was added. The browser GitHub OAuth start/callback contract gap from Checkpoint 3.1 remains explicit.
- No frontend product behavior was changed; `apps/web/src` remains frozen.
- No Postgres result, mutation kill, repository gate, or full Phase-3 acceptance result is inferred from static checks.

## Checkpoint 3.3 — API/SSE operational hardening + structural witnesses

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.3 closes remaining source-level gaps in Phase 3A/3C without widening the frozen HTTP contract or changing the frontend.

### API/SSE correctness changes established in source

- Structured API request logging is now implemented as a global boundary concern rather than per-handler ad hoc logging. Every request that reaches the Express application receives a bounded correlation id and emits one completion/abort record containing only method, frozen route name (or `unknown`), status, duration, correlation id, and authenticated principal/organization identifiers when available. Request bodies, query values, authorization headers, credentials, and provider payloads are not included.
- Caller-provided `X-Correlation-ID` values longer than the frozen identifier bound are not reflected or persisted; a platform UUID is minted instead. Valid caller correlation ids are preserved and still flow into API-originated review persistence.
- The SSE endpoint now uses the same rate-limit error mapping as normal routes. A denied review-events request therefore returns `429 RATE_LIMITED` before SSE headers rather than falling through to a generic `500`.
- SSE path parameters are validated with the frozen `REVIEW_EVENTS_STREAM.params` schema before the tenant event query. `Last-Event-ID` is validated as a non-negative safe integer instead of silently resetting malformed input to zero.
- The first tenant-scoped event query completes before SSE headers are flushed, so missing reviews and pre-stream database failures can still return the normal leak-free JSON error boundary.
- Every emitted durable event id is required to be a strictly increasing safe integer relative to the last acknowledged sequence. A regressing/duplicate store result is fail-closed instead of being serialized as a duplicate SSE frame.
- Backpressure handling now applies to both product frames and heartbeats. Waiting for `drain` also listens for transport close/error, preventing a disconnected client from leaving the handler suspended forever.
- Poll waits are interruptible by response close. Full batches are drained immediately rather than sleeping between 100-event pages.
- Once SSE headers are committed, an unexpected persistence/projection failure closes the transport instead of attempting to send an invalid JSON error over an established event stream. The client can reconnect using the last durable id it actually received.
- `X-Accel-Buffering: no` is set on the SSE response so common reverse-proxy deployments do not buffer progress frames.

### Acceptance witness source added/expanded

- `apps/api/tests/app.test.ts` now represents **37 parameterized/unit cases** at source level:
  - malformed-input rejection witnesses for **14 / 14** frozen routes, each proving the backing handler/store is not reached;
  - malformed-success-response rejection witnesses for **14 / 14** frozen routes;
  - route-scope short-circuiting;
  - structured correlation logging, malformed-JSON/unknown-route logging, and oversized-correlation replacement;
  - SSE rate-limit mapping, stream-param/`Last-Event-ID` validation, strict resume-after behavior, terminal close, and heartbeat behavior.
- `scripts/probe-phase3-architecture.mjs` adds the required Phase-3C planted-violation harness for:
  - `api-must-not-import-review-worker`;
  - `database-driver-only-in-database-package`.
    `--preflight-only` verifies both named dependency-cruiser rules exist without mutating a source archive. Execution requires an installed dependency-cruiser binary and a Git worktree, plants one forbidden edge at a time, requires the named rule to appear in the rejection, and restores the target in `finally`.
- The Phase-3 response-validation mutation anchor was updated after the API boundary refactor; `scripts/mutate-phase3.mjs --preflight-only` is again clean for all four frozen acceptance mutants.

### Checkpoint 3.3 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **527 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- missing touched relative imports: **0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` hash-manifest differences versus Checkpoint 3.2: **0**
- dependency-cruiser configuration: **parses**
- Phase-3 mutation manifest source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture probe source preflight: **2 / 2 named rules present**
- package-lock dependency parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- generated install/build directories retained in checkpoint: **0**

### Executable evidence still not claimed

A repository install still cannot be completed from the local npm cache. `npm ci --offline --ignore-scripts --no-audit --no-fund` stops on uncached `yallist`. Docker, Podman, and `psql` are unavailable. Therefore Vitest/Postgres execution, live dependency-cruiser planted-violation rejection, the four mutation kills, formatting/typechecking/build gates, and the complete nine-gate Phase-3 acceptance run are **not** reported as passing here.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural probes present: **2**. Structural planted-violation executions claimed: **0 / 2**.

### Checkpoint 3.3 non-claims

- This is not full Phase 3 completion.
- No public route was added; the browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- The runtime still intentionally rejects unsupported review overrides (`depth`, `categories`, `reviewDrafts`) rather than accepting fields it cannot honor.
- `POST /reviews` still requires `pullRequestId` because the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No Postgres result, live mutation kill, structural-rule execution, repository gate, or performance number is inferred from source/static evidence.

## Checkpoint 3.4 — tenant graph integrity + adversarial isolation witnesses

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.4 closes a database-boundary tenant-isolation gap left by the earlier route-level filters. Phase-3 API child tables denormalize `organization_id`, but several parent references were previously enforced only by a single resource id. That meant malformed internal SQL could theoretically create an organization-A row whose parent belonged to organization B. The HTTP queries still filtered by tenant, but the relational graph itself did not prove the stronger invariant required by the Phase-3 acceptance contract.

### Tenant-graph integrity established in source

- Migration `0015_phase3_tenant_graph_integrity.sql` adds **7** organization-qualified referenced-key indexes and **23** composite tenant foreign keys across the API-visible repository → pull request → revision → review → finding/summary/check/conversation/knowledge/dispatch graph.
- Every new tenant foreign key is added `NOT VALID` and then explicitly `VALIDATE CONSTRAINT`. Existing malformed rows therefore block migration instead of being silently grandfathered.
- Cascade behavior is preserved where the existing single-column relationship cascaded. Optional conversation pull-request/finding references use column-targeted `ON DELETE SET NULL` so the optional resource id can clear without erasing the non-null tenant key.
- `ApiStore.getReviewSummary` no longer trusts the opaque summary JSON for `reviewRunId`. The response identity is overwritten from the tenant-bound relational `review_run_id`, preventing stored JSON from smuggling a foreign run identifier through an otherwise tenant-scoped row.

### Adversarial Phase-3 isolation witness source

`packages/database/tests/phase3-tenant-integrity.test.ts` seeds the same API-visible resource classes in two organizations and supplies database-backed witnesses for the frozen isolation contract:

- all **23 / 23** composite tenant constraints exist and report `convalidated = true`;
- representative malformed cross-tenant repository, review-run, conversation, knowledge, and API-dispatch edges are rejected by their named composite foreign keys;
- own-tenant reads remain reachable while foreign repository, pull-request, review, review-summary, finding, pre-merge-check, conversation, knowledge, and review-event rows are hidden;
- a stale same-review event cursor returns no replay, and a foreign review id does not expose foreign SSE events;
- all four exposed Phase-3 mutations (`createReview`, `cancelReview`, `dismissFinding`, `resolveConversation`) return tenant-safe `404` results when given organization-B identifiers from an organization-A scope, and the foreign run/finding/conversation state remains unchanged.

`scripts/probe-phase3-tenant-graph.mjs` provides a fail-closed executable entry point. `--preflight-only` verifies the exact migration/witness inventory. Full mode requires installed Vitest dependencies and `ACALYS_REQUIRE_POSTGRES=1`; missing dependencies terminate non-zero and explicitly refuse to claim database evidence.

### Checkpoint 3.4 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **528 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- missing relative imports in the touched/new TypeScript/MJS source: **0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` differences versus Checkpoint 3.3: **0**
- `package-lock.json` differences versus Checkpoint 3.3: **0**
- dependency-cruiser and root package configuration: **parse**
- tenant-graph source preflight: **23 / 23 tenant FKs added; 23 / 23 validations present; 7 / 7 referenced-key indexes present; Postgres witness suite present**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- package-lock SHA-256 after parity probe: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- generated install/build directories retained in checkpoint: **0**

### Executable evidence still not claimed

A complete repository install remains impossible from this environment's npm cache. `npm ci --offline --ignore-scripts --no-audit --no-fund` exits non-zero on uncached package `yallist`. Docker, Podman, and `psql` are unavailable. The full tenant-graph probe therefore exits **2** after its source preflight because installed Vitest dependencies are absent, and it explicitly records that no executable database result is claimed.

Consequently this checkpoint does **not** claim Vitest/Postgres execution, live composite-FK rejection, the four mutation kills, dependency-cruiser planted-violation kills, formatting/typechecking/build gates, or the complete nine-gate Phase-3 acceptance run.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural probes present: **2**. Structural planted-violation executions claimed: **0 / 2**. Tenant-graph Postgres suite present: **1**. Tenant-graph Postgres suite executions claimed: **0 / 1**.

### Checkpoint 3.4 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route was added or changed.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No Postgres result, live mutation kill, structural-rule execution, repository gate, or performance number is inferred from source/static evidence.

## Checkpoint 3.5 — database-clock rate limiting + replica-safe dual-bucket admission

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.5 closes a correctness gap in the Phase-3 shared rate limiter. Earlier checkpoints persisted counters in Postgres, but the API process itself chose `window_start` from its local clock and consumed principal and organization buckets in two independent statements. Horizontally scaled replicas with clock skew could therefore disagree on the active fixed window, and an organization-level denial could still consume a principal's otherwise available budget.

### Shared rate-limit authority established in source

- `AuthStore.consumeApiRateLimits` now owns the complete principal + organization decision inside one Postgres transaction.
- `window_start` is derived from `date_trunc('minute', clock_timestamp())`; the API callback no longer accepts or forwards a process timestamp for rate limiting.
- Bucket lock order is always principal → organization. Concurrent requests for the same credential serialize on the principal row; different credentials converge on the organization row without reversing lock order.
- A request denied by its principal quota does not touch the organization bucket.
- A request that passes the principal quota but loses at the organization quota refunds its principal increment before commit. Organization exhaustion therefore cannot silently burn a credential's quota.
- Rejected counters are monotonic and bounded for a stable configuration: once the `limit + 1` sentinel is reached, repeated denied requests do not keep incrementing the hot row.
- Rolling configuration changes cannot lower an existing counter. This prevents a lower-limit replica from shrinking a bucket and a concurrently deployed higher-limit replica from later reopening quota that had already been consumed.
- Limit arguments are fail-closed unless they are positive safe integers.

### Acceptance witness source added

`packages/database/tests/phase3-rate-limit.test.ts` adds four Postgres witnesses:

1. the stored fixed window matches database time rather than caller/application time;
2. 20 concurrent admissions through multiple `AuthStore` instances produce exactly three successes for a principal limit of three, leave the organization count at three, and saturate the principal denial sentinel at four;
3. organization exhaustion rejects later principals while refunding/removing their principal buckets;
4. a rolling limit downgrade never lowers an existing counter, and restoring the higher limit continues from the prior observed count rather than an artificially reduced value.

`scripts/probe-phase3-rate-limit.mjs` provides a fail-closed source/execution entry point. `--preflight-only` verifies database-clock authority, removal of process-clock windowing from API bootstrap, transactional dual-bucket use, monotonic saturation, refund semantics, and all four Postgres witnesses. Full mode requires installed Vitest dependencies and `ACALYS_REQUIRE_POSTGRES=1`; missing dependencies terminate non-zero and explicitly refuse to claim executable evidence.

### Checkpoint 3.5 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **529 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- missing relative imports in touched/new TypeScript source: **0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` differences versus Checkpoint 3.4: **0**
- `package-lock.json` differences versus Checkpoint 3.4: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- Phase-3 rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- generated install/build directories retained in checkpoint: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` still exits non-zero because `yallist` is not cached. A bounded online `npm ci` attempt also failed to complete and populated no usable dependency cache. Docker, Podman, and `psql` remain unavailable. The full rate-limit probe therefore exits **2** after a successful source preflight because installed Vitest dependencies are absent, and it explicitly reports that no executable Postgres result is claimed.

Consequently this checkpoint does **not** claim Vitest/Postgres execution, live concurrent rate-limit results, the four Phase-3 mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural probes present: **2**. Structural planted-violation executions claimed: **0 / 2**. Tenant-graph Postgres suite executions claimed: **0 / 1**. Rate-limit Postgres suite executions claimed: **0 / 1**.

### Checkpoint 3.5 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route was added or changed.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No Postgres result, live mutation kill, structural-rule execution, repository gate, or performance number is inferred from source/static evidence.

## Checkpoint 3.6 — leak-free API error boundary + non-2xx contract validation

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.6 closes the remaining Phase-3A public error-boundary gap without changing the frozen route manifest or the frontend. Earlier checkpoints validated successful handler responses, but handler-generated non-2xx bodies were serialized directly, malformed JSON and undeclared `/api/v1` requests could fall through framework defaults, and a typed `AcalysError` message was trusted as public text. Those paths did not prove the frozen requirement that every API failure use the bounded `ApiErrorDto` and never expose stack traces, upstream bodies, raw database text, or other internal details.

### Error boundary established in source

- Every handler-generated non-2xx body is now parsed by the frozen `errorResponseSchema` before serialization. A malformed handler error body fails closed to the generic `INTERNAL_ERROR` DTO.
- `sendError` and mapped failures pass through the same schema-validated serializer, so all public API error paths share one bounded wire shape.
- The Express JSON parser has explicit projections for malformed JSON (`400`) and over-limit request bodies (`413`) before the framework can render default HTML/debug text or reflect parser internals.
- Undeclared `/api/v1` paths now return a schema-valid JSON `404` through the same boundary.
- All 12 platform `AcalysError` classes use an explicit public-message projection. Their stable code and retryability classification are retained, but the exception message itself is never forwarded to the caller.
- Native errors, arbitrary thrown values, and hostile Proxy values fail closed to a generic `INTERNAL_ERROR` without reading or interpolating their content. The classifier also guards the `instanceof` operations themselves because hostile proxies can trap prototype traversal.
- Request-validation field paths/messages are capped to the frozen contract limits before serialization.
- Correlation headers and structured request logging remain outside the body and continue to apply to malformed JSON and unknown-route failures.
- SSE behavior is unchanged after headers are committed: post-header failures still destroy the stream rather than attempting an invalid JSON error response.

### Acceptance witness source added/expanded

`apps/api/tests/app.test.ts` now additionally proves:

1. malformed handler non-2xx output is refused rather than serialized;
2. malformed JSON, oversized JSON, and unknown v1 routes all return schema-valid JSON errors and do not reflect request/parser/HTML text;
3. all **12 / 12** platform error classes project through the leak-free public taxonomy;
4. native errors and hostile thrown proxies cannot disclose their contents.

`scripts/probe-phase3-error-boundary.mjs` adds a fail-closed source/execution entry point. `--preflight-only` requires the non-2xx response schema boundary, explicit JSON-parser projections, JSON 404 boundary, public taxonomy projection, all 12 taxonomy witnesses, the malformed-handler witness, and the hostile-value witness. Full mode requires installed Vitest dependencies and exits non-zero when they are absent rather than converting source evidence into an execution claim.

### Checkpoint 3.6 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **529 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- undeclared public v1 handlers added by this checkpoint: **0**
- missing relative imports in touched/new TypeScript source: **0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.5: **0**
- `package-lock.json` differences versus Checkpoint 3.5: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- Phase-3 error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- Phase-3 rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- generated install/build directories retained in checkpoint: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` still exits non-zero because `yallist` is not cached. `node scripts/probe-phase3-error-boundary.mjs` therefore stops after its successful source preflight with exit code **2** because installed Vitest dependencies are absent. Docker, Podman, and `psql` remain unavailable from the checkpoint environment.

Consequently this checkpoint does **not** claim Vitest/API execution, Postgres execution, live mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural probes present: **2**. Structural planted-violation executions claimed: **0 / 2**. Error-boundary source probe: **1 / 1 preflight pass; 0 executable suite runs claimed**.

### Checkpoint 3.6 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route was added or changed.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No executable gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Checkpoint 3.7 — database-clock credential authority + durable membership provenance

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.7 closes replica-clock and credential-resurrection gaps in the Phase-3 authentication boundary without changing the frozen HTTP route manifest or frontend. Before this checkpoint, session/API-key liveness still accepted an API-process timestamp, session rotation authenticated and replaced a credential in separate transactions, and user-bound credentials were tied only to the current `(organization_id,user_id)` relationship. A removed-and-recreated membership could therefore make an old credential eligible again, while `api_keys.user_id ON DELETE SET NULL` could erase the only stored distinction between a deleted user's key and a genuinely organization-owned key.

### Database-owned credential authority established in source

- Session issuance, authentication, rotation, revocation, API-key issuance, authentication, and revocation no longer use the API replica's process clock for credential liveness. Postgres supplies `clock_timestamp()` inside the authoritative store operation.
- Authentication/rotation read the database clock only after acquiring all potentially blocking membership/credential locks. A credential that expires while waiting for a lock cannot be accepted against a stale pre-lock timestamp.
- Session rotation is now one `rotateSessionByHash` transaction: exact membership is fenced with `FOR SHARE`, the predecessor session is locked `FOR UPDATE`, liveness is checked against database time, the replacement is inserted with the same membership provenance, and the predecessor is marked rotated before commit. Membership removal cannot occur between authentication and replacement issuance.
- Session and user-bound API-key issuance require a live membership and persist that membership's exact immutable id. Deleting the membership clears only the FK referent; later rejoining creates a different membership id and cannot resurrect the old credential.
- `last_used_at` updates are monotonic through `GREATEST(COALESCE(last_used_at, at), at)` on session authentication/rotation and API-key authentication.
- User-bound API keys continue to apply the lower of the issuance-role ceiling and the currently locked membership role.

### Durable API-key ownership provenance

Migration `0016_phase3_credential_membership_integrity.sql` adds credential provenance that survives user/membership deletion:

- `auth_sessions.membership_id` references the exact authorizing membership with `ON DELETE SET NULL`; pre-existing sessions that cannot be attributed to a live membership are permanently revoked during migration.
- `api_keys.owner_kind` is constrained to `organization | user | legacy_unbound` and new keys are explicitly stamped by `AuthStore` at issuance.
- `api_keys.membership_id` records the exact membership for user-owned keys and is cleared on membership deletion without changing `owner_kind`.
- Existing NULL-user keys are deliberately classified `legacy_unbound` and revoked. Prior schema state cannot distinguish a true organization key from a deleted user's former key, so migration fails those ambiguous credentials closed instead of silently promoting them to organization ownership. Such legitimate legacy organization keys must be reissued once after upgrade.
- Orphaned user-owned keys are also revoked during migration. Runtime authentication independently refuses `legacy_unbound` rows and malformed owner/provenance shapes, including an injected unrevoked legacy row.

### Acceptance witness source added/expanded

`packages/auth/tests/auth.test.ts` now proves that a deliberately skewed API replica clock is not forwarded into session/API-key liveness, rotation is delegated to one atomic store operation, and API-key expiry/membership rejection is database-authoritative.

`packages/database/tests/phase3-auth-store.test.ts` now includes database-backed witnesses for:

1. database-clock session issuance/authentication and atomic rotation;
2. immediate user-key invalidation on membership removal without failed-auth `last_used_at` advancement;
3. no session/API-key resurrection after membership deletion and recreation;
4. deleted-user keys remaining user-owned tombstones rather than becoming organization keys;
5. refusal to issue user credentials without live membership plus database-clock API-key expiry validation;
6. role-ceiling behavior against current membership role;
7. explicit organization-owned CI-key provenance and tenant-scoped revocation;
8. fail-closed authentication of an injected, unrevoked `legacy_unbound` API-key row.

`scripts/probe-phase3-auth-clock.mjs` provides a fail-closed source/execution entry point. Its source preflight requires database-clock use, membership-before-credential locking, atomic hash-addressed rotation, monotonic last-use updates, explicit ownership stamping, both provenance FKs, legacy fail-closed migration/runtime behavior, and the focused unit/Postgres witnesses. Full mode requires installed Vitest dependencies and Docker; absent prerequisites terminate non-zero and do not become execution evidence.

The Phase-3 authentication mutant was also re-anchored to the new durable membership check (`owner_kind === "user"`). This keeps the four-mutation acceptance harness aimed at the current authorization boundary rather than the removed pre-Checkpoint-7 implementation.

### Checkpoint 3.7 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **529 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- public route/frontend additions in this checkpoint: **0**
- missing relative imports in touched/new TypeScript/MJS source: **0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.6: **0**
- `package-lock.json` byte differences versus Checkpoint 3.6: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- credential-authority source preflight: **pass; database clock + atomic rotation + durable provenance + legacy fail-closed ownership + 7 focused witness anchors present**
- Phase-3 error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- Phase-3 rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- generated install/build directories retained in checkpoint: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` still exits non-zero because `yallist` is not cached. Docker, Podman, and `psql` remain unavailable. The full credential-authority probe therefore cannot execute its Vitest/Postgres suites in this environment, and no database result is inferred from the source preflight.

Consequently this checkpoint does **not** claim Vitest/API execution, Postgres credential-race execution, live mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural probes present: **2**. Structural planted-violation executions claimed: **0 / 2**. Credential-authority source probe: **1 / 1 preflight pass; 0 executable suite runs claimed**.

### Checkpoint 3.7 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route was added or changed.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No executable gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Checkpoint 3.8 — database-clock mutation authority + monotonic durable writes

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.8 closes the remaining replica-clock dependency in the frozen Phase-3 mutating API boundary without changing the public HTTP manifest or frontend. Before this checkpoint, the API process attached its local `Date` to `IdempotencyIdentity`, and `ApiMutationStore` reused that process timestamp for idempotency rows, review/request/dispatch creation, cancellation completion/transitions, finding dismissal, conversation resolution, and returned DTO timestamps. Clock-skewed API replicas could therefore disagree about durable chronology, and a writer that waited behind newer durable state could move an update timestamp backward.

### Database-owned mutation chronology established in source

- `IdempotencyIdentity` no longer contains a timestamp. `apps/api` therefore cannot inject a replica clock into persistence through the production mutation path.
- Each `ApiMutationStore` transaction acquires exactly one `clock_timestamp()` value from Postgres and passes that database-owned instant through the idempotent mutation callback.
- A create-review mutation uses that one instant for `api_idempotency.created_at/completed_at`, `review_requests.requested_at`, `review_runs.created_at`, all `review_dispatch_jobs` scheduling/audit timestamps, and the returned `ReviewRunDto.createdAt`.
- Same-key replay therefore returns the original database-timestamped response rather than recomputing chronology on the replica handling the retry.
- Cancellation keeps durable history monotonic with `GREATEST(database_mutation_time, created_at, started_at)` and uses the persisted completion timestamp for both the cancellation transition and returned DTO.
- Finding dismissal and conversation resolution use `GREATEST(existing updated_at, database_mutation_time)` so a transaction that waited behind another writer cannot move `updated_at` backward. Conversation output is projected from the persisted returned timestamp rather than from an application clock.
- The older `ApiStore` mutation/idempotency compatibility helpers were also hardened to ignore caller time for writes and use Postgres clock/monotonic expressions, preventing a dormant internal API from reintroducing the same clock-authority defect later.
- No schema migration is required; this checkpoint changes timestamp authority and write semantics only.

### Acceptance witness source added/expanded

`packages/database/tests/phase3-mutation-clock.test.ts` adds four Postgres witnesses:

1. create-review persists one identical database timestamp across idempotency, request, run, dispatch, and returned response fields, and that timestamp is bounded by database time observed immediately before/after the transaction;
2. cancellation never writes completion/transition history behind an already-future durable `started_at`, and the response uses the persisted completion timestamp;
3. concurrent same-key mutations through separate `ApiMutationStore` instances converge on one `result` + one `replay` with an identical database-timestamped response;
4. even a completed idempotent not-found mutation cannot have `completed_at` precede its own database-created `created_at`.

`scripts/probe-phase3-mutation-clock.mjs` provides a fail-closed source/execution entry point. `--preflight-only` requires Postgres-owned mutation time, removal of `IdempotencyIdentity.now`, one-timestamp propagation through the production idempotent mutation path, monotonic cancellation/finding/conversation updates, hardened compatibility helpers, and all four Postgres witness anchors. Full mode requires installed Vitest plus Docker and exits non-zero rather than turning missing prerequisites into evidence.

The Phase-3 idempotency mutant was re-anchored after the `ApiMutationStore` rewrite. Mutation source preflight is again **4 / 4** unique current anchors with all four witness suites present.

### Checkpoint 3.8 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **530 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- public route/frontend additions in this checkpoint: **0**
- touched/new relative import specs checked: **6; unresolved: 0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.7: **0**
- `package-lock.json` byte differences versus Checkpoint 3.7: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- mutation-clock source preflight: **pass; Postgres clock + monotonic writes + compatibility-helper hardening + 4 / 4 Postgres witnesses present**
- credential-authority source preflight: **pass**
- error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package/dependency-cruiser/probe script syntax/config parsing: **pass**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- retained `node_modules`, `dist`, `build`, `.next`, or `coverage` directories: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` still exits non-zero because `yallist` is not available in the local npm cache. Vitest is therefore not installed in the reconstructed checkpoint tree. Docker, Podman, and `psql` are also unavailable. The full mutation-clock probe exits **2** after a successful source preflight and explicitly states that no executable database result is claimed.

Consequently this checkpoint does **not** claim execution of the four new Postgres witnesses, live mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural rules present: **2**. Structural planted-violation executions claimed: **0 / 2**. Mutation-clock source probe: **1 / 1 preflight pass; 0 executable suite runs claimed**.

### Checkpoint 3.8 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route was added or changed.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No executable gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Checkpoint 3.9 — atomic OAuth identity/membership/session commit

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.9 closes the remaining split-commit boundary between verified GitHub identity refresh, organization-membership role synchronization, and first-session issuance. Before this checkpoint, `AuthService.establishGithubSession` called `upsertOAuthIdentity`, `upsertMembership`, and `createSession` as three independent database operations. Identity/membership timestamps also came from the API replica clock. A session-insert failure could therefore leave the identity or role refresh committed without the corresponding login, and concurrent callbacks crossed transaction boundaries before the session was bound to the resulting membership.

### One database-owned OAuth commit established in source

- `AuthService.establishGithubSession` now generates the opaque session credential in memory and delegates all durable work to exactly one `AuthStore.establishOAuthSession` operation. It no longer calls the standalone identity upsert, membership upsert, or `issueSession` path.
- `AuthStore.establishOAuthSession` performs canonical provider-identity selection, membership upsert, exact membership provenance, and session insertion in one transaction using a data-modifying CTE graph (`oauth_user` -> `oauth_membership` -> `oauth_session`).
- A single materialized `clock_timestamp()` row owns the identity/membership refresh timestamp, session `created_at`, and session expiry base. No API-process `Date` crosses this commit boundary.
- Existing OAuth identities return their canonical stored user id; existing organization memberships return their canonical membership id. The newly issued session references that exact returned membership row.
- If session insertion fails, the transaction rolls back the identity and membership refresh as well; partial authentication state cannot survive independently.
- Identity and membership `updated_at` values use `GREATEST(existing, database_time)` so clock correction cannot move durable metadata backward.
- The older standalone `upsertOAuthIdentity` and `upsertMembership` helpers were also moved to Postgres-owned time and no longer accept a caller-supplied timestamp, preventing an internal compatibility path from reintroducing replica-clock identity metadata.
- `AuthServiceOptions.now` remains only as a deprecated compatibility field for existing callers/tests; credential and OAuth-commit chronology does not read it.

### Acceptance witness source added/expanded

`packages/auth/tests/auth.test.ts` now proves that GitHub session establishment calls one store operation, persists only the session hash, returns the database-provided expiry, and does not forward a process timestamp.

`packages/database/tests/phase3-auth-store.test.ts` adds three focused Postgres witnesses:

1. canonical identity, canonical membership role, first session, and expiry are committed from one database timestamp, with the session bound to the exact canonical membership;
2. a forced session-key collision rolls back the attempted identity display-name and membership-role refresh instead of leaving a partial login side effect;
3. concurrent callbacks through separate `AuthStore` instances converge on one provider identity and one organization membership while both successful sessions reference that same membership.

`scripts/probe-phase3-oauth-commit.mjs` provides a fail-closed source/execution entry point. `--preflight-only` requires the single store delegation, database-clock CTE graph, exact membership projection, removal of caller timestamps from identity/membership persistence, monotonic metadata updates, and all four focused unit/Postgres witness anchors. Full mode requires installed Vitest plus Docker and exits non-zero when prerequisites are missing rather than converting source evidence into an execution claim.

### Checkpoint 3.9 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **530 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- public route/frontend additions in this checkpoint: **0**
- touched/new relative import specs checked: **21; unresolved: 0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.8: **0**
- `package-lock.json` byte differences versus Checkpoint 3.8: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- OAuth-commit source preflight: **pass; one atomic database-owned commit + 4 focused witnesses present**
- mutation-clock source preflight: **pass; 4 / 4 Postgres witnesses present**
- credential-authority source preflight: **pass**
- error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package/dependency-cruiser/probe script syntax/config parsing: **pass**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- retained `node_modules`, `dist`, `build`, `.next`, or `coverage` directories: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` still exits non-zero because `yallist` is not available in the local npm cache. Vitest is therefore not installed in the reconstructed checkpoint tree. Docker, Podman, and `psql` are also unavailable. The full OAuth-commit probe exits **2** after its successful source preflight and explicitly states that no executable auth/Postgres result is claimed.

Consequently this checkpoint does **not** claim execution of the new Postgres rollback/concurrency witnesses, live mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural rules present: **2**. Structural planted-violation executions claimed: **0 / 2**. OAuth-commit source probe: **1 / 1 preflight pass; 0 executable suite runs claimed**.

### Checkpoint 3.9 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route was added or changed.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No executable gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Checkpoint 3.10 — replica-safe API dispatch ownership + generation-safe recovery

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.10 closes the remaining coordination gap between API-originated durable dispatch jobs and `apps/review-worker` without changing the frozen public HTTP manifest or frontend. Before this checkpoint, dispatch lease/retry chronology still depended on worker process time, an expired timestamp lease could be reclaimed while a healthy long-running executor was still active, cancellation could commit independently of active API dispatch execution, and terminal dispatch failure had no generation-safe replay primitive.

### Database-authoritative dispatch ownership established in source

- `ReviewDispatchStore.claim` no longer accepts a worker timestamp. Claim eligibility, claim time, lease expiry, retry scheduling, dead-letter chronology, and compatibility enqueue timestamps come from Postgres `clock_timestamp()`.
- Claim/cancel coordination uses one stable run-specific advisory key. Claim takes a transaction-scoped advisory lock before locking/revalidating the `review_runs` row; execution takes the same key as a session advisory lock that survives for the lifetime of the in-process execution.
- Claim candidate discovery uses bounded keyset pages. A long prefix of jobs protected by live executor locks therefore cannot permanently starve later ready work merely because the first scan window is busy.
- If a live executor owns the session lock, another replica cannot steal the run solely because its timestamp lease has elapsed. Process/database-session death releases the advisory lock automatically, after which ordinary lease expiry permits recovery.
- `acquireExecutionGuard` revalidates claim generation, dead-letter state, lifecycle state, and lease freshness before `ReviewExecutionPort.execute` is entered.
- The API dispatch worker heartbeats the current generation with database time. If renewal proves ownership stale, that worker does not settle the stale generation.
- A `busy` execution guard is treated as coordination only: the losing worker does **not** defer, refund, or increment the shared generation, because mutating it would fence the legitimate owner. The live owner's heartbeat/settlement remains authoritative; a crashed owner is recovered through lease expiry.
- Lifecycle-settled work found between claim and execution does not enter the review pipeline. Claim-time cleanup also removes non-dead-letter leftovers for `publishing`, `completed`, `failed`, `cancelled`, and `superseded` runs.
- Retry, deferral, dead-letter, and lease-renewal scheduling in the API dispatch worker no longer uses `Date.now()` / `new Date()`.

### Cancellation/execution serialization and lock ordering

- `ApiMutationStore.cancelReview` first performs a tenant-scoped visibility check before touching the global run-specific advisory key. A caller that supplies a foreign run id therefore receives tenant-safe `404` behavior without contending on the foreign tenant's live execution fence.
- Cancellation then waits on the same advisory fence used by claim/execution, locks and revalidates the run, commits the `cancelled` state and transition, and deletes the corresponding `review_dispatch_jobs` obligation in the same idempotent transaction.
- If cancellation wins before execution starts, the dispatch row is gone before a worker can enter execution. If a guarded executor wins first, cancellation cannot commit concurrently; it waits for the guard to release and then re-reads lifecycle state.
- Claim and cancellation share **advisory-first, run-row-second** ordering, avoiding an advisory-vs-row-lock cycle. Worker retry/dead-letter settlement occurs while its session advisory guard is still held.
- Dead-letter completion remains monotonic: the failed run completion timestamp is the maximum of database dead-letter time, run creation, and run start history.

### Generation-safe crash recovery and dead-letter replay

- Migration `0017_phase3_dispatch_coordination.sql` adds `review_dispatch_jobs_expired_lease_idx` on `(lease_expires_at, available_at, review_run_id)` for non-dead-letter rows with non-NULL leases. The existing unleased-ready index remains intact, so both first delivery and expired-lease recovery retain indexed queue paths.
- An abandoned claim becomes reclaimable only after its durable lease expires; reclaim increments `claim_generation`, so the old claimant can no longer settle.
- `ReviewDispatchStore.replayDeadLetter(reviewRunId, expectedGeneration)` never revives a terminal run in place. It requires the exact current dead-letter generation and creates a new queued `review_runs.attempt` plus a new dispatch job.
- Replay is serialized on the originating review request. Concurrent replay callers converge on the first newer attempt instead of creating sibling attempts.
- The original failed run and dead-letter dispatch row remain forensic history; old claimant generations stay stale after replay.

### Acceptance witness source added/expanded

`apps/review-worker/tests/api-dispatch-worker.test.ts` contains four focused worker witnesses:

1. review-lifecycle deferral remains coordination rather than a permanent failure;
2. a live peer execution guard suppresses duplicate pipeline execution without mutating its generation;
3. lifecycle settlement between claim and execution avoids pipeline entry;
4. heartbeat ownership loss prevents stale-generation settlement.

`packages/database/tests/phase3-dispatch-coordination.test.ts` contains six Postgres witnesses:

1. concurrent worker replicas converge on one claim for one run;
2. cancellation racing claim always leaves the run cancelled with no dispatch obligation, and any earlier claim is stale;
3. cancellation cannot commit while a live execution guard is held and succeeds only after that guard is released;
4. a crashed/abandoned claim is reclaimable after lease expiry with a higher generation and stale settlement is rejected;
5. an artificially expired timestamp lease is still not reclaimable while the live session advisory execution guard exists, but is reclaimable after release;
6. concurrent dead-letter replay converges on one new run attempt while the old dead-letter generation remains fenced.

The existing `packages/database/tests/phase3-api.test.ts` stale-dispatch-owner witness was updated to the database-clock dispatch API.

`scripts/probe-phase3-dispatch-coordination.mjs` is fail-closed. `--preflight-only` requires database-clock claim/scheduling authority, transaction + session advisory fences, cancellation on the same fence with tenant precheck, worker heartbeat ownership, transactional cancellation cleanup, the expired-lease recovery index, generation-safe new-attempt replay, and all **10** focused worker/Postgres witness anchors. Full mode requires installed Vitest plus Docker and exits non-zero when prerequisites are absent rather than converting source evidence into execution evidence.

### Checkpoint 3.10 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **530 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- missing/extra frozen route handlers: **0 / 0**
- public HTTP route/frontend additions in this checkpoint: **0**
- touched/new relative import specs checked: **27; unresolved: 0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.9: **0**
- `package-lock.json` byte differences versus Checkpoint 3.9: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- dispatch-coordination source preflight: **pass; database-clock ownership + advisory execution fencing + cancellation serialization + crash recovery + generation-safe replay + 10 / 10 focused witness anchors present**
- OAuth-commit source preflight: **pass**
- mutation-clock source preflight: **pass**
- credential-authority source preflight: **pass**
- error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- full dispatch-coordination probe: **exit 2 after successful source preflight because Vitest is not installed; no executable result claimed**
- retained `node_modules`, `dist`, `build`, `.next`, or `coverage` directories after cleanup: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` exits **1** with `ENOTCACHED` for `yallist`. Docker, Podman, and `psql` are unavailable. The full dispatch-coordination probe therefore exits **2** after its source preflight because installed Vitest dependencies are absent.

Consequently this checkpoint does **not** claim execution of the six new Postgres coordination witnesses, the worker Vitest cases, live mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural rules present: **2**. Structural planted-violation executions claimed: **0 / 2**. Dispatch-coordination source probe: **1 / 1 preflight pass; 0 executable suite runs claimed**.

### Checkpoint 3.10 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route was added or changed.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- The advisory guard prevents concurrent healthy executors while its database session is alive, but this checkpoint does not claim a universal exactly-once guarantee for arbitrary external side effects after loss of the ownership database session. Existing Phase-2 convergence/idempotency boundaries remain authoritative for those effects.
- No executable gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Checkpoint 3.11 — monotonic SSE liveness + in-flight poll keepalives

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.11 closes a liveness hole in the already-frozen review-progress SSE endpoint without changing the route manifest, event payload contract, or frontend. Checkpoint 3.3 added heartbeat/backpressure behavior, but heartbeat cadence was still computed with wall-clock `Date.now()` and only checked between persistence polls. A backwards host-clock adjustment could therefore suppress keepalives beyond the configured bound, and a slow or stalled `reviewEvents()` database call could leave an already-open stream silent indefinitely.

### Monotonic, bounded idle-heartbeat scheduling established in source

- SSE idle cadence now uses `performance.now()` from `node:perf_hooks`, not wall-clock `Date.now()`. Durable transition chronology remains database-owned; the monotonic process clock is used only for transport liveness scheduling.
- Heartbeat and poll intervals are validated at application construction. Both must be positive safe integers and are capped at 60 seconds, so a bad internal configuration fails startup instead of silently creating an effectively unbounded keepalive gap or hot poll loop.
- Product frames call `heartbeat.markActivity()`. A real review-progress event therefore resets the idle deadline and is not immediately followed by a redundant heartbeat merely because the last _heartbeat_ was old.
- `awaitWithHeartbeats` keeps heartbeats flowing while either the ordinary poll delay **or the durable `reviewEvents()` query itself** is pending. A slow database poll can no longer suppress transport keepalives after headers are already committed.
- Heartbeat writes continue to use the existing backpressure-aware `writeSseFrame` path. Operation completion waits until an already-started heartbeat write has drained, so a product frame cannot race/interleave with a keepalive write.
- Disconnect/error tears down heartbeat timers/listeners immediately. A rejected pending database operation is still observed by the attached rejection handler, preventing an ignored-promise rejection after the client has gone away.
- The idle scheduler clamps any backwards movement from an injected monotonic source to at most one full heartbeat interval. Production uses Node's monotonic performance clock, but the clamp preserves the transport bound even under a faulty injected source used by tests.

### Acceptance witness source added/expanded

`apps/api/tests/app.test.ts` now contains three focused SSE-liveness witnesses:

1. idle streams emit a heartbeat containing no product state and then resume polling;
2. a deliberately delayed second `reviewEvents()` call still produces multiple heartbeat frames before the terminal durable transition arrives;
3. timing configuration rejects zero/out-of-range intervals and a backwards-moving injected idle clock still cannot suppress the keepalive.

`scripts/probe-phase3-sse-liveness.mjs` is fail-closed. `--preflight-only` requires the monotonic clock import, absence of `Date.now()` from the API boundary, heartbeat-aware poll and durable-query waits, backpressure-aware keepalive writes, product-activity deadline reset, bounded timing configuration, serialized in-flight keepalive completion, and all **3 / 3** focused API witness anchors. Full mode requires installed Vitest and exits non-zero when dependencies are absent instead of converting source evidence into an execution claim.

### Checkpoint 3.11 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX parse: **531 files, 0 syntax diagnostics**
- note on prior evidence: an independent re-count of the packaged Checkpoint 3.10 archive also yields **531** TypeScript/TSX files; the earlier `530` line in Checkpoint 3.10 status was a counting/reporting error, not a source delta introduced here
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- missing/extra frozen route handlers: **0 / 0**
- public HTTP route/frontend additions in this checkpoint: **0**
- touched/new relative import specs checked: **1; unresolved: 0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.10: **0**
- `package-lock.json` byte differences versus Checkpoint 3.10: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- SSE-liveness source preflight: **pass; monotonic bounded scheduling + heartbeat-aware poll/query waits + serialized keepalive writes + 3 / 3 focused witnesses present**
- dispatch-coordination source preflight: **pass; 10 / 10 focused witness anchors present**
- OAuth-commit source preflight: **pass**
- mutation-clock source preflight: **pass**
- credential-authority source preflight: **pass**
- error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package/dependency-cruiser/probe script syntax/config parsing: **pass**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- full SSE-liveness probe: **exit 2 after successful source preflight because Vitest is not installed; no executable API result claimed**
- retained `node_modules`, `dist`, `build`, `.next`, or `coverage` directories after cleanup: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` exits **1** with `ENOTCACHED` for `yallist`. Docker, Podman, and `psql` are unavailable. The full SSE-liveness probe therefore exits **2** after its successful source preflight because installed Vitest dependencies are absent.

Consequently this checkpoint does **not** claim execution of the new API SSE cases, Postgres suites from earlier Phase-3 checkpoints, live mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural rules present: **2**. Structural planted-violation executions claimed: **0 / 2**. SSE-liveness source probe: **1 / 1 preflight pass; 0 executable suite runs claimed**.

### Checkpoint 3.11 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route or DTO was added or changed.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- Keepalive liveness does not override TCP backpressure: a client that stops reading can still delay subsequent writes until the connection drains or closes, which is the intentional backpressure safety behavior rather than a heartbeat guarantee.
- No executable gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Checkpoint 3.12 — cryptographically opaque, tenant/resource-bound pagination cursors

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.12 closes the remaining gap between the public pagination contract and the persistence implementation. The v1 contract has always said that list cursors are opaque, but the five cursor-bearing API routes still emitted the last database row UUID directly and cast the caller-provided cursor back to `uuid` inside SQL. That leaked persistence identifiers, allowed collection/filter replay, and let an otherwise schema-valid arbitrary cursor reach PostgreSQL as a cast failure.

### Stateless authenticated cursor boundary established in source

- `apps/api/src/pagination-cursor.ts` now owns the public cursor representation. Cursors are fixed-size versioned `c1.*` tokens whose payload is encrypted and authenticated with AES-256-GCM.
- The encrypted payload carries the database row UUID plus 128-bit bindings for the authenticated organization, collection kind, parent resource, and canonical collection-filter set. None of those values are emitted in plaintext.
- The five routes that actually accept a `cursor` query are independently bound: repositories, pull requests, findings, conversations, and knowledge.
- Nested cursors are parent-bound (`repositoryId` for pull requests/conversations; review id for findings). A cursor issued for one parent cannot be replayed under another.
- Finding cursors are additionally bound to the semantic `severity`, `category`, and `state` filters. `limit` is deliberately not bound so a client may change page size while continuing the same logical walk.
- Raw UUID cursors, malformed tokens, tampered ciphertext/tag bytes, wrong-tenant tokens, cross-collection tokens, wrong-parent tokens, and changed-filter tokens fail as a field-level `VALIDATION_ERROR` before the tenant persistence query executes.
- Cursor source ids returned by persistence must themselves be UUIDs. A malformed internal next-cursor source fails closed as an internal response-path error instead of producing an invalid public token.
- Production startup now requires `ACALYS_API_CURSOR_SECRET` (minimum 32 UTF-8 bytes). Optional comma-separated `ACALYS_API_CURSOR_PREVIOUS_SECRETS` generations are decode-only, preserving in-progress page walks during rolling secret rotation while all newly issued cursors use the active generation.
- Secret rings are bounded to four generations and cursor tokens remain below the public identifier limit. The dependency-free runtime smoke produced a 129-character token.
- No route path/method, DTO, frontend source, database schema, or package dependency changed in this checkpoint.

### Acceptance witness source added/expanded

`apps/api/tests/pagination-cursor.test.ts` contains **9** focused codec witnesses: opaque round-trip, tamper rejection, organization binding, collection binding, parent-resource binding, finding-filter binding, previous-generation rotation, raw-UUID/source-id rejection, and fail-closed weak/empty secret configuration.

`apps/api/tests/app.test.ts` contains **4** API integration witnesses: public encode/decode round-trip, raw/tampered rejection before the tenant query, organization/collection/parent replay rejection, and findings-filter replay rejection.

`scripts/probe-phase3-pagination-cursor.mjs` is fail-closed. `--preflight-only` requires AES-GCM encode/decode, tenant/resource/query bindings, all **5 / 5** cursor-bearing collection integrations, active/previous production secret wiring, and all **9 + 4** witness anchors. Full mode requires installed Vitest and exits non-zero when dependencies are absent.

A dependency-free transpiled runtime smoke additionally executed the codec against Node's real crypto implementation and proved round-trip, tamper rejection, raw UUID rejection, wrong organization/collection/resource/filter rejection, previous-generation rotation, the 256-character contract bound, and no plaintext row UUID in the issued token.

### Checkpoint 3.12 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX syntax parse: **533 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- missing/extra frozen route handlers: **0 / 0**
- route paths/method count changed in this checkpoint: **0**
- cursor-bearing v1 collections cryptographically integrated: **5 / 5**
- new cursor codec/API witness anchors: **9 + 4**
- dependency-free cursor crypto runtime smoke: **pass; token length 129**
- touched/new relative import specs checked: **4; unresolved: 0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.11: **0**
- `package-lock.json` byte differences versus Checkpoint 3.11: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- pagination-cursor source preflight: **pass; 5 / 5 collections + 9 codec + 4 API witnesses present**
- SSE-liveness source preflight: **pass; 3 / 3 focused witnesses present**
- dispatch-coordination source preflight: **pass; 10 focused witness anchors present**
- OAuth-commit source preflight: **pass**
- mutation-clock source preflight: **pass**
- credential-authority source preflight: **pass**
- error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package/dependency-cruiser/probe script syntax/config parsing: **pass**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- full pagination-cursor probe: **exit 2 after successful source preflight because Vitest is not installed; no executable API suite result claimed**
- retained `node_modules`, `dist`, `build`, `.next`, or `coverage` directories after cleanup: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` still exits **1** with `ENOTCACHED` for `yallist`. The global TypeScript compiler can syntax-parse the repository, but the workspace typecheck cannot start because the installed project dependency tree (including `@types/node`) is absent. Docker, Podman, and `psql` are also unavailable.

Consequently this checkpoint does **not** claim Vitest execution of the new cursor suites, Postgres suites from earlier Phase-3 checkpoints, live mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

Mutation definitions present: **4**. Mutation executions/kills claimed: **0 / 0**. Structural rules present: **2**. Structural planted-violation executions claimed: **0 / 2**. Pagination-cursor source probe: **1 / 1 preflight pass; 0 Vitest suite runs claimed**. Dependency-free cursor crypto smoke: **1 / 1 pass**.

### Checkpoint 3.12 non-claims

- This is not full Phase 3 completion.
- No frozen public HTTP route path/method or DTO was added or removed.
- Existing in-flight clients holding raw UUID cursors from an older unreleased checkpoint must restart their page walk; unsigned cursors are intentionally not accepted because doing so would defeat the new tenant/resource/filter authenticity boundary.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No executable repository gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Checkpoint 3.13 — frozen handler error-status enforcement

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.13 closes an outbound-contract gap left after Checkpoint 3.6 hardened error-body schemas. The v1 manifest freezes not only each success status and response schema but also each route's handler-level `errorStatuses`. Before this checkpoint, a handler/store regression could return a schema-valid error body with an undeclared non-2xx status (for example `418` or `503`), and the API boundary would serialize it. That allowed implementation code to widen the observable HTTP contract without changing `API_ROUTES`.

### Frozen error-status boundary established in source

- Handler-returned non-2xx results are now accepted only when `result.status` is present in the current route's frozen `errorStatuses` declaration.
- A schema-valid body with an undeclared handler status fails closed to the generic `500 INTERNAL_ERROR`; the handler's message/body is not reflected.
- Successful handler results continue to normalize to the route's frozen `successStatus` after response-schema validation.
- Boundary-owned failures remain independent of route-specific handler statuses. In particular, missing/invalid `Idempotency-Key` is now represented by a dedicated boundary exception mapped to the existing schema-valid `400 IDEMPOTENCY_KEY_REQUIRED` response rather than being returned as a handler result. Authentication, authorization, request validation, rate limiting, framework errors, and unexpected exceptions likewise remain on their existing global boundary paths.
- No route path, method, DTO, route error-status list, frontend source, database schema, or package dependency changed in this checkpoint.

### Acceptance witness source added/expanded

`apps/api/tests/app.test.ts` adds six focused runtime cases:

1. missing idempotency key still produces the boundary-owned `400 IDEMPOTENCY_KEY_REQUIRED` response;
2. a schema-valid declared `409` handler error is serialized unchanged;
   3-6. `createReview`, `cancelReview`, `dismissFinding`, and `resolveConversation` each return a schema-valid secret-bearing `418` from the mutation-store test double and must instead produce the generic `500` without reflecting the secret marker.

`scripts/probe-phase3-handler-status.mjs` is fail-closed. `--preflight-only` requires manifest-derived error-status enforcement, the boundary-owned idempotency path, the declared-status witness, the undeclared-status witness, and all **4 / 4** mutating-route anchors. Full mode requires installed Vitest and exits non-zero when dependencies are absent.

### Checkpoint 3.13 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX syntax parse: **533 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- route path/method/DTO changes in this checkpoint: **0**
- handler-status source preflight: **pass; manifest enforcement + boundary-owned idempotency + 4 / 4 mutating-route undeclared-status witnesses present**
- pagination-cursor source preflight: **pass; 5 / 5 collections + 9 codec + 4 API witnesses present**
- SSE-liveness source preflight: **pass; 3 / 3 focused witnesses present**
- dispatch-coordination source preflight: **pass; 10 focused witness anchors present**
- OAuth-commit source preflight: **pass**
- mutation-clock source preflight: **pass**
- credential-authority source preflight: **pass**
- error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- `apps/web/src` byte differences versus Checkpoint 3.12: **0**
- `package-lock.json` byte differences versus Checkpoint 3.12: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- retained `node_modules`, `dist`, `build`, `.next`, or `coverage` directories after cleanup: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` still exits **1** with `ENOTCACHED` for `yallist`. Docker, Podman, and `psql` are unavailable. Installed Vitest dependencies are therefore absent, so the full handler-status probe cannot execute the API suite in this environment.

Consequently this checkpoint does **not** claim Vitest execution of the six new handler-status cases, Postgres suites from earlier Phase-3 checkpoints, live mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

### Checkpoint 3.13 non-claims

- This is not full Phase 3 completion.
- No frozen public route path/method, DTO, success status, or declared route error-status list was added or changed.
- Global authentication/authorization/validation/rate-limit/framework failures remain boundary-owned and are not incorrectly constrained by a route's resource-specific `errorStatuses` list.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No executable repository gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Checkpoint 3.14 — bounded non-pageable pre-merge checks + cursor-leak closure

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.14 closes a cursor/completeness escape left after Checkpoint 3.12. `listReviewChecks` is the one frozen `PageDto` route whose manifest has **no cursor query**, yet `ApiStore.listReviewChecks` previously queried 101 rows and returned `result.rows[99].id` as `nextCursor` when more than 100 results existed. That continuation was a raw database UUID, could not be supplied back to the route, and meant the public response could both leak a persistence identifier and advertise an impossible continuation.

### Frozen non-pageable cardinality established in source

- Migration `0018_phase3_premerge_check_bound.sql` makes the frozen route shape a persistence invariant: one review run may have at most **100 distinct pre-merge check results**.
- The migration refuses to install over an already-invalid database (`HAVING COUNT(*) > 100`); oversized existing data is not grandfathered.
- A per-review `pg_advisory_xact_lock` serializes distinct check insertion across writer replicas. At 99 rows, two concurrent 100th/101st inserts cannot both commit.
- The trigger recognizes an existing `(review_run_id, check_id)` before applying the cardinality check, so the normal `INSERT ... ON CONFLICT ... DO UPDATE` result-refresh path remains valid at exactly 100 rows.
- `ApiStore.listReviewChecks` still reads one sentinel row (`LIMIT 101`) but now fails closed with `PREMERGE_CHECK_RESULT_LIMIT_VIOLATION` if the database invariant is ever missing/corrupted. It never emits a raw `nextCursor` for this route.
- The HTTP handler independently refuses a persistence adapter that supplies `nextCursor` for `listReviewChecks` and collapses it through the existing leak-free internal-error boundary. The raw continuation value is not reflected.
- No public route path/method, request/query/body schema, DTO, frontend source, package dependency, or lockfile entry changed.

### Acceptance witness source added/expanded

`packages/database/tests/phase3-premerge-check-bound.test.ts` contains **2** focused Postgres cases:

1. the 101st distinct result is rejected with `premerge_check_results_run_limit`, an existing check can still be upserted at the cap, and the tenant API store returns exactly 100 items with no continuation;
2. two concurrent inserts racing from 99 rows serialize so exactly one commits and durable cardinality is exactly 100.

`apps/api/tests/app.test.ts` adds the API boundary witness that a secret/raw persistence continuation returned by the store for the non-pageable route produces generic `500 INTERNAL_ERROR` and is not reflected.

`scripts/probe-phase3-check-page-bound.mjs` is fail-closed. `--preflight-only` requires migration-time invalid-data refusal, advisory serialization, the 100-row cap, store fail-closed behavior, removal of the old raw continuation expression, the API continuation refusal, and all **2 Postgres + 1 API** witness anchors. Full mode requires installed Vitest and forces `ACALYS_REQUIRE_POSTGRES=1` so a missing database cannot become a green skip.

### Checkpoint 3.14 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX syntax parse: **534 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- missing/extra frozen route handlers: **0 / 0**
- pre-merge-check public continuation paths after hardening: **0**
- pre-merge-check persistence bound: **100 distinct checks / review run**
- page-bound source preflight: **pass; persistence cap + advisory serialization + store/API fail-closed boundaries + 2 Postgres / 1 API witnesses present**
- handler-status source preflight: **pass**
- pagination-cursor source preflight: **pass; 5 / 5 cursor-accepting collections cryptographically bound**
- SSE-liveness source preflight: **pass**
- dispatch-coordination source preflight: **pass**
- OAuth-commit source preflight: **pass**
- mutation-clock source preflight: **pass**
- credential-authority source preflight: **pass**
- error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.13: **0**
- `package-lock.json` byte differences versus Checkpoint 3.13: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- full page-bound probe: **exit 2 after successful source preflight because Vitest is not installed; no executable API/Postgres result claimed**
- retained `node_modules`, `dist`, `build`, `.next`, or `coverage` directories after cleanup: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` exits **1** with `ENOTCACHED` for `yallist`. Installed Vitest is therefore absent, while Docker, Podman, and `psql` are unavailable. The full page-bound probe consequently exits **2** after its successful source preflight rather than allowing the Postgres suite to skip and masquerade as execution evidence.

This checkpoint does **not** claim execution of the new API/Postgres cases, live enforcement of the trigger under PostgreSQL, earlier Phase-3 Postgres suites, mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

### Checkpoint 3.14 non-claims

- This is not full Phase 3 completion.
- The migration deliberately rejects an upgraded database already containing more than 100 distinct pre-merge checks for one run; such data must be reconciled rather than silently truncated.
- No frozen public route or DTO was widened to add pagination to `listReviewChecks`; the checkpoint enforces the already-frozen non-pageable contract instead.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No executable repository gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Checkpoint 3.15 — fail-closed duplicate/structured query validation

Status: **SOURCE FROZEN; EXECUTABLE ACCEPTANCE STILL BLOCKED BY LOCAL TOOLING**

Checkpoint 3.15 closes an inbound-validation escape in the API boundary. `queryObject()` previously copied only scalar-string values from Express's parsed query object and silently dropped every array/object value. A malformed request such as `?limit=10&limit=20` is represented by Express as a non-scalar query value; dropping it converted the caller's malformed `limit` into an absent field, allowing the route schema to accept/default the request and reach a tenant-scoped handler. That violates the frozen Phase-3 rule that malformed query input is rejected before handler execution.

### Query-shape validation established in source

- `apps/api/src/app.ts` no longer filters malformed query values out of the object handed to the frozen route schema.
- Every parsed query entry must be a scalar string before schema coercion. Arrays/objects (including duplicate scalar parameters) fail closed with a field-level `VALIDATION_ERROR` instead of disappearing into an omitted/defaulted value.
- The validation path is bounded through the existing public field-error limits and does not echo caller query contents.
- Valid scalar query strings continue through the unchanged frozen route schemas, including numeric coercion for `limit` and the Checkpoint-12 opaque cursor decoder.
- No route path/method, DTO, query schema, persistence interface, frontend source, package dependency, or lockfile entry changed.

### Acceptance witness source expanded

`apps/api/tests/app.test.ts` adds a **5-route duplicate-query short-circuit matrix** covering every frozen route that accepts a query schema:

1. repositories;
2. repository pull requests;
3. review findings;
4. repository conversations;
5. knowledge.

Each witness sends `limit` twice, requires `400 VALIDATION_ERROR`, checks the bounded `limit` field error, and proves the tenant persistence handler is never called.

`scripts/probe-phase3-query-boundary.mjs` is fail-closed. `--preflight-only` requires removal of the old scalar-only filtering path, the explicit structured/duplicate rejection branch, and all **5 / 5** query-bearing route witnesses. Full mode requires installed Vitest and exits non-zero when dependencies are absent.

### Checkpoint 3.15 static/runtime evidence — 2026-09-09

- complete repository TypeScript/TSX syntax parse: **534 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen route handlers: **14 / 14**
- missing/extra frozen route handlers: **0 / 0**
- query-bearing frozen routes with duplicate-value short-circuit witnesses: **5 / 5**
- query-boundary source preflight: **pass; structured/duplicate values fail closed + 5 / 5 route witnesses present**
- touched/new relative import specs checked: **2; unresolved: 0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.14: **0**
- `package-lock.json` byte differences versus Checkpoint 3.14: **0**
- package-lock SHA-256: `13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d`
- pre-merge-check page-bound source preflight: **pass**
- handler-status source preflight: **pass**
- pagination-cursor source preflight: **pass**
- SSE-liveness source preflight: **pass**
- dispatch-coordination source preflight: **pass**
- OAuth-commit source preflight: **pass**
- mutation-clock source preflight: **pass**
- credential-authority source preflight: **pass**
- error-boundary source preflight: **pass; 12 / 12 taxonomy codes witnessed**
- rate-limit source preflight: **pass; 4 / 4 Postgres witnesses present**
- tenant-graph source preflight: **23 / 23 tenant FKs; 23 / 23 validations; 7 / 7 referenced-key indexes**
- Phase-3 mutation source preflight: **4 / 4 anchors unique; 4 / 4 witness suites present**
- Phase-3 architecture source preflight: **2 / 2 named rules present**
- package/dependency-cruiser/probe script syntax/config parsing: **pass**
- package-lock parity probe (`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`): **exit 0; lockfile unchanged**
- full query-boundary probe: **exit 2 after successful source preflight because Vitest is not installed; no executable API result claimed**
- retained `node_modules`, `dist`, `build`, `.next`, or `coverage` directories after cleanup: **0**

### Executable evidence still not claimed

`npm ci --offline --ignore-scripts --no-audit --no-fund` exits **1** with `ENOTCACHED` for `yallist`. Installed Vitest is therefore absent, while Docker, Podman, and `psql` are unavailable. The full query-boundary probe consequently exits **2** after its successful source preflight rather than converting source witnesses into fabricated executable evidence.

This checkpoint does **not** claim Vitest execution of the new duplicate-query matrix, earlier Phase-3 Postgres suites, live mutation kills, dependency-cruiser planted-violation kills, repository formatting/typecheck/build gates, or the complete nine-gate Phase-3 acceptance run.

### Checkpoint 3.15 non-claims

- This is not full Phase 3 completion.
- No frozen public route, DTO, success/error status list, or query schema was added or changed.
- Unknown scalar query keys retain the frozen schema's existing `z.object` compatibility behavior; this checkpoint specifically prevents non-scalar/duplicate caller values from being erased before validation.
- The browser GitHub OAuth start/callback contract gap remains explicit and still requires an approved contract addition before mounting.
- Unsupported review overrides (`depth`, `categories`, `reviewDrafts`) remain intentionally rejected rather than accepted without runtime semantics.
- `POST /reviews` still requires `pullRequestId`; the frozen API contract has no alternate commit/local-tree target shape.
- `apps/web/src` remains frozen; Phase 4 live dashboard integration has not started.
- No executable repository gate, database result, live mutation kill, structural-rule execution, or performance number is inferred from source/static evidence.

## Phase 3 finalization — implementation complete and acceptance consolidated

Status: **IMPLEMENTATION COMPLETE; FULL EXECUTABLE ACCEPTANCE REQUIRES A NORMAL CI/POSTGRES ENVIRONMENT**

Phase 3 is no longer being split into additional source-hardening checkpoints. The frozen capability contract in `capability-contract.md` is implemented and the repository now has one authoritative, fail-closed acceptance entry point instead of a sequence of checkpoint-specific claims:

```sh
npm run accept:phase3
```

A dependency-free archive/source preflight is available as:

```sh
npm run accept:phase3:preflight
```

The full command first runs every Phase-3 source/probe preflight, then executes the repository's protected nine-gate `verify` surface, forces Postgres integration suites to be non-skippable with `ACALYS_REQUIRE_POSTGRES=1`, plants both required architecture violations, kills the four contract-required mutants, and finally re-checks the source invariants after restoration. Any missing tool, skipped database execution, stale mutation anchor, surviving mutant, architectural escape, or non-zero repository gate fails the command. A successful full run is the only condition that writes an acceptance report with `"accepted": true`.

### Finalization controls added

- `scripts/assert-phase3-source-invariants.mjs` is dependency-free and checks the frozen 14-route/14-handler surface, the review-event SSE mount, zero `apps/api -> review-worker` imports, zero direct `pg` imports outside `@acalys/database`, and the required Phase-3 acceptance scripts.
- `scripts/accept-phase3.mjs` is the authoritative full/preflight acceptance runner and writes a machine-readable JSON evidence report.
- `docs/review/phase-3/acceptance.md` maps the command to the frozen capability contract and explains the exact fail-closed execution model.
- Root scripts `phase3:source-invariants`, `accept:phase3:preflight`, and `accept:phase3` expose the controls without changing dependencies or the lockfile.
- `.phase3-acceptance-report.json` is git-ignored local/CI evidence, not source-of-truth state.

### Final source evidence in this environment — 2026-09-09

- authoritative Phase-3 preflight chain: **PASS; all 15 controls executed successfully**
- complete repository TypeScript/TSX syntax parse using TypeScript parser: **534 files, 0 syntax diagnostics**
- frozen API route manifest: **14 entries**
- implemented frozen handlers: **14 / 14**
- missing/extra handlers: **0 / 0**
- `apps/api` direct imports of review-worker internals: **0**
- direct TypeScript `pg` imports outside `@acalys/database`: **0**
- `apps/web/src` byte differences versus Checkpoint 3.15: **0**
- `package-lock.json` byte differences versus Checkpoint 3.15: **0**
- package-lock SHA-256 before/after lockfile-only offline parity: **`13c705cd557c800139260e5fc7a428f5f0350eb69fedcc937dbc5f584029f46d` / identical**
- Phase-3 mutation preflight: **4 / 4 unique anchors; 4 / 4 witness suites present**
- Phase-3 architecture preflight: **2 / 2 named planted-violation rules present**
- tenant graph: **23 / 23 validated tenant FKs; 7 / 7 referenced-key indexes**
- rate-limit focused witnesses: **4 / 4 present**
- error taxonomy: **12 / 12 codes witnessed**
- pagination cursor collections: **5 / 5 cryptographically bound**
- query-bearing frozen routes with duplicate/structured-value short-circuit witnesses: **5 / 5**
- pre-merge-check persistence cap: **100 distinct checks / review run with fail-closed continuation boundary**

### Full acceptance attempt in this container

The authoritative full runner was invoked and **correctly exited 2 before counting any execution gate as passed**. Its environment check reported missing installed Vitest, dependency-cruiser, local TypeScript, a Git worktree (the canonical input here is a ZIP extraction), and Docker/Postgres runtime.

Dependency restoration was also attempted rather than assumed impossible:

- direct online `npm ci` could not complete because this container cannot resolve external package hosts;
- the historical `yallist@3.1.1` cache hole was locally bootstrapped outside the repository, which moved the offline install forward to the next missing frontend manifest/artifact rather than changing source or lock state;
- root-only offline installation likewise advanced to another uncached artifact (`yocto-queue`), confirming that the environment cache is broadly incomplete rather than the repository being blocked by one source defect;
- Docker, Podman, `postgres`, `initdb`, and `psql` are not installed; only `libpq` client libraries are present.

No cache/bootstrap material is included in the repository artifacts.

### Phase boundary

The Phase-3 **implementation** is complete and frozen at this point. The explicit non-claims in `capability-contract.md` remain intentional scope boundaries, not unfinished Phase-3 work: no extra browser OAuth HTTP routes are added outside the frozen manifest, and later-phase producers are not made to synthesize review summaries, conversations, knowledge, or pre-merge results.

The remaining unproduced evidence is environmental execution evidence, not another Phase-3 implementation slice. In a normal Git/Node/Docker CI environment, `npm run accept:phase3` is the single command that converts this implementation freeze into full executable acceptance; it must return zero and produce `"accepted": true` before anyone may claim the runtime acceptance gates passed.
