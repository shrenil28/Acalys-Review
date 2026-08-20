# P1-K — frontend production boundary

**Status:** COMPLETE. Fourteen commits, `54e73bd`..`4517bd8`.

The checkpoint that started by correcting two claims about the frontend made
in planning — both wrong in the direction of sounding worse and simpler than
the codebase actually was — closed its own task-review believing a central
claim that was false, and was only corrected by the whole-branch review that
came after: the merge-blocking rule really was re-derived instead of copied,
wrong both times it was written, but "no failure state can produce a
reassuring UI" was itself untrue at the page and hook wiring layer, in the
one place that layer was never tested. See "The central claim was false, and
its own review did not catch it" below.

---

## What each checkpoint established

| Checkpoint | Commit    | Established                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K.0        | `54e73bd` | Inventory only, nothing fixed. Corrected two planning claims (`apps/web` already participated in typecheck, build and depcruise; the semantic-collapse risk was misidentified). Catalogued 92 TS/TSX files (~16,600 LOC) and 12 Chrome-DevTools-Protocol screenshot scripts. Recorded four correctness defects, deliberately left unfixed as gate evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| K.1        | `028153e` | Replaced the blanket `apps/web/**` eslint ignore with an enumerated one (12 `.mjs` scripts + 2 config files). Brought `apps/web` under lint. Fixed the four K.0 defects. `copyToClipboard` changed to never reject, surfacing failure through the existing `error` toast tone instead. Ordering moved to a tested `pages/review/ordering.ts` with an `assertNever` default. Tests: 0 → 9.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| K.2        | `52c34dd` | Added `no-unreachable-in-web`, a depcruise rule scoped to what the browser actually loads from `index.html` (not covered by `no-orphans`) — planted a duplicate `src/src` subtree, watched the rule reject it, then removed it. Wired `@acalys/contracts/api/v1` in, aliased to source for dev. Wrote `lib/findings.ts`, the lifecycle adapter — and the same gate rejected it: no page fetches anything yet, so it has no consumer. Held back rather than landed.                                                                                                                                                                                                                                                                                                                                             |
| K.3        | `f0d6b7c` | Built the pieces of a live read path — `AiDeepScan` page, adapter, typed schema-validated client, `@acalys/contracts/api/v1` — but not a connected one: the page called the hook with no `reviewId`, so the wiring was inert until `907adda` (below) closed it. `ApiResult` is a four-way union (`ok` / `transport` / `contract` / `rejected`), not `T \| null`. `verified` reads as "In review", never "Open"; `superseded` carries a visible reason rather than disappearing silently — true of `lib/findings.ts` as written and tested, but the page never called it with anything but fixtures, so none of this reached the screen this commit shipped. Tests: 9 → 24. **This row overclaimed at the time it was written; corrected 2026-08-20, see "The central claim was false" below.**                 |
| K.4        | `bcef3ee` | `resolveDataMode` closes "no API URL configured → fixtures" as a production default; production now requires an explicit, coherent `VITE_ACALYS_DATA_MODE`. Distinguished an aborted request (`signal.aborted`) from a failed one. Added a six-case rejection taxonomy (`unauthorized`, `forbidden`, `absent`, `conflict`, `throttled`, `server`, `other`) that never carries the response body. 8 mutations planted, 8 killed. Tests: 24 → 35.                                                                                                                                                                                                                                                                                                                                                                |
| K.5a       | `7b58ed5` | Two depcruise rules — `pages-must-not-import-the-transport`, `pages-must-not-import-api-contracts` — planted a violation, watched both fail, then cleaned. `assert-export-conformance.mjs` compares the dev-time source alias for `@acalys/contracts/api/v1` against its published `dist/` export map across all 4 subpaths, wired into `verify`. Tests unchanged at 35 (no new frontend logic; both guards target code that does not exist yet).                                                                                                                                                                                                                                                                                                                                                              |
| K.5b       | `4230144` | `MergeGate` is a union with an explicit `unknown` state, never a `blocked: boolean`. Adds a freshness check: a pre-merge result is discarded as `unknown` if its `reviewRunId` does not match what is on screen — correctly, but as `useEffect` logic with no exported entry point, so `premerge.test.ts` could only test it by keeping its own local copy of the same two lines; the real code path had zero coverage until `4517bd8` exported it as `gateFromApiResult` (below). Two defects found while building it, below. Tests: 35 → 48.                                                                                                                                                                                                                                                                 |
| K.5c       | `5a77eb4` | The blocking policy (`isMergeBlockingResult`) moved into `@acalys/contracts` and is imported, never restated, by the frontend. Production fixture mode now requires two independent variables (`VITE_ACALYS_DATA_MODE=fixtures` and `VITE_ACALYS_ALLOW_DEMO_DATA=true`). A dev build with an API URL but no declared mode is `misconfigured`, not silently fixtures. Added `.git/acalys-mutation-session`, an interlock so a foreign `test:ci` run refuses to start against a tree a mutation harness is actively mutating. Tests: 48 → 50.                                                                                                                                                                                                                                                                    |
| —          | `ebc74f4` | Retired the frontend's own copy of the blocking-rule mutation (id 69) as `INVALID` once K.5c moved the rule into the contract — removed rather than retargeted, so one policy stays proven by one mutation (id 76) rather than two that can drift apart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| —          | `a6eab64` | Added the general fail-closed property to `premerge.test.ts`: no `MergeGate` built from incomplete, failed, stale, malformed or unavailable knowledge may be `not_blocked`. Enumerates all six `unknown`-producing paths, then fuzzes every `(status, blocking)` pair over two checks (144 combinations) against the real `gateFrom`. Tests: 50 → 52.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| —          | `cc38eda` | Prose-only. Test names and comments in `findings.test.ts` and `premerge.test.ts` now name the internal review surface (the Acalys dashboard, where a verified-but-withheld finding still reads "In review") and the PR/developer publication surface (which withheld findings never reach) as two distinct things. No assertion changed. Tests unchanged at 52.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| —          | `513a501` | The closure document below was written and reviewed here — approved with the central claim still false. Superseded by this revision; see "The central claim was false, and its own review did not catch it" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| —          | `907adda` | The whole-branch review's fix wave, source half. `useDeepScanFindings` and `useMergeGate` split `mode.kind === "fixtures" \| reviewId === undefined` into two branches instead of one; `AiDeepScan.tsx`'s empty-state ternary became a `switch` closed by `assertNever` so `misconfigured` gets its own sentence instead of inheriting the clean-scan one; `filtersActive` gates the clean-scan copy so an emptied-by-filter table reads "No findings match the current filters" instead; the `statuses` map became an override so API findings get a real badge instead of a blank one; both hooks and `client.ts` gained `.catch`/in-`try` handling for a throw that previously left the page loading forever. Tests unchanged at 52 (no test file touched).                                                 |
| —          | `4517bd8` | The whole-branch review's fix wave, test half. `gateFromApiResult` — the revision-freshness guard — is now exported from `useMergeGate.ts` and driven directly instead of mirrored locally in `premerge.test.ts`; deleting the real guard now fails 4 tests where it previously failed 0. `displaySeverity` gets the canonical five-entry table `premerge.test.ts` already used for `presentStatus`, closing the two-of-five assertion that let `case "high": return "Medium"` pass. Two tests that asserted less than their names claimed (determinism mistaken for independence; three hand-built literals mistaken for coverage of every construction path) were rewritten against real code paths. Tests unchanged at 52 — no test was added; existing ones were made to assert what they already claimed. |

