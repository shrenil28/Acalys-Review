/**
 * P1-L.4.2 — what TypeScript itself says about project membership.
 *
 * This file is deliberately independent of the governance implementation it
 * exists to check. It calls `ts.parseJsonConfigFileContent` directly, over an
 * in-memory `ParseConfigHost`, and asserts what the compiler's own project
 * parsing returns. Nothing here reimplements `include`/`exclude` matching —
 * the host's `readDirectory` delegates to `ts.matchFiles`, the same routine
 * `ts.sys.readDirectory` calls, so the glob semantics are the compiler's, not
 * this file's (rule 2 in the shared contract).
 *
 * # Why this has to be a separate file from the governance implementation
 *
 * L.3 shipped a fixture whose premise was false: an added ESM module was
 * supposed to make a bare reference resolve, and under ESM scoping it never
 * did, so the fact under test never changed and no mutation could be
 * detected. A fixture written by, or checked against, the code it is meant to
 * verify tends to encode that code's assumptions rather than test them. This
 * file is written without reading the governance implementation, so its
 * premises are checked against the compiler, not against whatever the other
 * agents believed the compiler would do.
 *
 * # The fixture
 *
 * ```
 * tsconfig.json                  include: ["packages/**\/*.ts", "sibling/**\/*.ts"]
 * packages/a/tsconfig.json       include: ["src/**\/*.ts"]
 * packages/a/src/foo.ts
 * packages/a/notes/aside.ts      (under packages/a, NOT under src)
 * sibling/sibling.ts
 * broken/tsconfig.json           malformed JSON
 * broken/thing.ts
 * ```
 *
 * `packages/a/src/foo.ts` sits under both projects' `include` on purpose: it
 * is what makes plural governance a fact rather than a shape the type merely
 * permits (invariant 7 — the two branches, "one project" and "two projects",
 * must actually diverge).
 *
 * `packages/a/notes/aside.ts` is the adversarial case. Directory proximity —
 * "nearest tsconfig wins" — says the nested project governs it, because it is
 * physically under `packages/a/`. The nested project's `include` says
 * otherwise: `src/**\/*.ts` does not admit a file under `notes/`. Asserting
 * the negative (nested does NOT admit it) is only meaningful because the
 * tempting wrong answer — proximity — is asserted first and shown to be
 * `true` (invariant 10: a negative assertion needs the wrong answer to be
 * genuinely reachable, not merely conceivable).
 *
 * `broken/thing.ts` exists so the malformed-config case is adversarial too.
 * If a caller treated "config failed to parse" as equivalent to "config
 * parsed to an empty project", the result would still look plausible: a
 * fallback parse of the malformed config's `{}` recovery value has no
 * `include`, so TypeScript's default (`**\/*`) admits `broken/thing.ts`
 * regardless. Without that file, the trap would parse to nothing either way,
 * and the assertion that you must not trust it would hold for no reason.
 */

import { describe, expect, it } from "vitest";
import ts from "typescript";

// ---------------------------------------------------------------------------
// In-memory filesystem plumbing.
//
// TypeScript's ParseConfigHost.readDirectory is documented as already having
// applied extensions/excludes/includes — parseJsonConfigFileContent does not
// re-filter what it returns (see getFileNamesFromConfigSpecs in
// commandLineParser.ts). So a readDirectory that only filters by extension
// would silently disable the compiler's own include matching and reintroduce
// exactly the home-grown glob semantics rule 2 forbids. `ts.matchFiles` is
// the real matcher; it is unexported from the public d.ts but present on the
// runtime namespace, so it is reached through a narrow, explicit cast rather
// than `any`.
// ---------------------------------------------------------------------------

interface FileSystemEntries {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (dir: string) => FileSystemEntries,
  realpath: (path: string) => string,
) => string[];

const matchFiles = (ts as unknown as { readonly matchFiles: MatchFiles })
  .matchFiles;

const ROOT = "/repo";
const abs = (relativePath: string): string => `${ROOT}/${relativePath}`;

/** Builds a ParseConfigHost backed by a Map, with no disk access anywhere. */
function inMemoryHost(files: ReadonlyMap<string, string>): ts.ParseConfigHost {
  function getFileSystemEntries(dir: string): FileSystemEntries {
    const prefix = `${dir}/`;
    const childFiles: string[] = [];
    const childDirectories = new Set<string>();
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        childFiles.push(rest);
      } else {
        childDirectories.add(rest.slice(0, slash));
      }
    }
    return { files: childFiles, directories: Array.from(childDirectories) };
  }

  const identityRealpath = (path: string): string => path;

  return {
    useCaseSensitiveFileNames: true,
    readDirectory(rootDir, extensions, excludes, includes, depth) {
      return matchFiles(
        rootDir,
        extensions,
        excludes,
        includes,
        /* useCaseSensitiveFileNames */ true,
        ROOT,
        depth,
        getFileSystemEntries,
        identityRealpath,
      );
    },
    fileExists(path) {
      return files.has(path);
    },
    readFile(path) {
      return files.get(path);
    },
  };
}

/** Parses one project's config text with `ts`'s own two-stage pipeline. */
function parseProject(
  files: ReadonlyMap<string, string>,
  configPath: string,
): {
  readonly errorText: string | undefined;
  readonly parsed: ts.ParsedCommandLine;
} {
  const text = files.get(configPath);
  if (text === undefined) {
    throw new Error(`fixture bug: no content registered for ${configPath}`);
  }
  const { config, error } = ts.parseConfigFileTextToJson(configPath, text);
  const errorText = error
    ? ts.flattenDiagnosticMessageText(error.messageText, "\n")
    : undefined;
  const host = inMemoryHost(files);
  const basePath = configPath.slice(0, configPath.lastIndexOf("/"));
  const parsed = ts.parseJsonConfigFileContent(
    config,
    host,
    basePath,
    undefined,
    configPath,
  );
  return { errorText, parsed };
}

