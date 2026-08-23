# P1-M.4 — discarded_replacement_return

Supersedes the contract frozen at `8e9b754`, which contained a contradiction
between its prose and its rule. Corrected before any source exists.

```
semantic family    returned_value_usage      (taxonomy rank 3)
capability         discarded_replacement_return
```

The family is not claimed. One capability inside it is.

## The contradiction that forced this revision

The superseded contract said, correctly, that validation-only calls must be
refuted. Its verifier rule then said:

```
some return path yields a different value  ->  verified
```

For

```ts
function isValid(raw: string): boolean {
  return raw.length > 0;
}
```

every path returns a value different from `raw`, so the rule verifies exactly
what the prose forbids. Prose loses to rules, because the rule is what gets
implemented. Narrowing the capability is the fix, not a stricter adjective.

## The defect this capability covers

```ts
// base                          // head
return normalize(raw);
normalize(raw);
return raw;
```

The callee returned a **replacement** for its input — a value the caller was
meant to use _instead of_ what it passed in. The head throws that replacement
away and returns the original. The call still happens, so nothing reads as
unused; the loss is the difference between what came back and what is now
returned.

## Analyzer — base to head, and deliberately ignorant of the callee

```
BASE  the call's value was consumed   (returned, assigned, or passed on)
HEAD  the same call is an expression statement, its value discarded
```

That is the whole hypothesis. It may not resolve the binding, consult the
checker, or read the callee's body. It will therefore propose on void
procedures, predicates and identity functions alike — which is what leaves the
verifier something real to disagree with.

## Verifier — prove a replacement, not a difference

Independent evidence, in order. Every step must be _established_; failure to
establish any of them is `inconclusive`, never a verdict.

```
1  resolve the EXACT callee binding in a revision-backed Program
2  identify the input parameter the call passes
3  the return type is compatible with REPLACING that input
4  the returned expression is dataflow-derived from that input
5  at least one successful return applies a non-identity transformation
```

### Outcomes

```
void / no value returned                         -> rejected
return is in a non-replacement domain
  (string input, boolean or predicate result)    -> rejected for THIS capability
every successful return is an identity alias
  of the input                                   -> rejected
replacement-compatible + derived from the input
  + at least one non-identity transformation     -> verified
binding, body, type or dataflow unestablished    -> inconclusive
the verifier cannot execute at all               -> unavailable
```

Worked against the four shapes that matter:

```ts
function normalize(raw: string): string { return raw.trim(); }   // VERIFIED
function assertValid(raw: string): void { ... }                  // rejected: nothing returned
function isValid(raw: string): boolean { return raw.length > 0 } // rejected: not a replacement
function identity(raw: string): string { return raw; }           // rejected: identity only
```

### Dataflow, not identifier comparison

Implementing step 4 or 5 as

```
returnExpression !== parameterIdentifier
```

would be another `UndefinedKeyword`-class proxy. These must mean the same
thing as their direct forms:

```ts
return raw;
const result = raw;
return result; // both identity

return raw.trim();
const normalized = raw.trim();
return normalized; // both a transform
```

So local aliasing is followed. The test is whether the returned value is the
input itself, however many names it travelled under, or something computed
from it.

### Binding resolution is load-bearing

The historical case plants a same-named `validate(): boolean` in a different
module. A verifier matching by name reaches the wrong declaration and returns
the wrong verdict with full confidence. Name matching is forbidden; step 1 is
resolution through the Program or it is `inconclusive`.

## Deferred to later capabilities in this family

Named now so they are not smuggled in later as "the same thing":

```
string -> number conversions whose result is discarded
Result<T> and error-return protocols
Promise<T>
builder / fluent APIs returning `this`
state-token returns
status codes
```

Each needs its own evidence and its own refutations. One heuristic does not
cover the family, and pretending otherwise is how a capability's precision
quietly becomes someone else's problem.

## Anchoring

M.3.3's invariant applies unchanged. The anchor is the changed statement that
discards the value, established from head syntax.

```
exact_head    the discarding statement    -> inline eligible
unavailable   no such statement in head   -> withheld and recorded
```

No fallback line.

## Base states

M.3.0's four, unchanged. `absent` is a positive determination; `unavailable`
and `not_indexed` abstain and record. Never "no base, so nothing was
discarded".

## Evidence required before freeze

Production witnesses through `runRealAnalysis` for: the genuine replacement
discard; a `void` callee refuted; a predicate callee refuted; an identity
callee refuted; the alias-dataflow forms of both identity and transform; a
same-named decoy in another module resolved correctly; each unestablished base
state; an unreproducible project; and the natural-FP sentinel.

At least one case where the analyzer proposes and the verifier returns
`rejected`. A verifier mutated to always confirm must die.

A separate mutation band, targeted-executed before manifest admission,
survivors classified before anything is fixed. Then the full historical
mutation harness before source freeze.

## Measurement

Development corpus only. Evaluation Epoch 2 is sealed and unseen; it is opened
once, by the evaluator, after this capability's source freeze. A failing
Epoch 2 is recorded and spent, never tuned against.

```
baseline   historical 5/12 · development 2/8 · published FP 0
```
