# Testing invariants

Rules this repository has paid for. Each was learned by shipping its violation,
and each is written here because the same mistake keeps reappearing somewhere
new.

---

## 1. Never infer that work happened from a framework's final status

> **Prove the intended stimulus executed. A green result is not evidence that
> anything ran.**

Instances so far:

```
async property tests never awaited                  passed, asserted nothing
a timeout test read a nonexistent property, `?? 0`  passed, asserted nothing
a mutation that never applied                       counted as killed
a compile failure before any test                   counted as killed
a Postgres suite killed by a parallel suite         skipped, reported green
a suite whose beforeAll threw                       "skipped", counted as executed
a probe counting held slot directories              scored the BROKEN limiter better
```

The last two are the sharpest. Vitest reports a test whose setup exploded as
`skipped`; a parser that only knew `pending` counted five un-run tests as five
executed and zero failed, so a mutation that broke setup outright read as
SURVIVED. And a probe measuring _slot directories held_ gave a limiter admitting
everyone a score of zero — better than the working one.

**Practice:** assert the premise, then the response. A fixture must be shown to
contain the stimulus it is named for.

---

## 2. Mutation verdicts

Frozen:

```
mutation APPLIED
+ target premise reachable
+ relevant tests actually EXECUTED
+ no relevant test SKIPPED
+ semantic assertion FAILED
= KILLED
```

A test **file** that failed to run at all is also a kill — the mutation was
detected — reported distinctly as `KILLED — suite could not run`.

Everything else is `INVALID`, `HARNESS_FAILURE`, or `SURVIVED` according to what
actually happened. A mutation reported INVALID is **not evidence**; four
patterns here have rotted on a refactor, and each was silently worthless until
the harness began exiting non-zero on it.

---

## 3. Destructive cleanup requires positive ownership proof

> **"Temporary-looking", "dangling", "old", and "from another run" are each
> insufficient on their own.**

Cleanup must establish:

```
the resource carries Acalys ownership identity
AND
  it belongs to this run
  OR it belongs to a run provably no longer live
```

Learned three times, in three places:

```
docker volume prune -f       would have destroyed a developer's compose database
DROP DATABASE LIKE '…%'      would reach another suite's data
rm -f $(… label=acalys.test) deleted the server four running suites were using
```

The third is the instructive one: reaping "another run's" containers is wrong
while another run is live, because a concurrent run legitimately _is_ another
run. Foreign ownership **and** age — a live run's container is seconds old.

This will apply again to worktrees, temp repositories, artifact directories,
caches and model sandboxes.

---

## 4. A harness restores its own snapshot, never the repository's

Forbidden inside tooling:

```
git checkout <path>
git reset --hard
git clean
```

A harness owns the paths it mutated and restores them from its **own** backup.
`git checkout` restores what HEAD contains, which silently destroys uncommitted
work — as it did once here, recovered only because an unrelated backup happened
to exist minutes earlier. That was luck, not process.

Required of a mutation harness:

```
before   refuse to start on a dirty tree in the files it mutates
during   own only the explicitly mutated paths
after    restore from its own snapshot, on the normal path AND on a signal
```

Signals cannot cover SIGKILL, so refusing an ambiguous starting state is the
last line of defence rather than the first.

---

## 5. A gate must be shown to fail

A gate that has never failed is a claim, not a control. Each of these was
planted and observed failing before being trusted:

```
a duplicated src/src tree               architecture reachability
a missing project reference             clean build, and the reference check
a forbidden premerge→publication import dependency-cruiser
Docker absent with fail-closed set      integration suites
a limiter admitting everyone            peak-overlap probe
```

Where a control cannot be shown to fail, say so explicitly rather than counting
it.

## 6. A mechanism test does not prove a production seam

Proving a function correct proves the function. It says nothing about whether
any production path reaches it, or reaches it with the arguments the test
used. Every claimed live path requires a **production-path witness**: a test
that enters where production enters and observes the fact at the far end.

P1-K demonstrated the gap at full size:

```
lib/ correctness           52 tests + 15 mutations    excellent
page/hook wiring           no production-path proof   central claim FALSE
```

