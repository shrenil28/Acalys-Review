/**
 * P1-M.4 verifier mechanism — mostly proving it says no.
 *
 * The analyzer proposes on every consumed-to-discarded change. Three of the
 * four shapes below are not defects, and a verifier that could not tell them
 * apart would turn this capability into "unused return value", which the
 * contract forbids by name.
 */

import { describe, expect, it } from "vitest";

import { verifyDiscardedReplacement } from "../src/verification/discarded-replacement.js";

const CALLER = "src/route.ts";

/** A caller that discards the result on line 3. */
const callerDiscarding = (importFrom: string) =>
  [
    `import { validate } from "${importFrom}";`,
    "export function route(raw: string): string {",
    "  validate(raw);",
    "  return raw;",
    "}",
  ].join("\n");

const verify = (files: Record<string, string>) =>
  verifyDiscardedReplacement(
    { path: CALLER, calleeName: "validate", line: 3 },
    { files: new Map(Object.entries(files)) },
  );

describe("the four shapes the contract names", () => {
  it("VERIFIES a normalizer whose transformed result is thrown away", () => {
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        'export function validate(raw: string): string {\n  if (raw === "") throw new Error("empty");\n  return raw.trim();\n}',
    });

    expect(outcome.kind).toBe("verified");
  });

  it("REJECTS a void procedure — nothing was discarded", () => {
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        'export function validate(raw: string): void {\n  if (raw === "") throw new Error("empty");\n}',
    });

    expect(outcome.kind).toBe("rejected");
    expect(outcome.detail).toContain("returns no value");
  });

  it("REJECTS a predicate — boolean cannot replace a string", () => {
    // The case that broke the superseded contract. Every path returns a value
    // different from `raw`, so a "returns something different" rule verifies
    // it. A replacement rule does not.
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        "export function validate(raw: string): boolean {\n  return raw.length > 0;\n}",
    });

    expect(outcome.kind).toBe("rejected");
    expect(outcome.detail).toContain("cannot replace");
  });

  it("REJECTS an identity function — the caller already has that value", () => {
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        "export function validate(raw: string): string {\n  return raw;\n}",
    });

    expect(outcome.kind).toBe("rejected");
    expect(outcome.detail).toContain("unchanged");
  });
});

describe("derivation follows aliases, not identifier text", () => {
  it("treats `const result = raw; return result` as identity", () => {
    // A syntactic comparison of the return expression against the parameter
    // identifier calls this a transformation, because the text differs. It is
    // the same value under another name.
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        "export function validate(raw: string): string {\n  const result = raw;\n  return result;\n}",
    });

    expect(outcome.kind).toBe("rejected");
    expect(outcome.detail).toContain("unchanged");
  });

  it("treats `const normalized = raw.trim(); return normalized` as a transform", () => {
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        "export function validate(raw: string): string {\n  const normalized = raw.trim();\n  return normalized;\n}",
    });

    expect(outcome.kind).toBe("verified");
  });

  it("follows a chain of const aliases without losing identity", () => {
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        "export function validate(raw: string): string {\n  const a = raw;\n  const b = a;\n  return b;\n}",
    });

    expect(outcome.kind).toBe("rejected");
  });

  it("VERIFIES when only one of several paths transforms", () => {
    // One lost normalization is enough. The other path handing back the input
    // does not make the discard safe.
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        'export function validate(raw: string): string {\n  if (raw === "") return raw;\n  return raw.trim();\n}',
    });

    expect(outcome.kind).toBe("verified");
  });
});

describe("unknown derivation stays unknown", () => {
  it("is INCONCLUSIVE when the return cannot be traced to the argument", () => {
    // A constant unrelated to the input. Nothing was transformed and nothing
    // was handed back, so neither verdict is available. Guessing
    // "transformed" would publish on evidence nobody has.
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        'export function validate(raw: string): string {\n  return "constant";\n}',
    });

    expect(outcome.kind).toBe("inconclusive");
    expect(outcome.detail).toContain("could not be traced");
  });

  it("is INCONCLUSIVE for a mutable rebinding it does not model", () => {
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        "export function validate(raw: string): string {\n  let value = raw;\n  value = value.trim();\n  return value;\n}",
    });

    expect(outcome.kind).toBe("inconclusive");
  });
});

describe("the binding is resolved, never matched by name", () => {
  it("uses the imported declaration, not a same-named one elsewhere", () => {
    // The historical case's decoy. `test-helper.ts` exports a `validate` that
    // returns boolean; resolving by name reaches it and REJECTS a real defect
    // with full confidence.
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        "export function validate(raw: string): string {\n  return raw.trim();\n}",
      "src/test-helper.ts":
        "export function validate(): boolean {\n  return true;\n}",
    });

    expect(outcome.kind).toBe("verified");
  });

  it("resolves to the decoy's semantics when the decoy is what is imported", () => {
    // The converse, so the assertion above cannot pass by ignoring imports
    // altogether. Same file set, different import — different verdict.
    const outcome = verify({
      [CALLER]: callerDiscarding("./test-helper.js"),
      "src/validator.ts":
        "export function validate(raw: string): string {\n  return raw.trim();\n}",
      "src/test-helper.ts":
        "export function validate(raw: string): boolean {\n  return raw.length > 0;\n}",
    });

    expect(outcome.kind).toBe("rejected");
    expect(outcome.detail).toContain("cannot replace");
  });
});

describe("replacement compatibility is the checker's judgement", () => {
  it("accepts a type alias, which prints differently but is the same type", () => {
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        "type Raw = string;\nexport function validate(raw: Raw): string {\n  return raw.trim();\n}",
    });

    expect(outcome.kind).toBe("verified");
  });

  it("accepts a narrowed return, which is still a replacement", () => {
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        'export function validate(raw: string | undefined): "a" | "b" {\n  return raw === "a" ? "a" : "b";\n}',
    });

    expect(outcome.kind).toBe("verified");
  });

  it("rejects a widened return that cannot stand in for the input", () => {
    const outcome = verify({
      [CALLER]: callerDiscarding("./validator.js"),
      "src/validator.ts":
        "export function validate(raw: string): string | number {\n  return raw.length;\n}",
    });

    expect(outcome.kind).toBe("rejected");
  });
});

describe("what cannot be established is not decided", () => {
  it("is INCONCLUSIVE when the callee's module is missing", () => {
    const outcome = verify({ [CALLER]: callerDiscarding("./validator.js") });

    expect(outcome.kind).toBe("inconclusive");
  });

  it("is INCONCLUSIVE when no such call sits at the published line", () => {
    const outcome = verifyDiscardedReplacement(
      { path: CALLER, calleeName: "validate", line: 99 },
      {
        files: new Map([
          [CALLER, callerDiscarding("./validator.js")],
          [
            "src/validator.ts",
            "export function validate(raw: string): string {\n  return raw.trim();\n}",
          ],
        ]),
      },
    );

    expect(outcome.kind).toBe("inconclusive");
  });
});
