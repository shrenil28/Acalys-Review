# P1-K closure

## Context

P1-K brought `apps/web` inside the repository's correctness gates and built
two validated backend seams. Everything through K.5c is committed
(`ebc74f4`). What remains is the evidence work that lets the checkpoint be
closed honestly, plus two gaps the last review named.

## Global Constraints

- **No visual change.** No `className`, no `style`, no JSX element added,
  removed or reordered in any existing component. New tests and new prose
  only, except where a task says otherwise.
- Every gate must pass before a task is complete: `npm run typecheck`,
  `npm run lint`, `npm run format:check`, `npm run depcruise`,
  `npm run build:clean`, `node scripts/assert-export-conformance.mjs`, and
  `ACALYS_REQUIRE_POSTGRES=1 npm run test:ci`.
- Never run `npm run test:ci` while `node scripts/mutate-p1i.mjs` is
  running; the interlock will refuse, and bypassing it produces fake
  regressions.
- Never run `git checkout`, `git reset --hard`, or `git clean` against a
  file holding uncommitted work.
- Tests assert **meaning**, never snapshots. A test that would pass against
  a plausible wrong implementation is not a test.

## Task 1 — the enforcement property test

`apps/web/tests/premerge.test.ts` covers several individual ways of not
knowing. It does not yet state the general property.

Add one property-style test asserting:

> No `MergeGate` representing incomplete, failed, stale, malformed or
> unavailable knowledge may have `kind === "not_blocked"`.

Enumerate every construction path that yields `unknown` — transport
failure, contract failure, a rejected response, an unfinished blocking
check, zero evaluated checks, and a revision mismatch — and assert each is
`unknown`. Then assert the converse: `not_blocked` is reachable only from a
response that validated and whose checks all settled without a blocking
failure.

This is fail-closed in the frontend sense: not "block the merge on a
network error", but "never claim permission you do not have".

Files: `apps/web/tests/premerge.test.ts` only.

## Task 2 — name the surfaces in the withheld tests

The K.5b tests say a withheld finding "is not published". That is true of
the PR comment surface and false of the internal review surface, where a
verified finding legitimately remains visible as "In review".

Rewrite the comments and test names in
`apps/web/tests/findings.test.ts` and `apps/web/tests/premerge.test.ts`
so they say which surface each claim is about. Use exactly two terms:

- **internal review surface** — the Acalys dashboard, where a verified
  finding legitimately remains visible as "In review"
- **PR/developer publication surface** — the pull-request comment, which a
  withheld finding does not reach

Do not change any assertion and do not touch any source file. This task
changes prose only, and exists because `withheld → globally invisible`
would erase useful internal review history if anyone later believed it.
Nobody should "improve clarity" here by editing implementation.

Files: the two test files. No source changes.

## Task 3 — the closure document

Write `docs/review/phase-1/k-frontend-boundary.md` assessing P1-K against
the definition of done, and update the status board in
`docs/review/phase-1/status.md` to mark P1-K complete.

The document must state, with evidence:

- what each checkpoint (K.0 through K.5c) established
- the defects P1-K found — including the ones I introduced and caught
- every gate `apps/web` now participates in, and the ones it does not
- what P1-K does **not** claim, stated as an explicit list beside what it
  does — the checkpoint establishes the production boundary and pattern,
  **not** completion of frontend/backend integration. Someone reading
  "P1-K COMPLETE" in six months must not take it to mean the frontend is
  fully connected. Say plainly that it does not mean: all pages consume
  backend data; a production backend is deployed; all data tiers are
  implemented; browser E2E coverage exists; or all frontend logic is
  mutation-tested.
- the deferred items carried forward

Cite evidence: checkpoint commit SHAs, test names, gate names, and counts.
Not a victory narrative — the limitations get the same plainness as the
gains.

Record the defects P1-K found, separating product bugs from process/test
defects: the API failure that rendered as "No vulnerabilities found";
missing production config silently entering fixtures; a verified finding
risking presentation as Open; the non-exhaustive semantic switch; the
floating and misused Promise defects; `MergeGate` blocking on `blocking`
without requiring `failed`; the `inconclusive → Passed` mutation that
survived because a total mapping was mistaken for a correct one; the
unreachable adapter the reachability gate rejected; and the test fixture
import that executed another test file.

Use the existing phase documents as the model for tone and structure. State
the frontend's remaining gaps as plainly as the gains.

Files: the new document, and `docs/review/phase-1/status.md`.
