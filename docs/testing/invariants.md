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
