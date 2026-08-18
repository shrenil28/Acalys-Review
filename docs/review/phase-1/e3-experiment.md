# P1-E.3 — what GitHub actually guarantees

Two live experiments against a real GitHub App, a real repository and a real open
pull request. No mocks: the whole point of this checkpoint is that the
publication protocol is built from measured provider behaviour rather than from
the endpoint list.

```
App              4630707  (client Iv23liuuJWsJn2fkys5C, slug acalys-e3-shrenil28-60186e)
Installation     154536860
Repository       shrenil28/Felicity-Event-Management-System
Pull request     #1  (open, not draft, head 9823a185ded39c2075320c0cb48bc09404881803)
Baseline commit  9e4f2d7b0c310d03c22f5f0f5d2a788b4e1e4f7b
```

No credential material appears in this document, in either transcript, or in any
probe output. See [Secret safety](#secret-safety) for how that is enforced
rather than remembered.

---

## Experiment 1 — lost-response recovery

`packages/providers/github/scripts/pending-review-probe.ts`

Marker identity `pub_msy2dyavvreizo`, minted **before** any request. The review
body carries `<!-- acalys:publication:pub_msy2dyavvreizo -->`; the inline comment
carries its own `<!-- acalys:finding:pub_msy2dyavvreizo:f1 -->`, because a review
and a finding are separately reconcilable identities.

| #   | Step                                                              | Method                                            | Status |
| --- | ----------------------------------------------------------------- | ------------------------------------------------- | ------ |
| 1   | installation token                                                | POST `/app/installations/154536860/access_tokens` | 201    |
| 2   | list PR files (find a diff line to anchor to)                     | GET `…/pulls/1/files`                             | 200    |
| 3   | **create PENDING review** (`event` omitted) + 1 inline comment    | POST `…/pulls/1/reviews`                          | 200    |
| 4   | _response deliberately discarded — the lost-response case begins_ |                                                   |        |
| 5   | list reviews, search for the marker                               | GET `…/pulls/1/reviews?per_page=100`              | 200    |
| 6   | fetch the rediscovered review                                     | GET `…/pulls/1/reviews/4956696317`                | 200    |
| 7   | list its inline comments                                          | GET `…/reviews/4956696317/comments`               | 200    |
| 8   | **submit the recovered review**                                   | POST `…/reviews/4956696317/events`                | 200    |
| 9   | re-list and count markers                                         | GET `…/pulls/1/reviews?per_page=100`              | 200    |

### What was observed

**The pending review is visible in the list API, with its body.** One review
returned, `state: "PENDING"`, body present, marker byte-identical to what was
sent. Recovery needs **one** list call — no per-comment scan.

**`submitted_at` is the second signal, and it is not redundant with `state`.**

```
PENDING    submitted_at: null
COMMENTED  submitted_at: "2026-08-18T02:49:41Z"
```

**The review id survives submission.** `4956696317` before and after; `node_id`
`PRR_kwDOTQi4Zc8AAAABJ3Eu_Q` likewise. A provider reference recorded at creation
stays valid through submit — it does not need re-resolving.

**Inline comments are retrievable once the id is rediscovered**, with the finding
marker intact — `id 3800595068`, `pull_request_review_id 4956696317`, path
`.acalys-e3-probe.md`.

**One provider normalization, and it matters.** The comment was created with
`line: 1, side: "RIGHT"`. The review-scoped listing returns neither:

```
sent       { path, line: 1, side: "RIGHT" }
returned   { path, position: 1, original_position: 1, commit_id, original_commit_id }
           line / side / start_line: absent
```

Content verification during reconciliation therefore **cannot** compare
`line`/`side` round-tripped through `/reviews/{id}/comments`. The digest must be
computed over fields the provider actually echoes on that endpoint, or read from
`/pulls/{n}/comments` instead.

**Final state: exactly one review carries the marker**, `state: "COMMENTED"`.
No duplicate was produced.

### Fields GitHub exposes that the ledger sketch did not represent

```
node_id                       stable global id, distinct from the numeric id
commit_id                     the revision the review is anchored to
original_commit_id            per comment — survives force-push
position / original_position  the legacy diff-offset anchor
author_association            NONE for an App
```

`commit_id` is the significant one: a review is bound to a revision, which is
exactly the identity `logical_key` must be scoped by.

---

## Experiment 2 — what a blind retry does

`packages/providers/github/scripts/duplicate-create-probe.ts`

Experiment 1 proved recovery is _possible_. It did not answer how dangerous
skipping it is. That decides whether reconcile-before-create is correctness or
merely tidiness, so it was measured.

| Attempt                                 | Identity sent                | Status  |
| --------------------------------------- | ---------------------------- | ------- |
| create #1                               | `pub_dup_msy6gk6ny4dm`       | **200** |
| create #2 — retry, same stable identity | `pub_dup_msy6gk6ny4dm`       | **422** |
| create #3 — retry, fresh identity       | `pub_dup_msy6gk6ny4dm_retry` | **422** |

Verbatim:

```json
{
  "message": "Unprocessable Entity",
  "errors": ["User can only have one pending review per pull request"],
  "status": "422"
}
```

The probe deleted the pending review afterwards; zero pending reviews remain.

### The finding that shapes the protocol

The 422 is **not** an idempotency guarantee. It is a constraint on _pending_
reviews only. The listing captured at the moment create #1 was accepted proves
it:

```
id=4957303438  state=PENDING    submitted_at=None                   ← just created, 200
id=4956696317  state=COMMENTED  submitted_at=2026-08-18T02:49:41Z   ← already submitted
```

A submitted review blocks nothing. So there are two windows, and they behave
oppositely:

```
create → (response lost) → retry create
   provider refuses with 422. A blind retry cannot duplicate the review.

create → submit → (response lost) → retry create
   provider ACCEPTS. A blind retry produces a second review, and submitting it
   produces a visible duplicate on someone's pull request.
```

**Reconcile-before-create is load-bearing in the second window, and the body
marker is the only thing that makes reconciliation possible there** — GitHub
offers no caller-supplied idempotency key for review creation.

---

## Outcome classification

```
Outcome A — recovery works cleanly.
```

Every clause of the criterion was met against the live provider: the pending
review was discoverable, the marker survived unaltered, the provider review id
was recovered without having seen the create response, the inline comments were
retrievable, the recovered review was submitted successfully, and exactly one
logical publication resulted.

Two qualifications, neither of which downgrades the outcome:

1. **The comment anchor is normalized** (`line`/`side` → `position`). Content
   verification must be written against what the provider echoes.
2. **The provider's 422 protects only the pending window.** It is a useful
   backstop, not a substitute for reconciliation.

### Assumptions confirmed

- A pending review is created by omitting `event`. ✓
- Its body is returned by the list endpoint, so recovery is one call. ✓
- A marker on the body survives round-trip byte-identically. ✓
- The review id can be recovered from provider state alone. ✓
- A recovered pending review can be submitted by a process that never saw the
  create response. ✓
- `unknown` is the right state for a lost response: the effect may well exist,
  and the probe recovered exactly such an effect. ✓

### Assumptions disproved or refined

- **"The inline comment anchor round-trips."** It does not, on the review-scoped
  endpoint. Refined: verify content against echoed fields.
- **"A duplicate create is the main risk."** Only after submission. Before that,
  the provider refuses.
- **"`state` alone identifies a pending review."** `submitted_at: null` is the
  more direct signal and is what a reconciler should test.

### Guarantee, stated accurately

> Acalys executes publication at least once internally when needed. Stable
> publication identity minted before the first request, plus reconciliation
> against provider state, make the externally visible result converge
> idempotently.

Not exactly-once. GitHub exposes no primitive that would make that claim true.

---

## Secret safety

The recorder was hardened **before** the live run, structurally rather than by
discipline:

- Headers are never recorded — the `Recorded` type has no field for them, so the
  `Authorization` bearer on every request cannot be captured by accident.
- Every credential is registered **at the point it is created** (PEM on read, App
  JWT on sign, installation token on receipt) and scrubbed by value from
  everything recorded. This catches the cases field-name rules miss: a token
  echoed into an error `message`, a `documentation_url`, or a field GitHub adds
  later.
- `assertNoCredentials` refuses to write a transcript that matches the _shape_ of
  a credential — `gh[pousr]_…`, a PEM header, a JWT — even one nobody registered.
  It throws rather than warns: a file written and then found to contain a
  credential has already leaked it.
- Transcripts are gitignored.

Verified after the live run: both transcripts contain zero matches for GitHub
token patterns, PEM headers, or JWT shapes. 14 redaction tests, including
planted unmistakable markers in unpredicted fields.

---

## Phase 0

```
Phase 0 remains frozen; E.3 was additive.
```

Nothing observed requires a Phase 0 contract to change. `commit_id`, `node_id`
and `position` are provider-reference details that belong in the internal
publication ledger, which is a Phase 1 persistence concept. Keeping
`PublicationEffect` internal is what allowed the protocol to absorb the two
refinements above without touching a frozen contract.
