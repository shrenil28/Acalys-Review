/**
 * Asynchronous completion: a promise whose settlement nobody waits for.
 *
 * The first real analyzer, and the category was chosen rather than picked. Four
 * things had to be true, and this class is the only one that was all four.
 *
 * **It is a real defect, not a style preference.** A dropped promise turns a
 * rejection into an unhandled rejection, turns an ordered sequence into a race,
 * and turns a test into one that cannot fail. This project shipped that last
 * one three separate times before a review caught it — `fc.assert(...)` without
 * an `await`, and three property tests that were structurally incapable of
 * failing. The category earned its place by having already cost us.
 *
 * **It is decidable from evidence, not from vibes.** Whether a call returns a
 * promise is a fact about a declaration. Either the declaration was supplied or
 * it was not, and when it was not this analyzer says nothing at all.
 *
 * **It needs context beyond the changed file.** `await store.transition(...)`
 * versus `store.transition(...)` is a one-token difference whose significance
 * lives in another file entirely. That makes this category a genuine test of
 * the context planner rather than of a regex — and it is why a planner
 * regression shows up here as lost recall rather than as nothing.
 *
 * **Its false positives are cheap to avoid and expensive to ship.** `void
 * promise` is a real statement of intent, `.catch()` is real handling, and a
 * reviewer that flags them is one people mute.
 *
 * # Three shapes
 *
 * ```
 * R1  floating          store.save(x);            settlement discarded
 * R2  always-truthy     if (isReady()) { … }      a Promise is always truthy
 * R3  discarded-in-loop items.forEach(async …)    every promise dropped at once
 * ```
 *
 * R2 deserves its severity. `if (isReady())` where `isReady` is async does not
 * *sometimes* misbehave — the branch is taken unconditionally, forever, and the
 * code reads exactly like code that works.
 */

import ts from "typescript";

import type {
  AnalyzerEvidence,
  AnalyzerInput,
  FindingLocation,
} from "../analyzer.js";
import type {
  AnalysisResult,
  CandidateFinding,
  CorrectnessFamily,
  Suppression,
} from "../finding.js";
import { propose } from "../finding.js";

export const ANALYZER_ID = "acalys.correctness.async-completion";
export const ANALYZER_VERSION = "1.0.0";

const RULES = {
  floating: `${ANALYZER_ID}/floating-promise`,
  condition: `${ANALYZER_ID}/promise-in-condition`,
  discarded: `${ANALYZER_ID}/promise-discarded-in-iteration`,
} as const;

/** A declaration that was supplied, and what it establishes. */
interface AsyncDeclaration {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  /** `async` keyword, or an explicit `Promise<…>` return type. */
  readonly reason: "async_keyword" | "promise_return_type";
}

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function hasAsyncModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    )
  );
}

function returnsPromiseType(node: ts.Node): boolean {
  const typed = node as { type?: ts.TypeNode };
  const type = typed.type;
  if (type === undefined || !ts.isTypeReferenceNode(type)) return false;
  return ts.isIdentifier(type.typeName) && type.typeName.text === "Promise";
}

/**
 * Collects, from supplied context only, the functions known to be asynchronous.
 *
 * Reads every item the planner admitted — including files that are context
 * rather than subject, which is the entire reason cross-file defects in this
 * category are findable at all.
 *
 * Pointer items are skipped by construction: they carry no body, so there is
 * nothing to parse. The body they point at is in the context under its own
 * item, so nothing is lost.
 */
