# P1-L.4.2 handoff — four agents landed, nothing integrated yet

**Read this first if you are picking up Acalys mid-flight.** The work is in a
safe but unfinished state: four isolated worktrees hold completed, committed,
individually-tested work that has **not** been merged into `master`.

Nothing is broken. Nothing is half-merged. `master` is clean at `719e172`.

---

## 1. Exact state

```
master            719e172   the frozen config model, types only, no parser
main tree         clean     (only .claude/ untracked — see the hazard below)
```

Four agent branches, each one commit on top of `719e172`, **no overlapping
files between them**:

```
worktree-agent-a3a37e9c15c31ae82   66a2126   Agent A  discovery      387 lines
worktree-agent-ae6c6549a2877407b   253e756   Agent B  compiler facts 600 lines
worktree-agent-a65c1d3c58c0d7273   5eafa5c   Agent C  governance     773 lines
worktree-agent-a8e67e81a357cd644   db90e8d   Agent D  premises       286 lines
```

Worktrees live under `.claude/worktrees/`. List them with `git worktree list`.

> **HAZARD:** `.claude/` is untracked. Do **not** run `git clean -fdx` — it
> would delete four agents' unmerged work. If the worktrees are ever lost, the
> commits still exist on their branches; recover with `git log --all`.

### Where the surrounding project stands

```
P1-L.1  factual repository index                    CLOSED
P1-L.2  references and bindings                     CLOSED
P1-L.3  incremental invalidation + rebuild oracle   CLOSED
P1-L.4.1 code-to-test relationships                 CLOSED @ bd1c5a4
P1-L.4.2 code-to-config governance                  IN PROGRESS  <- you are here
P1-L.4.3 code-to-instruction                        NOT STARTED
P1-L.5   quality + economics measurement            NOT STARTED

verify at 719e172   2,033 tests / 0 skipped, 303 modules / 0 violations
mutations           131 declared, 131/131 detected, 0 survived, 0 invalid
```

---

## 2. The frozen contract

`packages/code-intelligence/src/repository-index/config-model.ts` is
**coordinator-owned and frozen**. Types only; it reads no files. It was
corrected three times during review _before_ any parser existed, and those
corrections are the point:

```
                  coverage complete    coverage incomplete
some governance   governed             governed  (coverage carries the gap)
no governance     not_governed         undetermined
```

- `not_governed` is the **only** outcome asserting absence, and requires
  complete discovery **and** complete evaluation.
- An outage may prevent a negative conclusion; it must **never** erase an
  independently established positive fact.
- `SourceGovernance`, `OptionInheritance`, `ProjectReference` are three
  different edge types and must never collapse into one. `extends` is not
  source governance; a project reference is not source governance.
- Governance is **plural** — two projects can genuinely admit one file.
- `excluded_by_pattern` was deliberately removed: TypeScript reports the
  admitted set, not why other files are absent, so the reason is not
  establishable without reimplementing the glob semantics that are the whole
  reason to use the compiler as authority.

---

## 3. What each agent was asked to do, and what came back

Briefs are at
`/tmp/claude-1000/-home-shrenil-Desktop-codeRabbit/4ebd17c8-bd32-4aaa-a378-ff2cf9b57818/scratchpad/briefs/`
(`SHARED.md` plus one per agent). **These are in /tmp and will not survive a
reboot** — if you need them long-term, copy them into the repo first.

### Agent A — project discovery · `66a2126` · COMPLETE

**Goal:** answer only "which TypeScript projects exist, and is that discovery
complete?" — never which file belongs to which project.

**Produced:** `config-discovery.ts` + test (8 tests, 0 skipped).
`discoverProjects(snapshot)` returns discovered config paths plus a
`complete | incomplete` coverage verdict.

**Review status: PASSED.** It self-mutation-tested before committing (removing
the sort, removing the excluded-path guard, inverting the missing-reference
check — each broke 1–3 tests). It found a genuinely dead sort and **removed**
it per invariant 10 rather than manufacturing a test around it.

**Outstanding — one thing to carry into the claim:** a tsconfig under a
non-conventional filename that nothing references is undiscoverable by a
name-plus-reference-graph search. A documented it as a structural non-goal
rather than reporting `incomplete` forever (which would make `not_governed`
permanently unreachable). That is consistent with the model's "complete
relative to the discovered set", **but it must appear in the L.4.2 claim, not
only in a module comment.**

### Agent B — compiler-backed project facts · `253e756` · COMPLETE

