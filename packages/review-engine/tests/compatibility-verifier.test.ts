/**
 * P1-M.3 verifier mechanism — the refutations are the point.
 *
 * A verifier that only ever agreed with its analyzer would pass a "detects the
 * break" test and nothing else would notice. So most of what is asserted here
 * is the compiler *declining* to call something a break, in exactly the shapes
 * the contract lists.
 */

import { describe, expect, it } from "vitest";

import {
  REMOVED_EXPORT_CODES,
  probeSourceFor as removedProbe,
  verifyRemovedExport,
} from "../src/verification/removed-export.js";
import {
  REQUIRED_PARAMETER_CODES,
  verifyRequiredParameterAdded,
} from "../src/verification/required-parameter.js";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const BOUNDARY = "src/parser.ts";
const EXPORTED =
  "export function parse(raw: string): number {\n  return Number(raw);\n}";

const removal = (base: Record<string, string>, head: Record<string, string>) =>
  verifyRemovedExport(
    { boundaryPath: BOUNDARY, exportName: "parse", namespace: "value" },
    { baseFiles: files(base), headFiles: files(head) },
  );

describe("M.3.1 — a genuine removal", () => {
  it("VERIFIES when the name is no longer exported at the boundary", () => {
    const outcome = removal(
      { [BOUNDARY]: EXPORTED },
      {
        [BOUNDARY]:
          "function parse(raw: string): number {\n  return Number(raw);\n}\nexport { parse as parseInternal };",
      },
    );

    expect(outcome.kind).toBe("verified");
  });

  it("VERIFIES when the name is gone entirely", () => {
    const outcome = removal(
      { [BOUNDARY]: EXPORTED },
      { [BOUNDARY]: "export function other(): void {}" },
    );

    expect(outcome.kind).toBe("verified");
  });
});

describe("M.3.1 — the refutations", () => {
  it("REJECTS a declaration moved behind a named re-export", () => {
    // The declaration left the file. The contract did not.
    const outcome = removal(
      { [BOUNDARY]: EXPORTED },
      {
        [BOUNDARY]: 'export { parse } from "./impl";',
        "src/impl.ts": EXPORTED,
      },
    );

    expect(outcome.kind).toBe("rejected");
  });

  it("REJECTS a declaration moved behind `export *`", () => {
    const outcome = removal(
      { [BOUNDARY]: EXPORTED },
      {
        [BOUNDARY]: 'export * from "./impl";',
        "src/impl.ts": EXPORTED,
      },
    );

    expect(outcome.kind).toBe("rejected");
  });

  it("REJECTS an internal rename kept behind a public alias", () => {
    const outcome = removal(
      { [BOUNDARY]: EXPORTED },
      {
        [BOUNDARY]:
          "function parseImpl(raw: string): number {\n  return Number(raw);\n}\nexport { parseImpl as parse };",
      },
    );

    expect(outcome.kind).toBe("rejected");
  });
});

describe("M.3.1 — namespaces are not interchangeable", () => {
  const TYPE_BOUNDARY = "src/types.ts";

  it("does not report a removal for a type export that is still reachable", () => {
    // A value-shaped probe against a type-only export produces TS2693, which
    // is a fact about the probe, not about the author's change. Recognising it
    // would let the verifier manufacture removals out of its own choices.
    const outcome = verifyRemovedExport(
      {
        boundaryPath: TYPE_BOUNDARY,
        exportName: "Config",
        namespace: "type",
      },
      {
        baseFiles: files({
          [TYPE_BOUNDARY]: "export type Config = { a: string };",
        }),
        headFiles: files({
          [TYPE_BOUNDARY]: "export type Config = { a: string; b?: number };",
        }),
      },
    );

    expect(outcome.kind).toBe("rejected");
  });

  it("VERIFIES a type export that genuinely stopped being exported", () => {
    const outcome = verifyRemovedExport(
      {
        boundaryPath: TYPE_BOUNDARY,
        exportName: "Config",
        namespace: "type",
      },
      {
        baseFiles: files({
          [TYPE_BOUNDARY]: "export type Config = { a: string };",
        }),
        headFiles: files({
          [TYPE_BOUNDARY]:
            "type Config = { a: string };\nexport type { Config as Internal };",
        }),
      },
    );

    expect(outcome.kind).toBe("verified");
  });

  it("builds the probe in the symbol's own namespace", () => {
    expect(
      removedProbe({
        boundaryPath: TYPE_BOUNDARY,
        exportName: "Config",
        namespace: "type",
      }),
    ).toContain("import type {");
    expect(
      removedProbe({
        boundaryPath: BOUNDARY,
        exportName: "parse",
        namespace: "value",
      }),
    ).not.toContain("import type {");
  });
});

describe("M.3.1 — the base-validity premise", () => {
  it("is INCONCLUSIVE when the export never existed at base", () => {
    // Without this the verifier would report a break for every name it was
    // ever asked about, because a probe that fails at base fails at head too.
    const outcome = removal(
      { [BOUNDARY]: "export function other(): void {}" },
      { [BOUNDARY]: "export function other(): void {}" },
    );

    expect(outcome.kind).toBe("inconclusive");
    expect(outcome.detail).toContain("not valid against the base revision");
  });

  it("is INCONCLUSIVE when the boundary is missing from the head snapshot", () => {
    // Ambiguous between a deleted module and a snapshot that omitted it. The
    // ambiguity is refused rather than resolved in favour of a finding.
    const outcome = removal({ [BOUNDARY]: EXPORTED }, {});

    expect(outcome.kind).toBe("inconclusive");
    expect(outcome.detail).toContain("head snapshot");
  });
});

describe("M.3.1 — project reproduction is semantically necessary", () => {
  it("changes verdict when the `export *` target is withheld", () => {
    // Not `rootNames.length > 1`, which any implementation satisfies by
    // accident. Withhold the second module and the SAME query flips verdict,
    // so a verifier that quietly collapsed to the boundary file alone would
    // publish a break that does not exist.
    //
    // `export *` rather than a named re-export, and the difference is not
    // cosmetic. With `export { parse } from "./impl"` the name is declared in
    // the boundary's own export clause, so the probe's import resolves even
    // when the target is missing — the unresolved-module error lands inside
    // the boundary, not the probe. That fixture would have passed while
    // proving nothing. `export *` has no such clause: with the target absent,
    // there is genuinely nothing to re-export.
    const head = {
      [BOUNDARY]: 'export * from "./impl";',
      "src/impl.ts": EXPORTED,
    };

    expect(removal({ [BOUNDARY]: EXPORTED }, head).kind).toBe("rejected");

    const withheld: Record<string, string> = { ...head };
    delete withheld["src/impl.ts"];
    expect(removal({ [BOUNDARY]: EXPORTED }, withheld).kind).toBe("verified");
  });
});

// ---------------------------------------------------------------------------

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
  it("removal recognises only the three reachability codes", () => {
    expect([...REMOVED_EXPORT_CODES].sort()).toEqual([2305, 2459, 2460]);
  });

  it("does not recognise TS2693, the value-probe-on-a-type error", () => {
    expect(REMOVED_EXPORT_CODES.has(2693)).toBe(false);
  });

  it("does not recognise TS2307, which an incomplete snapshot also produces", () => {
    expect(REMOVED_EXPORT_CODES.has(2307)).toBe(false);
  });

  it("arity recognises only too-few-arguments", () => {
    expect([...REQUIRED_PARAMETER_CODES]).toEqual([2554]);
  });
});
