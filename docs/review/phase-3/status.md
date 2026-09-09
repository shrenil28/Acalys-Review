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
