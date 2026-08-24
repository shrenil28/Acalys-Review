/**
 * P1-M.3.6 — can an external consumer still import through this boundary?
 *
 * The predecessor asked a different question and got a confident wrong answer.
 * Its probe imports `./codec`, which asks whether another source file can still
 * reach `codec.ts`. When a manifest withdraws `./codec` from its exports map,
 * that file is byte-identical and still exports the name, so the probe compiles
 * and the verifier reports "still reachable" about a boundary that no longer
 * exists.
 *
 * ```
 * relative probe    import { decode } from "./codec";    bypasses the manifest
 * consumer probe    import { decode } from "pkg/codec";  goes through it
 * ```
 *
 * # The premise that makes the diagnostic mean anything
 *
 * Observed against the pinned compiler before this was written:
 *
 * ```
 * subpath exported        compiles
 * subpath withdrawn       TS2307  Cannot find module 'pkg/codec'
 * no exports map at all   TS2307  Cannot find module 'pkg/codec'
 * ```
 *
 * The third line is the whole reason `BASE must resolve` is mandatory. An
 * unfaithfully reconstructed package produces the *same* diagnostic as a
 * genuine withdrawal, so TS2307 on its own proves nothing — it proves a
 * withdrawal only once the identical consumer has been shown to resolve
 * against BASE.
 *
 * M.3.4 still refuses TS2307, and correctly: there the probe is relative and
 * these premises do not exist. One code, two meanings, separated by evidence.
 *
 * # What this is not allowed to trust
 *
 * The boundary fact may say *which specifier to try*. It may never say whether
 * that specifier resolves. A verifier shaped like `surface says absent ->
 * verified` would be the analyzer's opinion consulted twice, and an
 * independence witness exists to make that shape fail.
 */

import ts from "typescript";
import type { ComparisonVerdict } from "./compatibility-probe.js";

export interface ConsumerBoundaryQuery {
  /** What a consumer writes, e.g. `pkg/codec`. */
  readonly consumerSpecifier: string;
  readonly exportName: string;
  readonly namespace: "value" | "type";
  /** The package's own root, e.g. `` or `packages/codec`. */
  readonly packageRoot: string;
  readonly packageName: string;
}

const PROBE = "acalys-consumer/probe.ts";

/**
 * Lays the revision out as a consumer would see it.
 *
 * The package's files move under `node_modules/<name>/` and the probe sits
 * outside it. Placing the probe inside the package and importing relatively
 * would resolve without consulting the manifest at all, which is the defect
 * this capability exists to repair.
 */
function consumerLayout(
  files: ReadonlyMap<string, string>,
  query: ConsumerBoundaryQuery,
  probeSource: string,
): ReadonlyMap<string, string> {
  const laid = new Map<string, string>([[PROBE, probeSource]]);
  const prefix = query.packageRoot === "" ? "" : `${query.packageRoot}/`;

  for (const [path, content] of files) {
    if (prefix !== "" && !path.startsWith(prefix)) continue;
    const relative = prefix === "" ? path : path.slice(prefix.length);
    laid.set(`node_modules/${query.packageName}/${relative}`, content);
  }

  return laid;
}

function hostOver(files: ReadonlyMap<string, string>): ts.CompilerHost {
  const strip = (name: string): string => name.replace(/^\.?\/+/, "");
  return {
    fileExists: (name) => files.has(strip(name)),
    readFile: (name) => files.get(strip(name)),
    getSourceFile: (name, languageVersion) => {
      const content = files.get(strip(name));
      return content === undefined
        ? undefined
        : ts.createSourceFile(name, content, languageVersion, true);
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    directoryExists: (directory) => {
      const prefix = `${strip(directory)}/`;
      return [...files.keys()].some((path) => path.startsWith(prefix));
    },
    realpath: (name) => name,
  };
}

interface ProbeOutcome {
  readonly resolved: boolean;
  readonly codes: readonly number[];
}

/** Compiles the consumer against one revision, laid out as a package. */
function compileConsumer(
  files: ReadonlyMap<string, string>,
  query: ConsumerBoundaryQuery,
  probeSource: string,
): ProbeOutcome {
  const laid = consumerLayout(files, query, probeSource);
  const program = ts.createProgram({
    rootNames: [PROBE],
    options: {
      noLib: true,
      strict: true,
      // NodeNext is what makes the exports map participate at all. Under
      // Bundler or Node10 the subpath would resolve by file path and the
      // manifest would again be irrelevant.
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
    },
    host: hostOver(laid),
  });

  const source = program.getSourceFile(PROBE);
  if (source === undefined) return { resolved: false, codes: [] };

  const diagnostics = [
    ...program.getSemanticDiagnostics(source),
    ...program.getSyntacticDiagnostics(source),
  ].filter((diagnostic) => diagnostic.file?.fileName === PROBE);

  return {
    resolved: diagnostics.length === 0,
    codes: [...new Set(diagnostics.map((diagnostic) => diagnostic.code))].sort(
      (left, right) => left - right,
    ),
  };
}

/** Cannot find module — the consumer-boundary failure, under premises. */
const MODULE_NOT_FOUND = 2307;

export function verifyConsumerBoundary(
  query: ConsumerBoundaryQuery,
  revisions: {
    readonly baseFiles: ReadonlyMap<string, string>;
    readonly headFiles: ReadonlyMap<string, string>;
  },
): ComparisonVerdict {
  const probeSource =
    query.namespace === "type"
      ? [
          `import type { ${query.exportName} } from "${query.consumerSpecifier}";`,
          `type __AcalysProbe = ${query.exportName};`,
          "export type { __AcalysProbe };",
          "",
        ].join("\n")
      : [
          `import { ${query.exportName} } from "${query.consumerSpecifier}";`,
          `void ${query.exportName};`,
          "",
        ].join("\n");

  const base = compileConsumer(revisions.baseFiles, query, probeSource);

  // Mandatory. A package we could not reconstruct fails identically to one
  // that withdrew the subpath, so without this the HEAD diagnostic is
  // uninterpretable.
  if (!base.resolved) {
    return {
      kind: "inconclusive",
      detail:
        `a consumer importing \`${query.exportName}\` from \`${query.consumerSpecifier}\` does not compile ` +
        `against the base revision (${base.codes.map((code) => `TS${String(code)}`).join(", ") || "no diagnostic"}), ` +
        "so the head result cannot be attributed to this change",
    };
  }

  const head = compileConsumer(revisions.headFiles, query, probeSource);

  if (head.resolved) {
    return {
      kind: "rejected",
      detail: `the same consumer still imports \`${query.exportName}\` from \`${query.consumerSpecifier}\` at head`,
    };
  }

  if (!head.codes.includes(MODULE_NOT_FOUND)) {
    // It failed for some other reason. Reporting a boundary withdrawal on
    // that basis would attribute an unrelated breakage to this change.
    return {
      kind: "inconclusive",
      detail:
        `the head consumer failed with ${head.codes.map((code) => `TS${String(code)}`).join(", ")}, ` +
        "which is not the boundary-resolution failure this capability claims",
    };
  }

  return {
    kind: "verified",
    detail:
      `a consumer importing \`${query.exportName}\` from \`${query.consumerSpecifier}\` compiles against the ` +
      "base revision and cannot resolve that specifier at head",
  };
}
