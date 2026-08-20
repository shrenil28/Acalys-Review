# Agent C — the governance algebra

## Your one job

Implement exactly the frozen state model. Given discovery, project facts, and a
source path, answer `ConfigGovernanceResult`.

**You must not import `typescript`.** Not once. If you need a compiler fact you
do not have, that is a gap in Agent B's contract — report it rather than
reaching for the API yourself. This boundary is the reason the algebra can be
tested against hand-built facts that no happy-path extractor would produce.

## You own, exclusively

```
packages/code-intelligence/src/repository-index/config-governance.ts
packages/code-intelligence/tests/config-governance.test.ts
```

Create both. Touch nothing else.

## Inputs you can assume exist

From `./config-discovery.js` (Agent A) and `./config-projects.js` (Agent B).
Those files may not exist yet in your worktree — **define the input types you
need locally as `interface`s matching the shapes below, and import nothing from
those modules.** The coordinator reconciles the seam at integration; your job
is the algebra, and structural typing will make it fit.

```ts
interface ProjectDiscovery {
  readonly discovered: readonly string[];
  readonly coverage:
    | { readonly status: "complete" }
    | { readonly status: "incomplete"; readonly why: string };
}

interface ProjectConfigFact {
  readonly configPath: string;
  readonly availability:
    | { readonly kind: "available" }
    | {
        readonly kind: "unavailable";
        readonly failure: GovernanceFailure;
        readonly detail: string;
      };
  readonly admittedFiles: readonly string[];
  readonly namedInFiles: readonly string[];
  readonly extendsPath?: string | undefined;
  readonly referencedProjects: readonly string[];
}
```

## What to build

```ts
export function governanceFor(
  discovery: ProjectDiscovery,
  projects: readonly ProjectConfigFact[],
  sourcePath: string,
): ConfigGovernanceResult;

export function optionInheritance(
  projects: readonly ProjectConfigFact[],
): readonly OptionInheritance[];

export function projectReferences(
  projects: readonly ProjectConfigFact[],
): readonly ProjectReference[];
```

All three return types are already in `config-model.ts`. Import them.

## The algebra, precisely

```
relationships = every AVAILABLE project whose admittedFiles contains sourcePath
                reason = included_by_files  if also in namedInFiles
                         included_by_include otherwise

coverage.evaluated   = available project paths
coverage.unevaluable = unavailable ones, as GovernanceUnavailable

if relationships nonempty            -> governed   (coverage may be incomplete)
else if discovery complete
     and every project available     -> not_governed
else                                 -> undetermined
```

Note what `not_governed` requires: **both** complete discovery and complete
evaluation. Either gap makes it `undetermined`.

`optionInheritance` builds direct edges (`directness: "direct"`, `depth: 1`)
from each project's own `extendsPath`, then derives transitive edges by walking
those. Do not flatten a chain to its root.

## Tests you must write

Hand-build the facts. Do not construct them from a real repository — the point
is to reach states a happy-path extractor would not produce.

Required cases, each asserting its premise first:

1. two projects both admitting one file -> `governed` with BOTH, not one
2. `governed` while one unrelated project is `unavailable` -> still `governed`,
   and `coverage.unevaluable` names the gap. **This is the case the model was
   corrected for; it must be impossible to make it `undetermined`.**
3. no admitting project + complete discovery + all available -> `not_governed`
4. no admitting project + one unavailable -> `undetermined`, NOT `not_governed`
5. no admitting project + discovery incomplete -> `undetermined`
6. `included_by_files` vs `included_by_include` distinguished correctly, with a
   fixture where both kinds are present so the classification can be wrong
7. `extends` produces `OptionInheritance` and **never** a `SourceGovernance`
8. a project reference produces `ProjectReference` and **never** a
   `SourceGovernance` — assert the governance result for a file in the
   referencing project does not name the referenced project
9. a three-level extends chain yields direct and transitive edges with correct
   `depth`, not a single flattened edge

For every negative assertion (`not.toContain`, `toHaveLength(0)`), make sure the
fixture actually offers a wrong answer to reject. An assertion over an empty
possibility space proves nothing — see invariant 10.

## Explicitly out of scope

- reading files, parsing configs, or importing `typescript`
- discovering projects
- any production planner wiring
