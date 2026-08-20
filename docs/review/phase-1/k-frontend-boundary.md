# P1-K — frontend production boundary

**Status:** COMPLETE. Eleven commits, `54e73bd`..`cc38eda`.

The checkpoint that started by correcting two claims about the frontend made
in planning — both wrong in the direction of sounding worse and simpler than
the codebase actually was — and closed by catching itself making the same
category of mistake twice: a merge-blocking rule re-derived instead of
copied, wrong both times it was written.

---

## What each checkpoint established

| Checkpoint | Commit    | Established                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K.0        | `54e73bd` | Inventory only, nothing fixed. Corrected two planning claims (`apps/web` already participated in typecheck, build and depcruise; the semantic-collapse risk was misidentified). Catalogued 92 TS/TSX files (~16,600 LOC) and 12 Chrome-DevTools-Protocol screenshot scripts. Recorded four correctness defects, deliberately left unfixed as gate evidence.                                                                                                                                                                                 |
| K.1        | `028153e` | Replaced the blanket `apps/web/**` eslint ignore with an enumerated one (12 `.mjs` scripts + 2 config files). Brought `apps/web` under lint. Fixed the four K.0 defects. `copyToClipboard` changed to never reject, surfacing failure through the existing `error` toast tone instead. Ordering moved to a tested `pages/review/ordering.ts` with an `assertNever` default. Tests: 0 → 9.                                                                                                                                                   |
| K.2        | `52c34dd` | Added `no-unreachable-in-web`, a depcruise rule scoped to what the browser actually loads from `index.html` (not covered by `no-orphans`) — planted a duplicate `src/src` subtree, watched the rule reject it, then removed it. Wired `@acalys/contracts/api/v1` in, aliased to source for dev. Wrote `lib/findings.ts`, the lifecycle adapter — and the same gate rejected it: no page fetches anything yet, so it has no consumer. Held back rather than landed.                                                                          |
| K.3        | `f0d6b7c` | First live read path: `AiDeepScan` page ← adapter ← typed, schema-validated client ← `@acalys/contracts/api/v1`. `ApiResult` is a four-way union (`ok` / `transport` / `contract` / `rejected`), not `T \| null`. `verified` reads as "In review", never "Open"; `superseded` carries a visible reason rather than disappearing silently. Tests: 9 → 24.                                                                                                                                                                                    |
| K.4        | `bcef3ee` | `resolveDataMode` closes "no API URL configured → fixtures" as a production default; production now requires an explicit, coherent `VITE_ACALYS_DATA_MODE`. Distinguished an aborted request (`signal.aborted`) from a failed one. Added a six-case rejection taxonomy (`unauthorized`, `forbidden`, `absent`, `conflict`, `throttled`, `server`, `other`) that never carries the response body. 8 mutations planted, 8 killed. Tests: 24 → 35.                                                                                             |
| K.5a       | `7b58ed5` | Two depcruise rules — `pages-must-not-import-the-transport`, `pages-must-not-import-api-contracts` — planted a violation, watched both fail, then cleaned. `assert-export-conformance.mjs` compares the dev-time source alias for `@acalys/contracts/api/v1` against its published `dist/` export map across all 4 subpaths, wired into `verify`. Tests unchanged at 35 (no new frontend logic; both guards target code that does not exist yet).                                                                                           |
| K.5b       | `4230144` | `MergeGate` is a union with an explicit `unknown` state, never a `blocked: boolean`. Adds a freshness check: a pre-merge result is discarded as `unknown` if its `reviewRunId` does not match what is on screen. Two defects found while building it, below. Tests: 35 → 48.                                                                                                                                                                                                                                                                |
| K.5c       | `5a77eb4` | The blocking policy (`isMergeBlockingResult`) moved into `@acalys/contracts` and is imported, never restated, by the frontend. Production fixture mode now requires two independent variables (`VITE_ACALYS_DATA_MODE=fixtures` and `VITE_ACALYS_ALLOW_DEMO_DATA=true`). A dev build with an API URL but no declared mode is `misconfigured`, not silently fixtures. Added `.git/acalys-mutation-session`, an interlock so a foreign `test:ci` run refuses to start against a tree a mutation harness is actively mutating. Tests: 48 → 50. |
| —          | `ebc74f4` | Retired the frontend's own copy of the blocking-rule mutation (id 69) as `INVALID` once K.5c moved the rule into the contract — removed rather than retargeted, so one policy stays proven by one mutation (id 76) rather than two that can drift apart.                                                                                                                                                                                                                                                                                    |
| —          | `a6eab64` | Added the general fail-closed property to `premerge.test.ts`: no `MergeGate` built from incomplete, failed, stale, malformed or unavailable knowledge may be `not_blocked`. Enumerates all six `unknown`-producing paths, then fuzzes every `(status, blocking)` pair over two checks (144 combinations) against the real `gateFrom`. Tests: 50 → 52.                                                                                                                                                                                       |
| —          | `cc38eda` | Prose-only. Test names and comments in `findings.test.ts` and `premerge.test.ts` now name the internal review surface (the Acalys dashboard, where a verified-but-withheld finding still reads "In review") and the PR/developer publication surface (which withheld findings never reach) as two distinct things. No assertion changed. Tests unchanged at 52.                                                                                                                                                                             |

