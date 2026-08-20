# P1-L.4.2 — shared contract (frozen; do not change)

You are one of four parallel agents building CODE↔CONFIG governance for
Acalys. The semantic contract is **frozen and coordinator-owned**. You
implement against it. You do not redefine it.

Read first, in full:
`packages/code-intelligence/src/repository-index/config-model.ts`

That file is the contract. If you believe it is wrong, **stop and report the
problem** — do not work around it, and do not edit it.

## The state model you must honour

```
                  coverage complete    coverage incomplete
some governance   governed             governed  (coverage carries the gap)
no governance     not_governed         undetermined
```

- `not_governed` is the ONLY outcome asserting a repository fact about
  absence, and is reachable only with complete coverage.
- `undetermined` is what an incomplete evaluation produces. It is not a claim.
- **An outage may prevent a negative conclusion. It must never erase an
  independently established positive fact.**

## Three edge types that must never collapse into one

```
SourceGovernance   which project's rules admit this source file?
OptionInheritance  where do this project's options come from?
ProjectReference   which projects does this project depend on?
```

`extends` is NOT source governance. A project reference is NOT source
governance. Collapsing either would make every file in a monorepo governed by
the root config.

## Non-negotiable rules

1. **No directory proximity.** "Nearest tsconfig wins" is how editors feel,
   not how project membership is defined. Membership comes from the compiler.
2. **No reimplemented glob semantics.** Use TypeScript's own project parsing.
   If a fact needs a home-grown matcher to establish, do not claim the fact.
3. **Parse failure ≠ empty result.** A config that failed to parse tells you
   nothing about which files it admits.
4. **Governance is plural.** Two projects can admit one file. Record both.
5. Only produce facts your source of authority can actually establish. A
   narrower true answer beats a detailed invented one.

## Repository conventions you must follow

- TypeScript strict; `exactOptionalPropertyTypes` is on, so optional fields
  need `?: T | undefined` and conditional spreads, not `undefined` assignment.
- Comments explain **why**, not what. Match the density and voice of
  `config-model.ts` and `test-relationships.ts`.
- Tests: assert **premises before conclusions**. A fixture where the right and
  wrong answers coincide proves nothing (see `docs/testing/invariants.md`,
  invariants 7 and 10).
- Run `npx prettier --write <your files>` before finishing.

## Hard boundaries

- **Do not edit any file outside your ownership list.** In particular you must
  NOT touch: `config-model.ts`, any `index.ts` barrel, `package.json`,
  `scripts/mutate-p1i.mjs`, `docs/review/phase-1/status.md`.
  The coordinator does all export wiring after integration.
- **Do not run** `npm run verify`, `npm run test:ci`, or
  `node scripts/mutate-p1i.mjs`. They are serialized to the coordinator and
  contend for Docker/Postgres. Run only your own vitest files:
  `npx vitest run <your test file>`.
- **Do not spawn subagents.**

## Worktree setup

You are in an isolated git worktree. `node_modules` is not there. First:

```bash
ln -s /home/shrenil/Desktop/codeRabbit/node_modules ./node_modules
```

## What you must return

Not "done". An evidence packet:

```
commit sha
files changed (exact paths)
contract implemented (which types from config-model.ts)
tests executed / skipped counts, verbatim from vitest
what you deliberately did NOT implement
assumptions you had to make
anything you believe is wrong with the frozen contract
```
