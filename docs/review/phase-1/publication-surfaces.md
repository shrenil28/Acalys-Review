# P1-PUBLISH-SURFACES

A design checkpoint, additive like [P1-CONTEXT](./context-provenance.md). It
exists because the output requirement — _one summary comment, edited in place
across pushes_ — turned out to be a different kind of thing from what E.3 built,
and forcing it into the existing model would have broken the model quietly.

No code lands from this document. It records the distinction and the shape
before anything depends on getting it wrong.

---

## The distinction

E.3 built one thing and called it "publication". It is really two.

```
PublicationEffect                     PublicationSurface
an immutable external action          a durable mutable provider object

"publish review for run R"            "maintain THE Acalys summary comment
                                       for this pull request"

happens once, or converges to         exists once, and its content is
having happened once                  expected to change over time

same key + different digest           same key + different desired digest
    = invariant violation                 = update the provider object
```

Both need a stable identity minted before any request, and both need
reconcile-before-create. They differ in what a digest change _means_.

For an effect, a changed digest under a stable key is the alarm E.3 built: the
same external action was asked to mean two different things, and the effect may
already be visible carrying the other one. Neither resolution is safe.

For a surface, a changed digest under a stable key is **the normal case**. It is
the reviewer saying "the summary should now read differently", which is exactly
what a second push is supposed to produce.

The current ledger applies the effect rule to everything. Applied to a summary
comment it would reject every push after the first.

---

## Why this is not a naming quibble

Three requirements from the output spec are only satisfiable by an update
protocol:

**One comment across pushes.** A reviewer following a pull request through five
pushes should see one summary that is currently true. Five comments that
disagree is worse than none — the reader has to work out which is live.

**"No actionable comments" as a real result.** A surface can be updated to say
nothing was found. An immutable effect model has no way to express that except
by publishing another comment saying so, or by publishing nothing and letting
silence be ambiguous with "not run yet".

**Template changes.** A deploy that improves the Markdown must edit the existing
comment. Under the effect rule it raises a conflict; under a workaround where
the template version joins the identity, it creates `summary-v3`, `summary-v4`,
`summary-v5` and leaves the stale ones behind.

---

## Shape

Names are provisional; the fields are the point.

```
PublicationSurface
    surface identity            provider · repository · pull request · surface kind
                                NOT scoped by run — the surface outlives runs
    currentProviderReference    the comment that exists now, once known
    desiredContentDigest        what it should say
    confirmedContentDigest      what we have observed it saying
    renderVersion               which template produced the desired content
    state                       planned | attempting | unknown | live | failed
```

`desired` and `confirmed` being separate is what makes an update recoverable in
the same way E.3 made a create recoverable:

```
desired ≠ confirmed   →  an edit is owed
desired = confirmed   →  provider state matches intent
```

A lost response after an edit leaves `desired ≠ confirmed` and the state
`unknown` — the same epistemic position, resolved the same way: read provider
state, compare, converge. The E.3 machinery transfers; only the terminal
condition changes from "it exists" to "it says the right thing".

**Identity is not scoped by run.** That is the whole difference. A run-scoped key
would produce one surface per run, which is the behaviour being avoided.

---

## Template versioning

`renderVersion` is a field, not part of the identity.

```
surface     github:{repo}:{pr}:acalys-summary
render      3  →  desired digest abc123
later       4  →  desired digest xyz789      ← edit the same comment
```

Putting the template version in the key would make every deploy orphan the
previous comment. Keeping it beside the digest gives an honest answer to "why
did this change?" without changing what "this" refers to.

This also corrects something stated too strongly when the output spec was
written: _changing the template changes publication identity_. It does not. It
changes `desiredContentDigest`, and for a surface that is a normal update. For
an immutable effect the stronger rule still holds, because a submitted review is
not editable in the same sense.

---

## The resulting output architecture

```
GitHub pull request
│
├── persistent Acalys summary comment          ← SURFACE
│      one provider comment, edited across pushes
│      "no actionable comments" is an update, not a new comment
│
├── review run R1                              ← EFFECT
│      one submitted review + inline findings
│
├── review run R2                              ← EFFECT
│      one submitted review, if there is anything to say
│
└── conversations and replies                  (later)
```

Effects accumulate — a submitted review is a historical fact and should stay
one. The surface does not.

---

## Anchors, while the model is being written down

Recorded here because it is the same class of mistake: letting a provider's
representation become Acalys's meaning.

```
requested semantic anchor    ours, canonical, stable across pushes
    path · line · startLine · side · startSide · revision

provider-observed anchor     theirs, informational, may be absent or reshaped
    provider comment id · position? · line? · side?
    original_position? · original_line? · commit_id
```

E.3 observed a review-scoped listing that returned `position` and omitted
`line`/`side`. That is one endpoint's response shape, not a provider law —
GitHub's documented direction is the opposite, with `position` being phased out
for creation. Reconciliation reads whatever came back; it never lets the
provider redefine where a finding is. The case this protects is precisely the
one a surface has to handle well: a comment going outdated after a later push,
where a diff offset stops meaning anything and `path` + `line` + revision still
do.

---

## What is not being decided yet

- Whether a surface is a second table or a discriminated column on the existing
  one. The invariant differs; the recovery machinery does not.
- Whether "no actionable comments" should also resolve prior inline findings, or
  whether that belongs to reconciliation across revisions.
- What happens to a surface when the pull request closes.

None of these block P1-F, and answering them before there is a real reviewer to
render would be designing against an imagined product.

---

## Phase 0

Additive. A publication surface is a Phase 1 persistence concept, exactly as the
publication ledger was. Phase 0 remains frozen.
