# Phase 4.2 core review workflow

## Scope

Checkpoint 4.2 connects the existing Acalys triage experience to the frozen Phase-3 review API without changing that public API or inventing later-phase analytics. In production/API mode, repository pull requests, review mutation state, durable progress events, findings, pre-merge checks, conversations and the review summary all come from the live contract.

Fixture mode remains an explicit demo path. `Triage.tsx` chooses the data mode and lazy-loads `TriageFixture.tsx` only when fixtures were explicitly selected. The API-mode entry, live triage page and review drawer do not import review fixtures.

## Browser data path

Pages do not call `fetch` or import DTO schemas directly. The browser path is:

```text
LiveTriage / ReviewWorkflowDrawer
        ↓
reviewWorkflow.ts
        ↓
client.ts + browserSession.ts
        ↓
Phase-3 /api/v1 contract
```

The central client owns bearer authorization, JSON mutation encoding, response validation and authenticated event-stream opening. Review mutations carry a fresh stable `Idempotency-Key` for one user operation.

Pull-request discovery uses the repository directory that was connected in 4.1. Repository PR pagination is exhaustive up to a safety bound and repository fan-out is capped at four concurrent collectors so a large organization does not create an unbounded request burst.

## Review lifecycle

Selecting a live pull request opens the existing Acalys drawer treatment. Starting a review sends only the repository and pull-request identifiers exposed by the frozen contract. Unsupported fields such as risk, priority, reviewer assignment, diff statistics and effort are deliberately displayed as unavailable rather than inferred from fixtures.

After a successful create, the review run ID is stored in the triage URL as `review=<id>`. This makes an in-progress or settled review recoverable across a browser reload. On rehydration the run is fetched through `GET /reviews/:id` and must belong to the selected repository and pull request before it is accepted. The Start Review action remains disabled while that ownership check is in flight.

A create-review `409` remains a surfaced conflict. The frozen Phase-3 error body intentionally does not reveal an existing run ID, so the frontend cannot recover that run from a conflict alone without widening the public contract.

## SSE transport and resumption

The frontend uses authenticated `fetch` streaming rather than `EventSource`, because the frozen API requires bearer authorization and browser `EventSource` cannot attach the required `Authorization` header.

The stream parser:

- ignores comment/heartbeat frames;
- joins multi-line `data:` fields;
- validates JSON with `reviewProgressEventSchema`;
- rejects events belonging to another run;
- remembers the last durable `id:`;
- reconnects with `Last-Event-ID` after a dropped stream;
- uses bounded exponential retry delay;
- retries transport failures, `429`, and server failures;
- fails closed immediately for contract failures and non-retryable 4xx responses;
- stops on a `review.done` event or a terminal progress phase.

A reconnect never paints an unvalidated frame. The page shows the reconnect count so connection recovery is visible without changing the established UI language.

## Settled artifacts and mutations

Once the run settles, the adapter loads:

- review summary for completed runs;
- all review findings;
- the bounded pre-merge-check collection;
- repository conversations filtered to the selected pull request.

Published findings can be dismissed only with a non-empty user reason. Open conversations can be resolved. Both mutations use idempotency keys and refresh the live artifact set after success. A running review can be cancelled through the Phase-3 cancellation mutation.

Pre-merge-check status and `blocking` are kept separate. An empty check collection is rendered as **merge permission unknown**, never as approval.

## Stale-result rule

The current public frontend contract does not expose a review revision identifier. The UI therefore applies the strongest available conservative check: if the pull request `updatedAt` is later than the review run `createdAt`, results are marked stale and the user is told to start a new review before relying on them. This is deliberately documented as timestamp-based rather than pretending it is exact revision equality.

## Failure and empty states

API mode preserves the Phase-4 live state model:

- loading;
- deployment misconfiguration;
- transport/contract/rejected failure;
- true empty dataset;
- filtered-empty dataset.

A failed request is never rendered as a clean/empty review. Contract mismatches fail closed instead of falling back to demo data.

## Deferred fields

The live triage board intentionally does not synthesize later-owned information:

- AI/security risk and richer finding categorization — Phase 6;
- reviewer/identity-driven inbox semantics — later approved account/membership integration;
- aggregate review/effort/diff analytics — Phase 13;
- other later-phase security, reporting and organization metrics listed in the page-capability inventory.
