/**
 * P1-M.3.2 verifier mechanism — the refutations are the point.
 *
 * A verifier that only ever agreed with its analyzer would pass a "detects the
 * break" test and nothing else would notice. So most of what is asserted here
 * is the compiler *declining* to call something a break, in exactly the shapes
 * the contract lists.
 *
 * M.3.1's half of this file moved to `export-reachability.test.ts` when
 * `removed_export` was retired. Its results are the supersession obligation
 * M.3.4 owes, and they belong beside the capability that now has to keep them.
 */

import { describe, expect, it } from "vitest";

import {
  REQUIRED_PARAMETER_CODES,
  verifyRequiredParameterAdded,
} from "../src/verification/required-parameter.js";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const ARITY_BOUNDARY = "src/api.ts";
const arity = (baseSrc: string, headSrc: string, baseArity = 1) =>
  verifyRequiredParameterAdded(
    {
      boundaryPath: ARITY_BOUNDARY,
      exportName: "save",
      baseArity,
    },
    {
      baseFiles: files({ [ARITY_BOUNDARY]: baseSrc }),
      headFiles: files({ [ARITY_BOUNDARY]: headSrc }),
    },
  );

const ONE_ARG = "export function save(value: string): void {}";

describe("M.3.2 — a genuine arity break", () => {
  it("VERIFIES when a required positional parameter is added", () => {
    expect(
      arity(
        ONE_ARG,
        "export function save(value: string, flush: boolean): void {}",
      ).kind,
    ).toBe("verified");
  });

  it("VERIFIES when several required parameters are added", () => {
    expect(
      arity(
        ONE_ARG,
        "export function save(value: string, flush: boolean, retries: number): void {}",
      ).kind,
    ).toBe("verified");
  });
});

describe("M.3.2 — parameter count is not the rule", () => {
  it.each([
    [
      "optional",
      "export function save(value: string, flush?: boolean): void {}",
    ],
    [
      "defaulted",
      "export function save(value: string, flush: boolean = false): void {}",
    ],
    [
      "rest",
      "export function save(value: string, ...flush: boolean[]): void {}",
    ],
    [
      "an added overload with the old one retained",
      [
        "export function save(value: string): void;",
        "export function save(value: string, flush: boolean): void;",
        "export function save(value: string, flush?: boolean): void {}",
      ].join("\n"),
    ],
  ])("REJECTS when the new parameter is %s", (_label, head) => {
    // Every one of these raises the parameter count. None breaks the caller.
    expect(arity(ONE_ARG, head).kind).toBe("rejected");
  });
});

describe("M.3.2 — the base-validity premise", () => {
  it("is INCONCLUSIVE when the base contract never accepted that call", () => {
    // Claimed base arity of 1 against a base that requires 2. The probe is
    // invalid at base, so nothing about head can be attributed to the change.
    const outcome = arity(
      "export function save(value: string, flush: boolean): void {}",
      "export function save(value: string, flush: boolean, extra: number): void {}",
      1,
    );

    expect(outcome.kind).toBe("inconclusive");
    expect(outcome.detail).toContain("not valid against the base revision");
  });
});

describe("the recognised code sets stay disjoint and minimal", () => {
  it("arity recognises only too-few-arguments", () => {
    expect([...REQUIRED_PARAMETER_CODES]).toEqual([2554]);
  });
});
