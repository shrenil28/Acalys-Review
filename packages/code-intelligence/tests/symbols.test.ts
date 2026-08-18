import { describe, expect, it } from "vitest";

import {
  containingSymbol,
  extractFile,
  isTestFor,
  looksGenerated,
  referencingFiles,
} from "../src/index.js";

/**
 * Extraction quality is the ceiling on review quality.
 *
 * A callee never extracted is never a candidate, and a bug in code no reviewer
 * was offered is a bug no model can find. These tests are about the questions
 * the planner actually asks, not about the shape of the TypeScript AST.
 */

describe("containingSymbol answers 'what encloses this line?'", () => {
  const source = [
    "export const CONFIG = { retries: 3 };", // 1
    "", // 2
    "export function compute(input: number): number {", // 3
    "  const scaled = input * 2;", // 4
    "  const total = scaled + CONFIG.retries;", // 5
    "  return total;", // 6
    "}", // 7
    "", // 8
    "export class Store {", // 9
    "  get(key: string): string | undefined {", // 10
    "    const cached = key;", // 11
    "    return cached;", // 12
    "  }", // 13
    "}", // 14
  ].join("\n");

  const file = extractFile("src/compute.ts", source);

  it("returns the enclosing function, not the local assignment on the line", () => {
    // The regression this exists for: `containingSymbol` returns the innermost
    // match, so treating every local `const` as a symbol made the answer to
    // "what encloses this change?" be the changed line itself. The planner then
    // offered a four-token item as the containing symbol and the reviewer never
    // saw the function.
    expect(containingSymbol(file, 5)?.name).toBe("compute");
    expect(containingSymbol(file, 4)?.name).toBe("compute");
  });

  it("still treats a module-scope constant as a symbol", () => {
    // The other half of the same rule: a top-level `const` genuinely is a
    // declaration a reviewer asks to see.
    expect(containingSymbol(file, 1)?.name).toBe("CONFIG");
    expect(file.symbols.some((symbol) => symbol.name === "CONFIG")).toBe(true);
  });

  it("does not offer locals as symbols at all", () => {
    const names = file.symbols.map((symbol) => symbol.name);
    expect(names).not.toContain("scaled");
    expect(names).not.toContain("total");
    expect(names).not.toContain("cached");
  });

  it("returns the innermost declaration when methods nest inside classes", () => {
    const method = containingSymbol(file, 11);
    expect(method?.name).toBe("get");
    expect(method?.qualifiedName).toBe("Store.get");
    expect(method?.container).toBe("Store");
  });

  it("returns nothing for a line outside every declaration", () => {
    expect(containingSymbol(file, 8)).toBeUndefined();
  });

  it("treats a function-valued local as a symbol at any scope", () => {
    // A callback body is a real unit of review, unlike a loop counter.
    const withCallback = extractFile(
      "src/cb.ts",
      ["export function outer(): void {", "  const inner = () => 1;", "}"].join(
        "\n",
      ),
    );
    expect(withCallback.symbols.map((symbol) => symbol.name)).toContain(
      "inner",
    );
  });
});

describe("extractFile distinguishes declaration from use", () => {
  const source = [
    'import { parse } from "./parse.js";',
    'import type { Config } from "./config.js";',
    "",
    "export function run(): void {",
    "  parse('x');",
    "}",
  ].join("\n");
  const file = extractFile("src/run.ts", source);

  it("records imports with their names and type-only flag", () => {
    expect(file.imports).toHaveLength(2);
    expect(file.imports[0]?.specifier).toBe("./parse.js");
    expect(file.imports[0]?.names).toEqual(["parse"]);
    expect(file.imports[0]?.typeOnly).toBe(false);
    expect(file.imports[1]?.typeOnly).toBe(true);
  });

  it("marks the declaration of a name separately from its uses", () => {
    const declarations = file.references.filter(
      (reference) => reference.name === "run" && reference.isDeclaration,
    );
    const uses = file.references.filter(
      (reference) => reference.name === "parse" && !reference.isDeclaration,
    );

    expect(declarations).toHaveLength(1);
    expect(uses.length).toBeGreaterThan(0);
  });

  it("records the whole declaration span, not just the signature line", () => {
    const run = file.symbols.find((symbol) => symbol.name === "run");
    expect(run?.startLine).toBe(4);
    expect(run?.endLine).toBe(6);
    expect(run?.exported).toBe(true);
  });
});

describe("referencingFiles answers 'who calls this?'", () => {
  const files = [
    extractFile("src/target.ts", "export function handler(): void {}"),
    extractFile(
      "src/caller.ts",
      'import { handler } from "./target.js";\nhandler();',
    ),
    extractFile("src/other.ts", "export const unrelated = 1;"),
  ];

  it("finds callers and excludes the declaring file", () => {
    const callers = referencingFiles(files, "handler", "src/target.ts").map(
      (file) => file.path,
    );
    expect(callers).toEqual(["src/caller.ts"]);
  });

  it("returns nothing for a name nobody uses", () => {
    expect(referencingFiles(files, "handler", "src/caller.ts")).toHaveLength(0);
  });
});

describe("isTestFor and looksGenerated", () => {
  it("matches conventional test names for a subject", () => {
    expect(isTestFor("src/auth.test.ts", "src/auth.ts")).toBe(true);
    expect(isTestFor("tests/auth.spec.ts", "src/auth.ts")).toBe(true);
    expect(isTestFor("src/auth-flow.test.ts", "src/auth.ts")).toBe(true);
  });

  it("does not match an unrelated test", () => {
    expect(isTestFor("src/session.test.ts", "src/auth.ts")).toBe(false);
    // A file that merely starts with the same letters is not its test.
    expect(isTestFor("src/authorization.test.ts", "src/auth.ts")).toBe(false);
    expect(isTestFor("src/auth.ts", "src/auth.ts")).toBe(false);
  });

  it("detects generated files by header first, then by path", () => {
    expect(looksGenerated("src/client.ts", "// @generated by codegen\n")).toBe(
      true,
    );
    expect(
      looksGenerated("src/client.ts", "// Code generated by protoc.\n"),
    ).toBe(true);
    expect(looksGenerated("dist/bundle.js", "console.log(1);")).toBe(true);
  });

  it("does not flag a hand-written file whose name mentions generation", () => {
    expect(
      looksGenerated("src/generated-report.ts", "export const report = 1;"),
    ).toBe(false);
  });
});
