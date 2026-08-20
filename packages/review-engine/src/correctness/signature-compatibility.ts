/**
 * A signature that grew a requirement its callers do not satisfy.
 *
 * The defect this catches is the one a reviewer is least likely to find
 * unaided, because the mistake and its consequence are in different files and
 * the author only opened one of them:
 *
 * ```
 *   src/auth.ts        (changed)   export function verify(token, scope)   ← scope added
 *   src/session.ts     (untouched) verify(token)                          ← now wrong
 * ```
 *
 * # Why this is worth a rule when a compiler exists
 *
 * TypeScript catches this when both files are in one program and both are
 * typed. Three common situations where it does not:
 *
 *     the caller is JavaScript, or typed `any` at the boundary
 *     the caller is in another package that builds separately
 *     the parameter was made *semantically* required while staying optional
 *
 * The third is the interesting one and is why the rule reports on requiredness
 * as declared rather than on arity alone. But the honest framing is that this
 * is a **cheap deterministic pre-pass**: where the compiler already reports the
 * error, the finding is redundant, and redundancy is far cheaper than paying a
 * model to rediscover the same fact.
 *
 * # Precision, which is the whole difficulty
 *
 * Only reported when every one of these holds:
 *
 *     the declaration is exported and lives in a CHANGED file
 *     its parameter list is on a line the change touched
 *     a caller was SUPPLIED and was NOT changed
 *     that caller passes fewer arguments than the declaration now requires
 *
 * The unchanged-caller condition is what makes it a compatibility finding
 * rather than a lint. If the author updated the caller in the same change,
 * there is nothing to say — and saying it anyway is how a reviewer teaches
 * people that it has not read their diff.
 */

import ts from "typescript";

import type { AnalyzerEvidence } from "../analyzer.js";
import type {
  AnalysisResult,
  CandidateFinding,
  Suppression,
} from "../finding.js";
import { propose } from "../finding.js";
import type { AsyncAnalyzerInput } from "./async-completion.js";

export const SIGNATURE_ANALYZER_ID =
  "acalys.correctness.signature-compatibility";
export const SIGNATURE_ANALYZER_VERSION = "1.0.0";

const RULE = `${SIGNATURE_ANALYZER_ID}/caller-misses-required-parameter`;

interface ExportedSignature {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly required: number;
  readonly total: number;
  readonly parameterNames: readonly string[];
}