All four live defects the whole-branch review found — a fixtures disjunction
that made `api` mode render fabrications, a `misconfigured` state falling
through to "No vulnerabilities found", two seams that no call site reached,
and three filters emptying into a clean-scan message — sat in the layer that
_calls_ the well-tested `lib/` functions. Every `lib/` module was sound. The
review that certified the checkpoint, the review of that review, and the
closure document's own review all passed while agreeing on something false,
because all three were reading mechanism evidence and none asked for a
witness.

What the witness must traverse, stated as a chain rather than a checkbox:

```
production entry point
  → the code under test, reached by production's own call
  → the fact it returns
  → the consumer that acts on that fact
```

Two consequences bind future checkpoints:

**"Integrated" is a claim about a path, not about a component.** A
subsystem with excellent tests on `Thing.query(...)` is not integrated. The
claim requires at least one witness running the real chain — for the
repository index that P1-L builds, `production review entry → context
planner → RepositoryIndex → returned fact → analyzer/verifier consumption`.

**Wiring evidence is due with the first commit, not at the final audit.**
P1-K found its wiring defects in a whole-branch review after closure had
already been declared once. That ordering is what made the failure
expensive: the checkpoint had to be reopened, its closure document rewritten
to record the falsification rather than quietly corrected, and four rounds
of fixes applied to code that had already been reviewed twice. A checkpoint
that produces mechanism evidence and wiring evidence together cannot close
on a false central claim, because the claim has a witness from the start.

## 7. To prove a guard, make the two branches differ downstream

Reaching a guarded branch is not testing it. The test must construct an input
where the guarded and unguarded paths produce **different observable states** —
otherwise the assertion holds for a reason other than the one it names.

P1-L.1 produced three of these in one checkpoint, and a mutation found each:

```
determinism        varied Map insertion order, but the builder walks a
                   SORTED key list — passed with every canonical sort deleted

digest collision   compared "ab/c.ts" to "a/bc.ts", two different strings
                   that never shared a preimage — adversarial-looking, not
                   adversarial

availability       asserted an unavailable index leaves the syntactic
                   candidate standing, but `unavailableIndex` holds NO
                   RECORDS, so the lookup returns nothing whether or not
                   the guard runs
```

Each varied a dimension the code had already normalized, or exercised a state
where the difference had been erased before the guard could matter.

The repair is the same shape every time: find the state where the branches
diverge. For the third, that is an index with records present _and_
`availability: invariant_failed` — reachable, because a build can populate
records and then fail a consistency check.

Assert both premises before the conclusion:

```
prove the tempting fact exists
prove the guard says it is unusable
prove the tempting fact is not consumed
```

Without the first two, a later fixture edit that removes the temptation
silently restores the vacuity, and the test goes on passing.

## 8. A mutation must prove it applied before its result means anything

A mutation whose anchor no longer matches reports `INVALID` after a full run,
and an `INVALID` counted out of the denominator turns a stale definition into a
flattering percentage. Anchor rot is the _expected_ failure of text-fragment
targets — reformatting alone causes it — so the manifest is validated as a unit
before the first suite runs:

```
target matched EXACTLY once     an ambiguous anchor mutates an arbitrary site
replacement differs             a no-op mutation is unkillable
applying changes the source     the transformation is real, not notional
no duplicate ids                two definitions under one id hide one result
```

`node scripts/mutate-p1i.mjs --preflight-only` runs just this, in milliseconds.
Retargeting a mutation is not finished when the entry is edited; it is finished
when the preflight confirms the new anchor resolves.

Each refusal class was planted and observed:

```
a stale anchor                  refused, exit 2, 41ms
a duplicate mutation id         refused, exit 2, 37ms
a replacement that is a no-op   refused, exit 2, 40ms
```

Runtime-invalid verdicts remain possible — a mutation can apply and still fail
to reach its premise. This removes only the class knowable without running
anything, which is the class that costs a full run to discover.

**The preflight validates applicability, not intent.** A mutation retargeted at
the wrong-but-existing line passes it. That happened here: a probe script
killed mid-run left its edit in place, the next run snapshotted the corruption
as its baseline, and the anchor was valid the whole time. Which is invariant 4
again — a harness must restore its own snapshot, and restore-on-completion is
not restore-on-signal.

