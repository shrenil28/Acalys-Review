/**
 * P1-M.3.6 — the consumer boundary, proved through real module resolution.
 *
 * Most of what is asserted here is the verifier declining. That is the point:
 * a procedure that could only agree would pass a "detects the withdrawal" test
 * and nothing else would notice, and this capability's whole reason to exist is
 * that its predecessor confidently answered the wrong question.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  importSpecifierSpan,
  verifyConsumerBoundary,
} from "../src/verification/consumer-boundary.js";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const DECODE =
  "export function decode(raw: string): string {\n  return raw;\n}";

const manifest = (exports: Record<string, string>) =>
  JSON.stringify({ name: "pkg", version: "1.0.0", exports });

const check = (
  base: Record<string, string>,
  head: Record<string, string>,
  overrides: Partial<Parameters<typeof verifyConsumerBoundary>[0]> = {},
) =>
  verifyConsumerBoundary(
    {
      consumerSpecifier: "pkg/codec",
      exportName: "decode",
      namespace: "value",
      packageRoot: "",
      packageName: "pkg",
      ...overrides,
    },
    { baseFiles: files(base), headFiles: files(head) },
  );

const EXPORTED = {
  "package.json": manifest({ "./codec": "./src/codec.ts" }),
  "src/codec.ts": DECODE,
};

describe("the withdrawal its predecessor could not see", () => {
  it("VERIFIES when the exports map stops offering the subpath", () => {
    // `src/codec.ts` is byte-identical and still exports `decode`. A relative
    // probe compiles here and calls the boundary reachable; a consumer probe
    // cannot resolve the specifier at all.
    const outcome = check(EXPORTED, {
      "package.json": manifest({ ".": "./src/codec.ts" }),
      "src/codec.ts": DECODE,
    });

    expect(outcome.kind).toBe("verified");
    expect(outcome.detail).toContain("cannot resolve that specifier at head");
  });

  it("proves the source file really is untouched", () => {
    // Without this the assertion above could be passing because the module
    // changed, which is the case the predecessor already handled.
    const head = {
      "package.json": manifest({ ".": "./src/codec.ts" }),
      "src/codec.ts": DECODE,
    };
    expect(head["src/codec.ts"]).toBe(EXPORTED["src/codec.ts"]);
  });
});

describe("the refutations", () => {
  it("REJECTS when the target moves but the specifier survives", () => {
    // A consumer writes `pkg/codec` and does not care which file answers.
    expect(
      check(EXPORTED, {
        "package.json": manifest({ "./codec": "./src/moved.ts" }),
        "src/moved.ts": DECODE,
      }).kind,
    ).toBe("rejected");
  });

  it("REJECTS when re-export topology changes beneath a surviving specifier", () => {
    expect(
      check(EXPORTED, {
        "package.json": manifest({ "./codec": "./src/codec.ts" }),
        "src/codec.ts": 'export { decode } from "./impl.js";',
        "src/impl.ts": DECODE,
      }).kind,
    ).toBe("rejected");
  });

  it("REJECTS when the internal module goes but a public replacement remains", () => {
    expect(
      check(EXPORTED, {
        "package.json": manifest({ "./codec": "./src/replacement.ts" }),
        "src/replacement.ts": DECODE,
      }).kind,
    ).toBe("rejected");
  });
});

describe("independence — the surface does not get a vote", () => {
  it("REJECTS a hypothesised loss that resolution disproves", () => {
    // The shape that makes this a verifier rather than a formality. Something
    // upstream believes `pkg/codec` disappeared; TypeScript resolves it. An
    // implementation reading "surface says absent -> verified" fails here and
    // passes every other test in this file.
    const outcome = check(EXPORTED, EXPORTED);

    expect(outcome.kind).toBe("rejected");
  });
});

describe("the base premise is mandatory", () => {
  it("is INCONCLUSIVE when the base consumer never resolved", () => {
    // A package with no exports map fails with the SAME TS2307 as a genuine
    // withdrawal. Without proving the base import worked, that diagnostic is
    // uninterpretable — which is exactly what this guard exists for.
    const outcome = check(
      {
        "package.json": JSON.stringify({ name: "pkg" }),
        "src/codec.ts": DECODE,
      },
      { "package.json": JSON.stringify({ name: "pkg" }) },
    );

    expect(outcome.kind).toBe("inconclusive");
    expect(outcome.detail).toContain("does not compile against the base");
  });

  it("is INCONCLUSIVE when the package cannot be reconstructed at all", () => {
    expect(check({}, {}).kind).toBe("inconclusive");
  });

  it("is INCONCLUSIVE when head fails for an unrelated reason", () => {
    // The specifier still resolves; the probe fails on the name instead.
    // Reporting a boundary withdrawal here would attribute an unrelated
    // breakage to this change.
    const outcome = check(EXPORTED, {
      "package.json": manifest({ "./codec": "./src/codec.ts" }),
      "src/codec.ts":
        "export function encode(raw: string): string {\n  return raw;\n}",
    });

    expect(outcome.kind).toBe("inconclusive");
    expect(outcome.detail).toContain("not the boundary-resolution failure");
  });
});

describe("the consumer is genuinely external", () => {
  it("works for a package nested under a monorepo root", () => {
    const base = {
      "packages/codec/package.json": manifest({ "./codec": "./src/codec.ts" }),
      "packages/codec/src/codec.ts": DECODE,
    };
    const head = {
      "packages/codec/package.json": manifest({ ".": "./src/codec.ts" }),
      "packages/codec/src/codec.ts": DECODE,
    };

    expect(check(base, head, { packageRoot: "packages/codec" }).kind).toBe(
      "verified",
    );
  });

  it("handles a type-only export in type space", () => {
    const base = {
      "package.json": manifest({ "./codec": "./src/codec.ts" }),
      "src/codec.ts": "export type Config = { a: string };",
    };
    const head = {
      "package.json": manifest({ ".": "./src/codec.ts" }),
      "src/codec.ts": "export type Config = { a: string };",
    };

    expect(
      check(base, head, { exportName: "Config", namespace: "type" }).kind,
    ).toBe("verified");
  });
});

describe("a diagnostic must belong to THIS import", () => {
  // The generated probe carries exactly one import, so probe-locality and
  // specifier-locality coincide today. The span mechanism is what would keep
  // them apart if a probe ever carried two, so it is tested directly rather
  // than through an assertion that cannot currently fail.
  const parse = (text: string) =>
    ts.createSourceFile("probe.ts", text, ts.ScriptTarget.ES2022, true);

  const TWO_IMPORTS = [
    'import { a } from "pkg/other";',
    'import { decode } from "pkg/codec";',
    "void a;",
    "void decode;",
    "",
  ].join("\n");

  it("finds the span of the specifier it was asked about", () => {
    const source = parse(TWO_IMPORTS);
    const wanted = importSpecifierSpan(source, "pkg/codec");
    const other = importSpecifierSpan(source, "pkg/other");

    expect(wanted).toBeDefined();
    expect(other).toBeDefined();
    // Distinct regions, so a diagnostic at one cannot be counted at the other.
    expect(wanted?.start).not.toBe(other?.start);
    expect(
      wanted !== undefined &&
        other !== undefined &&
        (wanted.start >= other.end || other.start >= wanted.end),
    ).toBe(true);
  });

  it("finds nothing for a specifier the probe does not import", () => {
    expect(
      importSpecifierSpan(parse(TWO_IMPORTS), "pkg/absent"),
    ).toBeUndefined();
  });
});

describe("the resolver must honour the exports map", () => {
  it("refuses a specifier the map does not offer, even when the file exists", () => {
    // The layout that separates an exports-aware resolver from a path-based
    // one: `pkg/codec` matches a real file, and the manifest does not offer
    // it. Measured against the pinned compiler, NodeNext and Bundler both
    // refuse while Node10 resolves — so the mode is semantic input, and a
    // path-based resolver would call a withdrawn subpath reachable.
    const base = {
      "package.json": JSON.stringify({
        name: "pkg",
        exports: { "./codec": "./codec.ts" },
      }),
      "codec.ts": DECODE,
    };
    const head = {
      "package.json": JSON.stringify({
        name: "pkg",
        exports: { ".": "./index.ts" },
      }),
      "index.ts": "export const version = 1;",
      // Still present, still exporting, and no longer offered.
      "codec.ts": DECODE,
    };

    expect(check(base, head).kind).toBe("verified");
  });
});
