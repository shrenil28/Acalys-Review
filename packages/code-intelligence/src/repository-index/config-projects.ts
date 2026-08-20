/**
 * A config path, in. A {@link ProjectConfigFact}, out. Nothing about which
 * source file any project governs — that judgement belongs to whoever
 * combines these facts with a file list (Agent C's job, not this module's).
 *
 * The whole point of this file is that TypeScript's own project parser is
 * the only thing allowed to decide project membership. Every fact below is
 * either read straight off `ts.parseJsonConfigFileContent`'s answer, or is
 * plain relative-path arithmetic identical in kind to `resolveSpecifier` in
 * `build.ts` — never a pattern this module invented and asks the caller to
 * trust.
 *
 * # Why every path is rooted at `/` before it reaches the compiler
 *
 * Snapshot keys are repository-relative (`"pkg/tsconfig.json"`, no leading
 * slash) — the same convention `build.ts` uses. Handing the compiler a
 * config path in that same unrooted form breaks its own relative-path join:
 * `getNormalizedAbsolutePath` only collapses a leading `../` against the
 * base when the base is recognized as a rooted disk path, and an unrooted
 * base like `"pkg"` gets `../base-a` concatenated onto it verbatim instead
 * of climbing out of it — `"pkg/base-a"` rather than `"base-a"`. Confirmed by
 * running it, not assumed. Rooting every path at `/` before it reaches
 * `ts.readConfigFile` / `parseJsonConfigFileContent`, then stripping the
 * leading slash on the way back out, is the same fix `build.ts`'s
 * `compilerHost` applies for the identical reason.
 *
 * # Why `ts.matchFiles`
 *
 * `ParseConfigHost.readDirectory` is not a raw directory listing — TypeScript
 * calls it directly with the project's `include`/`exclude` patterns already
 * attached and expects the *filtered* file list back
 * (`getFileNamesFromConfigSpecs` in the compiler passes the pattern
 * arguments straight through to `host.readDirectory` and trusts the result).
 * A real filesystem host answers this by calling `ts.matchFiles` — the same
 * glob engine `ts.sys.readDirectory` uses — against a directory-entries
 * callback. It is not exported in the public `.d.ts`, but it is the only way
 * to honour "no reimplemented glob semantics": writing our own `include`
 * matcher here would be the exact mistake this checkpoint exists to rule
 * out, just moved one file over. Reached through a narrow local cast, at the
 * one call site that needs it.
 *
 * # Two ways `extends` breaks, discovered by tracing the parser
 *
 * `parseJsonConfigFileContent`'s `errors` were expected to carry one
 * diagnostic code for "extends target missing". Tracing `commandLineParser`
 * and reproducing it against fixtures turned up three: `6053` when the
 * extends resolver cannot find a target without an explicit `.json` suffix,
 * `5083` when the target *does* have a `.json` suffix and gets returned
 * unchecked by `getExtendsConfigPath` only to fail when something later
 * tries to read it, and `18000` for a circular extends chain. None of the
 * three fires for anything else the parser reports — an unrecognized
 * compiler option or an empty `files` list uses different codes and never
 * touches whether `fileNames` was computed. See `EXTENDS_FAILURE_CODES`.
 */

import ts from "typescript";
import { EXTRACTOR_VERSION } from "./identity.js";
import type { GovernanceFailure } from "./config-model.js";
import type { RevisionSnapshot } from "./build.js";
import type { FactProvenance } from "./records.js";

export interface ProjectConfigFact {
  readonly configPath: string;
  readonly availability:
    | { readonly kind: "available" }
    | {
        readonly kind: "unavailable";
        readonly failure: GovernanceFailure;
        readonly detail: string;
      };
  /** Files this project admits. Empty ONLY when available and admitting none. */
  readonly admittedFiles: readonly string[];
  /** Paths literally named in `files`, resolved. Establishable exactly. */
  readonly namedInFiles: readonly string[];
  /** The project's OWN `extends`, not the whole chain. */
  readonly extendsPath?: string | undefined;
  readonly referencedProjects: readonly string[];
  readonly coverage?: {
    readonly membership: "complete" | "incomplete" | "unusable";
    readonly optionInheritance: "complete" | "incomplete";
    readonly referenceDiscovery: "complete" | "incomplete";
    readonly reasons: readonly string[];
  };
  readonly provenance: FactProvenance;
}

// ---------------------------------------------------------------------------
// Path arithmetic — relative-segment joining, never a pattern matcher
// ---------------------------------------------------------------------------

const stripLeadingSlash = (path: string): string => path.replace(/^\/+/, "");

