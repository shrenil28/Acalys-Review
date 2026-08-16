# Phase 0 — Canonical contracts and architectural foundation

Phase 0 builds the language the Acalys Review platform speaks: the canonical domain, the
two transport layers, the monorepo shape, and the boundaries that keep later phases from
reaching into each other.

It builds **no** reviewer, webhook, clone, analyzer, sandbox, HTTP server, database, or
queue (§88–§91). Ports are declared so Phase 1 implements against them.

---

## What this is, and what it is not

> **Acalys today is a production-quality foundation for a CodeRabbit-class review system.
> It is not a production-quality review system.**

The distinction matters enough to state at the top of the directory, because "Phase 0 is
production-grade" and "Acalys is production-grade" are different claims and only the first
is true.

What exists is the contract layer: the domain, both transport layers, the boundaries, and
the tests that hold them. What does not exist is everything that produces a review — no
provider integration, no repository access, no analyzer, no reviewer, no persistence, no
server. `apps/web` still renders fixtures.

Contract-complete but not yet wired: path instructions, pre-merge checks, review summary
and walkthrough, conversations, suggested fixes. Those are Phase 1 wiring, not Phase 1
design.

The honest measure of whether this phase was correct is not how sophisticated the
contracts look. It is whether these three statements become true without a contract
redesign:

1. GitHub production ingestion shipped, then GitLab added without changing the review engine.
2. CLI review added without a second `Finding`/`Evidence` model.
3. Security scanning and multi-repo evidence added without rewriting finding provenance.

See [the Phase 1 plan](../phase-1/README.md) for what comes next and how its quality is
measured — including the review-quality gates, which the engineering gates below do not
substitute for.

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