## 9. A mutation joins the manifest only after a targeted execution

Invariant 8 validates that a mutation _applies_: unique anchor, real
replacement, source actually changed. There is a failure it structurally
cannot see:

```
anchor perfect
replacement real
declared suite valid
BUT the suite never reaches the mutated behaviour
```

That is not weak evidence, it is none — and it reads as a pass. So a newly
authored **or retargeted** mutation is not admitted to the full manifest until
it has passed both:

```
preflight            unique target, source-changing, no duplicate id
targeted execution   its DECLARED suite, run alone, with the mutant applied,
                     and observed to fail
```

Both halves of the second line are load-bearing.

**Its declared suite** — L.4.1 shipped three mutations that had never been
executed at all, and two of them (`#131`, `#130`) pointed at suites that did
not exercise the mutated line. One suite had zero occurrences of the function
it mutated.

**Run alone** — the probe for `#130` ran two suites together, saw one failure,
and recorded a kill. The harness runs only the declared suite, where nothing
failed. Running the union of suites hides exactly the attribution error the
targeted execution exists to catch, so the probe must invoke what the harness
will invoke and nothing more.

## 10. An assertion that cannot fail is not protection

Three times in one checkpoint, code or tests that read as defensive turned out
to defend nothing reachable:

```
a multi-module symbol guard    the execution model already prevented the split
an indexedDependants check     the condition below already subsumed it
caller assertions in a witness the fixture had no production module that could
                               become a wrong caller, so `not.toContain` was
                               trivially true
```

The first two were dead code; the third was a dead _test_, written while
fixing a dead-code finding. All three were found by a mutation surviving.

The rule that follows: when adding a guard or an assertion, establish the state
in which it fires. For a guard, that is a reachable input where guarded and
unguarded behaviour differ (invariant 7). For a negative assertion —
`not.toContain`, `toHaveLength(0)`, `toBeUndefined` — it is a fixture where the
_wrong_ answer is available to be produced. A negative assertion over an empty
possibility space is the cheapest way to look thorough while proving nothing.

Prefer removing dead defensive code to manufacturing a test around it. Dead
reassurance is worse than an absent guard, because it makes the next reader
add a case rather than ask whether the branch is reachable.

## 11. A proof inventory must prove its own completeness first

Invariants 8 and 9 validate individual mutations: that each applies uniquely,
and that its declared suite reaches it. Neither can notice a definition that
was never loaded at all.

P1-M.1 shipped a manifest whose anchors had rotted far enough that preflight
refused outright, and the useful reading is not "two stale anchors":

```
definitions existed
  -> the manifest did not load cleanly
    -> preflight had nothing to validate
      -> "mutation protection" existed only nominally
```

So the inventory is checked before the items in it:

```
INVENTORY   did every declared definition load, with unique ids and
            every required field?
TARGET      does each one uniquely match current source? (invariant 8)
EXECUTION   does its declared suite reach the behaviour? (invariant 9)
SEMANTIC    does the intended assertion fail?
```

`length > 0` is not the check. A loader that silently drops one definition is
also unacceptable, so the assertion is on the exact set.

The same shape applies to any structure that enumerates its own obligations.
The P1-M quality gate declares nine conditions, and a gate that evaluated seven
and reported "7/7 passed" would be this failure with higher stakes — so its
condition ids are asserted as an exact set, not counted.

**Corollary, learned the same day.** A canonical form must be specified by us,
not delegated to the runtime. `localeCompare` in the corpus seal made key
ordering depend on ICU data, so two correct machines could disagree about the
digest of identical content.

The first test written against it could not detect the defect: it compared two
digests computed by the _same_ function, which is self-consistent under any
comparator, so the right and wrong answers agreed. Pinning the digest of a
fixed input to a constant is what makes the comparator observable — a
self-consistency check never can be.

## 12. Ask what difference the mutation was supposed to create

The reflex on a surviving mutant is "why didn't the test kill it?". That
question assumes the baseline possessed the behaviour the mutation removes,
and P1-M.2 produced a case where it did not.