const toRooted = (path: string): string => `/${stripLeadingSlash(path)}`;

const dirnameOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
};

/**
 * `../base/tsconfig.json` from `pkg/tsconfig.json`'s directory to
 * `base/tsconfig.json`. The same segment-by-segment join `resolveSpecifier`
 * in `build.ts` uses for module specifiers, reused here for `extends` and
 * `files` entries because both are plain relative paths, never globs — join
 * arithmetic isn't the pattern-matching this checkpoint forbids reimplementing.
 */
function joinRelative(base: string, specifier: string): string {
  const parts = base === "" ? [] : base.split("/");
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    else if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedUnique = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort(compare);

// ---------------------------------------------------------------------------
// A virtual filesystem, backed by the snapshot
// ---------------------------------------------------------------------------

interface DirectoryEntries {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

const EMPTY_ENTRIES: DirectoryEntries = { files: [], directories: [] };

/**
 * A virtual `readdir`, built once per snapshot rather than per config —
 * `ts.matchFiles` calls this once per directory it visits while resolving
 * `include`, and a snapshot read once here answers every config this
 * function is asked about instead of being re-derived per call.
 */
function buildDirectoryIndex(
  snapshot: RevisionSnapshot,
): ReadonlyMap<string, DirectoryEntries> {
  const files = new Map<string, Set<string>>();
  const directories = new Map<string, Set<string>>();

  const record = (
    map: Map<string, Set<string>>,
    dir: string,
    name: string,
  ): void => {
    let names = map.get(dir);
    if (names === undefined) {
      names = new Set();
      map.set(dir, names);
    }
    names.add(name);
  };

  for (const path of snapshot.keys()) {
    const parts = stripLeadingSlash(path).split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join("/");
      const name = parts[depth];
      if (name === undefined) continue;
      record(depth === parts.length - 1 ? files : directories, dir, name);
    }
  }

  const index = new Map<string, DirectoryEntries>();
  for (const dir of new Set([...files.keys(), ...directories.keys()])) {
    index.set(dir, {
      files: [...(files.get(dir) ?? [])],
      directories: [...(directories.get(dir) ?? [])],
    });
  }
  return index;
}

/**
 * See the module comment's "Why `ts.matchFiles`" section. Not part of the
 * public `.d.ts`, so it is typed narrowly here rather than trusted at the
 * `ts` namespace's own (absent) type.
 */
type MatchFilesFn = (
  rootDir: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => DirectoryEntries,
  realpath: (path: string) => string,
) => string[];

const matchFiles: MatchFilesFn = (ts as unknown as { matchFiles: MatchFilesFn })
  .matchFiles;

if (matchFiles === undefined) {
  throw new Error(
    `TypeScript ${ts.version} does not expose ts.matchFiles; config parsing requires the compiler version used by ${EXTRACTOR_VERSION}.`,
  );
}

function createParseConfigHost(
  snapshot: RevisionSnapshot,
  directoryIndex: ReadonlyMap<string, DirectoryEntries>,
): ts.ParseConfigHost {
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => snapshot.has(stripLeadingSlash(path)),
    readFile: (path) => snapshot.get(stripLeadingSlash(path)),
    // `currentDirectory` is fixed at "" (repo root): every path this module
    // hands the compiler is already rooted at "/", so there is no second,
    // independent notion of "current directory" to thread through.
    readDirectory: (rootDir, extensions, excludes, includes, depth) =>
      matchFiles(
        rootDir,
        extensions,
        excludes,
        includes,
        /* useCaseSensitiveFileNames */ true,
        /* currentDirectory */ "",
        depth,
        (dir) => directoryIndex.get(stripLeadingSlash(dir)) ?? EMPTY_ENTRIES,
        /* realpath */ (path) => path,
      ),
  };
}

// ---------------------------------------------------------------------------
// Extends-chain failure, recognised by code rather than by message text
// ---------------------------------------------------------------------------

/**
 * See the module comment. Recorded as codes, not message strings, because a
 * diagnostic's rendered text is compiler-version prose and this check needs
 * to survive a `typescript` upgrade; the codes are the compiler's own stable
 * vocabulary for "what went wrong", which is exactly the granularity this
 * function needs and no finer.
 */
const EXTENDS_FAILURE_CODES = new Set<number>([
  5083, // Cannot_read_file_0 — a ".json"-suffixed extends target that isn't there
  6053, // File_0_not_found — an extends target the resolver never located
  18000, // Circularity_detected_while_resolving_configuration
]);

