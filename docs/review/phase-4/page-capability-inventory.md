# Phase 4 page → capability → owning phase → backing inventory

Status: **Checkpoint 4.1 baseline — approved by continuation instruction**
Canonical UI source: `apps/web/src/router.tsx` and `apps/web/src/pages/**`
Rule: a fixture may exist for explicit demo mode, but **API mode must never substitute it for missing live data**.

## Ownership vocabulary

| Owner             | Meaning in this inventory                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P4                | Dashboard integration itself: adapters, live state branches, browser auth/admin bridge, and wiring already-existing product APIs. |
| P5                | Sandboxed tools / deep tool evidence.                                                                                             |
| P6                | Summary, walkthrough, suggestions, security/performance/etc. review breadth.                                                      |
| P7                | Review conversations and chat-agent command/runtime integration.                                                                  |
| P8                | Learnings / knowledge authoring and runtime.                                                                                      |
| P9                | Pre-merge checks and CI ingestion.                                                                                                |
| P10               | Incremental review at scale and cache/incremental operational surfaces.                                                           |
| P11               | CLI / IDE product integration.                                                                                                    |
| P12               | Multi-provider / external integration expansion.                                                                                  |
| P13               | Billing, analytics, reports, usage aggregation and observability dashboards.                                                      |
| P14               | Production/operational hardening where a UI surface is operational rather than product data.                                      |
| **Missing phase** | The current roadmap has no owning implementation phase. This is a roadmap gap, not permission to invent a backend inside Phase 4. |

## Rendered route inventory

### Entry and overview

| Route    | Capability promised by UI                 |                Owner | Backing at P4.1                                        | Decision                                                                        |
| -------- | ----------------------------------------- | -------------------: | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `/login` | Browser sign-in/session establishment     | P4 (on Phase-3 auth) | UI only; no browser OAuth HTTP bridge in frozen P3 API | P4.3 must add an approved dashboard-auth contract; no fake success in API mode. |
| `/`      | Product overview / recent review activity |             P13 + P4 | fixture analytics                                      | Later-owner surface. P4 will gate API mode rather than show fixtures.           |

### Review / repository workflow

| Route                        | Capability promised by UI                                   |                                Owner | Backing at P4.1                                                                                             | Decision                                                                                              |
| ---------------------------- | ----------------------------------------------------------- | -----------------------------------: | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/review/repositories`       | Repository directory, review-enabled state, review activity |                             P4 + P13 | **Live repository read wired in 4.1**; analytics/mutation fields absent                                     | P4.1 live identity/read; P4.3 repository-setting mutations; P13 metrics.                              |
| `/review/repositories/:name` | Repository overview, settings, learnings, activity          |                        P4 + P8 + P13 | **Live repository + live knowledge read wired in 4.1**; settings/activity analytics unavailable in API mode | Preserve shell; never synthesize missing metrics.                                                     |
| `/review/triage`             | PR queue, review state, risk/priority/effort triage         |                        P4 + P6 + P13 | fixture                                                                                                     | P4.2 wires PR/review facts; P6 owns richer review-category/risk analysis; P13 owns aggregate metrics. |
| `/review/learnings`          | View/manage learnings                                       |     P8 (live read available from P3) | **Live knowledge read wired in 4.1**; write/delete absent                                                   | P4.1 live read; P8 adds author/edit/delete/runtime.                                                   |
| `/review/cache`              | Review/cache operational controls                           |                            P10 + P14 | fixture                                                                                                     | Explicit later-phase state in API mode until cache contract exists.                                   |
| `/integrations`              | Provider/integration connections                            | P12, baseline dashboard bridge in P4 | fixture                                                                                                     | P4.3 may expose existing GitHub installation status; provider expansion remains P12.                  |

### Pull-request analytics

| Route                                            | Capability promised by UI                     |     Owner | Backing at P4.1                                           | Decision                                                                    |
| ------------------------------------------------ | --------------------------------------------- | --------: | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/analytics/pr-reviews`                          | Review summary analytics                      |       P13 | fixture                                                   | P13; API mode must show deferred/unavailable state, not fixture values.     |
| `/analytics/pr-reviews/quality-metrics`          | Quality aggregation                           |       P13 | fixture                                                   | P13.                                                                        |
| `/analytics/pr-reviews/time-metrics`             | Review timing aggregation                     |       P13 | fixture                                                   | P13.                                                                        |
| `/analytics/pr-reviews/knowledge-base`           | Knowledge records + knowledge usage analytics |  P8 + P13 | **Live knowledge records wired in 4.1**; usage charts P13 | P4.1 shows live record count/list; aggregate charts explicitly unavailable. |
| `/analytics/pr-reviews/organization-trends`      | Org trend analytics                           |       P13 | fixture                                                   | P13.                                                                        |
| `/analytics/pr-reviews/pre-merge-checks`         | Check analytics                               |  P9 + P13 | fixture                                                   | P9 creates check data; P13 aggregates it.                                   |
| `/analytics/pr-reviews/reporting`                | Review reporting                              |       P13 | fixture                                                   | P13.                                                                        |
| `/analytics/pr-reviews/data-metrics`             | Data/usage metrics                            |       P13 | fixture                                                   | P13.                                                                        |
| `/analytics/pr-reviews/data-export`              | Export analytics                              |       P13 | fixture                                                   | P13.                                                                        |
| `/analytics/pr-security-reviews`                 | Security review analytics                     |  P6 + P13 | fixture                                                   | P6 produces security findings; P13 aggregates them.                         |
| `/analytics/ide-cli-reviews`                     | IDE/CLI review summary                        | P11 + P13 | fixture                                                   | P11 product integration, P13 aggregation.                                   |
| `/analytics/ide-cli-reviews/organization-trends` | IDE/CLI org trends                            | P11 + P13 | fixture                                                   | Later phase.                                                                |
| `/analytics/ide-cli-reviews/data-metrics`        | IDE/CLI metrics                               | P11 + P13 | fixture                                                   | Later phase.                                                                |