---

## The defects P1-K found

Seventeen items, in three kinds, plus one closed risk that was never a live
defect. The first five were wrong in code that had already shipped, caught by
a gate or, in one case, a mutation's target. The next five were caught by the
process built to catch them — self-review, a mutation's own test, or a gate
rejecting a module — before or instead of ever being a live defect. The last
seven were wrong in code this checkpoint itself shipped and its own
task-review approved, caught only by the whole-branch review that came after
— see "The central claim was false" below for what that implies about where
these seven were, and were not, guarded.

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

### Defects found by the final whole-branch review — wrong in code this checkpoint's own task-review had already approved

`513a501` closed this checkpoint's own task-review clean. The next gate up —
a review of the whole branch, not this checkpoint alone — read the same page
and hook code and found nine defects, all at the page/hook wiring layer none
of the 52 tests above ever touched. Seven were fixed in one wave
(`907adda`, `4517bd8`); the remaining two are the Category and Repository
filter mismatch, left open, see "What remains open" below. Numbering
continues from the ten above; these are not a separate list.

**11. `reviewId === undefined` was OR'd into the fixtures condition, so `api`
mode rendered fabricated fixtures as real findings.**
`useDeepScanFindings.ts:89` and `useMergeGate.ts:52` (both pre-`907adda`)
read `if (mode.kind === "fixtures" || reviewId === undefined)` and returned
the same fixture data for both. `AiDeepScan.tsx` called the hook with no
argument, so `reviewId` was permanently `undefined`: a correctly configured
production build — `VITE_ACALYS_DATA_MODE=api`, `VITE_ACALYS_API_URL` set,
backend healthy — showed seven hand-written fixture findings (DS-1041,
CWE-94, Critical, repo `n8n-clone`, …) as the user's security posture, and no
request was ever made. This is defect 5 above, reintroduced through a
different door one commit later: `bcef3ee` closed "no configuration →
fixtures"; this was "no review id → fixtures" in the same `if`. Fixed by
splitting the disjunction into two branches (`useDeepScanFindings.ts:89,94`,
`useMergeGate.ts:96,109` as they now read): `fixtures` mode is unchanged; `api`
mode with no review id is its own `misconfigured` state. Found by the
whole-branch review; no gate or test caught it. Fixed in `907adda`.

