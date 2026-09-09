# Production readiness review — 2026-09-09

**Verdict: not production-ready.** This is a development checkpoint with a reproduced
production worker blocking defect, additional runtime correctness problems, and failing
acceptance gates. Committing it records the current work; it does not approve deployment.

Reviewed against `b0252db`. Before adding this report, the working tree contained 115
changed/new files: 36 tracked modifications and 79 untracked files. The tracked diff was
1,408 insertions / 193 deletions; new files contained another 13,403 lines. Scope includes
Phase 2 model execution and hardening plus Phase 3 API/authentication through checkpoint
3.7. No implementation fixes, remaining-phase features, or permanent tests were added
during this review. Reproduction scripts and alternate test configuration lived in `/tmp`.

## What changed

| Area                        | Change from the committed baseline                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model execution             | New provider-neutral gateway, OpenAI/Anthropic transports, routing, replay, accounting, budget reservations, and credential admission.                                            |
| Review worker               | Required analyzer/verifier ports replace implicit deterministic defaults; new executable composition, GitHub source loading, independent verification, and API dispatch consumer. |
| Persistence                 | Migrations 0009–0016 add verification ownership, model accounting, auth/tenancy, webhook fencing, API dispatch, and credential provenance.                                        |
| Public API                  | New Express application mounts the 14 frozen manifest routes and SSE; includes authentication, scopes, tenant queries, idempotent mutations, and request logging.                 |
| Authentication              | Opaque hashed credentials, session rotation, membership-aware liveness, API-key role ceilings, OAuth services, and secret rotation support.                                       |
| Verification infrastructure | New unit/integration suites, architecture and security preflights, mutation definitions, and project references.                                                                  |

`apps/web/src` has no diff against the baseline. The public route manifest is unchanged.
The source includes useful protections: transactional mutation/idempotency persistence,
database-clock credential checks, durable membership provenance, fenced verification
claims, tenant foreign keys, restricted GitHub token access, and outbound API validation.
These strengths do not resolve the blockers below.

## Findings, ordered by priority

### 1. P1 — Production analysis blocks on its own review-run lock

Locations: `apps/review-worker/src/orchestrator.ts:218`,
`packages/database/src/review/stage-store.ts:261`,
`packages/database/src/review/model-budget-store.ts:150`.

The new asynchronous analyzer executes inside `runStage`'s transaction. That transaction
holds `SELECT ... FOR UPDATE` on the review run. The production analyzer calls the model
gateway, which reserves budget through another pooled connection. Inserting the
reservation checks its foreign key to that same review run and needs a conflicting
`FOR KEY SHARE` lock. Analysis waits for the reservation; the reservation waits for the
analysis transaction to finish. This blocks before the provider request timeout starts.
Other budget requests for that organization can also wait behind its advisory lock.

**Executed reproduction:** actual migrations, ingestion, stage store, and budget store
in a disposable PostgreSQL database. A diagnostic-only `lock_timeout = 1500ms` produced
SQLSTATE `55P03`, with PostgreSQL identifying the foreign-key `FOR KEY SHARE` on
`review_runs`. Provider dispatch remained false. Production config supplies no equivalent
timeout. The stage-store documentation already prohibits model/network work in this
callback. External analysis needs separately owned execution and a fenced commit step.

### 2. P1 — Production source does not pass TypeScript or clean build

Locations: `packages/database/src/webhook/postgres-inbox.ts:84`,
`apps/review-worker/src/runtime.ts:195`, `packages/auth/src/service.ts:8`.

`WebhookDelivery` now requires `claimGeneration`, but the PostgreSQL delivery mapper does
not supply it. Runtime composition supplies an explicitly undefined `observer.onError`
to an optional property whose type disallows that value under `exactOptionalPropertyTypes`.
The auth service also has an unused import rejected by the compiler. These are source
failures, independently of local package-resolution problems. Multiple test fixtures also
fail semantic typechecking after the new claim and usage contracts.

Both the typecheck and clean-build gates exited nonzero. The local dependency tree also
lacks links for the new workspaces, causing additional module-resolution failures;
those environment failures must be distinguished from the source errors above.