The shared analytics repository filter now uses the live repository directory in API mode. Username/team dimensions are not present in the P3 contract, so P4.1 leaves them unavailable rather than using fixture dimensions.

### Reports

| Route                    | Capability promised by UI         | Owner | Backing at P4.1 | Decision                  |
| ------------------------ | --------------------------------- | ----: | --------------- | ------------------------- |
| `/reports`               | Saved/recurring/on-demand reports |   P13 | fixture         | P13.                      |
| `/reports/recurring/new` | Create recurring report           |   P13 | local form only | P13 persistence/delivery. |
| `/reports/ondemand/new`  | Create on-demand report           |   P13 | local form only | P13.                      |

### Organization/account administration

| Route                      | Capability promised by UI        |                                 Owner | Backing at P4.1                 | Decision                                                                                                                   |
| -------------------------- | -------------------------------- | ------------------------------------: | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/organization/settings/*` | Org + repository review settings | P4 plus feature-specific later phases | local/fixture state             | P4.3 creates dashboard settings/admin contract for already-existing config; P5/P6/P9/P10 own specialized feature settings. |
| `/settings`                | User/account settings            |                                    P4 | local UI                        | P4.3 browser/admin contract.                                                                                               |
| `/settings/team`           | Team membership/RBAC             |                         P4 on P3 auth | fixture                         | P4.3 exposes tenant membership safely.                                                                                     |
| `/settings/api-keys`       | API key create/revoke/list       |                         P4 on P3 auth | fixture/local secret simulation | P4.3 exposes P3 credential ledger; secret shown only once.                                                                 |

### Security

| Route                    | Capability promised by UI           |         Owner | Backing at P4.1                                                    | Decision                                                                                                      |
| ------------------------ | ----------------------------------- | ------------: | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `/security/overview`     | Security findings/scan analytics    | P5 + P6 + P13 | fixture                                                            | Later phase.                                                                                                  |
| `/security/repositories` | Repository security posture         | P5 + P6 + P13 | **Live repository identity wired in 4.1**, scan counts unavailable | Do not synthesize scan totals.                                                                                |
| `/security/ai-deep-scan` | Deep scan execution/results         |       P5 + P6 | fixture                                                            | Later phase.                                                                                                  |
| `/security/pr-findings`  | Security-category findings          |            P6 | fixture                                                            | Later phase. Generic P3 findings are wired to review workflow in P4.2; security categorization breadth is P6. |
| `/security/activity-log` | Security activity/audit aggregation |     P13 + P14 | fixture                                                            | Later phase.                                                                                                  |

### Slack / Discord

All routes below are owned by **P7** (chat/conversation runtime) with provider-connection expansion in **P12**. They remain fixture UI at P4.1 and must be explicitly gated in API mode before Phase 4 closes:

- `/slack/scopes`
- `/slack/automations`
- `/slack/knowledge-base`
- `/slack/connections`
- `/slack/sandbox`
- `/slack/activity`
- `/slack/pr-auto-fix`
- `/discord/scopes`
- `/discord/connections`
- `/discord/automations`
- `/discord/knowledge-base`
- `/discord/sandbox`
- `/discord/activity`

### Plan / coding planner

| Routes                                                               | Capability promised by UI                                          |             Owner | Backing at P4.1  | Decision                                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------: | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/plan/discover`, `/plan/new`, `/plan/plans`, `/plan/configurations` | Issue/brief → generated coding plan, saved plans, planner rulesets | **Missing phase** | fixture/local UI | **Roadmap gap.** Phase 4 must gate API mode and record the gap; implementation requires an explicitly approved roadmap phase rather than being smuggled into dashboard integration. |

## Redirect-only routes

These are aliases, not independent capabilities: `/analytics/reports`, `/review/integrations`, `/review/caches`, `/review/organization-settings`, `/organization/settings`, `/security`, `/plan`.

## Phase-4 checkpoint plan (maximum five)

1. **4.1 — Live data foundation + inventory + repository/knowledge surfaces.** Shared adapter/result layer, request deduplication/abort semantics, repositories, repository detail, knowledge list/dashboard, security repository identity, live analytics repository filter. This checkpoint.
2. **4.2 — Core review workflow.** Pull requests, review creation/progress SSE, findings/triage, pre-merge checks and conversations using the frozen P3 API; five-state UI and stale-revision/reconnect rules.
3. **4.3 — Browser/admin integration.** Propose/implement approved dashboard-facing auth, membership, API-key and settings/integration endpoints needed by existing pages; no route invention without a contract update.
4. **4.4 — Production fixture firewall for later-owned surfaces.** All P5–P14/Missing-phase pages get explicit API-mode deferred/unavailable states while explicit demo mode preserves current fixtures. This closes “zero production fixture reads” without fabricating later-phase data.
5. **4.5 — Phase-4 acceptance.** Playwright primary flows, CDP before/after screenshot comparison, five-state matrix, network cancellation/dedup probes, and §6.3 performance measurement. Phase 4 closes only when those executable gates are green.

## P4.1 UI deltas allowed by §6

The visual shell, tables, controls, spacing and typography remain the existing UI. Only these state/data branches are intentionally different in API mode:

- loading/error/misconfigured/empty/filtered-empty states;
- unavailable later-phase metrics display `—` or an explicit unavailable panel instead of fixture values;
- controls with no live mutation contract are disabled rather than pretending to persist;
- live repository/knowledge identities replace fixtures;
- Phase-13-only username/team analytics dimensions are empty/unavailable rather than fixture-backed.
