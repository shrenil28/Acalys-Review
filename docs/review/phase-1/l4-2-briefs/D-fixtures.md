# Agent D — adversarial fixtures and compiler premises

## Your job, and why you are separate

You establish what **TypeScript itself** says, independently of how anyone
implemented the governance layer.

**Do not read** `config-governance.ts` or `config-projects.ts` before writing
your fixtures. If they exist in your worktree, ignore them. You are the check
on those implementations, and a check written after reading the implementation
tends to agree with it.

L.3 shipped a fixture whose premise was false — an added ESM module was
supposed to make a bare reference resolve, and under ESM scoping it never did,
so the fact never changed and no mutation could be detected. Your job is to
make that impossible here.

## You own, exclusively

```
packages/code-intelligence/tests/config-premises.test.ts
```

One file. Create it. Touch nothing else.

## The fixture

Build this in memory (a `Map<string, string>`), not on disk:

```
tsconfig.json                  include: ["packages/**/*.ts", "sibling/**/*.ts"]
packages/a/tsconfig.json       include: ["src/**/*.ts"]
packages/a/src/foo.ts
packages/a/notes/aside.ts      (under packages/a, NOT under src)
sibling/sibling.ts
broken/tsconfig.json           malformed JSON
```

The overlap is deliberate: `packages/a/src/foo.ts` should be admitted by BOTH
the root project and the nested one. That is what proves plural governance is a
fact rather than merely permitted by a type.

`packages/a/notes/aside.ts` is the tempting case: physically under
`packages/a/`, so directory proximity says the nested project governs it, while
the nested `include` does not admit it.

## What to assert — TypeScript's answers, directly

Call `ts.parseJsonConfigFileContent` yourself, over an in-memory
`ParseConfigHost`. Assert:

```
foo.ts     admitted by root     YES
foo.ts     admitted by nested   YES     <- plurality is real
sibling.ts admitted by root     YES
sibling.ts admitted by nested   NO
aside.ts   admitted by nested   NO      <- proximity would say yes
aside.ts   admitted by root     YES     (it matches packages/**)
broken     membership unknowable        <- parse produces errors
```

Every one of these is a premise. If any is false, the governance tests built on
it are vacuous, and you should report that rather than adjusting the assertion
to match what TypeScript happens to do.

Also assert the fixture is genuinely adversarial:

- `aside.ts` really is under `packages/a/` (so proximity is tempting)
- the two projects' admitted sets genuinely differ (so "both" and "one" are
  distinguishable answers)
- the malformed config really fails to parse, rather than parsing to something
  empty

## Explicitly out of scope

- testing `governanceFor`, `readProjectConfigs`, or `discoverProjects`
- any production wiring
- fixing anything you find wrong in another agent's code — report it instead
