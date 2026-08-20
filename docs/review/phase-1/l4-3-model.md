# P1-L.4.3 Wave 0 - code-to-instruction semantic model

Frozen baseline: `ac2c120` (P1-L.4.2 closure).

This wave defines instruction states before any repository discovery,
classification parser, planner wiring, or analyzer-input identity work exists.

## Separate facts

The model keeps four dimensions distinct:

```text
InstructionArtifact       what the repository contains
InstructionApplicability  whether and why it applies to a source
InstructionPrecedence     scope specificity and declared priority facts
InstructionTrust          whether the artifact may direct analysis
```

There is deliberately no generic `related_instruction` edge. Applicability is
plural: root and nested instructions may both apply, and the factual layer
retains both.

Canonical output order is only a serialization/presentation order. It is not
precedence. Wave 0 does not choose a winning instruction, infer precedence from
discovery order, or turn directory proximity into authority.

## Classification boundary

The type system permits these combinations:

| Class                     | Trust                         |
| ------------------------- | ----------------------------- |
| `repository_policy`       | `authoritative`               |
| `directory_scoped_policy` | `authoritative`               |
| `tool_instruction`        | `authoritative` or `advisory` |
| `documentation`           | `informational`               |
| `ordinary_text`           | `untrusted`                   |

Only the first three classes can produce instruction applicability. Therefore
imperative README prose, arbitrary Markdown, and source comments cannot become
authoritative merely because their contents sound like commands.

## Coverage lattice

Instruction discovery completeness and artifact evaluation completeness remain
visible alongside the answer:

```text
                              coverage complete    coverage incomplete
some applicable instructions applicable           applicable, with the gap
no applicable instructions   no_applicable...     undetermined
```

An unreadable relevant candidate blocks a negative conclusion. It cannot erase
an independently established root policy. An unreadable candidate in a sibling
scope does not make an unrelated target undetermined when discovery is complete.

## Wave 0 evidence

Hand-built fixtures freeze these cases without relying on a production parser:

- repository-wide applicability;
- nested applicability without sibling leakage;
- plural root and nested relationships;
- README and source-comment non-authority;
- malformed and unreadable relevant candidates;
- positive evidence surviving partial evaluation;
- incomplete discovery blocking absence;
- precedence facts remaining separate from trust;
- same filenames in different scopes using scope, not basename;
- add/delete transitions producing no stale applicability.

## Explicitly deferred

Wave 0 does not define instruction filenames, read the filesystem, parse an
instruction format, choose a precedence winner, modify planner inputs, or alter
analyzer-input identity. The unchanged-source production witness belongs to
Wave 2 after independent discovery, applicability, precedence/trust, and premise
work has been integrated.