**12. `misconfigured` fell through to "No vulnerabilities found in the
analyzed scope."** `AiDeepScan.tsx`'s empty-state logic branched only on
`failed`; `misconfigured` — added in `bcef3ee`, two commits after this page
was last touched — inherited the clean-scan sentence by default, so a
deployment variable that went missing read as a clean security result.
Fixed by replacing the ternary with a `switch (source.status)` closed by
`assertNever`, the same discipline `lib/findings.ts` and `lib/premerge.ts`
already used (`AiDeepScan.tsx:120,131` as it now reads); `misconfigured` gets
its own sentence, distinct from `failed`, because the remedy differs. Found
by the whole-branch review. Fixed in `907adda`.

**13. Both seams were call-site inert.** No page or component in the
application ever threaded a review id: `router.tsx:133` renders
`<AiDeepScanPage />` with no `reviewId` prop, and `PrFindings.tsx:66` renders
`<MergeGateBadge />` the same way. Practical effect: the merge-gate badge
rendered `null` in every configuration this application could be built in
(`MergeGateBadge` returns `null` for `state.gate.kind === "unknown"`, which
is the only state a component with no review id can ever reach), and
`listPreMergeChecks` — the pre-merge endpoint — was never called by the
application at all. `AiDeepScanPage` now accepts an optional `reviewId` prop
and passes it through, so the path is reachable once a caller has a review
to show; no caller does yet, so today the page in `api` mode lands on the
`misconfigured` sentence — the honest reading, since nothing was requested.
Found by the whole-branch review. Fixed in `907adda` (the seam is now
reachable; nothing yet reaches it — see "What remains open").

