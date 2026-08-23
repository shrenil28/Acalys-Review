/**
 * P1-M.3.2 — a cheap base-to-head hypothesis about a callable's public surface.
 *
 * ```
 * acalys.correctness/required-parameter-added
 * ```
 *
 * This file also held `removed_export` until M.3.4 superseded it. That body is
 * deleted rather than left dormant: `depcruise` reasons about module
 * reachability, and this module stays reachable through the capability above,
 * so a dead half would have gone on looking alive. Its mutations then survived
 * a full harness while defending nothing, which is how the deletion came to be
 * noticed at all.
 *
 * # What this is allowed to know
 *
 * Base and head source text, read syntactically. Nothing else. No Program, no
 * checker, no semantic diagnostics, and no peeking at what the verifier
 * concluded — the same prohibition M.2 carries, for the same reason: two
 * stages that consult one opinion are one stage that ran twice.
 *
 * # Why these hypotheses are deliberately wrong sometimes
 *
 * `parameterGrowth` counts parameters rather than reasoning about
 * optionality, so it will propose candidates that are not defects.
 *
 * That is the design, not a defect in it. The verifier compiles a consumer
 * that was valid against base and asks whether it still compiles — it can say
 * *no, you are wrong*, and it regularly does. Teaching these functions to be
 * certain would move the semantics into the stage that cannot be contradicted,
 * and the refutation cases would stop being tested at all because no candidate
 * would ever reach them.
 *
 * The cost of being wrong here is a verification that publishes nothing. The
 * cost of being certain here is the architecture.
 */

import ts from "typescript";
import type { AnalysisResult, CandidateFinding } from "../finding.js";
import type { AsyncAnalyzerInput } from "./async-completion.js";

export const REQUIRED_PARAMETER_RULE_ID =
  "acalys.correctness/required-parameter-added";

/** A callable's parameter shape, as declarations state it. */
interface CallableShape {
  readonly name: string;
  /** Arguments a caller must supply: everything before the first optional. */
  readonly required: number;
  /** Every declared parameter, optional and rest included. */
  readonly total: number;
}

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );

/**
 * Exported callables, by name, taking the most permissive overload.
 *
 * Minimum required arity across the overload set, never the maximum. A caller
 * satisfied by any signature is a caller that still compiles, so the maximum
 * would report a break every time a wider overload was added beside a
 * surviving narrow one.
 */
function exportedCallables(
  source: ts.SourceFile,
): ReadonlyMap<string, CallableShape> {
  const shapes = new Map<string, CallableShape>();

  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement)) continue;
    if (statement.name === undefined) continue;
    if (!hasExportModifier(statement)) continue;

    const parameters = statement.parameters;
    const required = parameters.filter(
      (parameter) =>
        parameter.questionToken === undefined &&
        parameter.initializer === undefined &&
        parameter.dotDotDotToken === undefined,
    ).length;

    const existing = shapes.get(statement.name.text);
    shapes.set(statement.name.text, {
      name: statement.name.text,
      required:
        existing === undefined
          ? required
          : Math.min(existing.required, required),
      total:
        existing === undefined
          ? parameters.length
          : Math.min(existing.total, parameters.length),
    });
  }

  return shapes;
}

/**
 * The base revision of a changed file, when M.3.0 established one is present.
 *
 * Returns nothing for `absent`, `unavailable` and `not_indexed` alike, but for
 * two different reasons that the caller must not merge: `absent` means the
 * file is new and no export it declares can have been removed, while the other
 * two mean the historical premise could not be established at all. Neither
 * licenses a candidate, so this returns `undefined` for all three — the
 * distinction matters for the degradation the caller records, not for whether
 * a hypothesis may be formed.
 */
function baseContentFor(
  input: AsyncAnalyzerInput,
  path: string,
): { readonly content: string } | { readonly abstain: string } | undefined {
  for (const item of input.context.items) {
    if (item.kind !== "base_revision") continue;
    if (item.path !== path) continue;
    const provenance = item.provenance;
    if (provenance?.source !== "base_revision_facts") continue;

    if (provenance.resolution === "present") {
      return { content: item.suppliedContent };
    }
    if (provenance.resolution === "absent") return undefined;
    return { abstain: provenance.resolution };
  }
  return undefined;
}

export interface ChangedSource {
  readonly path: string;
  readonly base: ts.SourceFile;
  readonly head: ts.SourceFile;
}

