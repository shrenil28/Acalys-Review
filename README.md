# Acalys Review

A cloud code-review platform: a GitHub/GitLab app that reviews pull requests with
AI-backed agents, verifies its findings against evidence, and publishes them back to the
provider — with a dashboard over the whole thing.

The build is phased. **Phase 0 (in progress) establishes the canonical contracts** every
later subsystem speaks; the reviewer, webhooks, workers, and persistence come after. The
full specification lives in [P0.txt](P0.txt).

---

## Layout

```
acalys/
├── apps/
│   └── web/                 Dashboard (Vite + React 18 + TypeScript + Tailwind)
├── packages/
│   └── contracts/           @acalys/contracts — the canonical domain language
├── tsconfig.base.json       Compiler baseline for packages authored in Phase 0+
└── .dependency-cruiser.cjs  Architectural boundary enforcement
```

Planned, each landing with the phase that needs it: `apps/{api,webhook-gateway,
review-worker,tool-worker,sandbox-worker,scheduler}` and `packages/{api-client,database,
auth,config,queue,telemetry,providers,repository,code-intelligence,tools,evidence,
knowledge,review-engine,verification,premerge,model-gateway}`.

Empty stubs are deliberately **not** scaffolded ahead of time — the workspace globs
(`apps/*`, `packages/*`) already exist, so nothing gets bolted on later.

## Running it

```bash
npm install
npm run dev        # dashboard at http://localhost:5173
npm run verify     # typecheck + lint + dependency boundaries + tests
```

Individual gates:

```bash
npm run typecheck
npm run lint
npm run depcruise    # architectural boundaries
npm run test
npm run build
```

---

## The architecture in one diagram

Everything below follows from a single rule: **provider-specific representations
terminate at an adapter, and the platform speaks only canonical contracts.**

```
GitHub PR ──┐
GitLab MR ──┼──> Provider Adapter ──> ReviewTarget ──> Review Platform ──> Agent Runtime
local tree ─┘                        (canonical)
```

Never the reverse. `@acalys/contracts` imports no provider SDK, no ORM, and no model SDK,
and dependency-cruiser fails the build if that ever changes.

### Three contract layers

```
                     contracts/src/domain/
        canonical · provider-neutral · persistence-neutral
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
      contracts/src/api/              contracts/src/internal/
      public DTOs (v1)                commands + events
              │                             │
              ▼                             ▼
      @acalys/api-client              apps/{api,workers}
              │
              ▼
          apps/web
```

The web app sees product concepts — Review, Finding, Summary, Conversation, Pre-Merge
Check, Repository, Pull Request, progress. It never sees a worker attempt, a queue lock,
a sandbox lease, or a raw model response. DTOs are projected _from_ domain types rather
than hand-written beside them, so the two cannot drift.

### Async by construction

Long-running work never blocks an HTTP request:

```
POST /api/v1/reviews  →  202 { reviewRunId, state: "queued" }
                              │
                         queue → review-worker → tools / agents / sandbox
                              │
UI follows: GET /api/v1/reviews/:id  ·  GET /api/v1/reviews/:id/events (SSE)
```

Workers scale horizontally without any change to the frontend API.

---

## Phase 0 status

Landed (Checkpoint A):

| Area       | Contents                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Primitives | `Brand`, `assertNever`, `JsonValue`, `canonicalJson`, `Timestamp`, `Checksum`, `RepositoryPath`, size limits, namespaced ids |
| Identity   | 21 branded ids, UUIDv7 factories, per-type schemas                                                                           |
| Ports      | `Clock` (+`SystemClock`/`FixedClock`), `IdGenerator`, `ContentHasher`                                                        |
| Errors     | 12-class taxonomy with retryability and leak-free serialization                                                              |
| Domain     | tenancy, provider, repository, git refs, actors                                                                              |
| Tooling    | npm workspaces, ESLint 9, Prettier, Vitest, dependency-cruiser, CI                                                           |

Remaining: review lifecycle and state machines (B) · evidence, findings, verification (C)
· API/internal layers, config resolution, events (D) · JSON Schema generation, fixtures,
docs, persistence plan (E).

### Conventions worth knowing

- **Timestamps** are RFC 3339 UTC with exactly three fractional digits
  (`2026-08-15T15:30:12.421Z`). Nothing else validates — the fixed width is what makes
  lexicographic order equal chronological order and keeps hashes byte-stable.
- **Ids** are UUIDv7 and branded. A `RepositoryId` will not compile where a `ReviewRunId`
  belongs.
- **Hashing** goes through `canonicalJson()`; raw `JSON.stringify` is lint-blocked in the
  contracts package because its key order is insertion order.
- **Optional means absent.** `undefined` for a missing value, `null` only where "explicitly
  cleared" is semantically distinct.
- **Schemas are the source of truth**; TypeScript types are inferred from them, never
  written in parallel.
