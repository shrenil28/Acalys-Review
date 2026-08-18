# P1-CONTEXT — analysis context provenance

**Status: design checkpoint, not yet implemented. Phase 0 is frozen and this does not
change it.**

This is a _sketch to validate against real repositories_, not a contract to freeze. It is
recorded before the context planner is built so the planner is designed against it — and
so that if the shape turns out wrong, the wrongness is discovered by real code rather than
inherited from a document.

---

## The question this exists to answer

Once the reviewer makes real decisions, one question becomes unavoidable:

> **Exactly what information did this analyzer see when it produced this finding?**

It is needed for reproducibility, false-positive debugging, eval attribution,
prompt-injection investigation, cost analysis, verifier-independence measurement, and
eventually customer-facing auditability. Six different consumers, one record.

Nothing in Phase 0 models it, because Phase 0 had no analyzer. This is the concept the
audit predicted Phase 1 would surface, and it is **additive** — a new sidecar contract, not
a reshaping of an existing one.

---

## Context is not Evidence

The most important line in this document.

```
Context    information available to the analyzer
Evidence   information asserted to support a finding
```

If a 2,000-line dependency file was supplied to an analyzer, it does not thereby become
evidence for every finding that analyzer produced. Collapsing the two would inflate every
finding's evidence list with everything that happened to be in the prompt, and
`EvidenceStrength` would stop meaning anything — a finding "supported by" 40 files is
supported by nothing.

It also must not live on `CandidateFinding`. One invocation over one context snapshot
normally produces several findings; attaching the bundle to each would duplicate it _n_
times and imply each finding had its own context.

The relationship is:

```
Agent / Analyzer Invocation
├── execution configuration     ← model, temperature, prompt version, request id, retry
├── AnalysisContextSnapshot     ← what was shown
├── output artifacts            ← raw response, reasoning trace (§120 permitting)
└── CandidateFinding[]          ← what was claimed
```

Findings reference the invocation. The invocation references the snapshot. Neither
duplicates the other.

---

## The strongest invariant

> The snapshot records what was **actually shown**, not what the planner intended to
> retrieve.

```
planner selects A, B, C
        ↓
token budgeting · truncation · deduplication
        ↓
prompt construction
        ↓
model actually receives  A · partial B · no C
```

The useful provenance record is the bottom line. If the snapshot captured the planner's
selection instead, then during an incident an engineer would read "the analyzer saw C" and
investigate on that basis — while C was dropped during prompt construction and never
reached the model. That is a false record, and a false record is worse than none because
it is trusted.

Two consequences:

- The snapshot is written **after** prompt construction, by the component that built the
  prompt, not by the planner.
- Every item carries a `contentDigest` of the bytes that actually went in. Truncation is
  recorded explicitly rather than an excerpt being presented as a whole artifact.
- Omissions are **first-class**, not absences. "C was dropped for budget" and "C was never
  considered" are different facts, and only the first explains a missed finding.

---

## Sketch

Deliberately reusing existing canonical references rather than inventing parallel models.

```ts
interface AnalysisContextSnapshot {
  readonly id: AnalysisContextSnapshotId;

  /**
   * What was analyzed — not merely which revision row it hung from.
   *
   * P1-E.1 established that identity is review target + revision, and P1-E.2
   * established that the same head against a different base is a different
   * change. A snapshot attributed only to a revision id could therefore be
   * replayed against the wrong interpretation of the change and look correct.
   *
   * The property that matters, whatever the exact fields: **a context snapshot
   * can never be replayed against a different interpretation of the change it
   * described.**
   */
  readonly analysisSubject: {
    readonly repositoryId: RepositoryId;
    readonly base: GitObjectId;
    readonly mergeBase?: GitObjectId | undefined;
    readonly head: GitObjectId;
    /** Digest of the normalized ChangeManifest — what was actually diffed. */
    readonly changeDigest: Checksum;
  };

  readonly revisionId: PullRequestRevisionId;

  readonly planner: {
    readonly strategyId: NamespacedId;
    readonly version: string;
  };

  /** In the order the model received them. Order changes model behaviour. */
  readonly items: readonly AnalysisContextItem[];

  readonly budget: { readonly limit: number; readonly consumed: number };

  /** What was considered and left out, and why. Never an absence. */
  readonly omissions: readonly ContextOmission[];

  /** Digest over the assembled context, for exact reproducibility. */
  readonly digest: Checksum;
}

interface AnalysisContextItem {
  readonly kind: ContextItemKind;

  // Existing canonical references. Not re-modelled here.
  readonly artifact?: ArtifactReference | undefined;
  readonly location?: SourceLocation | undefined;
  readonly symbol?: SymbolReference | undefined;

  /** Whether the analyzer saw the whole thing, and if not, what it saw. */
  readonly representation: "full" | "excerpt" | "summary" | "metadata";

  readonly inclusionReason: ContextInclusionReason;

  /** Digest of the bytes actually supplied — not of the source artifact. */
  readonly contentDigest: Checksum;

  /** Position in the assembled prompt. */
  readonly ordinal: number;

  readonly tokenCount?: number | undefined;

  /** See the trust boundary below. */
  readonly trust: ContextTrustLevel;
}

interface ContextOmission {
  readonly reason:
    | "budget_exceeded"
    | "file_too_large"
    | "generated"
    | "binary"
    | "policy"
    | "unavailable"
    | "deduplicated";
  readonly artifact?: ArtifactReference | undefined;
  readonly location?: SourceLocation | undefined;
}
```

