# P1-K.0 — frontend inventory

**Status:** inventory only. No source changed, no UI changed, nothing fixed.

Its purpose is to answer _what is actually there_ before anything is brought
under a gate, because two things stated earlier in planning turned out to be
wrong, and both were wrong in the direction of making the problem sound worse
and simpler than it is.

---

## Corrections to earlier claims

**"apps/web is excluded from every quality gate."** Not true.

| Gate      | Participates | Evidence                                           |
| --------- | ------------ | -------------------------------------------------- |
| typecheck | **yes**      | `tsc -b --noEmit`, runs via `--workspaces`, passes |
| build     | **yes**      | `tsc -b && vite build`, in `build:clean`           |
| depcruise | **yes**      | 95 of 280 modules cruised are `apps/web/`          |
| lint      | **no**       | `apps/web/**` in eslint ignores                    |
| tests     | **no**       | zero test files exist                              |
| mutation  | **no**       | no semantic logic under mutation                   |

So the frontend is not outside the engineering system. It is outside **lint and
tests**, which is narrower and more fixable than "it only builds".

**"The non-exhaustive switch is the semantic-collapse risk."** Not true either.
It is `Triage.tsx:94`, `switch (display.ordering)` missing `"updatedAt"` — a
sort-order enum. A real defect (findings sort by an unintended key) but not a
trust-state collapse. The structural _class_ is the same; the stakes are not.

---

## File classification

92 TypeScript/TSX files, ~16,600 LOC, plus 12 `.mjs` scripts.

| Bucket                  | Count | Location                                         |
| ----------------------- | ----: | ------------------------------------------------ |
| 1. App entry / runtime  |     2 | `src/main.tsx`, `src/router.tsx`                 |
| 2. Domain / view-model  |     4 | `src/lib/` — breadcrumbs, nav, session, utils    |
| 3. Data (mock fixtures) |     8 | `src/data/`                                      |
| 4. Reusable UI          |    31 | `src/components/{ui,layout,charts,integrations}` |
| 5. Pages                |    44 | `src/pages/`                                     |
| 6. Scratch / tooling    |    12 | `*.mjs`, plus postcss/tailwind config            |

Bucket 6 is not production code. Every `.mjs` file opens
`http://127.0.0.1:9222/json/list` — the Chrome DevTools Protocol — and drives
screenshots. Referenced by **zero** production modules, verified individually
rather than assumed. They warrant a narrow, enumerated ignore; they do not
warrant `apps/web/**`.

---

## Lint baseline

30 problems with the ignore lifted. Not one is stylistic.

```
14  parse-error                       the .mjs scratch scripts, outside the TS project
12  no-unnecessary-type-assertion     mechanical
 2  no-floating-promises              CORRECTNESS
 1  no-misused-promises               CORRECTNESS
 1  switch-exhaustiveness-check       CORRECTNESS
```

### The four correctness defects, recorded and deliberately not fixed

| #   | Rule                          | Location                                          | Consequence                                                |
| --- | ----------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `no-floating-promises`        | `components/integrations/ConnectModals.tsx:78`    | an integration connect can fail with the rejection dropped |
| 2   | `no-floating-promises`        | `pages/organization/OrganizationSettings.tsx:396` | a settings save can fail silently                          |
| 3   | `no-misused-promises`         | `pages/account/ApiKeys.tsx:249`                   | an async handler passed where `void` is expected           |
| 4   | `switch-exhaustiveness-check` | `pages/review/Triage.tsx:94`                      | `"updatedAt"` ordering falls through                       |

Left in place on purpose. Fixing them before the gate can catch them destroys
the evidence that the gate works — the same discipline that kept the analyzer's
shadowing bug alive until the verifier had been shown to stop it.

---

## Semantic surfaces: there are almost none yet

This is the most consequential finding, and it inverts the risk.

Searching the frontend for the backend's trust vocabulary —
`verified`, `inconclusive`, `unavailable`, `withheld`, `superseded`,
`dismissed`, `stale` — returns four files, and every hit is either marketing
copy or an unrelated enum. The three `switch` statements in the codebase are
over `display.ordering` and settings `section`.

**The frontend cannot currently collapse backend meanings, because it never
receives them.** It is a complete UI shell driven by fixtures in `src/data/`.

The risk is therefore prospective rather than present, and the mitigation is a
boundary built before the wiring, not a rescue afterwards.

---

## What the UI actually consumes

The instruction is that the UI does not change and the backend is made
compatible with it. So the UI's fixtures are the specification, and this is what
they require.

### `DeepScanFinding` → backend `ReviewFinding`

| UI field      | UI type                                   | Backend today                                                 | Gap            |
| ------------- | ----------------------------------------- | ------------------------------------------------------------- | -------------- |
| `severity`    | `"Critical" \| "High" \| … \| "Info"`     | `"critical" \| "high" \| … \| "info"`                         | case only      |
| `category`    | `string`                                  | 15-value `FindingCategory`                                    | UI is looser   |
| `file`,`line` | `string`, `number`                        | `path`, `startLine`                                           | naming         |
| `summary`     | `string`                                  | `claim`                                                       | naming         |
| `detail`      | `string`                                  | `explanation`                                                 | naming         |
| `remediation` | `string`                                  | `remediation`                                                 | aligned        |
| `detectedAt`  | `string`                                  | `created_at`                                                  | naming         |
| `status`      | `"Open"\|"Fixed"\|"Ignored"\|"In review"` | `verified\|published\|resolved\|dismissed\|stale\|superseded` | **vocabulary** |
| `subsystem`   | `string`                                  | —                                                             | **absent**     |
| `cwe`         | `string?`                                 | —                                                             | **absent**     |

The `status` row is the one that matters. Four display states against six
lifecycle states is a lossy mapping in the direction this project has spent
several checkpoints preventing, and it needs a deliberate, exhaustive adapter —
not an inline conditional.

### `PrFinding` → per-PR aggregate

`fixed`, `total`, `criticalHigh`, `state: Open|Merged|Closed`, `lastActivity`.
The backend has the underlying rows and exposes no such aggregate.

### `TriagePr` → substantially new backend capability

`priority`, `reviewGuidance`, `changeType`, `risk`, `securityRisk`,
`blastRadius`, `reviewEffort`, `issueSeverity`, `reviewState`.

None of these exist in the backend. They are not renames or adapters — they are
analyses the engine does not perform: change classification, risk scoring,
blast-radius estimation, and review-effort prediction.

---

## Honest scope of "make the backend compatible with the UI"

Three tiers, and they are very different sizes.

```
tier 1  naming and case            a DTO adapter          small
tier 2  aggregates and lifecycle   query + mapping work   moderate
tier 3  risk, effort, blast radius NEW ANALYSES           a phase, not a task
```

Tier 3 is the bulk of the triage screen. It is genuinely new product capability,
and calling it "compatibility" would understate it by a wide margin.

---

## What P1-K.0 deliberately did not do

- No source file was modified.
- No component, style, layout or copy was touched.
- No lint rule was disabled and no ignore was widened.
- The four correctness defects remain, as baseline evidence.
- No `eslint --fix` was run.
