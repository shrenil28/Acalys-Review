# Acalys — CodeRabbit-style review dashboard

A front-end dashboard branded **Acalys**, built to match the CodeRabbit dashboard (`app.coderabbit.ai`), rebuilt from
the Anima/Figma exports in the parent folder plus reference screenshots of the
live app.

```
coderabbit-clone/
└── frontend/          # Vite + React 18 + TypeScript + Tailwind
```

## Running it

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle
npm run typecheck  # types only
```

## Design system

Every token was sampled from the running app rather than guessed. CodeRabbit
ships a single dark theme built on a 305° hue ramp; the values live in
`src/index.css` and are exposed through Tailwind in `tailwind.config.js`.

| Token | Value | Used for |
| --- | --- | --- |
| `canvas` | `oklch(0.213 0.0098 305)` | Page background |
| `shell` | `oklch(0.177 0.0084 305)` | Sidebar, popovers, modals |
| `surface` | `oklch(0.252 0.0112 305)` | Cards and panels |
| `line` | `oklch(0.312 0.014 305)` | Hairline borders |
| `fg` / `fg-muted` / `fg-subtle` / `fg-faint` | 0.949 → 0.401 lightness | Text ramp |
| `brand` | `oklch(0.75 0.183 55.934)` | CodeRabbit orange |

Type is Geist (UI) and Geist Mono (code, paths, tabular data).

Charts use hex equivalents of these tokens rather than `oklch()`: Chrome rejects
`oklch()` inside SVG presentation attributes, which silently drops every mark.

## Structure

```
src/
├── components/
│   ├── ui/          Button, Badge, Card, Table, Input, Menu/Popover, Modal,
│   │                Drawer, Tabs, ViewRail, Switch, Checkbox, Pagination,
│   │                Progress, EmptyState, Toast, Skeleton
│   ├── charts/      Grafana-style Panel + StatPanel, Area/Bar/Line/Donut,
│   │                Sparkline — one shared categorical ramp
│   ├── layout/      AppShell, Sidebar, CollapsedRail, SidebarNav, TopBar,
│   │                WorkspaceSwitcher, UserMenu, CommandPalette,
│   │                ShortcutsModal, PageHeader, SecurityBanner
│   └── icons.tsx    Brand marks lucide doesn't ship (GitHub, GitLab, Discord,
│                    Jira, Linear, CodeRabbit)
├── data/            Deterministic sample data (seeded generator, so reloads
│                    render identically)
├── lib/             nav tree, breadcrumbs, session, formatters
├── pages/           One folder per nav section
└── router.tsx       All routes
```

## Routes

| Section | Routes |
| --- | --- |
| Explore | `/` |
| Analytics → PR reviews | `/analytics/pr-reviews` + 8 views (quality-metrics, time-metrics, knowledge-base, organization-trends, pre-merge-checks, reporting, data-metrics, data-export) |
| Analytics → IDE/CLI | `/analytics/ide-cli-reviews` + organization-trends, data-metrics |
| Reports | `/reports`, `/reports/recurring/new`, `/reports/ondemand/new` |
| Review | `/review/triage`, `/review/repositories`, `/review/repositories/:name`, `/review/integrations`, `/review/learnings`, `/review/cache` |
| Organization settings | `/organization/settings/{general, review/summary, review/walkthrough, review/behavior, pre-merge-checks, finishing-touches, custom-post-merge-actions, statuses, fun}` |
| Security | `/security/{overview, repositories, ai-deep-scan, pr-findings, activity-log}` |
| Slack | `/slack/{scopes, automations, knowledge-base, connections, sandbox, activity, pr-auto-fix}` |
| Discord | `/discord/{scopes, connections, automations, knowledge-base, sandbox, activity}` |
| Plan | `/plan/{discover, new, plans, configurations}` |
| Account | `/settings`, `/settings/{team, api-keys}` |
| Auth | `/login` |

## Behaviour worth knowing

- **Command palette** — `⌘K` / `Ctrl+K`. Results are grouped into Configuration
  Settings, Navigation and Settings, and individual settings are addressable.
- **Keyboard shortcuts** — `?` opens the shortcut sheet (suppressed while typing).
- **Sidebar** — collapsible; the state persists in `localStorage`. Collapsed, each
  group opens a hover flyout so sub-pages stay one click away. A floating
  "View more" pill appears when the nav overflows.
- **Organization settings** — three panes: section nav, editor, and a live preview
  of the review comment that reacts to every toggle. The `👁 View` chip on a row
  scrolls the preview to the block that setting controls. Four view modes:
  Concise, All Settings, YAML Editor, Global Overrides.
- **Triage** — board and list layouts, `?view=` / `?q=` / `?layout=` in the URL,
  and a distinct empty state per view.
- **Toasts** — every destructive or persisting action confirms in the corner.

## Wiring a backend

The UI reads only from `src/data/*`, so each module maps to one endpoint group:

| Module | Suggested endpoints |
| --- | --- |
| `data/repos.ts` | `GET/POST /repositories`, `PATCH /repositories/:name` |
| `data/analytics.ts` | `GET /analytics/{summary,quality,time,trends,checks,knowledge}` |
| `data/security.ts` | `GET /security/{findings,pr-findings,activity}`, `POST /security/scan` |
| `data/review.ts` | `GET /triage`, `/integrations`, `/learnings`, `/caches`, `/plans` |
| `data/account.ts` | `GET /members`, `/api-keys` |
| `data/orgSettings.ts` | `GET/PUT /organization/settings` (shape mirrors `.coderabbit.yaml`) |

`components/ui/Skeleton.tsx` is ready for the loading states those fetches will
need — it is intentionally unused while the data is local and synchronous.

## Known gaps

- Data is local and in-memory: edits persist for the session, not across reloads.
- The bundle is a single ~900 kB chunk. Route-level `React.lazy` is the obvious
  split once the backend lands.
- Slack and Discord surfaces render their pre-connection state, since the real
  OAuth flow needs a backend.
- Billing, subscriptions, and plan tiers are deliberately absent — this clone
  covers the product surface only.
