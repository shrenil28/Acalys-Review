# One invocation, executed twice

**Status:** recorded, not built. Required _before_ the verifier becomes
model-backed or tool-using. Not a P1-I defect.

## The gap

P1-I gives a `VerificationInvocation` **result-persistence idempotency**: one
invocation id, one durable `VerificationAttempt`, enforced by
`UNIQUE (invocation_id)` and a composite foreign key that also pins the
candidate and the ordinal.

It does **not** give that invocation **execution-concurrency** semantics.
Nothing stops two workers recovering the same `scheduled` command and both
running the verifier:

```
                  invocation X  (scheduled)
                 /                        \
        worker A                            worker B
        model verifier                      model verifier
             ↓                                   ↓
          verified                          inconclusive
```

Both are legitimate executions of the same logical invocation. With a
deterministic verifier they cannot disagree, so the question does not arise.
With a stochastic one they will, and then `ON CONFLICT (invocation_id)` means
**arrival order decides which conclusion the product stands behind** — a
finding published on reasoning that no execution actually produced, or a real
defect suppressed because the slower worker happened to be the one that
verified it.

This is the same shape as the publication-ledger lesson from E.2/E.3: a stable
logical identity carrying changed content is not a retry. It is an identity
that has stopped identifying one thing.

## What is already built: detection

`VerificationStore.recordAttempt` refuses a second result for an invocation
that already has one, comparing the **substantive** content — status, decision,
reasons in order, severity, confidence — and raising `AttemptResultConflict`.
A byte-identical redelivery still converges, so at-least-once delivery is
unaffected.

Detection is deliberately not the fix. It tells you the invocation executed
twice; it does not stop the second execution, and by the time it fires the
model call has already been paid for.

## What is required before a stochastic verifier

**Single-flight execution.** A second worker must not execute the invocation at
all. Either:

```
VerificationInvocation
    scheduled       nobody is executing it
    claimed         a worker holds a lease, with an expiry
    settled         the attempt is durable
```

with a **recoverable** lease — expiry plus a fencing token, so a worker that
stalls past its lease and then wakes up cannot write a result under a claim
that has since been reissued. A lease without fencing moves the race rather
than removing it.

Or an equivalent protocol that makes concurrent execution impossible rather
than merely detectable.

Note the constraint this must respect: `claimed` must not come to mean _a
worker is alive_. It means _an attempt may be in flight, so the lease must be
honoured or expired_, exactly as `attempting` does in the publication ledger
and `publishing` does in the run lifecycle. A state that assumes liveness is a
state that strands work when a machine dies.

## Why this is not being built now

The deterministic verifier cannot produce the failure, and a lease built
against a verifier that cannot exercise it would be a code path that runs
rarely — which is the category of code that is wrong. It should be built with
the model-backed verifier, tested against a verifier that genuinely disagrees
with itself, and the `AttemptResultConflict` check should stay afterwards as
the assertion that the lease is working.