**14. Three filters emptied the table into the same clean-scan message.**
Status, Category and Repository could each empty the results table against
real API data, and all three landed on "No vulnerabilities found in the
analyzed scope." — a filter presented as a security result. Status was the
worst of the three: the `statuses` override map was seeded only from
fixture ids, so every API finding had `undefined` there, which also
rendered a blank `Badge` in the Status column regardless of filtering.
Fixed for Status by making `statuses` an override on top of
`finding.status` (`AiDeepScan.tsx:59,74` as it now reads) so API findings
render and filter on the backend-derived lifecycle status. Fixed for the
emptying itself, all three filters, by gating the clean-scan sentence on
`filtersActive` (`AiDeepScan.tsx:64,148`): an emptied-by-filter table now
reads "No findings match the current filters," never the clean-scan
sentence. The Category and Repository filter _vocabularies_ still do not
match what the adapter produces — see "What remains open." Found by the
whole-branch review. Fixed in `907adda` (partially; vocabulary mismatch
remains open).

**15. The revision-identity guard had zero test coverage.** The freshness
check added in K.5b (`4230144`) — a pre-merge result is `unknown` if its
`reviewRunId` does not match what is displayed — lived only inside
`useMergeGate`'s `useEffect`, with no exported entry point. `premerge.test.ts`
could exercise it only by keeping its own local copy of the same
dispatch logic (`gateFromApiResult`, defined at `premerge.test.ts:292` before
this fix). Deleting the real guard from `useMergeGate.ts` left all 52 tests
green, because the tests were checking the copy, not the original. This item
was recorded as a _minor, deferred_ finding in the SDD ledger during K.5b's
own task-review — a scoping argument, not a correctness one — and was
reclassified to must-fix by the whole-branch review. Fixed by exporting the
real dispatch as `gateFromApiResult` from `useMergeGate.ts` and deleting the
test's copy; the four tests that now fail if the guard is deleted are
`"rejects checks evaluated for a different review run"`,
`"keeps a late response from overwriting the current one"`,
`"keeps every way of not knowing distinguishable, and never reassuring"`, and
`"is unknown on every construction path that does not know"`
(`premerge.test.ts:250,277,318,398`). Found by the whole-branch review; K.5b's
own task-review had noted the shape of the gap and deferred it. Fixed in
`4517bd8`.

**16. `displaySeverity` was proven total, not correct.** The test asserted
two of five mappings (`critical`, `info`), so `case "high": return "Medium"`
— a Critical finding rendered one tone quieter, the opposite direction a
security tool should ever be wrong in — would have passed. Fixed with a
canonical table driven from the contract's own `FINDING_SEVERITIES`,
asserting every member's exact output plus label distinctness plus the
arity check (`findings.test.ts`, the `"maps every severity, and refuses one
it does not know"` test as it now reads). Found by the whole-branch review.
Fixed in `4517bd8`.

**17. Two more tests in `premerge.test.ts` asserted less than their names
claimed.** `"never derives blocking from severity or finding count"` called
`gateFrom` twice with identical input and checked the results matched —
determinism, not independence from severity. `"has no visual state that
could be mistaken for permission"` built three `{kind:"unknown"}` literals
by hand and asserted they were `unknown`, which a change to how `unknown`
gates are actually _constructed_ could never fail. Both were rewritten
against real code paths: the first now varies every field a check carries
other than `(status, blocking)` and cross-products every contract severity
against all three outcomes; the second now builds every gate through
`gateFromApiResult` and `gateFrom` themselves (transport failure, 503,
contract violation, wrong-revision response, zero checks, an unfinished
blocking check) and asserts the six reasons stay mutually distinct. Found
by the whole-branch review. Fixed in `4517bd8`.

Also fixed in the same wave, not separately numbered because neither is a
defect in a claim this document makes: three `.then` chains
(`useDeepScanFindings`, `useMergeGate`, `client.ts`) had no `.catch` and no
`try` around a throwing call, so a thrown error left the page on its loading
skeleton forever rather than reaching a `failed`/`unknown` state. Fixed in
`907adda`.