const COMPLETE_EMPTY_MEMBERSHIP_CODES = new Set<number>([
  18002, // The files list in config file is empty
  18003, // No inputs were found in config file
]);

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function referencesAreValid(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry) => isRecord(entry) && typeof entry["path"] === "string",
      ))
  );
}

type FactCompleteness = NonNullable<ProjectConfigFact["coverage"]>;

function classifyConfigDiagnostics(
  config: unknown,
  errors: readonly ts.Diagnostic[],
): FactCompleteness | undefined {
  if (errors.length === 0) return undefined;

  const record = isRecord(config) ? config : {};
  const membershipSelectorInvalid =
    (record["files"] !== undefined && !isStringArray(record["files"])) ||
    (record["include"] !== undefined && !isStringArray(record["include"])) ||
    (record["exclude"] !== undefined && !isStringArray(record["exclude"]));
  const referenceSelectorInvalid = !referencesAreValid(record["references"]);
  const rawCompilerOptions = record["compilerOptions"];
  const compilerOptionsShapeInvalid =
    rawCompilerOptions !== undefined && !isRecord(rawCompilerOptions);
  const compilerOptionDiagnosticCodes = new Set(
    isRecord(rawCompilerOptions)
      ? ts
          .convertCompilerOptionsFromJson(rawCompilerOptions, "")
          .errors.map((diagnostic) => diagnostic.code)
      : [],
  );
  const compilerOptionsInvalid =
    compilerOptionsShapeInvalid || compilerOptionDiagnosticCodes.size > 0;
  const extendsBroken = errors.some((diagnostic) =>
    EXTENDS_FAILURE_CODES.has(diagnostic.code),
  );
  const hasExplicitMembershipSelector =
    isStringArray(record["files"]) || isStringArray(record["include"]);

  let membership: FactCompleteness["membership"] = membershipSelectorInvalid
    ? "unusable"
    : extendsBroken && !hasExplicitMembershipSelector
      ? "incomplete"
      : "complete";
  let optionInheritance: FactCompleteness["optionInheritance"] =
    extendsBroken || compilerOptionsInvalid ? "incomplete" : "complete";
  let referenceDiscovery: FactCompleteness["referenceDiscovery"] =
    referenceSelectorInvalid ? "incomplete" : "complete";
  const reasons: string[] = [];

  if (membershipSelectorInvalid) reasons.push("membership_selector_invalid");
  if (extendsBroken) reasons.push("extends_unresolvable");
  if (compilerOptionsInvalid) reasons.push("compiler_options_invalid");
  if (referenceSelectorInvalid) reasons.push("references_invalid");

  const knownShapeFailure =
    membershipSelectorInvalid || referenceSelectorInvalid;
  const unknownCodes = errors
    .filter(
      (diagnostic) =>
        !EXTENDS_FAILURE_CODES.has(diagnostic.code) &&
        !COMPLETE_EMPTY_MEMBERSHIP_CODES.has(diagnostic.code) &&
        !(diagnostic.code === 5024 && knownShapeFailure) &&
        !compilerOptionDiagnosticCodes.has(diagnostic.code) &&
        !(diagnostic.code === 5024 && compilerOptionsShapeInvalid),
    )
    .map((diagnostic) => diagnostic.code);
  if (unknownCodes.length > 0) {
    membership = "unusable";
    optionInheritance = "incomplete";
    referenceDiscovery = "incomplete";
    reasons.push(
      `unknown_config_diagnostic:${sortedUnique(unknownCodes.map(String)).join(",")}`,
    );
  }

  if (
    membership === "complete" &&
    optionInheritance === "complete" &&
    referenceDiscovery === "complete"
  ) {
    return undefined;
  }

  return { membership, optionInheritance, referenceDiscovery, reasons };
}

/**
 * Where the project's OWN `extends` points, resolved one hop.
 *
 * Re-derives the target with the same relative-path arithmetic
 * `getExtendsConfigPath` uses internally (a `./` or `../` prefix required, a
 * `.json` fallback, existence checked against the same snapshot the host
 * gave the compiler) rather than reading it back out of `parsed.raw`,
 * because `raw.files`/`include`/`exclude` get backfilled from the base when
 * the child config omits them but `raw.extends` does not — relying on that
 * asymmetry holding across compiler versions would be a needless dependency
 * when recomputation is this cheap. This is path joining, not glob matching,
 * so it is not the thing rule 1 forbids reimplementing.
 *
 * Only called once extends resolution is already known to have succeeded (no
 * {@link EXTENDS_FAILURE_CODES} in `parsed.errors`), so a mismatch here would
 * mean this mirror disagrees with the compiler — treated as "cannot
 * establish" rather than guessed at.
 */
