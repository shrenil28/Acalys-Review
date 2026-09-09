# Phase 3 capability contract — public API and authentication

Status: **FROZEN before implementation**

## Claim

Phase 3 exposes exactly the frozen `@acalys/contracts/api/v1` route manifest and its review-event SSE stream through an authenticated, tenant-isolated HTTP application. Every inbound path/query/body and every successful response is validated by the manifest schema. Every mutating request is idempotent, every request has a correlation id, and no handler can choose a tenant from caller-controlled input.

Authentication provides opaque rotating sessions and scoped API keys, both stored only as one-way hashes. Authorization uses the closed role vocabulary `owner | admin | member | read_only`. Tenant scope is enforced in database query methods, not reconstructed in route handlers. Rate limits are enforced per principal and organization with a durable shared store suitable for horizontal API replicas.

The SSE stream exposes product-level review progress only. It uses monotonic per-review event ids derived from durable run transitions, supports `Last-Event-ID`, emits bounded heartbeats, and never exposes worker attempts, leases, queue identities, model responses, or other execution internals.

## Explicit non-claims

- Phase 3 does not make later-phase product capabilities (conversations, learnings, review summaries, pre-merge runners) produce data. Their routes may legitimately return an empty page or 404 only when the corresponding tenant-scoped persistence contains no resource.
- Phase 3 does not add a new public route outside the frozen manifest.
- GitHub OAuth code exchange and installation-link construction are implemented as an authentication service, but there is no HTTP start/callback endpoint in the frozen route manifest. Publishing such endpoints requires an explicit contract addition before they can be mounted.
- Phase 3 does not expose provider installation tokens, session secrets, API-key material, webhook secrets, private keys, stack traces, upstream bodies, or raw database errors.
- `unknown` failures are not represented as successful empty results.

## Independent verification

1. A manifest-conformance test proves every `API_ROUTES` entry has exactly one handler and no extra v1 handler exists.
2. Request tests plant malformed params/query/body and prove the handler is not reached.
3. Response tests make a handler return a plausible malformed object and prove the boundary refuses to serialize it as success.
4. Cross-tenant tests seed the same resource class in two organizations and prove a principal in A cannot read or mutate B even when supplying B's id directly.
5. API-key/session tests prove plaintext credentials are not persisted, rotation invalidates the predecessor, revocation is immediate, scopes are enforced, and last-used is updated only after successful authentication.
6. Idempotency tests prove equal key + equal canonical request replays the original response and equal key + different request conflicts.
7. SSE tests prove resume starts strictly after `Last-Event-ID`, heartbeats contain no product state, stale/foreign event ids do not cross tenants, and disconnect tears the stream down.
8. Dependency-cruiser mutation: temporarily import a worker internal from `apps/api` and prove the architectural gate rejects it.

## Acceptance thresholds

- 14/14 manifest routes implemented; 0 undeclared `/api/v1` routes.
- Request and response schema validation: 100% route coverage.
- Cross-tenant reads/mutations: 0 successful adversarial cases.
- Session/API-key plaintext persistence: 0 occurrences.
- SSE resume duplicates: 0; missed durable transitions after supplied event id: 0.
- Required gates all green with Postgres integration tests required.
- Mutations planted in auth, tenant query, idempotency, and response-validation boundaries; 0 survivors.
