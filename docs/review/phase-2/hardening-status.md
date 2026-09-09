# Phase 2 hardening checkpoint — 2026-09-08

Status: **CODE-LEVEL CHECKPOINT FROZEN; PHASE 2 ACCEPTANCE BLOCKED ON EXTERNAL EXECUTION PREREQUISITES.**

This document records only evidence available from the supplied archive workspace. It does not
turn unexecuted tests or unavailable external probes into passing evidence.

## What this checkpoint established

- `packages/model-gateway` exposes a provider-neutral `ModelPort`; OpenAI and Anthropic adapters
  are contained behind that boundary and use an injectable native `fetch` transport.
- Structured model output is schema-validated before it leaves the gateway. Malformed output is
  a first-class failure, not a coerced candidate.
- Model routing is configuration-driven. Model id, task class, tier, routing-policy version and
  prompt-template version participate in execution/analyzer identity.
- The gateway records provider attempts, tokens, cache-read/cache-creation usage, cost and replay
  state. Replay traffic is not counted as billable provider usage.
- Model calls use atomic Postgres budget reservations. The full configured per-call ceiling is
  reserved before each actual provider dispatch; a known outcome settles to measured cost while
  an unresolved post-dispatch reservation remains conservative.
- Provider credential concurrency/rate admission is fleet-wide through Postgres, with bounded
  cleanup of history that no longer affects either the rolling rate window or active leases.
- Cassette record/replay reloads under an inter-process lock and commits through fsync + atomic
  rename + directory fsync. A held lock fails closed rather than being stolen unsafely.
- A provider call whose remote effect is possible but whose local accounting/cassette commit is
  uncertain returns `local_commit_unknown`; the gateway does not blindly issue the stochastic
  call again.
- LLM correctness analysis receives assembled planner context rather than a filesystem/repository
  handle. Candidate anchors are projected from planner-owned items instead of trusting arbitrary
  model paths or line numbers.
- If the configured LLM analysis path is unavailable, production analysis fails closed instead of
  representing deterministic-only output as a complete LLM review.
- Analyzer identity includes immutable revision identity, resolved base/head/change content,
  instructions/config/context, analyzer/prompt versions and model-routing identity.
- LLM candidates flow through an independent verifier with a closed reason vocabulary. The
  verifier performs a fresh provider file read and does not receive the proposing model's
  justification.
- Verification execution is protected by recoverable single-flight leases with claim token /
  generation fencing at the database write boundary.
- Durable webhook jobs have claim-generation fencing. A stale claimant cannot complete, defer or
  release work after another worker has reclaimed the lease.
- A peer-owned verification lease is a coordination deferral, not a failure attempt; owed review
  work remains scheduled without drifting toward dead-letter.
- Current webhook deliveries cannot be acknowledged merely because a `ReviewRun` row exists.
  `createWorker` requires a review-execution port and hands work off only after the review state
  reaches the durable publication obligation (`publishing`) or another accepted terminal state.
- A production executable now exists: `apps/review-worker/package.json` `start` launches
  `dist/main.js`; source `main.ts` builds `createProductionReviewRuntime()`, which composes the
  webhook inbox, immutable revision lookup, GitHub source reader, model gateway, real LLM analyzer,
  independent verifier, and resumable orchestrator.
- GitHub source reads stay inside `@acalys/provider-github`. Installation tokens are restricted to
  the exact repository with `contents: read`; provider response bodies/credentials are not surfaced
  in errors; arbitrary absolute request URLs and redirects are refused.
- The GitHub source adapter refuses incomplete recursive trees, the compare-file completeness
  ceiling, patchless changed text, oversized repositories/blobs, and binary changed files rather
  than treating incomplete knowledge as clean source.
- The shared Postgres integration harness discovers and applies the complete numerically ordered
  migration directory instead of silently stopping at the former hard-coded migration set.
- Real Postgres tests were added for concurrent run/org budget reservation, pre-dispatch expiry,
  post-dispatch conservative retention, release, max-call accounting, and webhook claim fencing.

## Production caller chain proven structurally

```
apps/review-worker/package.json start
  -> apps/review-worker/src/main.ts
  -> createProductionReviewRuntime()
  -> createWorker()
  -> createReviewExecutionPort()
  -> advanceToSettled()
  -> runRealAnalysis()
  -> ModelGateway.request()
  -> LLM candidate generation
  -> independent verifier fresh source read
  -> durable verification / policy / publication-intent transition
```

This is structural source reachability evidence. It is **not** a live production probe.

## Tests added / strengthened but not executed in this environment

- model-gateway adapter, retry/accounting, replay and failure-semantics tests;
- LLM candidate anchor / prompt-injection / verifier tests;
- analyzer-input identity regression tests, including base-side content;
- Postgres model-budget concurrency and reservation-lifecycle tests;
- webhook ownership/defer fencing integration tests;
- GitHub installation-token exchange tests;
- GitHub repository reader tests for real hunk anchors, merge-base propagation, compare truncation,
  binary changed files and independent file reads.

## Static evidence at freeze

The final packaging script re-runs these checks and records their values in the external checkpoint
response:

- TypeScript parser diagnostics for affected workspaces;
- JSON parsing of root/workspace manifests and lockfile;
- exact manifest/lock dependency agreement for touched workspaces;
- provider-SDK import / lock-entry scan;
- executable production composition caller scan;
- source-level `apps/web` comparison to the originally uploaded archive.

## Explicitly does not claim

- No semantic TypeScript typecheck is claimed.
- No Vitest suite is claimed passing.
- No Postgres integration test is claimed executed.
- No mutation is claimed killed.
- No live OpenAI or Anthropic model call is claimed.
- No sealed holdout has been opened or spent.
- No precision, recall, false-positive, token, cost, p50 or p95 evaluation metric is claimed.
- No external GitHub source-reader probe is claimed.
- Phase 2 is **not COMPLETE**.

## External blockers observed in this execution environment

- The workspace dependency set is not installed. An offline npm install cannot complete because
  required cached packages are unavailable; the globally available TypeScript version is not the
  repository-pinned compiler.
- Docker is unavailable and `psql` is unavailable, so the mandatory real-Postgres CI gate cannot
  execute here.
- Real OpenAI/Anthropic provider credentials are unavailable, so the required live-provider probe
  cannot run here.

The sealed holdout intentionally remains **UNSPENT** until the implementation can be frozen under
an executable acceptance environment. Opening it without the required gate/provider environment
would spend evaluation evidence without a valid candidate.

## UI delta

None. Phase 2 does not intentionally modify `apps/web`. At packaging time, its source tree is
compared against the original uploaded archive; generated dependency/compiler artifacts are not
accepted as UI changes.

## Corrections to earlier in-progress notes

- The final implementation does **not** depend on OpenAI or Anthropic npm SDK packages; the provider
  adapters use the gateway-owned native-fetch boundary. Therefore there is no provider-SDK lockfile
  graph to resolve.
- The current root lockfile contains the `packages/model-gateway` workspace and matches the touched
  workspace manifests.
- The production GitHub repository reader and executable review-worker composition root now exist;
  earlier in-progress notes that identified those as missing are superseded by this checkpoint.