export function collectAsyncDeclarations(
  input: AnalyzerInput,
): ReadonlyMap<string, readonly AsyncDeclaration[]> {
  const declarations = new Map<string, AsyncDeclaration[]>();

  const record = (declaration: AsyncDeclaration): void => {
    const existing = declarations.get(declaration.name) ?? [];
    existing.push(declaration);
    declarations.set(declaration.name, existing);
  };

  for (const item of input.context.items) {
    if (item.representation === "metadata") continue;
    // Instructions are prose. Parsing them as TypeScript would be reading
    // tenant text as code, which is the confusion the trust levels exist to
    // prevent.
    if (item.kind === "instruction") continue;

    const source = parse(item.path, item.suppliedContent);
    const line = (node: ts.Node): number =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const visit = (node: ts.Node): void => {
      const asyncKeyword = hasAsyncModifier(node);
      const promiseReturn = returnsPromiseType(node);

      if (asyncKeyword || promiseReturn) {
        const named = node as ts.NamedDeclaration;
        const nameNode = named.name;
        if (nameNode !== undefined && ts.isIdentifier(nameNode)) {
          record({
            name: nameNode.text,
            path: item.path,
            line: line(node),
            reason: asyncKeyword ? "async_keyword" : "promise_return_type",
          });
        } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
          // `const run = async () => …` — the name is on the variable.
          const parent = node.parent;
          if (
            parent !== undefined &&
            ts.isVariableDeclaration(parent) &&
            ts.isIdentifier(parent.name)
          ) {
            record({
              name: parent.name.text,
              path: item.path,
              line: line(parent),
              reason: asyncKeyword ? "async_keyword" : "promise_return_type",
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(source, visit);
  }

  return declarations;
}

/** The identifier a call resolves to, if it is a plain or member call. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    return callee.name.text;
  }
  return undefined;
}

/**
 * The root call of a member chain, and the methods applied to it.
 *
 * `save().then(fn).finally(g)` is a statement whose expression is a call to
 * `finally`, not to `save`. Reading only the outermost callee is how a floating
 * promise escapes detection by being chained — and worse, how it escapes
 * *quietly*, since the outer name (`then`, `catch`) is never a declared async
 * function and so the rule simply finds nothing.
 *
 * An earlier version of this file had a `isHandled` walk that inspected the
 * call's parents. Every one of its branches was unreachable: R1 only ever calls
 * it with a call that *is* an expression statement's expression, so the walk
 * terminated on its first iteration, every time. The clean cases passed for
 * accidental reasons, and a mutation that deleted a branch killed no test.
 * Unwrapping the chain is what that function was reaching for.
 */
function unwrapChain(expression: ts.Expression): {
  readonly root: ts.CallExpression | undefined;
  readonly methods: readonly string[];
} {
  const methods: string[] = [];
  let current: ts.Expression = expression;

  for (;;) {
    if (!ts.isCallExpression(current)) break;
    const callee = current.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.name) &&
      ts.isCallExpression(callee.expression)
    ) {
      methods.push(callee.name.text);
      current = callee.expression;
      continue;
    }
    return { root: current, methods };
  }

  return { root: undefined, methods };
}

/**
 * Whether a chain deals with rejection.
 *
 * `.catch` and `.finally` are real handling. `.then` is not: a `.then` without
 * a trailing `.catch` leaves the rejection path exactly as unhandled as no
 * chain at all, while looking to a reader like the promise was dealt with.
 */
function chainHandlesRejection(methods: readonly string[]): boolean {
  return methods.includes("catch") || methods.includes("finally");
}

function locate(
  source: ts.SourceFile,
  path: string,
  node: ts.Node,
): FindingLocation {
  const start =
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { path, startLine: start, endLine: end };
}

/**
 * Evidence that a call is asynchronous, and how strong that evidence is.
 *
 * A name declared once, unambiguously, in supplied context is as close to
 * proof as syntax gets — `deterministic`. A name declared in several supplied
 * places is weaker, because this analyzer resolves member calls by method name
 * and cannot know the receiver's type: `store.save()` and `cache.save()` are
 * the same name to it. Reporting that ambiguity as a lower strength — which
 * flows straight into a lower confidence — is more honest than picking one
 * declaration and sounding certain.
 */
function asyncEvidence(
  declarations: readonly AsyncDeclaration[],
  name: string,
): AnalyzerEvidence | undefined {
  const first = declarations[0];
  if (first === undefined) return undefined;

  const ambiguous = declarations.length > 1;
  return {
    type: "static_analysis",
    strength: ambiguous ? "supporting" : "deterministic",
    observation: ambiguous
      ? `\`${name}\` is declared asynchronous in ${String(declarations.length)} supplied ` +
        `locations (${declarations.map((d) => `${d.path}:${String(d.line)}`).join(", ")}); ` +
        "the receiver's type is not resolved, so the match is by name"
      : `\`${name}\` is declared at ${first.path}:${String(first.line)} with ` +
        (first.reason === "async_keyword"
          ? "the `async` keyword"
          : "an explicit `Promise` return type"),
    location: { path: first.path, startLine: first.line, endLine: first.line },
  };
}

export interface AsyncAnalyzerInput extends AnalyzerInput {
  /**
   * What is under review, as opposed to what may be consulted.
   *
   * Not extra context — no file content arrives this way. It is the statement
   * of *subject*, and without it the analyzer reports pre-existing defects in
   * any file a change happened to touch. That is the most common way a review
   * bot becomes noise: technically correct, entirely unwanted.
   */
  readonly subject: readonly {
    readonly path: string;
    readonly changedLines: readonly number[];
  }[];
  /** Which cluster this analysis belongs to, so findings are attributable. */
  readonly clusterId?: string | undefined;
}

export function analyzeAsyncCompletion(
  input: AsyncAnalyzerInput,
): AnalysisResult {
  const declarations = collectAsyncDeclarations(input);
  const findings: CandidateFinding[] = [];
  const suppressions: Suppression[] = [];
  const clusterId = input.clusterId ?? "cluster:unscoped";

  const subjectByPath = new Map(
    input.subject.map((entry) => [entry.path, new Set(entry.changedLines)]),
  );

  for (const item of input.context.items) {
    const changed = subjectByPath.get(item.path);
    if (changed === undefined) continue;
    if (item.representation !== "full") continue;

    const source = parse(item.path, item.suppliedContent);

    const emit = (
      node: ts.Node,
      ruleId: string,
      family: CorrectnessFamily,
      claim: string,
      causal: {
        readonly steps: readonly string[];
        readonly trigger: string;
        readonly consequence: string;
      },
      remediation: string,
      severity: "critical" | "high" | "medium" | "low" | "info",
      evidence: readonly AnalyzerEvidence[],
      identity: string,
    ): void => {
      const location = locate(source, item.path, node);
      // Only what the change touched. A defect the author did not write is
      // someone else's review, and reporting it is the fastest way to teach
      // people that Acalys comments on code they never opened.
      if (
        !Array.from(changed).some(
          (line) => line >= location.startLine && line <= location.endLine,
        )
      ) {
        return;
      }

      // Everything goes through `propose`, including findings this rule is
      // certain of. A rule that *can* bypass the discipline is one that will,
      // the first time someone is in a hurry.
      const outcome = propose({
        ruleId,
        family,
        claim,
        causal: { anchor: location, ...causal },
        remediation,
        counterfactual: {
          // The site is on a line this change touched, so the author wrote it.
          // Pre-existing instances elsewhere in the same file are filtered out
          // above and never reach here.
          existsWithoutChange: false,
          because:
            "the call site is on a line this change introduced or modified",
        },
        proposedSeverity: severity,
        location,
        evidence,
        identityHint: identity,
        clusterId,
      });

      if (outcome.kind === "finding") findings.push(outcome.finding);
      else suppressions.push(outcome.suppression);
    };

    const visit = (node: ts.Node): void => {
      // R2 first: a promise in a condition is a strictly worse instance of the
      // same mistake, and reporting both would be two comments for one defect.
      if (ts.isIfStatement(node) || ts.isWhileStatement(node)) {
        const condition = node.expression;
        if (ts.isCallExpression(condition)) {
          const name = calleeName(condition);
          const declared =
            name === undefined ? undefined : declarations.get(name);
          const evidence =
            name === undefined || declared === undefined
              ? undefined
              : asyncEvidence(declared, name);

          if (name !== undefined && evidence !== undefined) {
            emit(
              condition,
              RULES.condition,
              "control_flow",
              `\`${name}()\` returns a promise and is used directly as a condition.`,
              {
                steps: [
                  `\`${name}\` is asynchronous, so calling it without \`await\` yields a Promise object`,
                  "a Promise object is always truthy, whatever it later resolves to",
                  "so the branch is taken on every execution and the check never fails",
                ],
                trigger: "every execution that reaches this statement",
                consequence:
                  "the guard silently does nothing, and code that depends on it being a real check runs unconditionally",
              },
              `Await the call — \`if (await ${name}()) { … }\` — and make the enclosing function \`async\`. If the intent was to test that the call was made rather than its result, say so explicitly rather than relying on truthiness.`,
              "high",
              [
                evidence,
                {
                  type: "source",
                  strength: "deterministic",
                  observation:
                    "the call is the condition expression, with no `await`",
                  location: locate(source, item.path, condition),
                },
              ],
              `${item.path}:${name}:condition`,
            );
            // Not descended into: the same call must not also be reported as a
            // floating promise.
            ts.forEachChild(
              ts.isIfStatement(node) ? node.thenStatement : node.statement,
              visit,
            );
            return;
          }
        }
      }

      // R3: every promise the callback produces is dropped, all at once.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.name) &&
        node.expression.name.text === "forEach"
      ) {
        const callback = node.arguments[0];
        if (
          callback !== undefined &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          hasAsyncModifier(callback)
        ) {
          emit(
            node,
            RULES.discarded,
            "concurrency",
            "`forEach` discards the promise its async callback returns.",
            {
              steps: [
                "the callback is `async`, so each invocation returns a Promise",
                "`forEach` ignores its callback's return value",
                "so every iteration is started and none is awaited",
              ],
              trigger:
                "any non-empty collection, and any iteration whose promise rejects",
              consequence:
                "the loop completes before the work does, ordering is not guaranteed, and a rejection becomes an unhandled rejection",
            },
            "Use `for (const item of items) { await … }` when the iterations must happen in order, or `await Promise.all(items.map(async (item) => …))` when they may run together.",
            "high",
            [
              {
                type: "static_analysis",
                strength: "deterministic",
                observation:
                  "an `async` callback is passed to `forEach`, whose return value is discarded",
                location: locate(source, item.path, node),
              },
            ],
            `${item.path}:forEach:${String(locate(source, item.path, node).startLine)}`,
          );
        }
      }

      // R1: a promise-producing statement whose settlement nobody observes.
      if (ts.isExpressionStatement(node)) {
        // `void save()` and `await save()` are not calls at the statement's
        // root, so they never reach here — the shape check is the suppression,
        // and it is exact rather than heuristic.
        const { root, methods } = ts.isCallExpression(node.expression)
          ? unwrapChain(node.expression)
          : { root: undefined, methods: [] as readonly string[] };

        const name = root === undefined ? undefined : calleeName(root);
        const declared =
          name === undefined ? undefined : declarations.get(name);

        if (
          name !== undefined &&
          declared !== undefined &&
          !chainHandlesRejection(methods)
        ) {
          const evidence = asyncEvidence(declared, name);
          if (evidence !== undefined) {
            const chained = methods.length > 0;
            emit(
              node,
              RULES.floating,
              "error_handling",
              chained
                ? `\`${name}()\` is chained with \`.${methods.join(".")}\` but its rejection is never handled.`
                : `The promise returned by \`${name}()\` is discarded.`,
              {
                steps: [
                  `\`${name}\` is asynchronous, so this call returns a Promise`,
                  chained
                    ? `the chain applies \`.${methods.join(".")}\`, none of which handles rejection`
                    : "the statement discards it, so nothing observes settlement",
                  "a rejection therefore has no handler, and any ordering later code relies on is not enforced",
                ],
                trigger:
                  "any execution in which the call rejects, or in which later code assumes it finished",
                consequence:
                  "an unhandled rejection, and work that may not have completed when the next statement runs",
              },
              chained
                ? `Add \`.catch(…)\` to the chain, or \`await\` it inside a \`try\`/\`catch\`.`
                : `Add \`await\` if the result is needed before the next statement, \`.catch(…)\` if the failure should be handled here, or \`void\` if discarding it is deliberate.`,
              "medium",
              [
                evidence,
                {
                  type: "source",
                  strength: "deterministic",
                  observation: chained
                    ? `the chain \`.${methods.join(".")}\` contains no \`.catch\` or \`.finally\``
                    : "the call is a statement on its own, with no `await`, `void`, `return` or `.catch`",
                  location: locate(source, item.path, node),
                },
              ],
              `${item.path}:${name}:floating`,
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

/**
 * The deterministic producer for this category.
 *
 * Deliberately not a model. Whether a call returns a promise is a fact about a
 * declaration, and spending expensive reasoning to rediscover what a parser
 * establishes for free is the most common way an LLM reviewer becomes
 * uneconomic. Reasoning is for what this cannot establish: why the failure
 * matters here, what breaks downstream, and what the right repair is.
 */
export const asyncCompletionAnalyzer = {
  id: ANALYZER_ID,
  version: ANALYZER_VERSION,
  categories: ["correctness"] as const,
  analyze(input: AsyncAnalyzerInput): AnalysisResult {
    return analyzeAsyncCompletion(input);
  },
};