---

## The defects P1-K found

Ten items, in two kinds, plus one closed risk that was never a live defect.
The first five were wrong in code that had already shipped, caught by a gate
or, in one case, a mutation's target. The next five were caught by the
process built to catch them — self-review, a mutation's own test, or a gate
rejecting a module — before or instead of ever being a live defect.

### Product defects — wrong in shipped code until a gate caught them

| #   | Defect                                                                     | Location                                          | Found by                                                          | Fixed in  |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | --------- |
| 1   | Floating promise: `writeText` rejection dropped, toast still says "copied" | `components/integrations/ConnectModals.tsx:78`    | `no-floating-promises`, once the lint ignore narrowed (`54e73bd`) | `028153e` |
| 2   | Floating promise, same shape: a settings save can fail silently            | `pages/organization/OrganizationSettings.tsx:396` | `no-floating-promises`                                            | `028153e` |
| 3   | Misused promise: an async handler passed where `void` is expected          | `pages/account/ApiKeys.tsx:249`                   | `no-misused-promises`                                             | `028153e` |
| 4   | Non-exhaustive switch: `"updatedAt"` silently sorted by `default`          | `pages/review/Triage.tsx:94`                      | `switch-exhaustiveness-check`                                     | `028153e` |

A fifth belongs in this bucket but was not caught by a static gate: through
`f0d6b7c`, an unset `VITE_ACALYS_API_URL` meant fixtures unconditionally —
including in a production build where the variable was merely forgotten,
which would have put fabricated security findings in front of a real user.
`bcef3ee` (K.4) closed it: `resolveDataMode` requires production to declare
an explicit, coherent data mode and returns `misconfigured` — never
fixtures — for anything else. Guarded going forward by mutations #67
("missing configuration silently becomes fixtures") and #74 ("production
fixtures without demo authorization are allowed") in
`scripts/mutate-p1i.mjs`.

### Process and test defects — caught before or instead of shipping

**6. A verifier outage rendering as "No vulnerabilities found."** The first
wiring of the K.3 read path was `findings = ready ? source.findings :
EMPTY`, which would have made a failed request render the same empty-state
copy as a clean review — the frontend restatement of the collapse P1-I
exists to prevent on the backend. Caught and rewritten by the author before
the commit landed (`f0d6b7c`); there is no separate commit showing the bug
merged and then fixed, only the commit message recording that it was
written and replaced. No regression test asserts the exact string that
would have shipped — only that the failure and success branches remain
distinct.

**7. `MergeGate` blocking on `blocking` alone, without requiring `status ===
"failed"`.** Written wrong twice. First in K.5b's draft of `gateFrom`,
caught by the author, and fixed by copying the backend's own rule verbatim
rather than re-deriving it (`4230144`). Then again in K.5c, when the same
policy was re-derived a second time while moving it into
`@acalys/contracts` — caught this time by a test (`5a77eb4`). The
repetition, not either instance alone, is the finding: this is an easy
enough mistake to make twice that "import the rule" is now the stated
policy, not "get the rule right."

**8. Mutation #73 survived its first test.** "An inconclusive check is
reported as passed" was planted, and the exhaustiveness test in place at
the time asserted only that every `PreMergeCheckStatus` produced _some_
label — `"Passed"` is truthy, so a total mapping passed as though it were a
correct one. Replaced with a canonical table asserting each status's exact
reading, plus a separate, weaker distinctness check (`4230144`).

**9. `lib/findings.ts`'s first version was unreachable.** No page in the
application fetched anything at the time it was written, so
`no-unreachable-in-web` rejected it as a module with zero consumers. Held
back rather than landed, and the gate was not widened to admit it
(`52c34dd`).

**10. A test fixture import executed another test file.**
`apps/web/tests/api-client.test.ts` imported `findings.test.ts` for a
fixture value and re-ran its whole suite, reporting 14 tests where 6 were
written. Fixed by moving the fixture to `apps/web/tests/fixtures/findings.ts`
(`f0d6b7c`).

**A closed risk, not a found defect:** a verified-but-withheld finding
presenting as "Open" — the exact collapse the K.3 adapter was built to
avoid — was never wrong in shipped code. It is listed here because it is
the thing mutation #61 exists to guard (planted and killed in `bcef3ee`),
and because the distinction between "this was wrong" and "this is now hard
to get wrong" matters more here than anywhere else in the document: item 7
above is the same risk shape, and it _was_ wrong, twice.

---

## Gates `apps/web` participates in, and the ones it does not