**Goal:** given config paths, use `ts.parseJsonConfigFileContent` to produce
`ProjectConfigFact`. No discovery heuristics, no source-governance conclusions,
no reimplemented globs.

**Produced:** `config-projects.ts` + test (6 tests, 0 skipped, package
typecheck clean).

**Review status: PASSED**, with two findings worth preserving:

1. `namedInFiles` is read from the project's **pre-extends-merge**
   `config.files`, not `parsed.raw.files` — TypeScript backfills `raw.files`
   from the base config when a child omits it, so the post-merge value would
   misattribute an _inherited_ `files` list as "literally named", producing a
   wrong `included_by_files` classification nothing downstream could detect.
2. Extends failures are detected by diagnostic **code** `{5083, 6053, 18000}`,
   traced through `commandLineParser.js`. Two different codes fire depending on
   whether the extends string already ends in `.json`; assuming one would miss
   half the cases.

**Declared narrowings (must reach the claim):** takes only the first entry of
an `extends: string[]` array, because the contract field is singular; does not
resolve bare-specifier extends through `node_modules` (returns `undefined`
rather than a wrong answer).

### Agent C — governance algebra · `5eafa5c` · COMPLETE

**Goal:** implement the frozen state model exactly. Forbidden to import
`typescript` at all, so its tests can reach states no happy-path extractor
produces.

**Produced:** `config-governance.ts` + test (10 tests, 0 skipped).
`governanceFor`, `optionInheritance`, `projectReferences`.

**Review status: PASSED.** Audited directly against every boundary question:

```
no `typescript` import                        held (grep-verified)
positive facts survive coverage gaps          held — returns `governed` before
                                              consulting completeness at all
not_governed requires BOTH dimensions         held
plurality                                     held
extends/references separate from governance   held
```

**Outstanding — two items:**

1. **THE INTEGRATION BLOCKER.** C requires `provenance: FactProvenance` on its
   input `ProjectConfigFact`; B's real type does not have it. This is a
   **coordinator brief error** — the shape was specified to both agents without
   the field, while the frozen model requires provenance on all three edge
   types. C correctly refused to fabricate placeholder provenance and pushed
   the requirement into the input contract instead. **Resolution decided:
   derive it at the integration seam from `configPath` — the fact's source is
   that file — so neither agent invents it.**
2. An `extends` **cycle** currently stops the walk via a silent visited-set
   guard. The model does not define that state, which is a coordinator
   omission. It reports a truncated inheritance chain as though complete — the
   same shape as reporting a parse failure as an empty set. **Resolution
   decided: it becomes `extends_unresolvable`, which already exists in the
   model.**

`governanceFor` never returns `not_indexed` — nothing in its inputs carries
module coverage (an L.1 fact). C left it unproduced rather than guessing;
correct, and the state belongs to a higher layer that knows both.

### Agent D — adversarial premises · `db90e8d` · COMPLETE

**Goal:** establish what TypeScript itself says about membership, written
**blind** — forbidden to read B's or C's implementation, so the check does not
encode the implementation's assumptions.

**Produced:** `config-premises.test.ts` (5 tests, 0 skipped).

**Review status: PASSED, and it is the strongest artifact of the wave.** All
seven premises verified empirically against TypeScript 5.9.3 _before_ any
assertion was written:

```
foo.ts     admitted by root    YES
foo.ts     admitted by nested  YES     plurality is real, not type-permitted
sibling.ts admitted by nested  NO
aside.ts   admitted by nested  NO      directory proximity says yes; TS says no
aside.ts   admitted by root    YES
broken     unknowable                  real diagnostic, not empty recovery
```

**It caught its own vacuity unprompted:** the malformed-config trap proved
nothing as first written, because with no file under `broken/` a wrongly
recovered `{}` config parses to an empty list _either way_. It added
`broken/thing.ts` so the wrong path produces a genuinely non-empty tempting
result, and confirmed that by direct probe before encoding it.

**Outstanding — one item.** Both B and D reach `ts.matchFiles` through a narrow
cast, because it is not in TypeScript's public `.d.ts`. They arrived at this
independently, each having verified from TypeScript's shipped source that
`ParseConfigHost.readDirectory` must return an already-filtered list — so an
extension-only `readDirectory` would silently disable the compiler's own
include matching. The reasoning is sound and the failure mode is a loud throw,
not a silent pass. **Resolution decided: add one guard in each file asserting
the symbol exists, with a message naming the TypeScript version, so an upgrade
that drops it says why instead of `not a function`.**

---

## 4. Integration plan — do these in order

Everything below is **coordinator-owned**. Do not delegate the merge.