function requiredParameterCount(
  parameters: readonly ts.ParameterDeclaration[],
): number {
  // A parameter is required until something says otherwise: `?`, a default, or
  // a rest element. Counting from the left stops at the first optional one,
  // because TypeScript forbids a required parameter after an optional one.
  let required = 0;
  for (const parameter of parameters) {
    if (
      parameter.questionToken !== undefined ||
      parameter.initializer !== undefined ||
      parameter.dotDotDotToken !== undefined
    ) {
      break;
    }
    required += 1;
  }
  return required;
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

export function analyzeSignatureCompatibility(
  input: AsyncAnalyzerInput,
): AnalysisResult {
  const findings: CandidateFinding[] = [];
  const suppressions: Suppression[] = [];
  const clusterId = input.clusterId ?? "cluster:unscoped";

  const subjectByPath = new Map(
    input.subject.map((entry) => [entry.path, new Set(entry.changedLines)]),
  );

  const parse = (path: string, source: string): ts.SourceFile =>
    ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

  // 1. Exported signatures whose parameter list the change touched.
  const changedSignatures = new Map<string, ExportedSignature>();

  for (const item of input.context.items) {
    const changed = subjectByPath.get(item.path);
    if (changed === undefined || item.representation !== "full") continue;
    if (item.kind === "instruction" || item.kind === "coverage") continue;

    const source = parse(item.path, item.suppliedContent);

    const visit = (node: ts.Node): void => {
      const isFunction =
        ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
      if (isFunction && node.name !== undefined && ts.isIdentifier(node.name)) {
        const declaredOn =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const parameterEnd =
          source.getLineAndCharacterOfPosition(
            node.parameters.end === node.parameters.pos
              ? node.name.getEnd()
              : node.parameters.end,
          ).line + 1;

        const touched = Array.from(changed).some(
          (line) => line >= declaredOn && line <= parameterEnd,
        );

        if (touched && (isExported(node) || ts.isMethodDeclaration(node))) {
          changedSignatures.set(node.name.text, {
            name: node.name.text,
            path: item.path,
            line: declaredOn,
            required: requiredParameterCount([...node.parameters]),
            total: node.parameters.length,
            parameterNames: node.parameters.map((parameter) =>
              ts.isIdentifier(parameter.name) ? parameter.name.text : "…",
            ),
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(source, visit);
  }

  if (changedSignatures.size === 0) {
    return { findings, suppressions, degradations: [] };
  }

  // 2. Callers that were supplied but NOT changed.
  for (const item of input.context.items) {
    if (subjectByPath.has(item.path)) continue;
    if (
      item.representation !== "full" ||
      item.kind === "instruction" ||
      item.kind === "coverage"
    ) {
      continue;
    }

    const source = parse(item.path, item.suppliedContent);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.name)
            ? callee.name.text
            : undefined;

        const signature =
          name === undefined ? undefined : changedSignatures.get(name);

        if (
          name !== undefined &&
          signature !== undefined &&
          node.arguments.length < signature.required &&
          // A spread could supply any number of arguments; counting them would
          // be a guess, and guessing here produces a confident false positive
          // in the exact codebases that use spreads.
          !node.arguments.some((argument) => ts.isSpreadElement(argument))
        ) {
          const start =
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1;
          const location = {
            path: item.path,
            startLine: start,
            endLine:
              source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          };

          const missing = signature.parameterNames
            .slice(node.arguments.length, signature.required)
            .map((parameter) => `\`${parameter}\``)
            .join(", ");

          const evidence: AnalyzerEvidence[] = [
            {
              type: "static_analysis",
              strength: "deterministic",
              observation:
                `\`${signature.name}\` is declared at ${signature.path}:${String(signature.line)} ` +
                `with ${String(signature.required)} required parameter(s); this change modified that parameter list`,
              location: {
                path: signature.path,
                startLine: signature.line,
                endLine: signature.line,
              },
            },
            {
              type: "source",
              strength: "deterministic",
              observation: `this call passes ${String(node.arguments.length)} argument(s) and was not modified by this change`,
              location,
            },
          ];

          const outcome = propose({
            ruleId: RULE,
            family: "api_contract",
            claim: `\`${name}()\` is called without ${missing}, which this change made required.`,
            causal: {
              anchor: {
                path: signature.path,
                startLine: signature.line,
                endLine: signature.line,
              },
              steps: [
                `this change altered the parameter list of \`${signature.name}\``,
                `it now requires ${String(signature.required)} argument(s)`,
                `this caller still passes ${String(node.arguments.length)} and was not updated`,
              ],
              trigger: "any execution that reaches this call site",
              consequence: `\`${missing}\` is \`undefined\` inside \`${signature.name}\`, so it behaves as though a value was supplied when none was`,
            },
            remediation:
              `Pass ${missing} at this call site, or give the parameter a default in ` +
              `\`${signature.name}\` so existing callers stay correct.`,
            counterfactual: {
              existsWithoutChange: false,
              because:
                "the caller is unchanged; the mismatch exists only because this change altered the signature",
            },
            proposedSeverity: "high",
            location,
            evidence,
            identityHint: `${item.path}:${name}:arity:${String(start)}`,
            clusterId,
          });

          if (outcome.kind === "finding") findings.push(outcome.finding);
          else suppressions.push(outcome.suppression);
        }
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(source, visit);
  }

  return { findings, suppressions, degradations: [] };
}

export const signatureCompatibilityAnalyzer = {
  id: SIGNATURE_ANALYZER_ID,
  version: SIGNATURE_ANALYZER_VERSION,
  categories: ["correctness"] as const,
  analyze: analyzeSignatureCompatibility,
};
