/**
 * P1-M.3.4 — a public name that consumers can no longer reach.
 *
 * Supersedes `removed_export`, which was named for detecting removals and
 * detected renames:
 *
 * ```ts
 * export { decode }  ->  export { decode as decodeInternal }   it found this
 * export { decode }  ->  (decode simply gone)                  it missed this
 * ```
 *
 * The cause was structural rather than a bug. That analyzer compared the
 * *syntactic export names* of the two revisions and its anchor resolution
 * required a head statement mentioning the name — so a name that left without
 * a trace left no anchor and no candidate. A capability whose name promises
 * removals and delivers renames is an honesty defect, and the repair is a
 * capability that means what it says.
 *
 * # The direction of reasoning is the whole change
 *
 * ```
 * OLD   look in HEAD for evidence that the old name changed     rename-shaped
 * NEW   start from the BASE public surface and ask, of each
 *       previously reachable name, whether HEAD still reaches
 *       it through the same boundary
 * ```
 *
 * Nothing here resolves modules or consults the checker. Where syntax cannot
 * establish that reachability was preserved — a wholesale re-export, a barrel
 * restructuring, a declaration that moved somewhere this file cannot see — it
 * proposes and lets the verifier settle it. Rebuilding a module resolver
 * inside the analyzer would be the same mistake in a new place: the stage that
 * cannot be contradicted deciding the semantics.
 */

import ts from "typescript";
import type { AnalysisResult, CandidateFinding } from "../finding.js";
import type { AsyncAnalyzerInput } from "./async-completion.js";
import { comparableSources, type ChangedSource } from "./api-compatibility.js";

export const EXPORT_REACHABILITY_RULE_ID =
  "acalys.correctness/public-export-reachability-loss";

interface PublicName {
  readonly name: string;
  readonly namespace: "value" | "type";
}

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );

/** Every name a module exposes by name, read syntactically. */
function publicSurface(source: ts.SourceFile): readonly PublicName[] {
  const found = new Map<string, PublicName>();
  const localKinds = new Map<string, "value" | "type">();

  for (const statement of source.statements) {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      localKinds.set(statement.name.text, "type");
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      localKinds.set(statement.name.text, "value");
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          localKinds.set(declaration.name.text, "value");
        }
      }
    }
  }

  const remember = (name: string, namespace: "value" | "type"): void => {
    if (!found.has(name)) found.set(name, { name, namespace });
  };

  for (const statement of source.statements) {
    if (hasExportModifier(statement)) {
      const namespace =
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
          ? "type"
          : "value";
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name !== undefined
      ) {
        remember(statement.name.text, namespace);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            remember(declaration.name.text, "value");
          }
        }
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const exposed = element.name.text;
        const local = element.propertyName?.text ?? exposed;
        remember(
          exposed,
          statement.isTypeOnly || element.isTypeOnly
            ? "type"
            : (localKinds.get(local) ?? "value"),
        );
      }
    }
  }

  return [...found.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

/** The line of the statement that exposes `name`, in whichever revision. */
function exposingLine(source: ts.SourceFile, name: string): number | undefined {
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (element) =>
          element.name.text === name || element.propertyName?.text === name,
      )
    ) {
      return lineOf(statement);
    }
  }

  for (const statement of source.statements) {
    if (!hasExportModifier(statement)) continue;
    const declared =
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
        ? statement.name.text
        : undefined;
    if (declared === name) return lineOf(statement);
  }

  return undefined;
}

/** A wholesale `export * from "..."`, which hides names from syntax. */
function wholesaleLine(source: ts.SourceFile): number | undefined {
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      statement.exportClause === undefined
    ) {
      return (
        source.getLineAndCharacterOfPosition(statement.getStart(source)).line +
        1
      );
    }
  }
  return undefined;
}

/**
 * Where a reachability loss may be published.
 *
 * Three rungs, and the middle one is the reason this capability can publish at
 * all. A name that is simply gone has no head statement, and a rule that
 * withheld everything without one would make the capability semantically
 * correct and systematically unpublishable for its own defect class.
 */
type ReachabilityAnchor =
  | { readonly kind: "head"; readonly line: number; readonly because: string }
  | { readonly kind: "base"; readonly line: number; readonly because: string }
  | { readonly kind: "unavailable"; readonly because: string };