**What remains open — two of the nine, deliberately not fixed.** The
Category filter's option list (`"Injection"`, `"Access control"`, …) and the
Repository filter still do not match what the API adapter produces: the
adapter passes the backend's snake_case category (`data_integrity`) where
the filter expects the fixture vocabulary, and `repo: ""` for every API
finding because `FindingDto` carries no repository field at all. Selecting
either filter against live data still empties the table — it now does so
honestly, into "No findings match the current filters," never the clean-scan
sentence (item 14), but it does still empty. Aligning the vocabularies means
changing the filter to `FINDING_CATEGORIES` and giving `FindingDto` a
repository name — a contract change and a taxonomy decision, not wiring, and
explicitly out of scope for a no-redesign fix wave. The dangerous half of
this defect is closed; the honest-but-empty half is carried forward, not
fixed.

---

## Gates `apps/web` participates in, and the ones it does not

| Gate               | Participates       | Evidence                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck          | yes                | `apps/web`'s project builds clean under `tsc -b --noEmit` (re-verified directly, 2026-08-20); part of the repo-wide `typecheck` step in `verify`                                                                                                                                                                                                                |
| lint               | yes, since K.1     | `eslint .` clean over `apps/web` (re-verified via `npm run lint`, 2026-08-20); enumerated ignore covers only the 12 CDP scripts and 2 build-config files, not product code                                                                                                                                                                                      |
| format             | yes                | `prettier --check .` covers `apps/web`; clean there (re-verified via `npm run format:check`, 2026-08-20) — pre-existing warnings elsewhere in the tree live only under `.superpowers/sdd/`, outside this checkpoint's files                                                                                                                                     |
| build              | yes                | `tsc -b && vite build`, inside `build:clean`                                                                                                                                                                                                                                                                                                                    |
| depcruise          | yes                | 293 modules cruised, 0 violations (re-verified via `npm run depcruise`, 2026-08-20); three web-specific rules — `no-unreachable-in-web` (K.2), `pages-must-not-import-the-transport`, `pages-must-not-import-api-contracts` (K.5a) — each planted, watched to fail, then cleaned before being trusted                                                           |
| export conformance | yes, since K.5a    | `assert-export-conformance.mjs`, wired into `verify`; compares the dev-time source alias for `@acalys/contracts/api/v1` against the published `dist/` export map across all 4 subpaths                                                                                                                                                                          |
| tests              | yes, since K.1     | 52 tests across 6 files (re-verified via `npx vitest run apps/web/tests`, 2026-08-20); folded into the repo-wide `test:ci`. All 52 exercise `lib/` functions directly; none render a page or a hook — see below                                                                                                                                                 |
| mutation           | partial, since K.4 | 15 cases in `scripts/mutate-p1i.mjs` target `lib/findings.ts`, `lib/premerge.ts`, `lib/api/client.ts`, `lib/api/config.ts`, and the shared contract rule they depend on. Run by a separate harness (`node scripts/mutate-p1i.mjs`), not by `verify`. Re-run in full at closure: 75 planted, 75 killed, 0 survived, 0 invalid — see "Closing verification" below |
| schemas            | n/a                | `apps/web` carries no schema files; the 49-file schema gate belongs to `packages/contracts`                                                                                                                                                                                                                                                                     |

What that table understates, and did until the whole-branch review: mutation
coverage is scoped to five `lib/` files, and every one of the 52 tests
exercises a `lib/` function directly. `apps/web/src/pages` (45 files) and
`apps/web/src/components` (34 files) carry no tests and no mutation coverage
at all — not because they hold no logic worth testing, but because nothing
in this checkpoint tested them. That framing was wrong at closure `513a501`:
`pages/security/AiDeepScan.tsx` held real decision logic — the fixtures
disjunction, the empty-state branch, three filter predicates — and every one
of defects 11–14 above lived in exactly this untested gap. The corrected
claim: `lib/` is the layer this checkpoint's tests and mutations cover, and
covers well; the page/hook layer that calls `lib/` and renders its result is
where every live defect the final review found was sitting, and where none
of P1-K's 52 tests or 15 mutations ever looked.

---

## The central claim was false, and its own review did not catch it

