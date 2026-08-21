/**
 * P1-M.2 — writing `undefined` into an optional property, under a project
 * that forbids it.
 *
 * ```ts
 * interface Entry { tag?: string }
 * entry.tag = undefined;        // an error when exactOptionalPropertyTypes is on
 * ```
 *
 * The defect is invisible without the configuration. The same line is correct
 * in one project and wrong in another, which is why this family is called
 * configuration-sensitive and why it was the first thing P1-L.5's analyzer set
 * could not see: nothing in it consulted a governing compiler option.
 *
 * # What this analyzer is allowed to know
 *
 * Changed syntax, and the effective options of the projects that govern the
 * changed file. Nothing else. In particular:
 *
 * ```
 * FORBIDDEN: semantic diagnostics, a TypeScript Program, the type checker
 * ```
 *
 * That prohibition is the whole architecture. Asking the compiler "is this
 * wrong?" is the *verifier's* procedure, and an analyzer that did it would
 * make two independent stages one opinion consulted twice — leaving the funnel
 * with a verifier that can only ever agree. The hypothesis here is deliberately
 * cheap and deliberately fallible; being contradicted is the point.
 *
 * # Why a syntactic optionality check is correct rather than sloppy
 *
 * `isOptionalProperty` reads `tag?: string` out of a visible declaration. It
 * cannot see through generics, mapped types, or a declaration the planner did
 * not select, and it does not try. A hypothesis that is sometimes wrong is
 * exactly what a verifier exists to settle; a hypothesis that is *never* wrong
 * would mean the analyzer had already done the verifier's work.
 *
 * The failure mode this creates is a candidate the compiler refutes, which
 * costs a verification and publishes nothing. The opposite failure mode —
 * teaching the analyzer to be certain — costs the independence.
 */

import ts from "typescript";
import type { AnalysisResult, CandidateFinding } from "../finding.js";
import type { AsyncAnalyzerInput } from "./async-completion.js";

export const EXACT_OPTIONAL_WRITE_RULE_ID =
  "acalys.correctness/exact-optional-property-write";

/** The compiler option that makes the write illegal. */
const RELEVANT_OPTION = "exactOptionalPropertyTypes";

/**
 * A project that governs the changed file and enables the semantics.
 *
 * Project-scoped rather than singular because governance is plural (L.4.2). A
 * file admitted by two projects is genuinely governed by both, and the claim
 * this analyzer makes is scoped to the ones that actually enable the option.
 */
interface GoverningProject {
  readonly configPath: string;
  readonly governsPath: string;
}

/**
 * Reads `exactOptionalPropertyTypes` out of a selected configuration item.
 *
 * `JSON.parse` after stripping comments rather than `ts.parseJsonText`: this
 * is a *syntactic* read of a value the planner already selected, and reaching
 * for the compiler's config machinery here would start the analyzer down the
 * path of reproducing the project — which is the verifier's job and the thing
 * correction 3 of the M.2 contract exists to prevent.
 *
 * A config this cannot parse yields no governing project, so the analyzer
 * abstains rather than guessing the option is on.
 */
function enablesExactOptional(content: string): boolean {
  try {
    const withoutComments = content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const parsed: unknown = JSON.parse(withoutComments);
    if (parsed === null || typeof parsed !== "object") return false;
    const options = (parsed as { readonly compilerOptions?: unknown })
      .compilerOptions;
    if (options === null || typeof options !== "object") return false;
    return (options as Record<string, unknown>)[RELEVANT_OPTION] === true;
  } catch {
    return false;
  }
}

/**
 * The projects that govern a path and enable the option.
 *
 * The planner emits one `configuration` item per governing project, with a
 * citation naming which source it governs. Both halves matter: an item for a
 * project that governs a *different* file says nothing about this one.
 */
function governingProjects(
  input: AsyncAnalyzerInput,
  sourcePath: string,
): readonly GoverningProject[] {
  const found: GoverningProject[] = [];

  for (const item of input.context.items) {
    if (item.kind !== "configuration") continue;
    const provenance = item.provenance;
    if (provenance?.source !== "configuration_facts") continue;
    if (!provenance.citation.includes(`governs ${sourcePath}`)) continue;
    if (!enablesExactOptional(item.suppliedContent)) continue;

    found.push({ configPath: item.path, governsPath: sourcePath });
  }

  return found.sort((left, right) =>
    left.configPath < right.configPath
      ? -1
      : left.configPath > right.configPath
        ? 1
        : 0,
  );
}

/** Every property declared optional in this source, by name. */
function optionalPropertyNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      node.questionToken !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return names;
}

/** A write of the `undefined` literal into a property access. */
interface UndefinedWrite {
  readonly propertyName: string;
  readonly line: number;
  readonly text: string;
}

