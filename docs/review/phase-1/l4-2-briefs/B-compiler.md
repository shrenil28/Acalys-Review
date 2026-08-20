# Agent B — compiler-backed project facts

## Your one job

```
tsconfig path  ->  TypeScript compiler API  ->  ProjectConfigFact
```

You are given config paths. You do **not** discover them (Agent A) and you do
**not** conclude anything about source governance (Agent C).

## You own, exclusively

```
packages/code-intelligence/src/repository-index/config-projects.ts
packages/code-intelligence/tests/config-projects.test.ts
```

Create both. Touch nothing else.

## What to build

For each config path, using `ts.parseJsonConfigFileContent` (plus
`ts.readConfigFile` / `ts.parseJsonText` as needed) over an in-memory
`ParseConfigHost` backed by the `RevisionSnapshot`:

```ts
export interface ProjectConfigFact {
  readonly configPath: string;
  readonly availability:
    | { readonly kind: "available" }
    | {
        readonly kind: "unavailable";
        readonly failure: GovernanceFailure;
        readonly detail: string;
      };
  /** Files this project admits. Empty ONLY when available and admitting none. */
  readonly admittedFiles: readonly string[];
  /** Paths literally named in `files`, resolved. Establishable exactly. */
  readonly namedInFiles: readonly string[];
  /** The project's OWN `extends`, not the whole chain. */
  readonly extendsPath?: string | undefined;
  readonly referencedProjects: readonly string[];
}

export function readProjectConfigs(
  snapshot: RevisionSnapshot,
  configPaths: readonly string[],
): readonly ProjectConfigFact[];
```

`GovernanceFailure` is already defined in `config-model.ts` — import it.

## The rules that matter most here

1. **Do not reimplement `include`/`exclude`.** The entire justification for
   this agent is that TypeScript answers membership. If you write a glob
   matcher, you have removed the reason to trust the answer.
2. **`unavailable` must never surface as `admittedFiles: []`.** A config that
   failed to parse tells you nothing about what it admits. These two states
   must be distinguishable by a caller that only looks at your output.
3. **`extendsPath` is the project's own `extends` only.** Do not walk the
   chain and report the root. Agent C builds the chain from direct edges.
4. **Diagnostics**: record a canonical `failure` reason plus a sanitized
   `detail`. Do not put raw compiler error strings anywhere that could reach a
   digest — they are environment-sensitive.

## Tests you must write

Premises before conclusions, and fixtures where right and wrong differ:

- a project with `include` admits the matching files and not others — and
  assert the non-matching file EXISTS in the snapshot, so "not admitted" is a
  real answer rather than an absent input
- a project with `files` reports `namedInFiles` exactly
- a malformed config yields `unavailable`, and `admittedFiles` is NOT usable as
  evidence of emptiness — write the assertion so that returning `[]` with
  `available` would fail
- `extends` reports the direct parent only, for a two-level chain
  (`pkg -> base-a -> base-b`): assert `pkg.extendsPath === base-a`, NOT base-b
- `references` are reported and are not confused with `extends`

## Explicitly out of scope

- which projects exist (Agent A)
- which project governs a file (Agent C)
- any `SourceGovernance` / `ConfigGovernanceResult` value
