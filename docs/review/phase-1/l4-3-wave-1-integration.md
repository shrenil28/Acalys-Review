# P1-L.4.3 Wave 1 - Integration 1

## Baselines

```text
P1-L.4.2 closure     ac2c120
P1-L.4.3 Wave 0      c0b6748
Wave 1 common parent c0b6748
```

The authoritative integration branch was rebuilt from `c0b6748` and the
reviewed agent deltas were applied serially in A, B, C, D order. This avoided
relying on shared-checkout state exposed by the agent runtime.

## Integrated components

### Agent A - discovery and classification

- Exact `AGENTS.md` allowlist only.
- Root `AGENTS.md` is `repository_policy`.
- Nested `AGENTS.md` is `directory_scoped_policy`.
- `README.md` is classifiable as documentation but is never read or emitted as
  an instruction candidate.
- Random Markdown and imperative wording do not establish instructions.
- Unsafe and non-canonical repository paths are rejected.
- Traversal coverage and artifact evaluation failures remain explicit.

### Agent B - scope and applicability

- Operates only on already-discovered artifacts.
- Uses segment-aware scope containment.
- Preserves every applicable root, package, and directory relationship.
- Reports relevant evaluation gaps without treating sibling failures as gaps.
- Canonical output order is presentation-only, never precedence.

### Agent C - precedence and trust

- Produces pairwise precedence and trust relationships, never only a winner.
- Preserves every applicability fact and its provenance.
- Scope specificity is separate from declared priority.
- A missing priority is not coerced to zero.
- Trust is analyzed independently from precedence.
- Ties and incomparability remain explicit.

### Agent D - independent premises

Concrete filesystem fixtures establish root/nested coexistence, sibling
isolation, same-basename scope separation, imperative documentation and source
prose, fatal decode and malformed-content failures, incomplete traversal, and
an unchanged-source scope-change snapshot with no stale artifact path.

## Coordinator audit

```text
discovery performs applicability                no
applicability rediscovers files                 no
precedence uses traversal/insertion order       no
trust collapses into precedence                 no
ordinary documentation becomes authoritative   no
unreadable artifact erases known positive       no
incomplete coverage emits absence               no
nested policy leaks into sibling                no
lower-precedence facts are discarded            no
instruction state changes RepositoryIndex id    no
```

The frozen `instruction-model.ts` was not modified during Wave 1.

## Verification

```text
focused instruction suites  53 passed / 0 skipped
full verify                  2,140 executed / 0 skipped
dependency analysis         311 modules / 0 violations
schema check                49 generated files match
clean build                 passed
export conformance          passed
```

## Deferred to Wave 2

- production planner selection;
- canonical `InstructionFacts` identity;
- analyzer-input identity integration;
- unchanged-source add/delete production witnesses;
- mutation/red-team campaign;
- read-only adversarial review.
