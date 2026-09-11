# Phase 4 production fixture firewall

Date: **2026-09-09**  
Checkpoint: **4.4**  
Base: **Phase 4 Checkpoint 4.3 full archive**

## Purpose

Checkpoint 4.4 closes the remaining dashboard integration safety gap without implementing product backends owned by Phases 5–14. Acalys keeps the existing fixture-rich UI available only when explicit demo/fixture mode is authorized. In production/API mode, a later-owned route renders a truthful deferred or read-only state and does not mount its fixture subtree.

The firewall is deliberately stronger than replacing fixture values at render time. The production browser's **static import graph** is checked from `apps/web/src/main.tsx`; it must not reach `apps/web/src/data/**`, `apps/web/src/lib/session.ts`, or any `*Fixture.tsx` UI module. Later-owned demo screens are loaded with `React.lazy()` only after `resolveDataMode()` has selected explicit fixture mode.

## Deferred surface groups

The following existing interfaces preserve their original demo presentation behind lazy fixture modules while API mode is explicit about the absent durable contract:

- overview (`/`): Phase 13 aggregate activity/usage;
- review cache: Phases 10 + 14;
- PR analytics, reports, data metrics/export: Phase 13;
- IDE/CLI analytics: Phases 11 + 13;
- security overview/deep scan/findings/activity: Phases 5/6/13/14 as recorded in the inventory;
- Slack/Discord operational pages: Phases 7 + 12;
- planner pages: **roadmap gap / missing owning phase**, so no backend is invented in Phase 4.

`/organization/settings/*` uses the same lazy-fixture rule, but API mode remains intentionally **read-only** instead of a generic deferred page because Checkpoint 4.3 already established that truthful boundary.

## Authenticated shell cleanup

Fixture isolation also applies outside route bodies. Checkpoint 4.4 removed static demo-session dependencies from the authenticated shell:

- `UserMenu` projects the authenticated dashboard session in API mode and lazy-loads the original demo menu only in fixture mode;
- `WorkspaceSwitcher` projects the session organization in API mode and does not fabricate additional organizations or switching authority;
- breadcrumb labels use the authenticated organization in API mode; demo workspace labels are obtained only through a fixture-mode dynamic import.

This prevents a production page that is otherwise live from leaking demo identity/workspace facts through persistent navigation chrome.

## Checkpoint 4.3 resolver repair

Independent 4.4 source review found that several 4.3 browser/admin modules imported `resolveDataConfig`, while `apps/web/src/lib/api/config.ts` exported only `resolveDataMode`. Syntax parsing cannot detect a missing named export. Checkpoint 4.4 repairs that latent build/type failure by exporting `resolveDataConfig` as the same fail-closed resolver:

```ts
export const resolveDataConfig = resolveDataMode;
```

There is intentionally one data-mode decision function, not two implementations that could drift.

## Source witnesses

`node scripts/probe-phase4-fixture-firewall.mjs` is dependency-free and fails closed on the following invariants:

1. the browser static import graph is fixture-data/session/fixture-UI free;
2. all later-owned wrappers use the shared deferred boundary and lazy demo imports;
3. authenticated shell modules do not statically import demo session state;
4. organization settings keeps its API-mode read-only boundary with lazy demo loading;
5. `resolveDataConfig` is the canonical resolver alias;
6. all 35 later-owned route declarations are still accounted for in the router;
7. the isolated fixture-module inventory remains present rather than being silently deleted.

Focused Vitest source in `apps/web/tests/fixture-firewall.test.ts` additionally pins production configuration behavior: explicit API mode resolves identically for dashboard/admin callers, production fixture mode requires the independent demo authorization flag, and missing production data mode fails as `misconfigured` rather than falling back to demo data.

## Validation boundary

The dependency-free source probes can execute in this container. The locked workspace dependency tree still cannot be installed offline because the cache lacks `yallist`, so React/Vite/Vitest/typecheck/build/Playwright execution is **unverified here**, not reported as passing. Those executable browser gates remain the single intended scope of Checkpoint 4.5.