P1-K's working claim, stated across K.3–K.5c and restated in this document
at `513a501`, was some form of "no failure state can produce a reassuring
UI" — an outage does not read as a clean scan, a stale result does not read
as permission to merge. That claim was false at `513a501`. Defects 11 and 12
above mean an `api`-mode build with no wiring fault at all — correct
`VITE_ACALYS_DATA_MODE`, correct `VITE_ACALYS_API_URL`, a healthy backend —
rendered fabricated findings as real ones, and a missing deployment variable
rendered as a clean scan. This is not a corner case the claim failed to
cover; it is the exact case the claim was about, in the one place — the
`AiDeepScan` page — this checkpoint singled out as its live proof.

The claim was tested thoroughly in one place and not at all in the other.
`lib/findings.ts` and `lib/premerge.ts` — the adapters, the status mapping,
the blocking policy — carry 52 tests and 15 mutations between them, and that
coverage is real: nothing in the final review found a defect inside `lib/`.
Every defect it found (11–17) was at the layer above `lib/` — the hook that
decides which branch of a disjunction to take, the page that decides which
sentence an empty table gets, the call site that does or does not pass a
`reviewId`. No test in `apps/web/tests` ever rendered a page, called a hook,
or exercised a call site; "What P1-K does not claim" said as much throughout
(`513a501` still had "Not that browser end-to-end coverage exists" among its
own disclaimers) without connecting that gap to the central claim depending
on exactly that layer.

Nor was this a review failure at any single point. K.3, the commit that
built the live read path, passed its own task-review. K.5b, which added the
freshness guard later found to have zero coverage, passed its own
task-review — and its own author, in the same session, correctly flagged the
test as a local mirror rather than the real thing (recorded as a _minor,
deferred_ SDD item, not escalated). The closure document at `513a501` passed
its own review too: reviewed clean, with a reviewer who independently
verified fifteen separate figures against the repository. Every one of those
reviews was reading the same claim and the same code, and none of them
caught it, because none of them were positioned to: a per-task review checks
that a task did what it said, and a document review checks that the document
matches the code — neither is built to notice that both the code and the
document agree on something false. Only the review that read the whole
branch as one artifact, with the accumulated claim as the thing under test
rather than any single commit, found the gap.

What this says about where P1-K's tests were, and were not: testing a pure
function proves the function. It proves nothing about whether the function
is ever called, called with the right arguments, or has its result rendered
without being silently discarded by a `||` two lines above the call. `lib/`
being fully covered was true and is still true; it was never the same claim
as "the page is safe," and treating the first as evidence for the second is
the mistake this checkpoint made and is now recording so the next one does
not make it by default. A future checkpoint whose central claim is about
user-visible behavior needs a test at the layer the user is at, not only at
the layer under it — and until `apps/web` has a way to render a page or a
hook under test (`renderHook` / `@testing-library/react` are not installed;
see `Carried forward`), that layer's correctness depends on whole-branch
review catching what unit tests structurally cannot.

---

## What P1-K does not claim

- **Not that any page consumes backend data in the deployed app.** `AiDeepScan`
  and `MergeGateBadge` have live-capable wiring — an adapter, a typed client,
  a `reviewId` prop each will pass through — but no route or caller supplies
  a review id (defect 13 above): `router.tsx:133` renders `<AiDeepScanPage />`
  bare, `PrFindings.tsx:66` renders `<MergeGateBadge />` bare. In `api` mode
  today the deep-scan page lands on `misconfigured` and the badge renders
  `null`, in every configuration this application can be built in. The other
  pages catalogued in `k-frontend-inventory.md` — 43 of the 44 total, `AiDeepScan`
  being the 44th — remain driven by the fixtures in `src/data/`, unchanged.
  This is a correction of what earlier revisions of this document claimed;
  see "The central claim was false" above.
- **Not that a production backend is deployed.** `resolveDataMode` and the
  API client exist and are hardened; nothing in P1-K provisions, deploys, or
  points at a real backend. `VITE_ACALYS_API_URL` unset is still the
  default everywhere except a production build, where it is `misconfigured`
  rather than silently fine — see defect 5 above. A _correctly_ configured
  production build was, until `907adda`, a separate way to reach fabricated
  data anyway — see defect 11.
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
  exercises a `lib/` function directly — this is the gap defects 11–17 lived
  in; see "The central claim was false" above.
