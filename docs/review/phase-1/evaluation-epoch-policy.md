# Evaluation epochs — lifecycle, frozen

Frozen before Epoch 2 is authored, so the rule cannot be shaped by what the
fixtures turn out to contain.

## What never changes

```
gate formulas            unchanged
gate thresholds          unchanged
precision requirement    unchanged
holdout denominator      8
required holdout recall  4/8
```

A failed epoch is never a reason to move a threshold. Epoch 1's published
false positive is evidence that the precision requirement is doing work, not
evidence that it is too strict.

## The lifecycle

```
created    before the capability work it will evaluate begins
sealed     by a manifest digest over canonical serialization
observed   exactly once
immutable  the first observation is recorded whatever it says
spent      immediately after that observation
```

An epoch is blinded validation evidence only while nobody implementing against
it has seen it. The moment it is observed, that property is gone permanently —
not because the cases changed, but because the people and processes that will
next modify the source now know what is in it.

## The consequence, stated as a rule

```
source changed after observing an epoch
  -> must be evaluated against a NEW, previously unseen epoch

P1-M may close only when a FROZEN source revision passes the UNCHANGED gate
against a FRESH epoch that was sealed before that capability's work began

every earlier failed epoch remains permanently reported
```

This is deliberately not "replace the test set until something passes". The
distinction is the direction of causation:

```
INVALID   the set failed          -> get a different set
VALID     the set was exposed     -> it can no longer blind-validate
                                     work done after the exposure
```

The second is ordinary experimental hygiene. What makes it honest rather than
convenient is the last line above: nothing is deleted, and the final report
shows every failure. Passing Epoch 2 will not rewrite Epoch 1.

## Roles

```
evaluator        authors and seals the epoch; opens it after source freeze
implementation   never sees epoch source, labels, anchors, or case
                 descriptions before its own freeze
coordinator      holds only the digest and inventory metadata
```

The implementation side may know that an epoch exists, its case count, and its
family distribution. That is experiment design, not leakage — it is what makes
a result interpretable at all — and it is deliberately not enough to build to.

### The residual limitation, stated rather than glossed

Storing fixtures outside the implementation worktree makes casual inspection
unlikely, not impossible. The separation is procedural, and it is only as good
as the discipline that keeps it. Recording that plainly is better than
implying a digest can hide a file from a process that can read the disk.

Epoch 1 had stronger independence than any later epoch will: it existed before
the capabilities were conceived. Later epochs should be read as somewhat
weaker evidence, and that weakening is itself part of the record.

## Registry

```
EPOCH 1   sealed before P1-M.2 · observed at M.3 source freeze d612eac
          historical 5/12 · development 2/8 · holdout 0/8 · published FP 1
          gate FAIL on 1, 2, 3, 7
          status SPENT — usable as regression evidence, never as blinded
          validation, and any replay is labelled a post-holdout regression
          replay earning no generalization credit

EPOCH 2   p1-m-epoch-2/returned-value-usage.v1
          sealed independently, before any M.4 source existed
          8 cases · 4 returned_value_usage · 4 cross-family
          cross-family: configuration_sensitive_type_safety,
                        public_api_compatibility,
                        sensitive_data_exposure,
                        deterministic_serialization
          manifest digest bee7cd8e66b788d4664c58578f82ec88b203e760d0f7c78a568ee587728c82c9
          stored at /home/shrenil/Desktop/acalys-evaluator/epoch-2/ (outside this repo)
          seal verified independently by the coordinator: SEAL INTACT
          status SEALED — never observed
```

```
EPOCH 3   p1-m-epoch-3/public-export-reachability-loss.v1
          sealed independently, before any M.3.4 source existed
          8 cases · 4 export-reachability · 4 cross-family
          cross-family: boundary_comparison,
                        configuration_sensitive_type_safety,
                        fail_closed_authorization,
                        returned_value_usage
          manifest digest fcaa19119cf9ded0068ce7ce43b033b07f20cb8b3aef3f353333bc4ed4154eb0
          stored at /home/shrenil/Desktop/acalys-evaluator/epoch-3/ (outside this repo)
          seal verified independently by the coordinator: SEAL INTACT, exit 0
          status SEALED — never observed
```

## Epoch 3 carries two decisions worth recording

**Precision pressure lives inside the primary family, not only across it.**
Eight cases, a perfect implementation reaching exactly `4/8`, and a
must-decline refutation in the primary family cannot all hold if that decline
is a standalone row — it would move the denominator or cap a perfect
implementation at `3/8`. The evaluator co-located it instead: every primary
case carries one planted reachability loss _and_ named shapes in the same
base/head pair that must be refuted, each frozen with why it is not a loss.
Publishing one costs precision from inside the family. Epoch 2's four
cross-family cases all stayed silent, which was reassuring and tested less
than it could have.

**Refutation attribution is decided before the observation.** Cross-family
cases are labelled `capability_recall_miss`. Primary cases are labelled
`incorrect_verifier_reject_unless_contract_narrows`: the evaluator authored
from family semantics without reading the M.3.4 contract, so a primary case
refused because that contract scopes the shape out is a recall miss — and the
scorer must cite the narrowing clause. A refusal with no clause to cite is an
incorrect reject.

That is the Epoch 2 correction applied in advance rather than discovered
afterwards. Epoch 2's single refutation was a scope boundary reported as a
broken verifier, and the argument about which it was happened after the number
was recorded. Here the criterion is fixed first, and the burden is on the
implementation to point at the clause.

