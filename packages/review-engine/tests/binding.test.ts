import { describe, expect, it } from "vitest";

import { isLexicallyShadowed } from "@acalys/code-intelligence";

import { resolveCallProduct } from "../src/verification/binding.js";
import type { VerificationContext } from "../src/index.js";

const ASYNC_STORE =
  "export async function save(value: number): Promise<void> {\n  return;\n}";

const contextOf = (files: Record<string, string>): VerificationContext => ({
  items: Object.entries(files).map(([path, content]) => ({
    path,
    content,
    reason: "unit",
  })),
  digest: "unit",
  incomplete: false,
});

/**
 * The mechanism under the eval numbers.
 *
 * Both sides of the shadowing case are tested here directly, so the guarantee
 * survives changes to the corpus, the harness or the metric definitions. A
 * property that only exists as a row in a dashboard is a property that
 * disappears the day someone reorganizes the dashboard.
 *
 * The two resolvers are tested **separately and against the same code**,
 * because their agreement is the point: the analyzer walks lexical scopes in
 * `@acalys/code-intelligence`, the verifier binds through the TypeScript
 * checker, and neither calls the other. Two implementations that can be wrong
 * in different ways.
 */
describe("A shadowed callee resolves to the shadow, by two routes", () => {
  const SHADOW = [
    'import { save } from "./store.js";',
    "export function run(save: (value: number) => void): void {",
    "  save(1);",
    "}",
  ].join("\n");

  it("the analyzer's lexical walk sees the parameter", () => {
    expect(isLexicallyShadowed(SHADOW, "src/shadow.ts", "save", 3)).toBe(true);
  });

  it("the verifier's checker binds to the parameter", () => {
    const binding = resolveCallProduct(
      contextOf({ "src/shadow.ts": SHADOW, "src/store.ts": ASYNC_STORE }),
      "src/shadow.ts",
      3,
    );
    expect(binding.kind).toBe("resolved");
    if (binding.kind !== "resolved") throw new Error("unreachable");
    expect(binding.producesPromise).toBe(false);
    expect(binding.declaredAt).toBe("src/shadow.ts:2");
    expect(binding.via).toBe("typescript_checker");
  });

  it("neither is fooled into silence when there is no shadow", () => {
    // The other half. A resolver that answered "shadowed" everywhere would
    // pass the two tests above and suppress every real finding — the failure
    // opposite to the one being fixed, and just as silent.
    const REAL = [
      'import { save } from "./store.js";',
      "export function run(): void {",
      "  save(1);",
      "}",
    ].join("\n");

    expect(isLexicallyShadowed(REAL, "src/caller.ts", "save", 3)).toBe(false);

    const binding = resolveCallProduct(
      contextOf({ "src/caller.ts": REAL, "src/store.ts": ASYNC_STORE }),
      "src/caller.ts",
      3,
    );
    expect(binding.kind).toBe("resolved");
    if (binding.kind !== "resolved") throw new Error("unreachable");
    expect(binding.producesPromise).toBe(true);
    expect(binding.declaredAt).toBe("src/store.ts:1");
  });

  it("a sibling scope declaring the name is not a shadow", () => {
    // Scope containment is load-bearing. Treating any same-named declaration
    // as a shadow would be the name-matching bug again, wearing the costume of
    // the fix for it.
    const SIBLING = [
      'import { save } from "./store.js";',
      "function elsewhere(save: (value: number) => void): void {",
      "  save(0);",
      "}",
      "export function run(): void {",
      "  save(1);",
      "}",
    ].join("\n");

    expect(isLexicallyShadowed(SIBLING, "src/a.ts", "save", 6)).toBe(false);
    expect(isLexicallyShadowed(SIBLING, "src/a.ts", "save", 3)).toBe(true);
  });
});

/**
 * The three defects step 2 found, each pinned at its own layer.
 *
 * All three were invisible in the final matrix until the number moved, and each
 * belongs to a different class:
 *
 * ```
 * path identity      an absolute path met a relative key
 * program model      a type could not resolve without a lib
 * AST targeting      the chain's tail was bound instead of its root
 * ```
 *
 * The path one especially: identity-normalization defects return "not found"
 * rather than throwing, so they read as missing data and can sit in code
 * intelligence for a long time looking like a planner gap.
 */
describe("The binding resolver's failure modes stay fixed", () => {
  it("resolves a relative import despite the checker's absolute paths", () => {
    // The checker calls the resolution hook with `/src/caller.ts` because the
    // host's current directory is `/`, while context keys are
    // repository-relative. Every join missed, every import bound to unknown,
    // and the symptom was "no declaration" rather than "no file".
    const binding = resolveCallProduct(
      contextOf({
        "src/caller.ts": [
          'import { save } from "./store.js";',
          "export function run(): void {",
          "  save(1);",
          "}",
        ].join("\n"),
        "src/store.ts": ASYNC_STORE,
      }),
      "src/caller.ts",
      3,
    );
    expect(binding).toMatchObject({ kind: "resolved", producesPromise: true });
  });

  it("binds the root of a method chain, not its tail", () => {
    // `save(1).then(...)` is one call whose callee is `.then` — a library
    // member this program has no lib for, so binding it fails and the verifier
    // abstains. The claim is about `save`.
    const binding = resolveCallProduct(
      contextOf({
        "src/caller.ts": [
          'import { save } from "./store.js";',
          "export function run(): void {",
          "  save(1).then(() => undefined);",
          "}",
        ].join("\n"),
        "src/store.ts": ASYNC_STORE,
      }),
      "src/caller.ts",
      3,
    );
    expect(binding).toMatchObject({ kind: "resolved", producesPromise: true });
  });

  it("does not need the standard library to recognise an async function", () => {
    // The first draft asked for the call's TYPE, which needs `lib.d.ts` in the
    // program. Without it every `Promise<void>` was unresolvable and a real
    // defect came back REJECTED — the catastrophic cell. Async-ness is read
    // from the bound declaration instead.
    const binding = resolveCallProduct(
      contextOf({
        "src/only.ts": [
          "async function work(): Promise<void> {",
          "  return;",
          "}",
          "export function run(): void {",
          "  work();",
          "}",
        ].join("\n"),
      }),
      "src/only.ts",
      5,
    );
    expect(binding).toMatchObject({ kind: "resolved", producesPromise: true });
  });

  it("abstains rather than guessing when nothing binds", () => {
    const binding = resolveCallProduct(
      contextOf({
        "src/dyn.ts": [
          "export function run(get: () => (value: number) => unknown): void {",
          "  get()(1);",
          "}",
        ].join("\n"),
      }),
      "src/dyn.ts",
      2,
    );
    expect(binding.kind).toBe("unresolved");
  });
});