### 3. P1 — Models are never given the output schema they must satisfy

Locations: `packages/model-gateway/src/gateway.ts:35` and the two adapter request bodies;
`packages/review-engine/src/llm/correctness.ts:133` and `llm/verifier.ts:84`.

The gateway sends “matching schema acalys.…”, but forwards only a schema name to the
adapter. Neither adapter sends the actual response schema. The analyzer/verifier system
prompts also omit the full required keys and allowed enum values. A model cannot infer
private field names such as `identityHint` or the verifier's exact reason vocabulary
from that identifier. Local Zod validation rejects malformed output after spending the
call, but does not tell the model what to generate. An empty candidate array can pass,
so this must not be mistaken for evidence that useful structured findings work.

This is a source-traced finding, not a measured live-provider failure rate. Supply the
schema through the provider request or a complete explicit output contract, and bind
that contract into request identity.

### 4. P1 — Worker recovery loses ambiguous model-execution semantics

Locations: `apps/review-worker/src/analysis.ts:714`,
`apps/review-worker/src/execution.ts:73`, and `apps/review-worker/src/worker.ts:180`.

The gateway distinguishes unknown remote execution and local commit uncertainty and
does not retry them inside one call. The analyzer maps every non-success to
`LlmAnalysisUnavailableError`; the execution port catches every error and returns
`retryable_failure`. The worker then schedules the job again. The stage rolled back,
so resuming analysis can issue the stochastic request again. Non-retryable configuration
and budget failures are similarly collapsed into retries.

This source-level defect remains after resolving finding 1. The worker boundary must
preserve whether an outcome permits redispatch, with durable recovery for uncertainty.
Gateway-only retry tests do not establish that property across job recovery.

### 5. P2 — Credential admission can expire while the provider call is still active

Locations: `packages/database/src/review/model-admission-store.ts:70`,
`packages/model-gateway/src/gateway.ts:443`, `apps/review-worker/src/main.ts:43`.

Active concurrency excludes expired admission leases. Configuration accepts a one-second
lease, while the analyzer normally permits a 60-second provider call. There is no
admission renewal and no validation tying the lease duration to dispatch preparation
plus request duration. With concurrency set to one, another replica can enter after
one second while the first request is still running. Verification-invocation heartbeats
do not renew this separate credential lease. Preserve admission ownership throughout
dispatch, or enforce an appropriately bounded lifetime. This finding is source-traced.

### 6. P2 — GitHub patch parsing drops or shifts valid changed-line anchors

Location: `packages/providers/github/src/source/repository-reader.ts:164`.

Inside a hunk, added source `++counter;` appears as `+++counter;`, and deleted source
`--counter;` appears as `---counter;`. The parser treats these prefixes like file headers:
it omits the added line and incorrectly advances the head cursor for the deleted line.
The resulting anchors can omit the relevant edit or point beyond the file.

**Executed reproduction:** a mocked provider response with a valid two-line replacement
produced `changedLines: [3]`; the correct head lines were `[1, 2]`. This used the real
`GithubRepositoryReader.readRevision`, without contacting GitHub. Hunk contents need
parsing according to their leading diff marker once a hunk has begun.

### 7. P2 — Invalid repeated query parameters bypass validation

Location: `apps/api/src/app.ts:85`.

`queryObject` silently drops all non-string values before schema validation. Express
represents repeated query keys as arrays, so malformed known parameters become absent
instead of being rejected. This affects limits and can also silently remove finding
filters.

**Executed reproduction:** `GET /api/v1/repositories?limit=0&limit=999999` returned HTTP
200 and called the store with the default limit of 25. The known malformed field should
reach validation or produce a 400, not disappear.

### 8. P2 — Missing model usage is converted to zero billable usage

Locations: `packages/model-gateway/src/adapters/openai.ts:35` and `:149`; analogous
normalization exists in the Anthropic adapter.

A successful response with output text but absent/invalid usage fields is returned as
`kind: "ok"` with zero tokens. The gateway calculates zero cost, records it, and releases
the conservative reservation. A malformed upstream response therefore weakens the cost
ceiling instead of retaining accounting uncertainty.

