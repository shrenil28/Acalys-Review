# Phase 3 acceptance

Phase 3 has one authoritative acceptance command:

```sh
npm run accept:phase3
```

The command is deliberately fail-closed. A missing dependency, unavailable
Postgres runtime, skipped integration suite, stale mutation anchor, surviving
mutant, or architecture rule that does not reject its planted violation makes
the command non-zero. A source-only archive can run:

```sh
npm run accept:phase3:preflight
```

Preflight is useful evidence, but it is **not** Phase 3 acceptance.

## What full acceptance executes

1. Every dependency-free Phase 3 source/probe preflight.
2. `npm run verify`, which is the repository's protected nine-gate surface:
   typecheck, lint, formatting, dependency-cruiser, project references, schema
   conformance, clean build, export conformance, and `test:ci`.
3. Postgres is forced on with `ACALYS_REQUIRE_POSTGRES=1`; integration suites
   may not skip because Docker is unavailable.
4. The architecture probe plants an `apps/api -> review-worker` import and a
   direct `pg` import outside `@acalys/database`; both named dependency rules
   must reject the tree.
5. The Phase 3 mutation harness plants the four contract-required mutants in
   authentication, tenant lookup, idempotency digest binding, and response
   validation; all four must be killed by their declared suites.
6. Source invariants run once more after mutation/architecture restoration.

A successful full run writes `.phase3-acceptance-report.json` with
`"accepted": true`. The file is local evidence and is git-ignored; CI should
archive it as a build artifact if long-term execution evidence is required.

## Frozen implementation scope

The acceptance target remains the contract in `capability-contract.md`:
exactly 14 manifest HTTP routes plus the review-event SSE stream, authenticated
and tenant-scoped access, rotating opaque sessions and scoped API keys, shared
durable rate limiting, transactionally idempotent mutations, correlation IDs,
validated request/response/error boundaries, and durable resumable SSE.

The contract's explicit non-claims stay non-claims. In particular, Phase 3 does
not add browser GitHub OAuth start/callback HTTP routes outside the frozen
manifest and does not make later-phase review-summary/conversation/knowledge/
pre-merge data producers generate new product data.