function undefinedWrites(source: ts.SourceFile): readonly UndefinedWrite[] {
  const writes: UndefinedWrite[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.name) &&
      // An Identifier named `undefined`, NOT `ts.SyntaxKind.UndefinedKeyword`.
      // That keyword only appears in type position; in an expression
      // `undefined` is an ordinary identifier reference. Matching the keyword
      // here found nothing at all, silently, which is the failure mode of
      // guessing an AST shape instead of measuring it.
      ts.isIdentifier(node.right) &&
      node.right.text === "undefined"
    ) {
      writes.push({
        propertyName: node.left.name.text,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        text: node.getText(source),
      });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return writes;
}

/**
 * Forms candidates for exact-optional property writes.
 *
 * Produces nothing at all when no governing project enables the option —
 * including when governance could not be established. The planner only emits a
 * `configuration` item for a project L.4.2 positively determined to govern the
 * file, so "no item" already means "no established governance", and inventing
 * a hypothesis from its absence would be reasoning from our own failure to
 * look.
 */
export function analyzeExactOptionalWrite(
  input: AsyncAnalyzerInput,
): AnalysisResult {
  const findings: CandidateFinding[] = [];
  const clusterId = input.clusterId ?? "cluster:unscoped";
  const subjectByPath = new Map(
    input.subject.map((entry) => [entry.path, new Set(entry.changedLines)]),
  );

  for (const item of input.context.items) {
    const changedLines = subjectByPath.get(item.path);
    if (changedLines === undefined) continue;
    if (item.representation !== "full") continue;
    if (item.kind === "instruction" || item.kind === "configuration") continue;
    if (!/\.[cm]?tsx?$/.test(item.path)) continue;

    const projects = governingProjects(input, item.path);
    if (projects.length === 0) continue;

    const source = ts.createSourceFile(
      item.path,
      item.suppliedContent,
      ts.ScriptTarget.ES2022,
      true,
      item.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const optional = optionalPropertyNames(source);

    for (const write of undefinedWrites(source)) {
      if (!changedLines.has(write.line)) continue;
      if (!optional.has(write.propertyName)) continue;

      // Several governing projects enabling the semantics produce ONE
      // candidate. Publishing the same defect once per tsconfig that admits
      // the file would be a precision failure wearing the costume of
      // thoroughness.
      findings.push(candidateFor(item.path, write, projects, clusterId));
    }
  }

  return { findings, suppressions: [], degradations: [] };
}

function candidateFor(
  path: string,
  write: UndefinedWrite,
  projects: readonly GoverningProject[],
  clusterId: string,
): CandidateFinding {
  const location = {
    path,
    startLine: write.line,
    endLine: write.line,
  };
  const scope = projects.map((project) => project.configPath).join(", ");

  return {
    ruleId: EXACT_OPTIONAL_WRITE_RULE_ID,
    category: "correctness",
    family: "nullability",
    claim:
      `Writing \`undefined\` to the optional property \`${write.propertyName}\` ` +
      `is rejected under ${RELEVANT_OPTION}, which is enabled by ${scope}.`,
    causal: {
      anchor: location,
      steps: [
        `\`${write.propertyName}\` is declared optional, so its type does not include \`undefined\` unless written explicitly.`,
        `${scope} enables ${RELEVANT_OPTION}, which distinguishes an absent property from one present and \`undefined\`.`,
        `\`${write.text}\` makes the property present with the value \`undefined\`, which that option forbids.`,
      ],
      trigger: "compiling the change under its governing project",
      consequence:
        "the project fails to typecheck, and any consumer distinguishing absence from an explicit `undefined` observes the wrong state",
    },
    remediation:
      `Delete the property (\`delete ${write.text.split("=")[0]?.trim() ?? write.propertyName}\`) ` +
      `or widen its declared type to include \`undefined\`.`,
    counterfactual: {
      existsWithoutChange: false,
      because: "the write is on a changed line",
    },
    proposedSeverity: "medium",
    // Derived from what was observed, not asserted: a syntactic optionality
    // read plus a configuration fact is real support and not proof, and the
    // verifier is what turns it into either.
    confidenceScore: 0.6,
    location,
    evidence: [
      {
        type: "static_analysis",
        strength: "supporting",
        observation: `\`${write.text}\` writes the \`undefined\` literal into a property access.`,
        location,
      },
      {
        type: "static_analysis",
        strength: "supporting",
        observation: `\`${write.propertyName}\` is declared with an optional marker in this file.`,
        location,
      },
      ...projects.map((project) => ({
        type: "static_analysis" as const,
        strength: "supporting" as const,
        observation: `${project.configPath} governs ${project.governsPath} and enables ${RELEVANT_OPTION}.`,
        location: { path: project.configPath, startLine: 1, endLine: 1 },
      })),
    ],
    identityHint: `${path}:${write.propertyName}:exact-optional-write`,
    clusterId,
  };
}