---

## The trust boundary

The adversarial eval bucket makes prompt-control integrity a hard gate, and a hard gate
needs something to enforce against. Every item preserves where its text came from:

```
repository source              untrusted — data, never instruction
repository instruction/config   tenant-authored — instruction, tenant-scoped
PR description                  untrusted — author-controlled
PR comment                      untrusted — anyone with access
linked issue                    untrusted — often world-writable
external documentation          untrusted
tool output                     semi-trusted — machine-generated, still parseable input
platform policy                 trusted — system-owned
```

The failure this prevents: flattening everything to text before prompt construction. Once
a linked issue's body and the platform's own instructions are the same kind of string, the
prompt builder cannot distinguish them and neither can the model. The builder needs to be
able to say _this is data from an untrusted repository, not an instruction controlling the
reviewer_ — and it can only say that if the distinction survived assembly.

This reuses the existing provenance vocabulary rather than inventing a second one.
`EvidenceProvenance` already distinguishes tool / agent / ci / repository / external; the
trust level is the same distinction asked a different question, and the two must not drift
into separate taxonomies.

---

## What does **not** belong in the snapshot

```
model · temperature · prompt template version · LLM request id
latency · token price · retry number · agent execution state
```

Those describe the **invocation**, not its context. Keeping them out is what lets the same
snapshot be shared, compared, or replayed against a different model — which is exactly what
eval attribution needs. A snapshot that embedded the model could not answer "same context,
different model: did quality change?"

---

## Analyzer and verifier get separate snapshots

Not this:

```
ReviewRun
  └── contextSnapshot
```

This:

```
ReviewRun
├── analyzer invocation  → AnalysisContextSnapshot A
└── verifier invocation  → AnalysisContextSnapshot B
```

The verifier deliberately sees a _different_ context: more surrounding source, different
history, the candidate finding itself, the evidence the analyzer selected, reproduction or
tool output — while **not** receiving the analyzer's reasoning or assumptions.

A shared snapshot would make that impossible to express, and would quietly destroy the
property the verifier exists for. With two, "is the verifier actually independent?" becomes
a measurable question: compare A and B, and if B ⊇ A plus the analyzer's conclusions, the
independence is nominal.

---

## Open questions for the real implementation

Listed rather than guessed at:

1. **Snapshot granularity.** One per invocation, or one per analyzer _pass_ when an
   analyzer iterates? The second is more faithful and much larger.
2. **Retention.** Snapshots are the bulk of the provenance data and are read rarely.
   Probably artifact-backed with a shorter retention than findings, but that depends on how
   often false-positive debugging actually reaches for them.
3. **Whether `digest` alone suffices for replay**, or whether the assembled context must be
   stored verbatim as an artifact. Storing it is expensive; not storing it makes exact
   replay impossible and reduces the record to "this is what it should have been".
4. **`ContextItemKind` and `ContextInclusionReason` vocabularies.** Both should be closed
   unions, and neither can be enumerated honestly before a real planner exists.

Question 3 is the one to resolve first, because it decides whether this contract supports
reproducibility or only auditability — and those are different products.
