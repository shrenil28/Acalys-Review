# P1-GATE-INTERLOCK — evidence integrity

A small checkpoint with one guarantee:

> A repository-wide correctness gate cannot run against a worktree currently
> owned by a mutation session unless it is an authenticated child of that
> session.

It exists because the repository could manufacture false evidence about
itself, and P1-L is about to run a great many gates.

---

## What was wrong

K.5c introduced `.git/acalys-mutation-session` after two mutation runs were
corrupted by a concurrently launched `test:ci`. It guarded `test:ci`. It
guarded nothing else:

```
guarded      test:ci
unguarded    typecheck  lint  format:check  depcruise
             build:clean  references  schemas:check
             export-conformance
```

Eight gates read the worktree while a harness was actively rewriting it. The
obvious failure is a phantom regression — a gate fails because it read a
mutant, and someone spends an afternoon on a bug nobody wrote. That is the
annoying case.

The dangerous case is the inverse:

```
a gate PASSES against a mutated tree
  → recorded as evidence the tree is clean
```

A green `depcruise` proves nothing about the code if the code it cruised was
not the code. Evidence produced that way is indistinguishable from real
evidence at the moment it is filed, and that is precisely the class of
failure P1-J and P1-K each paid for once.

---

## The mechanism

One door. `scripts/run-gate.mjs` checks the interlock, execs the real gate,
and propagates its exit code unchanged:

```
npm run <gate>
  → node scripts/run-gate.mjs <gate> -- <real command>
      → assertGateAllowed(gate, ACALYS_MUTATION_SESSION)
          → exec, or exit 3
```

A wrapper rather than a check inside each gate, for a reason that is not
taste: four of the nine gates are third-party binaries (`tsc`, `eslint`,
`prettier`, `depcruise`) with no inside to add a check to. The choice was
between guarding some gates and guarding all of them through one entry point.

The nonce is **forwarded, not consumed**. `ACALYS_MUTATION_SESSION` passes
through to the child untouched, so a gate that runs other gates — `verify`,
or `typecheck` fanning out across workspaces — stays authorized all the way
down. Without that the harness could start a run and have it refused three
levels deep by its own lock.

Exit code **3**, distinct from a gate's own failure (1). If both were 1, a CI
log could not distinguish "the code is broken" from "the gate never ran" —
and the second silently reads as the first.

---

## Both directions, because one of them is a trap

An interlock that refuses everything is trivially "safe" and makes mutation
testing impossible: the harness could not run the gates it exists to run.
Both directions are asserted, and the second is a requirement rather than a
courtesy:

```
session active + independent process  → refused    (9/9 gates)
session active + harness's own child  → allowed    (9/9 gates)
```

---

## Staleness is proven, never estimated

A crashed harness leaves its lock behind, and a lock nothing can clear is a
lock that gets deleted by hand until deleting it becomes reflex. So stale
sessions are reclaimed — but only on **positive ownership proof**, the rule
this repository has now paid for three times (invariant 3):

```
the machine rebooted since the lock was written  → dead, certainly
no /proc entry for the recorded pid              → dead, certainly
the pid exists but started at a different time   → dead, pid was recycled
none of the above establishable                  → UNDETERMINABLE → refuse
```

Note what is absent: **age**. "The lock is old" is not evidence its owner is
gone. A long mutation run is old and healthy; a crashed one is young and
dead. A time-based reaper gets both backwards, and this repository has twice
destroyed live resources by reasoning that way.

The pid start-time check is what makes reclamation safe at all. Without it a
recycled pid — a different process wearing a dead one's number — reads as the
live holder, and the stale lock becomes permanent.

`undeterminable` fails closed and says so, including that it will not remove
a lock it could not adjudicate. The asymmetry justifies it: refusing a gate
wastes a minute; reclaiming a live session corrupts a mutation run and
everything concluded from it.

---

## Evidence

24 tests in `scripts/tests/gate-interlock.test.ts`, every one spawning a real
process against a real lock directory. The thing under test is cross-process
by nature, and a same-process test of it would prove something adjacent to
the claim rather than the claim — the mistake that let a no-op startup
limiter pass three green runs in P1-INFRA-POSTGRES.

Refusal is asserted by whether the gate command **ran**, not only by an exit
code: each gate body writes a marker file, and a wrapper that printed a
refusal and executed anyway would pass an exit-code-only test.

Per invariant 5, every control was planted and watched to fail:

```
the guard never refuses                       9 of 24 tests failed
the nonce path removed (refuses harness too)  2 of 24 tests failed
staleness decided by age, not ownership       1 of 24 tests failed
undeterminable treated as dead (fail-open)    1 of 24 tests failed
a gate unrouted from the wrapper              1 of 24 tests failed
a tenth unguarded step added to verify        1 of 24 tests failed
a gate silently dropped from verify           1 of 24 tests failed
```

The last three are structural: the suite reads `package.json`, asserts every
protected gate routes through the wrapper, and asserts `verify` runs
protected gates and nothing else. That is the control that survives someone
adding a tenth gate a year from now.

**Production-path witness** (invariant 6 — this checkpoint's own rule applied
to itself). The unit tests drive a throwaway worktree. The claim is about
this repository's real gate surface, so it was proven there too: a live
holder process, then all nine gates invoked through their actual npm scripts.

```
independent  npm run <gate>              → exit 3, refused        9/9
harness      ACALYS_MUTATION_SESSION=…   → exit 0, ran and passed 4/4 real gates
wrong nonce  npm run lint                → exit 3, refused
holder stopped → lock released → gates run normally again
```

Full `verify` after the change: **1,870 tests, 0 skipped**, all nine gates
green through the new wrapper.

---

## What this does not guard

Stated because an interlock believed to be total is worse than one whose
edges are known.

- **Hand-typed tool invocations.** `npx tsc`, `npx eslint .`, or a `tsc -b`
  run from an editor bypass this entirely. The interlock covers the declared
  gate surface — the npm scripts CI and humans run — and cannot cover
  arbitrary commands. `typecheck:projects` is an internal helper of the
  guarded `typecheck` and is bypassable the same way.
- **`format` and `dev`.** Deliberately unprotected. `format` writes rather
  than reports, and blocking an interactive dev server on a background
  mutation run is an interlock nobody keeps.
- **Concurrent sessions on separate worktrees.** The lock is per-worktree
  (`<cwd>/.git/…`), which is correct — two worktrees are two trees — but it
  means the guarantee is per-tree, not per-machine.