// ---------------------------------------------------------------------------
// The fixture, built as a Map<string, string> — never written to disk.
// ---------------------------------------------------------------------------

const ROOT_TSCONFIG = abs("tsconfig.json");
const NESTED_TSCONFIG = abs("packages/a/tsconfig.json");
const BROKEN_TSCONFIG = abs("broken/tsconfig.json");
const FOO = abs("packages/a/src/foo.ts");
const ASIDE = abs("packages/a/notes/aside.ts");
const SIBLING = abs("sibling/sibling.ts");
const BROKEN_THING = abs("broken/thing.ts");

const FIXTURE = new Map<string, string>([
  [
    ROOT_TSCONFIG,
    JSON.stringify({ include: ["packages/**/*.ts", "sibling/**/*.ts"] }),
  ],
  [NESTED_TSCONFIG, JSON.stringify({ include: ["src/**/*.ts"] })],
  [FOO, "export const foo = 1;\n"],
  [ASIDE, "export const aside = 1;\n"],
  [SIBLING, "export const sibling = 1;\n"],
  // Deliberately malformed: an unterminated object, not merely unexpected
  // JSON. A truncated-but-parseable document would not exercise the failure
  // this fixture is for.
  [BROKEN_TSCONFIG, "{ this is not json"],
  [BROKEN_THING, "export const thing = 1;\n"],
]);

describe("what TypeScript itself says about project membership", () => {
  it("the fixture is genuinely adversarial before any conclusion is drawn", () => {
    // aside.ts really is physically under packages/a/ — proximity has
    // something to be tempted by, not a straw case.
    expect(ASIDE.startsWith(`${abs("packages/a")}/`)).toBe(true);

    // The malformed config really fails to parse — this is not a config that
    // happens to produce an empty result.
    const { error } = ts.parseConfigFileTextToJson(
      BROKEN_TSCONFIG,
      FIXTURE.get(BROKEN_TSCONFIG)!,
    );
    expect(error).toBeDefined();
    expect(ts.flattenDiagnosticMessageText(error!.messageText, "\n")).toMatch(
      /expected/i,
    );
  });

  it("root admits foo.ts, sibling.ts, and aside.ts", () => {
    const { errorText, parsed } = parseProject(FIXTURE, ROOT_TSCONFIG);
    expect(errorText).toBeUndefined();
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.fileNames).toContain(FOO);
    expect(parsed.fileNames).toContain(SIBLING);
    // packages/**/*.ts matches anything under packages/, including a file the
    // nested project's own include does not reach.
    expect(parsed.fileNames).toContain(ASIDE);
  });

  it("the nested project admits foo.ts but not aside.ts or sibling.ts", () => {
    const { errorText, parsed } = parseProject(FIXTURE, NESTED_TSCONFIG);
    expect(errorText).toBeUndefined();
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.fileNames).toContain(FOO);
    expect(parsed.fileNames).not.toContain(SIBLING);
    // The tempting wrong answer, stated first: proximity says yes.
    expect(ASIDE.startsWith(`${abs("packages/a")}/`)).toBe(true);
    // TypeScript's own answer, which is what governance must actually use.
    expect(parsed.fileNames).not.toContain(ASIDE);
  });

  it("foo.ts is admitted by both projects — plurality is a fact, not a permission", () => {
    const root = parseProject(FIXTURE, ROOT_TSCONFIG).parsed;
    const nested = parseProject(FIXTURE, NESTED_TSCONFIG).parsed;

    expect(root.fileNames).toContain(FOO);
    expect(nested.fileNames).toContain(FOO);

    // If the two admitted sets coincided, "governed by one project" and
    // "governed by two" would be indistinguishable and this fixture would
    // prove nothing about plurality specifically. They must actually differ.
    const rootSet = new Set(root.fileNames);
    const nestedSet = new Set(nested.fileNames);
    expect(rootSet).not.toEqual(nestedSet);
    expect(nestedSet.size).toBeLessThan(rootSet.size);

    // A "nearest tsconfig wins" reducer would report foo.ts as governed by
    // the nested project alone, discarding the root's independently true
    // admission. Both are real; picking one is a choice a consumer makes,
    // not a fact TypeScript itself asserts.
    expect(root.fileNames.includes(FOO) && nested.fileNames.includes(FOO)).toBe(
      true,
    );
  });

  it("a malformed config fails to parse, and the failure is not equivalent to an empty result", () => {
    const { errorText, parsed: naive } = parseProject(FIXTURE, BROKEN_TSCONFIG);

    // The correct conclusion: membership is unknowable, because the JSON
    // itself never parsed. This must be checked before the config object is
    // ever handed to parseJsonConfigFileContent.
    expect(errorText).toBeDefined();

    // The trap, made concrete: parseConfigFileTextToJson's error recovery
    // value is `{}`, which has neither `files` nor `include`. TypeScript's
    // own default for that shape is `**/*`, so treating the failed parse as
    // "an empty project" and proceeding anyway does not fail closed — it
    // silently admits broken/thing.ts. If this list came back empty, the
    // earlier assertion that the recovery is dangerous would hold for no
    // reason (invariant 10); it does not.
    expect(naive.fileNames.length).toBeGreaterThan(0);
    expect(naive.fileNames).toContain(BROKEN_THING);

    // Which is exactly why config_unparsable must be reported from the
    // parseConfigFileTextToJson error directly, never inferred from what a
    // downstream parse of its recovery value happens to admit.
  });
});