**Executed reproduction:** an injected HTTP 200 response containing only `output_text`
was accepted with both token counts zero. Required accounting fields need validation;
unknown usage must not become evidence of a free provider call.

## Executed validation

Checks ran independently so one failing gate would not hide the remaining results.

| Check                                 | Result                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck                             | **FAIL** — production and test-source errors.                                                                                                               |
| ESLint                                | **FAIL** — 152 errors, zero warnings.                                                                                                                       |
| Prettier check                        | **FAIL** — 71 files reported. No formatting applied.                                                                                                        |
| Dependency boundaries                 | **PASS** — 381 modules, 1,330 dependencies.                                                                                                                 |
| Project references                    | **PASS** — closed across 12 workspace packages.                                                                                                             |
| Generated schemas                     | **PASS** — 49 generated files match source.                                                                                                                 |
| Clean build                           | **FAIL** — source errors plus missing local new-workspace links.                                                                                            |
| Export conformance                    | **PASS** — contracts source/dist agree across four subpaths. This is not an all-package build pass.                                                         |
| Required-Postgres test run            | **FAIL** — 2,674 passed / 15 failed assertions; zero pending among collected tests. API suite also failed to load, so these counts do not cover that suite. |
| API suite with temporary source alias | **FAIL** — 51 passed / 1 failed. This bypasses local resolution only; it does not repair the standard gate.                                                 |
| Six Phase-3 source preflights         | **PASS** — architecture, tenant graph, rate limits, error boundary, auth clock, mutation manifest. No mutation executions or kills are claimed.             |
| Diff whitespace check                 | **PASS** before this report.                                                                                                                                |

Docker was accessible after sandbox escalation. The full suite used
`ACALYS_REQUIRE_POSTGRES=1 npm run test:ci`; its diagnostic bundle recorded child exit 1,
no terminating signal, a reachable daemon, and approximately 118 seconds runtime.

Important test failures and limits:

- Eight verification-store assertions and two funnel/publication assertions fail because
  fixtures omit the new non-null claim fields. Several no longer reach the constraint
  they intend to test.
- Four tenant-integrity cases fail during seed setup: one SQL placeholder is inferred
  as both UUID and text. These failures do not prove isolation is broken, but the intended
  adversarial witnesses were not exercised.
- One OAuth test uses a fixed service clock but the credential ring's real clock. Its
  predecessor secret had already expired at execution time. This is calendar-dependent
  test evidence, not proof that an active empty secret was accepted.
- The standard API suite cannot resolve the locally unlinked `@acalys/auth`. Under a
  temporary source alias, its remaining failing error-boundary test sends no cancellation
  body and receives 400 before reaching the mocked mutation; it expected 500.
- The lifecycle-hardening file is also marked failed in the JSON report although all
  ten listed assertions passed and its suite message is empty. This review does not
  attribute that unexplained suite-level failure to a product defect.
- Existing dependencies were usable but incomplete for the new workspace graph. An
  offline install with lockfile writes disabled failed on an uncached registry request.
  No successful clean installation is claimed.

Detailed local outputs are `/tmp/coderabbit-review-{typecheck,lint,format,depcruise,build,`
`schemas,exports,tests,api-tests,behavior-probes,diff-probe}.log`, plus the ignored
`.vitest-report.json` and `.diagnostics/test-ci-2026-09-09T04-33-35-124Z.md`.
These local files are supplementary; the material evidence is summarized above.

## Checkpoint boundary

The checkpoint documents accurately avoided claiming earlier executable acceptance;
this review adds actual results from the current environment. Phase 2/3 acceptance
remains incomplete. Live model/provider probes, sealed-holdout quality evaluation,
performance measurements, and mutation execution were not performed. Static preflight
success cannot replace those checks or the failing repository gates.

The documented OAuth HTTP contract gap, unsupported review overrides, and later dashboard
integration remain outside this review's implementation scope. No work was added to
those areas. The immediate release requirement is to address the present blockers and
obtain passing executable acceptance for the existing scope.