| Gate               | Participates       | Evidence                                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck          | yes                | `apps/web`'s project builds clean under `tsc -b --noEmit` (re-verified directly, 2026-08-20); part of the repo-wide `typecheck` step in `verify`                                                                                                                                                      |
| lint               | yes, since K.1     | `eslint .` clean over `apps/web` (re-verified via `npm run lint`, 2026-08-20); enumerated ignore covers only the 12 CDP scripts and 2 build-config files, not product code                                                                                                                            |
| format             | yes                | `prettier --check .` covers `apps/web`; clean there (re-verified via `npm run format:check`, 2026-08-20) — pre-existing warnings elsewhere in the tree live only under `.superpowers/sdd/`, outside this checkpoint's files                                                                           |
| build              | yes                | `tsc -b && vite build`, inside `build:clean`                                                                                                                                                                                                                                                          |
| depcruise          | yes                | 293 modules cruised, 0 violations (re-verified via `npm run depcruise`, 2026-08-20); three web-specific rules — `no-unreachable-in-web` (K.2), `pages-must-not-import-the-transport`, `pages-must-not-import-api-contracts` (K.5a) — each planted, watched to fail, then cleaned before being trusted |
| export conformance | yes, since K.5a    | `assert-export-conformance.mjs`, wired into `verify`; compares the dev-time source alias for `@acalys/contracts/api/v1` against the published `dist/` export map across all 4 subpaths                                                                                                                |
| tests              | yes, since K.1     | 52 tests across 6 files (re-verified via `npx vitest run apps/web/tests`, 2026-08-20); folded into the repo-wide `test:ci`                                                                                                                                                                            |
| mutation           | partial, since K.4 | 15 cases in `scripts/mutate-p1i.mjs` target `lib/findings.ts`, `lib/premerge.ts`, `lib/api/client.ts`, `lib/api/config.ts`, and the shared contract rule they depend on. Run by a separate harness (`node scripts/mutate-p1i.mjs`), not by `verify`, and not re-run for this document per instruction |
| schemas            | n/a                | `apps/web` carries no schema files; the 49-file schema gate belongs to `packages/contracts`                                                                                                                                                                                                           |

What that table understates: mutation coverage is scoped to five files.
`apps/web/src/pages` (45 files) and `apps/web/src/components` (34 files)
carry none, because almost none of them contain logic to mutate — they
render what the adapters hand them. Every test added across P1-K is a
`vitest` unit test against a pure function, a hook's non-React dispatch
logic restated locally, or a config resolver; nothing here renders a page
or drives a browser, and no such layer exists.

---

## What P1-K does not claim

- **Not that all pages consume backend data.** One page, `AiDeepScan`, reads
  through the live path built in K.3. The other pages catalogued in
  `k-frontend-inventory.md` — 44 of them at K.0 — remain driven by the
  fixtures in `src/data/`, unchanged.
- **Not that a production backend is deployed.** `resolveDataMode` and the
  API client exist and are hardened; nothing in P1-K provisions, deploys, or
  points at a real backend. `VITE_ACALYS_API_URL` unset is still the
  default everywhere except a production build, where it is `misconfigured`
  rather than silently fine — see defect 5 above.
- **Not that all data tiers are implemented.** `k-frontend-inventory.md`
  named three tiers of backend-compatibility work: naming/case, aggregates
  and lifecycle mapping, and entirely new analyses (`priority`, `risk`,
  `securityRisk`, `blastRadius`, `reviewEffort`, `reviewGuidance`,
  `changeType`, `issueSeverity`, `reviewState` for the Triage screen). P1-K
  wired the lifecycle-mapping slice needed for findings and the merge gate.
  Tier 3 — the bulk of the Triage screen, and genuinely new product
  capability rather than compatibility work — is untouched.
- **Not that browser end-to-end coverage exists.** There is no rendered-page
  test anywhere in this checkpoint. Every one of the 52 `apps/web` tests
  exercises a function directly.
- **Not that all frontend logic is mutation-tested.** 15 mutation cases
  cover five files. The 45 pages and 34 components that make up most of the
  frontend's code carry no mutation coverage, because most of what they
  contain is presentation rather than the kind of decision a mutation can
  meaningfully corrupt.

---

## Carried forward

- **Tier 2 and tier 3 backend capability**, per `k-frontend-inventory.md`:
  `PrFinding` aggregates, and the substantially new `TriagePr` analyses
  (change classification, risk scoring, blast-radius estimation,
  review-effort prediction). None exist in the backend; none are renames.
- **43 of 44 catalogued pages remain fixture-driven.** Only `AiDeepScan`
  and the merge-gate badge consume anything live.
- **The `gateFromApiResult` test helper mirrors two lines of
  `useMergeGate.ts` locally** (`a6eab64`), because that dispatch has no
  exported pure function and this test stack has no hook-rendering
  infrastructure (`renderHook` / `@testing-library/react` are not
  installed). It restates only boundary dispatch — the blocking policy
  itself is never restated, every path ends in the real `gateFrom` — but if
  `useMergeGate`'s shape changes, the mirror has to change with it by hand.
  Recorded rather than fixed because the fix (exporting a pure dispatch
  function) is a source change outside a test-only task's scope.
- **The 12 CDP screenshot scripts remain enumerated out of lint and carry no
  tests.** Correct as scratch tooling, not product code; unchanged since
  K.0.

Not carried forward from earlier phases into this document: P1-J's open
items (`P1-VERIFY-CONCURRENCY`, the historical shadowing replay, the
unexplained funnel-suite startup failure) are unrelated to the frontend and
remain recorded where P1-J left them.
