# Phase 0 — Canonical contracts and architectural foundation

Phase 0 builds the language the Acalys Review platform speaks: the canonical domain, the
two transport layers, the monorepo shape, and the boundaries that keep later phases from
reaching into each other.

It builds **no** reviewer, webhook, clone, analyzer, sandbox, HTTP server, database, or
queue (§88–§91). Ports are declared so Phase 1 implements against them.

---

## Documents

|                                                    |                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [architecture.md](./architecture.md)               | monorepo shape, the three contract layers, the async command path, and how every boundary is enforced |
| [domain-model.md](./domain-model.md)               | entities, the distinctions the model refuses to collapse, identity, and fingerprints                  |
| [state-machines.md](./state-machines.md)           | `ReviewRun` (11 states) and the finding lifecycle (6 states)                                          |
| [contracts.md](./contracts.md)                     | every contract with purpose, ownership, immutability, and versioning                                  |
| [events.md](./events.md)                           | the command/event split, causation policy, taxonomy, outbox readiness                                 |
| [versioning.md](./versioning.md)                   | `schemaVersion` vs API version, evolution rules, generated artifacts                                  |
| [provider-boundaries.md](./provider-boundaries.md) | where provider vocabulary stops, and the proof that it does                                           |
| [persistence-plan.md](./persistence-plan.md)       | the 19 tables Phase 1 writes, and the JSONB boundary                                                  |
| [phase-0-report.md](./phase-0-report.md)           | the §130 completion report                                                                            |
| [examples/](./examples/)                           | pointer to the validated fixture set                                                                  |

---

## Definition of done (§133)

> Phase 1 can build GitHub App → webhook normalization → `ReviewTarget` → `PullRequest` →
> `Revision` → `ReviewRequest` → `ReviewRun` **without changing these contracts**.

---

## Running the gates

```bash
npm run verify          # typecheck · lint · depcruise · schema drift · tests
npm run build           # contracts, api-client, web
npm run format:check
npm run dev             # the dashboard, unchanged, from apps/web
```

`npm run schemas:generate` after any contract change; `schemas:check` fails CI otherwise.
