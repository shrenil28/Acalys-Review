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
