/**
 * Errors that are caught and then forgotten.
 *
 * The failure this finds is not "an exception happened". It is that the system
 * *decided* to continue as though nothing had, and left no trace that it did.
 * The bug report is always the same shape: something silently did not happen,
 * and the logs are clean.
 *
 * ```
 * try { await store.commit(); } catch {}          the write may not have happened
 * try { parse(input); } catch (error) {}          the error is bound and dropped
 * ```
 *
 * # Why this is narrow on purpose
 *
 * "Handles errors badly" is unboundedly subjective and is where an error-
 * handling reviewer becomes noise. Only two shapes are reported, and both are
 * mechanical:
 *
 *     the catch block is empty
 *     the catch binds the error and never mentions it again
 *
 * Everything else is left alone. A `catch` that logs, rethrows, returns a
 * default, increments a metric, or assigns to a variable is a decision someone
 * made, and a reviewer that argues with decisions gets muted.
 *
 * **A comment inside the block counts as handling.** `catch { /* best effort *\/ }`
 * is an author saying "I know". Ignoring that is how a reviewer teaches people
 * that explaining themselves does not help.
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

export const SWALLOWED_ERROR_ANALYZER_ID = "acalys.correctness.swallowed-error";
export const SWALLOWED_ERROR_VERSION = "1.0.0";

const RULES = {
  empty: `${SWALLOWED_ERROR_ANALYZER_ID}/empty-catch`,
  unused: `${SWALLOWED_ERROR_ANALYZER_ID}/unused-error-binding`,
} as const;

/** Whether the block does anything at all, comments included. */
function isSubstantive(block: ts.Block, source: ts.SourceFile): boolean {
  if (block.statements.length > 0) return true;
  // An author who wrote a comment stated an intention. Text between the braces
  // is enough — parsing its meaning is not this rule's business.
  const text = block.getFullText(source);
  const inner = text.slice(text.indexOf("{") + 1, text.lastIndexOf("}"));
  return inner.trim() !== "";
}

/** Whether the caught binding is mentioned anywhere in the handler. */
function bindingIsUsed(clause: ts.CatchClause, name: string): boolean {
  let used = false;
  const visit = (node: ts.Node): void => {
    if (used) return;
    if (ts.isIdentifier(node) && node.text === name) {
      // The declaration itself is not a use.
      const parent = node.parent;
      const isDeclaration =
        parent !== undefined &&
        ts.isVariableDeclaration(parent) &&
        parent.name === node;
      if (!isDeclaration) used = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(clause.block, visit);
  return used;
}

export function analyzeSwallowedErrors(
  input: AsyncAnalyzerInput,
): AnalysisResult {
  const findings: CandidateFinding[] = [];
  const suppressions: Suppression[] = [];
  const clusterId = input.clusterId ?? "cluster:unscoped";
  const subjectByPath = new Map(
    input.subject.map((entry) => [entry.path, new Set(entry.changedLines)]),
  );

  for (const item of input.context.items) {
    const changed = subjectByPath.get(item.path);
    if (changed === undefined || item.representation !== "full") continue;
    if (item.kind === "instruction") continue;

    const source = ts.createSourceFile(
      item.path,
      item.suppliedContent,
      ts.ScriptTarget.Latest,
      true,
      item.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) {
        const start =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const end =
          source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const touched = Array.from(changed).some(
          (line) => line >= start && line <= end,
        );

        if (touched) {
          const location = { path: item.path, startLine: start, endLine: end };
          const substantive = isSubstantive(node.block, source);
          const binding =
            node.variableDeclaration !== undefined &&
            ts.isIdentifier(node.variableDeclaration.name)
              ? node.variableDeclaration.name.text
              : undefined;

          const evidence: AnalyzerEvidence[] = [
            {
              type: "static_analysis",
              strength: "deterministic",
              observation: substantive
                ? `the catch binds \`${String(binding)}\` and never refers to it again`
                : "the catch block contains no statements and no comment",
              location,
            },
          ];

          const emit = (
            ruleId: string,
            claim: string,
            steps: readonly string[],
            remediation: string,
          ): void => {
            const outcome = propose({
              ruleId,
              family: "error_handling",
              claim,
              remediation,
              causal: {
                anchor: location,
                steps,
                trigger: "any execution in which the guarded operation throws",
                consequence:
                  "the failure is invisible: execution continues as though the operation succeeded, and nothing records that it did not",
              },
              counterfactual: {
                existsWithoutChange: false,
                because:
                  "the handler is on a line this change introduced or modified",
              },
              proposedSeverity: "medium",
              location,
              evidence,
              identityHint: `${item.path}:catch:${String(start)}`,
              clusterId,
            });
            if (outcome.kind === "finding") findings.push(outcome.finding);
            else suppressions.push(outcome.suppression);
          };

          if (!substantive) {
            emit(
              RULES.empty,
              "This `catch` discards the error and does nothing.",
              [
                "the guarded operation can throw",
                "the handler has no statements, so nothing observes the failure",
                "execution resumes after the `try` as though it had succeeded",
              ],
              "Do one of: rethrow, log with enough context to diagnose it, return an explicit failure the caller can act on, or leave a comment stating why continuing is correct here.",
            );
          } else if (binding !== undefined && !bindingIsUsed(node, binding)) {
            emit(
              RULES.unused,
              `This \`catch\` binds \`${binding}\` and never uses it.`,
              [
                "the guarded operation can throw",
                `\`${binding}\` holds the only description of what failed`,
                "it is never read, so the reason is lost even though the handler runs",
              ],
              `Include \`${binding}\` in what the handler does — log it, wrap it, or attach it as a cause — or drop the binding to make the discard deliberate.`,
            );
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(source, visit);
  }

  return { findings, suppressions, degradations: [] };
}

export const swallowedErrorAnalyzer = {
  id: SWALLOWED_ERROR_ANALYZER_ID,
  version: SWALLOWED_ERROR_VERSION,
  categories: ["correctness"] as const,
  analyze: analyzeSwallowedErrors,
};