function resolveExtendsTarget(
  snapshot: RevisionSnapshot,
  configDir: string,
  rawExtends: string | undefined,
): string | undefined {
  if (rawExtends === undefined) return undefined;
  if (!(rawExtends.startsWith("./") || rawExtends.startsWith("../"))) {
    // A bare specifier resolves through node_modules, which this snapshot
    // does not model — out of scope, mirroring resolveSpecifier's identical
    // choice for module specifiers in build.ts.
    return undefined;
  }
  const joined = joinRelative(configDir, rawExtends);
  const candidate =
    snapshot.has(joined) || joined.endsWith(".json")
      ? joined
      : `${joined}.json`;
  return snapshot.has(candidate) ? candidate : undefined;
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

function unavailableFact(
  configPath: string,
  failure: GovernanceFailure,
  detail: string,
  revision: string,
): ProjectConfigFact {
  return {
    configPath,
    availability: { kind: "unavailable", failure, detail },
    admittedFiles: [],
    namedInFiles: [],
    referencedProjects: [],
    provenance: {
      source: "typescript_syntax",
      path: configPath,
      startLine: 1,
      endLine: 1,
      extractorVersion: EXTRACTOR_VERSION,
      revision,
    },
  };
}

function readOneConfig(
  snapshot: RevisionSnapshot,
  host: ts.ParseConfigHost,
  configPath: string,
  revision: string,
): ProjectConfigFact {
  const cleanPath = stripLeadingSlash(configPath);

  // Checked directly against the snapshot rather than inferred from a
  // compiler diagnostic: "the file is not here" is a fact this module can
  // establish itself, exactly, without asking the compiler to explain its
  // own read failure.
  if (!snapshot.has(cleanPath)) {
    return unavailableFact(
      cleanPath,
      "config_absent",
      `${cleanPath} is not present in the revision snapshot`,
      revision,
    );
  }

  const rooted = toRooted(cleanPath);
  const readResult = ts.readConfigFile(rooted, (path) =>
    snapshot.get(stripLeadingSlash(path)),
  );
  if (readResult.error !== undefined || readResult.config === undefined) {
    return unavailableFact(
      cleanPath,
      "config_unparsable",
      `${cleanPath} does not parse as JSON`,
      revision,
    );
  }

  const config: unknown = readResult.config;
  const rawExtends = isRecord(config)
    ? firstString(config["extends"])
    : undefined;
  const rawFiles = isRecord(config) ? config["files"] : undefined;

  const configDir = dirnameOf(cleanPath);
  const basePath = toRooted(configDir);
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    host,
    basePath,
    undefined,
    rooted,
  );

  const coverage = classifyConfigDiagnostics(config, parsed.errors);
  const admittedFiles =
    coverage?.membership === "unusable"
      ? []
      : sortedUnique(parsed.fileNames.map(stripLeadingSlash));

  const namedInFiles = sortedUnique(
    (Array.isArray(rawFiles) ? rawFiles : [])
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => joinRelative(configDir, entry)),
  );

  const extendsPath = resolveExtendsTarget(snapshot, configDir, rawExtends);

  const referencedProjects = sortedUnique(
    (parsed.projectReferences ?? []).map((reference) =>
      stripLeadingSlash(ts.resolveProjectReferencePath(reference)),
    ),
  );

  return {
    configPath: cleanPath,
    availability: { kind: "available" },
    admittedFiles,
    namedInFiles,
    ...(extendsPath === undefined ? {} : { extendsPath }),
    referencedProjects,
    ...(coverage === undefined ? {} : { coverage }),
    provenance: {
      source: "typescript_syntax",
      path: cleanPath,
      startLine: 1,
      endLine: 1,
      extractorVersion: EXTRACTOR_VERSION,
      revision,
    },
  };
}

/**
 * One {@link ProjectConfigFact} per config path, each independent: a
 * malformed config at index 3 cannot make index 0's answer disappear. Which
 * config paths exist is Agent A's job; which source files each admitted
 * project actually governs is Agent C's — this function only asks the
 * compiler what a given config, taken alone, admits.
 */
export function readProjectConfigs(
  snapshot: RevisionSnapshot,
  configPaths: readonly string[],
  revision: string,
): readonly ProjectConfigFact[] {
  const directoryIndex = buildDirectoryIndex(snapshot);
  const host = createParseConfigHost(snapshot, directoryIndex);
  return configPaths.map((configPath) =>
    readOneConfig(snapshot, host, configPath, revision),
  );
}