```
1. cherry-pick in dependency order:  A -> B -> C -> D
      git cherry-pick 66a2126 253e756 5eafa5c db90e8d

2. reconcile the provenance seam
      add `provenance: FactProvenance` to B's ProjectConfigFact,
      derived from configPath (path, startLine 1, endLine 1,
      source "typescript_syntax", extractorVersion, revision)
      C then typechecks structurally with no change

3. make an extends cycle `extends_unresolvable` rather than a silent stop

4. add the ts.matchFiles guard in config-projects.ts and config-premises.test.ts

5. wire the barrels — COORDINATOR ONLY, no agent touched these:
      packages/code-intelligence/src/repository-index/index.ts
      packages/code-intelligence/src/index.ts

6. npx prettier --write on everything touched

7. read-only architecture audit across the MERGED diff, asking:
      does A leak membership policy?
      does B implement discovery heuristics?
      does C reach for the compiler?
      can `unavailable` ever surface as `[]`?
      does incomplete coverage permit `not_governed`?
      does plurality survive end to end?
      do extends or references become source governance?
      any directory/name heuristic anywhere?

8. ACALYS_REQUIRE_POSTGRES=1 npm run verify        (expect ~2,060 tests)

9. THEN the second wave: production witness + mutations
```

### Wave 2, still to do

- **Production witness (unchanged source).** The strongest architectural proof
  available and it does not need instructions to land:

  ```
  H1  foo.ts bytes = X, governed by root
  H2  foo.ts bytes = X, nested config added, now governed by root + nested

  code-symbol digest      UNCHANGED
  config fact identity    CHANGED
  assembled context       CHANGED
  analyzer-input identity CHANGED
  ```

  This is why `ConfigFacts` sits outside `RepositoryIndex`.

- **Second production witness:** partial availability — project A governs
  `foo`, project B unavailable; production carries A's positive fact and does
  **not** claim the search was complete.

- **Mutations, IDs 133+.** Each one must pass the admission pipeline below.
  Suggested targets: governance by directory proximity; plural projects
  collapsed to one; one unavailable project erasing known positive governance;
  incomplete coverage producing `not_governed`; non-admitted file becoming
  governed; `included_by_files` inverted; extends emitted as source governance;
  project reference emitted as source governance; extends chain flattened;
  unavailable config represented as empty; production planner ignoring
  ConfigFacts; config-only H2 change failing to alter analyzer-input identity;
  config-only H2 change wrongly altering the RepositoryIndex digest.

---

## 5. Rules that must not be broken

**Mutation admission (invariant 9).** A new _or retargeted_ mutation joins the
manifest only after preflight **and** a targeted execution against its
**declared** suite, **run alone**. Both halves are load-bearing and both have
already failed once each in this project.

```
node scripts/mutate-p1i.mjs --preflight-only    # milliseconds
npx vitest run <the declared suite>             # with the mutant applied
```

**Serialization.** Parallelize coding, unit tests, fixtures, static review.
**Never** parallelize `npm run verify`, `npm run test:ci`, or
`node scripts/mutate-p1i.mjs` — they contend for Docker/Postgres and the
mutation-session interlock will refuse anyway.

**File ownership.** Agents own their own files. The coordinator owns
`config-model.ts`, every `index.ts` barrel, `package.json`,
`scripts/mutate-p1i.mjs`, `docs/review/phase-1/status.md`.

**Evidence reporting.** Report pre-run validity and execution separately, so
`0 invalid` cannot be read as filtering. Report semantic kills separately from
setup kills — `#58` is a known, pre-existing setup kill in the Postgres
harness and must not be counted as a semantic one.

**The invariants** in `docs/testing/invariants.md` are load-bearing, especially:
7 (to prove a guard, make the branches differ downstream), 8 (a mutation must
prove it applied), 9 (targeted execution before admission), 10 (an assertion
that cannot fail is not protection).

---

## 6. The L.4.2 claim, when it closes

Draft — tighten against what actually ships:

> P1-L.4.2 derives CODE↔CONFIG governance from TypeScript's own project
> parsing rather than directory proximity or filename convention. It
> distinguishes governed, not-governed, and undetermined, and never lets an
> evaluation outage erase an established positive fact. Source governance,
> option inheritance, and project references remain three separate edge types.
> Governance is complete relative to the set of **discovered** projects.

**Non-claims that must be stated:** discovery of unconventionally-named,
unreferenced projects; multi-entry `extends` arrays beyond the first; bare
specifier extends through `node_modules`; any review-quality improvement.
