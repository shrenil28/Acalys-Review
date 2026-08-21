/**
 * P1-M.2's verifier — the compiler's own answer, obtained independently.
 *
 * The analyzer hypothesised that a write of `undefined` into an optional
 * property is illegal under the governing project. It reached that from syntax
 * and a configuration value, and it is allowed to be wrong. This settles it by
 * building the project and asking TypeScript.
 *
 * # Three outcomes, and the middle one is not abstention
 *
 * ```
 * faithful program + relevant diagnostic present   VERIFIED
 * faithful program + relevant diagnostic ABSENT    REJECTED
 * faithful program cannot be built                 INCONCLUSIVE
 * ```
 *
 * The second row is the independent refutation path, and collapsing it into
 * abstention would be the quiet failure that matters most here: every
 * refutation would become "we could not tell", and the analyzer's hypothesis
 * would never be contradicted by anything. A verifier that can only agree is
 * not a verifier.
 *
 * That case is real rather than theoretical. `value?: Maybe<string>` where
 * `Maybe<T> = T | undefined` is syntactically identical to the defect — an
 * optional property assigned `undefined` under an enabled option — and
 * TypeScript affirmatively reports nothing, because `undefined` is part of the
 * declared type.
 *
 * # Why the program is built from the project, not from the options
 *
 * ```
 * WRONG   ts.createProgram([changedFile], governingCompilerOptions)
 * RIGHT   parse the config, take its options AND its file set, over the
 *         revision's bytes
 * ```
 *
 * A `Program` is the project — its roots, its resolution, its libs. Copying
 * `compilerOptions` onto an arbitrary single-file program yields diagnostics
 * about a project that does not exist, and those diagnostics would be evidence
 * for a claim nobody made.
 *
 * The bytes come from the verification context, which is what the planner
 * selected for *this revision*. A verifier reading the working tree while
 * adjudicating a claim about a specific head SHA would manufacture evidence
 * from the wrong revision — the failure L.1 made structurally impossible for
 * the index, and which must not reappear one layer up.
 */

import ts from "typescript";
import type { VerificationContext } from "./decide.js";

/**
 * The diagnostic TypeScript emits for this violation.
 *
 * Established by running the compiler, not by reading documentation: TS2412 is
 * what 5.9.3 produces for a write of `undefined` into an optional property
 * under `exactOptionalPropertyTypes`. Matching on the code rather than the
 * message text is deliberate — messages are localized and get reworded between
 * releases, so prose matching would silently stop verifying anything.
 */
export const EXACT_OPTIONAL_DIAGNOSTIC_CODE = 2412;

export type ExactOptionalOutcome =
  | { readonly kind: "verified"; readonly detail: string }
  | { readonly kind: "rejected"; readonly detail: string }
  | { readonly kind: "inconclusive"; readonly detail: string };

export interface ExactOptionalQuery {
  /** The changed file the claim is about. */
  readonly path: string;
  /** 1-based, inclusive — the candidate's semantic region. */
  readonly startLine: number;
  readonly endLine: number;
  /** Config paths the analyzer said govern this file. */
  readonly configPaths: readonly string[];
}

const isConfigPath = (path: string): boolean =>
  /tsconfig[\w.-]*\.json$/.test(path);

/**
 * Builds a compiler host over the revision's bytes and nothing else.
 *
 * `fileExists` and `readFile` are closed over the context, so the program
 * physically cannot reach the working tree. That is the property that makes
 * this evidence about the revision under review rather than about whatever is
 * checked out.
 */
function compilerHostOver(files: ReadonlyMap<string, string>): ts.CompilerHost {
  return {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const content = files.get(fileName);
      return content === undefined
        ? undefined
        : ts.createSourceFile(fileName, content, languageVersion, true);
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
}

/**
 * The config-parsing half, kept separate.
 *
 * `CompilerHost` declares `useCaseSensitiveFileNames` as a method and
 * `ParseConfigHost` declares it as a boolean. An intersection of the two is
 * uninhabitable without lying to the type system, and a cast there would leave
 * the next reader unable to tell which contract is real. Two objects over one
 * map is the honest shape and costs nothing.
 */
function parseConfigHostOver(
  files: ReadonlyMap<string, string>,
): ts.ParseConfigHost {
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    // The project's file set comes from `files`/`include` expansion, and this
    // verifier is given exactly the sources the planner selected. Returning
    // nothing here means `include` globs contribute no files, so a project is
    // reproduced from its explicit `files` list plus the changed path — which
    // is why `rootNames` below adds that path rather than trusting expansion.
    readDirectory: () => [],
  };
}

