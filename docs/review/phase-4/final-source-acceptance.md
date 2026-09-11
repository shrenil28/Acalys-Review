# Phase 4 final-source acceptance handoff

This document is the handoff for executable checks that cannot be completed in the source-only sandbox used to freeze Checkpoint 4.6.

## One-command source preflight

```bash
npm run accept:phase4:preflight
```

This is dependency-free. It runs all eleven Phase-4 probes and then the entire frozen Phase-3 preflight. A failure is fatal.

## Full dependency/Postgres acceptance

```bash
npm ci
npm run accept:phase4
```

Full mode requires the repository-local Vitest, TypeScript, ESLint, Prettier and dependency-cruiser binaries plus a working Docker/Postgres runtime. It sets `ACALYS_REQUIRE_POSTGRES=1` before the protected `npm run verify` pipeline, so Postgres suites cannot skip to green. A missing prerequisite exits with status 2 and is recorded as blocked, not passed.

The generated `.phase4-acceptance-report.json` records source preflights, inherited Phase-3 status, environment prerequisites and executable results. Acceptance reports are runtime evidence and should not be committed or packaged as source truth.

## Browser release witness

The repository currently has no Playwright harness, so browser acceptance is deliberately not fabricated by `accept-phase4.mjs`. Against the production build in API mode, validate at minimum:

1. OAuth/browser exchange, session rehydration/logout and organization pinning.
2. Repository/PR discovery, review creation, authenticated SSE reconnect with `Last-Event-ID`, reload rehydration, cancellation and duplicate/conflict behavior.
3. Team role changes, invitations/redemption/removal, API-key one-time issuance and revocation.
4. Organization/repository review-policy edits, revision conflict rollback, pause/resume and ignored/base-branch policy behavior.
5. Linear/CircleCI/MCP/Jira settings without credential disclosure in browser/network responses.
6. Analytics filters/timezones, reports/manual generation and explicit unavailable recurring delivery.
7. Notification revision conflicts, repository metrics/activity, cache physical deletion and security finding dismissal.
8. Fixture firewall: production/API mode must never render demo facts when a live backend is missing or failing.

Capture the browser evidence separately. Do not modify the source acceptance report to claim browser coverage.
