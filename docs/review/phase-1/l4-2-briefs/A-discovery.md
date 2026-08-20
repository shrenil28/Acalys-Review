# Agent A — project discovery ONLY

## Your one question

> Which TypeScript projects do we know about, and how complete is that
> discovery?

You do **not** decide whether any source file belongs to any project. That is
Agent C's job, working from Agent B's compiler facts. If you find yourself
writing anything about a `.ts` source file's membership, you have crossed the
boundary.

## You own, exclusively

```
packages/code-intelligence/src/repository-index/config-discovery.ts
packages/code-intelligence/tests/config-discovery.test.ts
```

Create both. Touch nothing else.

## What to build

A pure function over a `RevisionSnapshot` (`ReadonlyMap<string, string>`,
already defined in `./build.js`) returning discovered projects and how
complete that discovery is:

```ts
export interface ProjectDiscovery {
  readonly discovered: readonly string[]; // config paths, canonical order
  readonly coverage:
    | { readonly status: "complete" }
    | { readonly status: "incomplete"; readonly why: string };
}

export function discoverProjects(snapshot: RevisionSnapshot): ProjectDiscovery;
```

Shape it as you judge best, but those two questions must both be answerable.

## The point of `coverage`

Later, Agent C must be unable to conclude `not_governed` from
"zero admitting projects" when discovery itself was incomplete. Your coverage
signal is what makes that impossible.

So: be explicit and conservative about when discovery is `incomplete`. Examples
worth considering — decide which you can actually establish:

- a config references a project path not present in the snapshot
- the snapshot appears truncated or excludes directories
- a `tsconfig`-shaped file exists that you deliberately did not treat as a
  project, and can say why

Do **not** report `complete` merely because you finished iterating.

## Tests you must write

Assert premises before conclusions. At minimum:

- a repository with two configs discovers exactly two, in canonical order
- a repository with none discovers none, and says whether that is complete
- a case that genuinely yields `incomplete`, where the reason is established
  rather than assumed — and prove the case is real before asserting the result
- discovery is deterministic: same snapshot, same answer, regardless of Map
  insertion order (build the Map both ways)

That last one matters: L.1 shipped a determinism test that passed with every
canonical sort deleted, because the builder walked a sorted key list. Make sure
yours can actually observe the property it names.

## Explicitly out of scope

- reading `include`/`exclude`/`files` semantics — Agent B, via the compiler
- deciding which project governs a source file — Agent C
- `extends` resolution — Agent B