```
EPOCH 4   p1-m-epoch-4/public-api-reachability-loss.v1
          sealed independently, before any M.3.5 source existed
          8 cases · 4 public-API reachability · 4 cross-family
          cross-family: configuration_sensitive_type_safety,
                        returned_value_usage,
                        sensitive_data_exposure,
                        required_failure_observability
          manifest digest a969020f0423fcc1baa3729ef01bcc60bcebdefe676ca271b20ebf0d3290100b
          stored at /home/shrenil/Desktop/acalys-evaluator/epoch-4/ (outside this repo)
          seal verified independently by the coordinator: SEAL INTACT, exit 0
          status SEALED — never observed
```

### Epoch 4 turns the Epoch 3 oracle defect into a fixture property

Two of its eleven frozen refused coordinates _are_ the mistake Epoch 3's oracle
made: a head coordinate occupying a deleted member's exact lines while
declaring a different name, and a head coordinate on a deleted manifest entry's
line that is unrelated syntax. The seal proves mechanically that neither
matches under policy 2.

So the rule frozen above is not only asserted, it is adversarially tested by
the corpus that comes after it. An oracle that repeated Epoch 3's error would
now fail its own seal.

The seal additionally refuses to build on: an anchor missing a side, a
provenance, or an exact span; a deletion anchored head-side; a hull wider than
its enumeration; and a must-not-publish shape carrying no reason. Nine allowed
anchors, five base-sided and four head-sided, with one primary case
enumerating both sides of the same clause — each on its own side, never
hulled.

Sixteen named must-refuse shapes are distributed across all eight cases, so
precision pressure comes from inside the primary family as well as across it.

## Anchor authoring, binding from Epoch 4 onward

Epoch 3 rejected a correct finding, and the evaluator reported why without
being asked: its sealed anchor was head `date.ts:1`, which points at
`function parseDateInternal(...)` — a _different declaration_ that merely
occupies the deleted one's line. The product anchored base `date.ts:1`, the
export a reader actually needs.

The oracle equated two locations because they shared a line number.

```
allowed publication anchors are SEMANTIC change locations,
identified by path + side + exact span

numeric line correspondence across BASE and HEAD is never evidence
that two anchors describe the same change
```

Concretely:

```
a deletion            the exact BASE/LEFT deleted syntax is a valid anchor
                      unrelated HEAD syntax on the same line is NOT valid,
                      and a matching line number does not make it so

a rename or a change  the exact HEAD syntax expressing the change is valid

both genuinely useful enumerate BOTH, on their own sides. Never hull them.
```

Each expected anchor from Epoch 4 carries `path`, `side`, `startLine`,
`endLine`, and a provenance naming why that syntax _is_ the defect —
`deleted_export_clause`, `changed_public_boundary`, `changed_callsite`, and so
on. That field is evaluator and seal metadata; the production scorer does not
read it. Its purpose is to make an evaluator state the semantic reason for a
coordinate, so that "same line number" cannot quietly stand in for "same
change".

### What is already mechanical, and what is not

Honest split, because the difference matters:

```
MECHANICAL   the scorer consults `side` under both policies, and three
             mutations defend it — #259, #261, #285. A base-side finding
             cannot satisfy a head-side allowed anchor, and a stated side
             cannot be treated as absent.

AUTHORING    that an allowed anchor points at the syntax which constitutes
             the defect is a judgement made when the epoch is written. No
             scorer can check it, because the scorer has no notion of what
             the defect *is* beyond what the oracle asserts.
```

The seal can enforce the shape — every anchor sided, spanned, and given a
provenance — and refuse to build otherwise. It cannot enforce that the
provenance is true. That is why the rule is frozen here before an epoch is
authored rather than discovered while scoring one.

## Epoch 2 scoring instruction, binding at evaluation time

The evaluator reports that `M1ExpectedFinding` cannot express an enumeration
of allowed anchors, so each case carries its true enumeration in
`EPOCH2_ANCHOR_POLICY` while `expectedFindings[0]` holds the minimal **hull**
of that enumeration, present only so the frozen overlap matcher runs
unchanged.

Scoring must use the enumeration, not the hull.

The overlap matcher accepts any candidate whose span touches the expected
span. Two allowed anchors at lines 3 and 7 produce a hull of 3–7, and a
finding published at line 5 would then score as correct while pointing at
nothing. That is precisely how Epoch 1's historical result was partly earned —
a 1–4 allowed span blessed a hardcoded line-1 anchor — and it is the defect
M.3.3 exists to have repaired.

The evaluator states the seal refuses to build a hull wider than its
enumeration, which if every enumeration is contiguous makes the two identical.
That cannot be confirmed without reading the fixtures, and the coordinator must
not. So the instruction is unconditional rather than contingent: at evaluation
time, a candidate counts only if its anchor is one of the enumerated allowed
anchors. The hull is never the acceptance criterion.

## Epoch 2 measures something Epoch 1 could not

Two of the four cross-family cases sit in families with shipped capabilities
(`configuration_sensitive_type_safety`, `public_api_compatibility`), so this
epoch can ask whether M.2 and M.3 generalize. Epoch 1 could not, by
construction — seven of its eight rows were out of scope for everything
implemented.

The other two cross-family cases are in unimplemented families and can only
cost precision, never add recall. A perfect M.4 therefore reaches at least
`4/8` — the frozen threshold — and up to `6/8` if the shipped capabilities
generalize. The threshold was not adjusted to fit this; it has been frozen
since M.1.