function parse(path: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.ES2022,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * The changed TypeScript files whose base revision is present.
 *
 * Shared with M.4, which needs the same pairing under the same base-state
 * rules. Exported rather than duplicated so that "which files may be compared,
 * and what to do when the base could not be established" is decided once.
 */
export function comparableSources(input: AsyncAnalyzerInput): {
  readonly sources: readonly ChangedSource[];
  readonly degradations: readonly { path: string; because: string }[];
} {
  const subjectPaths = new Set(input.subject.map((entry) => entry.path));
  const sources: ChangedSource[] = [];
  const degradations: { path: string; because: string }[] = [];
  // One entry per path, not per context item.
  //
  // A changed file routinely arrives as several items — the hunk, the
  // containing symbol, the indexed declaration — and comparing the surface
  // once per item would publish one finding per representation of the same
  // logical break. The contract is one consumer-visible break, one finding.
  const seen = new Set<string>();

  for (const item of input.context.items) {
    if (!subjectPaths.has(item.path)) continue;
    if (seen.has(item.path)) continue;
    // Positively the changed file's complete head text, not "anything with a
    // .ts path that is not on a blacklist".
    //
    // A blacklist let an instruction-coverage report through — prose, carried
    // under the source file's own path — and comparing a real base file
    // against prose concluded that every export had been deleted. A surface
    // comparison is only meaningful between two complete files, so the head
    // side is identified by what it IS rather than by what it is not.
    if (item.kind !== "source_file") continue;
    if (item.reason !== "changed_hunk") continue;
    if (item.representation !== "full") continue;
    if (!/\.[cm]?tsx?$/.test(item.path)) continue;

    const base = baseContentFor(input, item.path);
    if (base === undefined) continue;
    if ("abstain" in base) {
      degradations.push({
        path: item.path,
        because: `the base revision is ${base.abstain}, so no claim about what the public surface used to be can be established`,
      });
      continue;
    }

    seen.add(item.path);
    sources.push({
      path: item.path,
      base: parse(item.path, base.content),
      head: parse(item.path, item.suppliedContent),
    });
  }

  return { sources, degradations };
}

// ---------------------------------------------------------------------------
// M.3.2 — required_parameter_added
// ---------------------------------------------------------------------------

export function analyzeRequiredParameterAdded(
  input: AsyncAnalyzerInput,
): AnalysisResult {
  const findings: CandidateFinding[] = [];
  const clusterId = input.clusterId ?? "cluster:unscoped";
  const { sources, degradations } = comparableSources(input);

  for (const source of sources) {
    const before = exportedCallables(source.base);
    const after = exportedCallables(source.head);

    for (const [name, baseShape] of before) {
      const headShape = after.get(name);
      if (headShape === undefined) continue;

      // Total parameters, not required ones. A coarse and knowingly
      // over-inclusive trigger: `f(a)` growing to `f(a, b?)` fires here and is
      // not a break. The verifier makes the base-valid call and settles it,
      // and a trigger narrow enough to be always right would mean the
      // refutation path was never exercised by anything.
      if (headShape.total <= baseShape.total) continue;

      findings.push(
        requiredParameterCandidate(
          source.path,
          name,
          baseShape,
          headShape,
          source.head,
          clusterId,
        ),
      );
    }
  }

  // Reported, not discarded.
  //
  // A comparison capability that abstained because it could not establish the
  // base is producing an empty result for a reason, and an empty result with
  // no reason attached is indistinguishable from a clean review. That is the
  // exact confusion M.3.0's four states exist to prevent, and dropping these
  // would reintroduce it one layer up.
  return {
    findings,
    suppressions: [],
    degradations: degradations.map((entry) => ({
      clusterId,
      reason: `${entry.path}: ${entry.because}`,
    })),
  };
}

function requiredParameterCandidate(
  path: string,
  name: string,
  base: CallableShape,
  head: CallableShape,
  headSource: ts.SourceFile,
  clusterId: string,
): CandidateFinding {
  const declaration = headSource.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  const line =
    declaration === undefined
      ? 1
      : headSource.getLineAndCharacterOfPosition(
          declaration.getStart(headSource),
        ).line + 1;
  const location = { path, startLine: line, endLine: line };

  return {
    ruleId: REQUIRED_PARAMETER_RULE_ID,
    category: "correctness",
    family: "api_contract",
    claim:
      `\`${name}\` accepted ${String(base.required)} required argument(s) at the base revision and ` +
      `now declares ${String(head.required)}, so a call written against the previous contract may no longer compile.`,
    causal: {
      anchor: location,
      steps: [
        `\`${name}\` required ${String(base.required)} argument(s) at the base revision.`,
        `The changed declaration requires ${String(head.required)}.`,
        "A caller that was not updated in this change passes too few arguments.",
      ],
      trigger: `calling \`${name}\` the way the base revision permitted`,
      consequence:
        "callers written against the previous signature fail to compile",
    },
    remediation: `Give the new parameter of \`${name}\` a default or make it optional, or update every caller.`,
    counterfactual: {
      existsWithoutChange: false,
      because: "the signature is part of the change",
    },
    proposedSeverity: "medium",
    // Deliberately modest. A parameter-count increase is consistent with
    // optional, defaulted and rest parameters, none of which break a caller.
    confidenceScore: 0.5,
    location,
    evidence: [
      {
        type: "static_analysis",
        strength: "supporting",
        observation: `\`${name}\` declared ${String(base.total)} parameter(s) at the base revision and ${String(head.total)} now.`,
        location,
      },
    ],
    identityHint: `${path}:${name}:required-parameter-added`,
    clusterId,
  };
}
