/**
 * P1-M.3 — compiling a base-shaped consumer against two revisions.
 *
 * Shared by `removed_export` and `required_parameter_added`. It answers one
 * question for both:
 *
 * > Can a consumer usage proven valid against BASE still compile against HEAD?
 *
 * # Why the BASE compile is mandatory and not a sanity check
 *
 * A probe that never compiled anywhere also fails against HEAD. Without the
 * BASE step, a malformed probe "verifies" every change that has ever been
 * made, and the verifier becomes a generator of findings rather than a test of
 * them. So the premise is established first, and a probe BASE rejects yields
 * `inconclusive` — a statement about our probe, not about the author's change.
 *
 * # Probe-local diagnostics only
 *
 * HEAD may carry unrelated errors. Counting diagnostics, or comparing counts
 * between revisions, would report those as compatibility breaks. Only
 * diagnostics whose span falls inside the synthetic probe file and whose code
 * is one this capability recognises can establish anything.
 */

import ts from "typescript";

/** Where the synthetic consumer is written. Never a real repository path. */
export const PROBE_BASENAME = "__acalys_compat_probe__";

export interface ProbeOutcome {
  readonly compiled: boolean;
  /** Recognised, probe-local diagnostics, in source order. */
  readonly relevant: readonly ts.Diagnostic[];
  /** Every probe-local diagnostic, recognised or not. */
  readonly probeLocal: readonly ts.Diagnostic[];
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
  };
}

/**
 * The module specifier a consumer sitting beside the boundary would write.
 *
 * Extension-less on purpose: the probe is compiled under bundler resolution,
 * and the point is to resolve the same module a consumer would, not to
 * reproduce a particular project's import style.
 */
export function specifierFor(boundaryPath: string): string {
  const base = boundaryPath.replace(/\.[cm]?tsx?$/, "");
  const parts = base.split("/");
  return `./${parts[parts.length - 1] ?? base}`;
}

/** The probe's path: beside the boundary, so the specifier stays relative. */
export function probePathFor(boundaryPath: string): string {
  const parts = boundaryPath.split("/");
  parts[parts.length - 1] = `${PROBE_BASENAME}.ts`;
  return parts.join("/");
}

/**
 * Compiles `probeSource` against one revision's files.
 *
 * `noResolve` is deliberately NOT set. M.2's verifier could set it because it
 * asked about one file's own semantics; this one asks whether an import
 * resolves, and a program that resolves nothing answers that question `no`
 * every time — which would verify every candidate ever formed.
 */
export function compileProbe(options: {
  readonly files: ReadonlyMap<string, string>;
  readonly boundaryPath: string;
  readonly probeSource: string;
  readonly recognisedCodes: ReadonlySet<number>;
}): ProbeOutcome {
  const probePath = probePathFor(options.boundaryPath);
  const files = new Map(options.files);
  files.set(probePath, options.probeSource);

  const program = ts.createProgram({
    rootNames: [probePath],
    options: {
      noLib: true,
      strict: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      // Declarations the probe never mentions are irrelevant to it, and
      // emitting would need a filesystem this host does not have.
      noEmit: true,
    },
    host: hostOver(files),
  });

  const source = program.getSourceFile(probePath);
  if (source === undefined) {
    return { compiled: false, relevant: [], probeLocal: [] };
  }

  // Scoped to the probe's own source file. A diagnostic reported inside the
  // author's code is not evidence about a synthetic consumer, however
  // suggestive its message.
  const probeLocal = [
    ...program.getSemanticDiagnostics(source),
    ...program.getSyntacticDiagnostics(source),
  ].filter((diagnostic) => diagnostic.file?.fileName === probePath);

  return {
    compiled: probeLocal.length === 0,
    relevant: probeLocal.filter((diagnostic) =>
      options.recognisedCodes.has(diagnostic.code),
    ),
    probeLocal,
  };
}

export type ComparisonVerdict =
  | { readonly kind: "verified"; readonly detail: string }
  | { readonly kind: "rejected"; readonly detail: string }
  | { readonly kind: "inconclusive"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * The differential adjudication both capabilities share.
 *
 * The order of the checks is the contract. BASE validity is established before
 * HEAD is looked at, so there is no path on which a HEAD diagnostic can be
 * reported without a demonstrated premise.
 */
export function adjudicateComparison(options: {
  readonly baseFiles: ReadonlyMap<string, string>;
  readonly headFiles: ReadonlyMap<string, string>;
  readonly boundaryPath: string;
  readonly probeSource: string;
  readonly recognisedCodes: ReadonlySet<number>;
  readonly describe: (diagnostic: ts.Diagnostic) => string;
}): ComparisonVerdict {
  // The boundary must exist at HEAD before a missing export can mean anything.
  //
  // A boundary absent from the head snapshot is ambiguous between "the module
  // was deleted" and "the verifier was never given it", and those demand
  // opposite conclusions. Reporting the first would convert an incomplete
  // snapshot into a published finding, so the ambiguity is refused instead.
  if (!options.headFiles.has(options.boundaryPath)) {
    return {
      kind: "inconclusive",
      detail: `the boundary ${options.boundaryPath} is not present in the head snapshot, which cannot be distinguished from a snapshot that omitted it`,
    };
  }
  if (!options.baseFiles.has(options.boundaryPath)) {
    return {
      kind: "inconclusive",
      detail: `the boundary ${options.boundaryPath} is not present in the base snapshot`,
    };
  }

  const base = compileProbe({
    files: options.baseFiles,
    boundaryPath: options.boundaryPath,
    probeSource: options.probeSource,
    recognisedCodes: options.recognisedCodes,
  });

  if (!base.compiled) {
    return {
      kind: "inconclusive",
      detail:
        "the synthetic consumer is not valid against the base revision, so no regression can be attributed to the change" +
        (base.probeLocal[0] === undefined
          ? ""
          : ` (${options.describe(base.probeLocal[0])})`),
    };
  }

  const head = compileProbe({
    files: options.headFiles,
    boundaryPath: options.boundaryPath,
    probeSource: options.probeSource,
    recognisedCodes: options.recognisedCodes,
  });

  if (head.relevant.length > 0) {
    return {
      kind: "verified",
      detail: `a consumer valid against the base revision no longer compiles: ${options.describe(head.relevant[0]!)}`,
    };
  }

  return {
    kind: "rejected",
    detail:
      "the same consumer still compiles against the head revision, so the public contract it depends on survived",
  };
}
