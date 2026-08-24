# Evaluation Epoch 4 — first observation

Opened once by the independent evaluator against frozen M.3.5 + M.3.6, under
anchor policy 2. Recorded whatever it says.

## Provenance

```
source freeze            071294b   (capability source ad0a8ca)
Epoch 4 digest           a969020f0423fcc1baa3729ef01bcc60bcebdefe676ca271b20ebf0d3290100b
seal verified            SEAL INTACT, real process exit 0, before any case ran
status after observation SPENT
```

## Result

```
historical     6 TP / 12   0 FP   precision 1.0   recall 0.5
development    3 TP /  8   0 FP   precision 1.0   recall 0.375
Epoch 4        1 TP /  8   1 FP   precision 0.5   recall 0.125
natural FP     0 published of 1 replayed
```

The single true positive is **cross-family**. The primary family published zero
true positives and the one false positive.

### Primary family, per case

| case                          | proposed | verified | published | anchored | stopped at              |
| ----------------------------- | -------- | -------- | --------- | -------- | ----------------------- |
| barrel `export *` narrowed    | yes      | no       | no        | —        | verifier (inconclusive) |
| manifest subpath withdrawn    | yes      | yes      | yes       | **no**   | anchor                  |
| value export narrowed to type | no       | —        | no        | —        | analyzer (out of scope) |
| public class member withdrawn | no       | —        | no        | —        | analyzer (out of scope) |

### What worked

M.3.6 did the thing it was built for. The manifest case — a subpath withdrawn
while every source byte is identical — was proposed, and verified
`consumer_boundary_unreachable_at_head` by an external consumer probe. Epoch
3's sharpest miss is repaired.

Sixteen must-refuse shapes were planted; three distinct shapes were proposed
across four proposals, and **none published**. One of those refusals is the new
consumer verifier declining a surface change where reachability survives. Zero
reachability candidates on any cross-family case.

## Two defects in code I wrote, both confirmed here

### 1. The anchor is hardcoded to line 1 — again

`candidateFor` in `boundary-reachability.ts`:

```ts
const location = {
  path: loss.establishedIn,
  startLine: 1,
  endLine: 1,
  side: "base" as const,
};
```

This is **the M.3.3 defect reintroduced**. M.3.3 exists because
`removedExportCandidate` hardcoded line 1 and produced Epoch 3's published false
positive. The evaluator caught it in the barrel case: the identity is
`frameChecksum`, declared at line 9, and the anchor points at line 1 — which is
`encodeFrame`, a different symbol.

The manifest case published at `src/testing.ts:1` and was scored a false
positive. It was right about the file only because that file's line 1 happens
to be the declaration.

### 2. Nothing mutation-tested M.3.5's proposal layer

```
mutations targeting packages/review-engine/src/correctness/boundary-reachability.ts   0
#250 "the head anchor reverts to a hardcoded line 1"  targets export-reachability.ts
```

The band that killed 10 of 10 covered `consumer-boundary.ts` and
`deterministic.ts` — M.3.6's verifier. **M.3.5's analyzer has no mutation
coverage at all.** So the guarantee that a published anchor must be resolved
rather than constant existed for the superseded module and not for the one that
replaced it, and a clean band said nothing about it.

That is invariant 14's failure mode with the polarity reversed. There, a
mutation's evidence route went stale. Here, new code arrived with no mutation
pointing at it, and the full harness cannot detect an absence of coverage —
only a break in coverage that exists.

## Gate

```
FAIL  1. historical published recall >= 8/12         0.5 (6/12)
FAIL  2. dev and holdout recall each >= 4/8          development 0.375, holdout 0.125
FAIL  3. published precision 100% on all splits      hist 1, dev 1, holdout 0.5
PASS  4. no natural false positive published
PASS  5. baseline true positives do not regress
PASS  6. incorrect rejects and unavailability zero   0 incorrect, 0 unavailable, 3 inconclusive
FAIL  7. additional TP / additional comments == 1.0  0.8333 (5 TP / 6 comments)
PASS  8. witness and semantic mutations              relayed attestation
PASS  9. context demand-selected per capability      relayed attestation

P1-M GATE NOT SATISFIED — failing conditions 1, 2, 3, 7
```

Conditions 8 and 9 are **relayed**, not measured. The evaluator said so
explicitly: no committed attestation record exists for these two capabilities,
and it did not re-derive the mutation band. Given finding 2 above, condition 8's
PASS is exactly the kind of claim that should have been measured — a capability
with zero mutations attested as having semantic mutation kills.

## Where the loss moved

Epoch 3: boundary-only edits produced no candidate at all.
Epoch 4: they are proposed with the right name and boundary, and the
source-edit variants die at verification.

The evaluator measured this 9 for 9 on post-observation probes: the consumer
verifier is conclusive only when the manifest itself changed, returning
`comparison_revision_unavailable` otherwise. Its isolation probe holds the
comparison revision fixed and changes one file, and the retained M.3.4 module
verifier verifies the same loss the new one abstains on.

The code path is confirmed here — the M.3.6 dispatch returns `undefined` when no
`package.json` appears in the candidate's evidence locations, and
`adjudicateCompatibility` maps that to `comparison_revision_unavailable`. **Why
the evidence lacks it when the manifest is unchanged is not yet established**,
and is recorded as unfinished rather than guessed.

## The evaluator's own corrections

Reported without being asked, and both are right:

- **The attribution vocabulary has no slot for "neither confirmed nor
  refused".** That is where the epoch's central primary case landed. Condition 6
  PASSES while the capability's flagship case died at the verifier — the second
  epoch running where its PASS conceals something, for a different reason each
  time. Epoch 3: analyzer non-proposal. Epoch 4: verifier non-conclusion.
- **Two of four primary slots were spent on shapes the contract scopes out.**
  Authoring blind is the design; the cost is that half the primary set could not
  have fired whatever the implementation did. A future epoch should risk at most
  one slot that way.

It also flagged an honest ambiguity in its own oracle rather than scoring it
silently: for a boundary-only edit, it enumerated the manifest line and refused
`src/testing.ts:1` as "byte-identical to base; nothing changed at this
location". The product anchored the correct declaration of the correct symbol on
the correct side. Unlike Epoch 3's oracle error, this one is defensible on both
sides — where to send a developer when a manifest edit causes a loss is a real
open question, and it needs an explicit clause before the next epoch rather than
an implicit convention.

## Portfolio

```
M.4   returned_value_usage    1 TP at an enumerated anchor — generalizes again
M.2   exact_optional          0/0 for the THIRD time, third distinct shape
                              (a spread carrying undefined into an exact-optional property)
```

M.2 being write-shaped is honest scoping, not a defect. Three independent
confirmations is now strong evidence about where its boundary actually is.

## What this observation does not license

Epoch 4 is spent. Nothing here permits editing M.3.5, M.3.6, M.4 or M.2 against
these results. The two defects above are real and were confirmed against the
source, not inferred from the score — the anchor repair and the missing mutation
coverage belong to a next checkpoint measured against a newly sealed epoch.