- **Not that all frontend logic is mutation-tested, or that what is untested
  is mere presentation.** 15 mutation cases cover five `lib/` files. The 45
  pages and 34 components that make up most of the frontend's code carry no
  mutation coverage and, until the whole-branch review, no test coverage of
  any kind — not because they hold only presentation, but because
  `pages/security/AiDeepScan.tsx` alone held the fixtures disjunction, the
  empty-state branch, and three filter predicates, all untested, and all
  wrong. The Category and Repository filters remain wrong in a narrower way
  — see "What remains open" above.

---

## Carried forward

- **Tier 2 and tier 3 backend capability**, per `k-frontend-inventory.md`:
  `PrFinding` aggregates, and the substantially new `TriagePr` analyses
  (change classification, risk scoring, blast-radius estimation,
  review-effort prediction). None exist in the backend; none are renames.
- **44 of 44 catalogued pages remain fixture-driven in practice.** `AiDeepScan`
  and the merge-gate badge are wired to consume live data and reachable by a
  caller that supplies a `reviewId`; no caller does. This document previously
  said 43 of 44 with the two live consumers as an exception — corrected;
  see defect 13 above.
- **The Category and Repository filters do not match the API adapter's
  vocabulary.** `data_integrity` vs. `"Injection"`; `repo: ""` because
  `FindingDto` carries no repository field. No longer dangerous — an
  emptied-by-filter table reads honestly as of `907adda` — but still
  functionally broken against live data. Needs `FINDING_CATEGORIES` in the
  filter and a repository field on `FindingDto`; both are contract/product
  decisions outside a wiring fix. See "What remains open" above.
- **The 12 CDP screenshot scripts remain enumerated out of lint and carry no
  tests.** Correct as scratch tooling, not product code; unchanged since
  K.0.

Not carried forward from earlier phases into this document: P1-J's open
items (`P1-VERIFY-CONCURRENCY`, the historical shadowing replay, the
unexplained funnel-suite startup failure) are unrelated to the frontend and
remain recorded where P1-J left them.

---

## Closing verification

Recorded because the numbers above are per-checkpoint and scoped to
`apps/web`. These are the whole-repository results from the run that closed
P1-K, on `236d2dc`, with a clean tree:

```
tests        1,846 executed, 0 skipped   (ACALYS_REQUIRE_POSTGRES=1)
mutations    75 planted, 75 killed, 0 survived, 0 invalid
depcruise    293 modules, 0 violations

typecheck             green
lint                  green
format                green
references            green
schemas               green
clean build           green
export conformance    green
```

Two properties of that run matter more than the totals.

**0 skipped is an assertion, not an observation.** `ACALYS_REQUIRE_POSTGRES=1`
makes a missing Docker daemon a hard failure rather than a quiet skip, so
"1,846 executed" means 1,846 tests ran — not 1,846 tests were collected. The
distinction is invariant 1 in [invariants.md](../../testing/invariants.md),
and it exists because a green suite that silently skipped its integration
half is the most expensive kind of false evidence this project has produced.

**0 invalid is what makes 75/75 meaningful.** An `INVALID` verdict means the
mutation no longer applies — its target moved or was refactored away — and a
harness carrying invalid patterns reports a smaller denominator each time
without saying so. Four patterns rotted this way during P1-J and were
retargeted at stable constants rather than call sites; one (id 69) was
retired outright in `ebc74f4` when K.5c moved the blocking rule into the
contract, so one policy stays proven by one mutation instead of two that can
drift apart.

Neither number is claimed as coverage of the page/hook layer. As the gate
table above states, all 52 `apps/web` tests and all 15 web mutations target
`lib/`, and the 79 files under `pages/` and `components/` carry neither.
That gap is the checkpoint's central lesson, not a footnote to it.
