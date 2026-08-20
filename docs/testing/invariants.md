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