`#214` replaced the verifier's project file set with the changed file alone.
It survived. The test was not weak: the implementation had **never** supplied
the behaviour the mutation claimed to disable — a path-prefix mismatch had
been silently dropping every project file since the verifier was written. The
mutant and the baseline were the same program for the property under test.

A stronger test could not have fixed that. The implementation had to gain the
guarantee before any test could defend it.

So the diagnosis order is:

```
1  did the mutation apply to the intended current source?
     no  -> mutation defect / invalid

2  does the BASELINE actually exhibit the behaviour the mutant removes?
     no  -> pre-existing implementation defect
            (baseline_behaviour_absent — investigate the code, not the test)

3  does the declared fixture reach that behaviour?
     no  -> fixture reachability weakness

4  do correct and mutated behaviour produce distinguishable observable state?
     no  -> vacuous fixture, or a genuinely equivalent mutant

5  still not failing?
     -> assertion weakness
```

Step 2 is the one that is easy to skip and expensive to skip. Starting at
step 5 produces elaborate tests around code that does nothing, and they pass.

### Run outcome is not diagnosis

The harness reports `SEMANTIC_KILL`, `SETUP_KILL`, `SURVIVED`, `INVALID`.
Those are outcomes. A survivor's _diagnosis_ is a separate vocabulary, and the
distinction is what keeps the record legible:

```
implementation_defect        the code is wrong
baseline_behaviour_absent    the guarantee was never there to remove
test_weakness                the assertion cannot fail on the difference
fixture_premise_weakness     the fixture never reaches the behaviour
mutation_weakness            wrong anchor, wrong suite, no-op replacement
equivalent_mutant            no reachable state distinguishes them
```

`baseline_behaviour_absent` is arguably a subtype of `implementation_defect`,
and it is kept separate because the phrase records what actually happened:
**the mutation could not remove a guarantee the implementation never
supplied.**

For an apparent equivalent mutant, ask whether a reachable state exists in
which baseline and mutant differ. If none does under the current execution
model, remove or retarget the mutation — or delete the dead code it targets —
rather than building theatre around it. Three times in this project that
answer has been "the code is dead" (invariant 10).

## 13. Comparison identity belongs in the cache key, not in the context digest

Stated generally, because the narrow version of it is what goes wrong:

```
if analyzer semantics may observe a comparison revision,
that revision's identity participates DIRECTLY in the analyzer cache key
```

The failure this prevents is invisible in every test that does not construct
it deliberately. An analyzer that compares a change against some earlier
revision produces results that are a function of _both_ revisions. If the key
covers only the head, then

```
base = A, head = H
base = B, head = H
```

collide, and one of the two is served the other's findings. In practice that
is a rebased pull request, or a branch retargeted from `main` onto a release
branch, coming back reviewed and wrong.

### The context digest cannot stand in for it

The tempting argument is that comparison material shows up in the assembled
context, so `contextDigest` already covers it. It does not. Comparison
material is _offered_ to the planner and may be dropped by budget, by
ablation, or by a selection rule — so two reviews against different bases can
assemble byte-identical context and agree on every other entry in the key.
The key must contain the **semantic input identity**, not whichever
representation of it survived selection.

### Name it for the comparison, not for a commit

`baseSha` is the wrong shape even when it is the right value. A pull-request
base and a merge base are different revisions, and a pipeline that later
distinguishes them will have a key entry whose name asserts there is only
one. Take the identity of the comparison material actually supplied: the
revision, every path, the state each path resolved to, and the content.

A commit identifier still belongs _inside_ that digest — not as a label, but
because it appears in the citation each comparison item carries, so an
analyzer reading that citation genuinely receives different input when it
changes.

### Testing it requires holding the context digest fixed

A test that lets the context differ between the two bases can pass because
the context differed, proving nothing about whether the comparison identity
participates at all. Hold `contextDigest` identical across the two, and
assert the converse as well — identical semantic inputs must produce an
identical key — or the entry can be satisfied by mixing in entropy, which
defeats caching entirely while passing every difference assertion.