function resolveAnchor(
  source: ChangedSource,
  name: string,
): ReachabilityAnchor {
  const head = exposingLine(source.head, name);
  if (head !== undefined) {
    return {
      kind: "head",
      line: head,
      because: `the changed statement mentioning \`${name}\` is on this line`,
    };
  }

  const wholesale = wholesaleLine(source.head);
  if (wholesale !== undefined) {
    return {
      kind: "head",
      line: wholesale,
      because: `\`${name}\` is exposed, if at all, by the wholesale re-export on this line`,
    };
  }

  const base = exposingLine(source.base, name);
  if (base !== undefined) {
    return {
      kind: "base",
      line: base,
      because: `the deleted statement exposed \`${name}\` on this line of the base revision`,
    };
  }

  return {
    kind: "unavailable",
    because: `no statement exposing \`${name}\` was found in either revision`,
  };
}

export function analyzeExportReachability(
  input: AsyncAnalyzerInput,
): AnalysisResult {
  const findings: CandidateFinding[] = [];
  const clusterId = input.clusterId ?? "cluster:unscoped";
  const { sources, degradations } = comparableSources(input);
  const unlocalized: { path: string; because: string }[] = [];

  for (const source of sources) {
    const before = publicSurface(source.base);
    const after = new Set(
      publicSurface(source.head).map((entry) => entry.name),
    );

    for (const exposed of before) {
      // Deliberately NOT `after.has(name) || headMentions(name)`. Requiring a
      // head mention is the rename-shaped predicate this capability replaces.
      if (after.has(exposed.name)) continue;

      const anchor = resolveAnchor(source, exposed.name);
      if (anchor.kind === "unavailable") {
        unlocalized.push({
          path: source.path,
          because:
            `\`${exposed.name}\` is no longer named in the public surface, but the finding has ` +
            `no publishable anchor (${anchor.because})`,
        });
        continue;
      }

      findings.push(candidateFor(source, exposed, anchor, clusterId));
    }
  }

  return {
    findings,
    suppressions: [],
    degradations: [...degradations, ...unlocalized].map((entry) => ({
      clusterId,
      reason: `${entry.path}: ${entry.because}`,
    })),
  };
}

function candidateFor(
  source: ChangedSource,
  exposed: PublicName,
  anchor: Extract<ReachabilityAnchor, { kind: "head" | "base" }>,
  clusterId: string,
): CandidateFinding {
  const location = {
    path: source.path,
    startLine: anchor.line,
    endLine: anchor.line,
    side: anchor.kind,
  };

  return {
    ruleId: EXPORT_REACHABILITY_RULE_ID,
    category: "correctness",
    family: "api_contract",
    claim:
      `\`${exposed.name}\` was reachable through ${source.path} at the base revision and may no longer be ` +
      `reachable through that boundary, so consumers importing it stop compiling.`,
    causal: {
      anchor: location,
      steps: [
        `${source.path} exposed \`${exposed.name}\` in its public ${exposed.namespace} surface at the base revision.`,
        `The changed public surface no longer names \`${exposed.name}\`.`,
        anchor.kind === "base"
          ? `No statement in the changed file mentions it, so the coordinate is the deleted statement.`
          : `Whether it survives depends on what the changed statement re-exports.`,
      ],
      trigger: `importing \`${exposed.name}\` from ${source.path}`,
      consequence:
        "consumers written against the previous public surface no longer compile",
    },
    remediation: `Keep \`${exposed.name}\` reachable through ${source.path}, or record the removal as an intentional breaking change.`,
    counterfactual: {
      existsWithoutChange: false,
      because: "the name was reachable at the base revision",
    },
    proposedSeverity: "medium",
    // A syntactic surface comparison cannot see through a re-export, which is
    // precisely what the verifier resolves.
    confidenceScore: 0.55,
    location,
    evidence: [
      {
        type: "static_analysis",
        strength: "supporting",
        observation: `\`${exposed.name}\` is in the base revision's public ${exposed.namespace} surface of ${source.path}.`,
        location,
      },
      {
        type: "static_analysis",
        strength: "supporting",
        observation: `The published location is established evidence: ${anchor.because}.`,
        location,
      },
    ],
    identityHint: `${source.path}:${exposed.name}:${exposed.namespace}:export-reachability-loss`,
    clusterId,
  };
}
