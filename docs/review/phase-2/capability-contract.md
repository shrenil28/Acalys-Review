# Phase 2 capability contract — model-backed correctness

**Status:** FROZEN before Phase 2 source implementation.

## Claim

Phase 2 may add model-backed candidate generation and model-backed independent
verification without changing the authority chain established in Phase 1:

```
assembled planner context
  -> analyzer candidate
  -> independent verifier
  -> verified finding
  -> publication policy
  -> provider effect
```

A model answer is never itself a ReviewFinding and never authorizes publication.

## Explicit non-claims

- A successful model call does not mean its content is correct.
- A timeout does not mean the provider did not execute or bill the request.
- Model-generated evidence is not conclusive evidence.
- A candidate for which no independent verification procedure can run is not
  publishable.
- The model may not request or discover repository files. It receives exactly
  the `AssembledContext` produced by the planner.
- Phase 2 does not add new public API routes or change the Phase 0 contracts.

## Model gateway boundary

Only `packages/model-gateway` may import a model-provider SDK. The gateway
returns canonical outcomes:

- `ok`: schema-valid structured output plus usage/accounting;
- `failed`: a known terminal failure (invalid response, rejected request,
  budget refusal, retry exhaustion with a known non-commit outcome);
- `unknown`: the request may have reached the provider but Acalys cannot know
  whether it executed, including client-side timeout/connection loss after
  dispatch.

Structured output is parsed and schema-validated before it leaves the gateway.
Provider response objects never escape an adapter.

## Analyzer contract

The LLM correctness analyzer receives `AssembledContext` and nothing else. It
returns candidates only. A model selects an *ordinal already admitted by the
planner*, not an arbitrary path. The runtime derives the canonical path/span
from that context item; an ordinal without a truthful positional span is
rejected rather than anchored at line 1.

Repository source, diffs, comments, PR descriptions and advisory instructions
are untrusted data. Their contents are serialized into delimited data blocks;
they do not become platform instructions.

## Verification contract

The independent model verifier receives only:

- the candidate's claim and public category/severity;
- code independently supplied by the verifier's source port for the claimed
  anchor;
- the closed verification response vocabulary.

It must not receive analyzer rationale, causal steps, remediation, model output
transcript or analyzer prompt. Its prompt template has a distinct identity.
The production scheduling path claims a recoverable fenced lease before invoking
this verifier. An expired claimant cannot persist after a newer claim exists.

## Acceptance

Phase 2 is acceptable only if all of these are executable facts:

1. provider SDK imports outside `packages/model-gateway` fail dependency cruise;
2. OpenAI and Anthropic adapters are selectable entirely by configuration;
3. recorded calls replay without network access and validate byte-identically;
4. changing prompt template, context, model, analyzer version, routing decision,
   resolved config/instructions, base/merge-base or ChangeManifest changes the
   analyzer-input identity;
5. token, cache and cost facts are persisted per interaction and aggregated per
   ReviewRun;
6. simultaneous workers cannot execute one verification invocation under the
   same valid fence;
7. a stale lease holder cannot persist its result;
8. model output cannot anchor outside planner-supplied positional context;
9. prompt-injection corpus content cannot alter the platform instruction frame;
10. evaluation reports the complete metric set and never turns an unmeasured
    value into zero.