/**
 * Asks the compiler whether the claimed violation is real.
 *
 * Returns `inconclusive` rather than guessing whenever the project cannot be
 * faithfully reproduced — a missing config, an unparsable one, or a source the
 * planner did not supply. Each of those means the semantic environment is not
 * the governing one, and a diagnostic obtained from a different environment is
 * evidence about a different question.
 */
export function verifyExactOptionalWrite(
  query: ExactOptionalQuery,
  context: VerificationContext,
): ExactOptionalOutcome {
  const files = new Map(context.items.map((item) => [item.path, item.content]));

  if (!files.has(query.path)) {
    return {
      kind: "inconclusive",
      detail: `${query.path} is not in the verifier's context, so the governing program cannot include it`,
    };
  }

  const configPaths = query.configPaths.filter(
    (path) => isConfigPath(path) && files.has(path),
  );
  if (configPaths.length === 0) {
    return {
      kind: "inconclusive",
      detail:
        "no governing configuration was supplied, so the project's effective options are unknown",
    };
  }

  const compilerHost = compilerHostOver(files);
  const configHost = parseConfigHostOver(files);
  let sawFaithfulProgram = false;

  for (const configPath of [...configPaths].sort()) {
    const raw = files.get(configPath);
    if (raw === undefined) continue;

    const parsedText = ts.parseConfigFileTextToJson(configPath, raw);
    if (parsedText.error !== undefined || parsedText.config === undefined) {
      // An unparsable config cannot tell us what it admits or enables. Not a
      // refutation — the absence of an answer, which is a different fact.
      continue;
    }

    const parsed = ts.parseJsonConfigFileContent(
      parsedText.config,
      configHost,
      "/",
      undefined,
      configPath,
    );

    // The project's OWN file set, plus the file under review. Without the
    // former this would not be the governing project; without the latter the
    // diagnostic could not exist at all.
    const rootNames = [
      ...new Set([...parsed.fileNames, query.path].filter((f) => files.has(f))),
    ].sort();

    const program = ts.createProgram({
      rootNames,
      options: {
        ...parsed.options,
        // The context holds repository sources, never `lib.d.ts`. Without
        // these the program reports thousands of missing-global errors and
        // buries the one diagnostic being asked about.
        noLib: true,
        noResolve: true,
      },
      host: compilerHost,
    });

    const source = program.getSourceFile(query.path);
    if (source === undefined) continue;
    sawFaithfulProgram = true;

    const relevant = program
      .getSemanticDiagnostics(source)
      .filter(
        (diagnostic) => diagnostic.code === EXACT_OPTIONAL_DIAGNOSTIC_CODE,
      )
      .filter((diagnostic) => overlapsClaim(diagnostic, source, query));

    if (relevant.length > 0) {
      return {
        kind: "verified",
        detail: `TS${String(EXACT_OPTIONAL_DIAGNOSTIC_CODE)} reported under ${configPath} within the claimed region`,
      };
    }
  }

  if (!sawFaithfulProgram) {
    return {
      kind: "inconclusive",
      detail:
        "no governing configuration could be parsed into a program containing the changed file",
    };
  }

  // The environment was reproduced and the compiler found nothing. That is a
  // refutation of the analyzer's hypothesis, and it is reported as one.
  return {
    kind: "rejected",
    detail: `no TS${String(EXACT_OPTIONAL_DIAGNOSTIC_CODE)} in the claimed region under any governing project`,
  };
}

/**
 * Whether a diagnostic falls inside the claimed region.
 *
 * Overlap, not equality. TypeScript anchors this error on the assignment's
 * right-hand side — measured at nine characters for `undefined`, not the whole
 * statement — so requiring the spans to match would reject a correct detection.
 * The supported shape is a single-line property write, which is why "the lines
 * intersect" can be stated exactly rather than approximated.
 */
function overlapsClaim(
  diagnostic: ts.Diagnostic,
  source: ts.SourceFile,
  query: ExactOptionalQuery,
): boolean {
  if (diagnostic.start === undefined) return false;
  const start = source.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
  const end =
    source.getLineAndCharacterOfPosition(
      diagnostic.start + (diagnostic.length ?? 0),
    ).line + 1;
  return start <= query.endLine && end >= query.startLine;
}
