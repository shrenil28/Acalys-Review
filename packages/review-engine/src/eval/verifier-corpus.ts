/**
 * Claims constructed to test the verifier, fed to it directly.
 *
 * Separate from `ANALYZER_CORPUS`, and the separation is load-bearing.
 *
 * ```
 * natural     the analyzer really produced this candidate on this code
 * injected    a claim built by hand, which the analyzer may never produce
 * ```
 *
 * Natural candidates measure **the product**: does verification improve what a
 * developer actually receives? Injected claims measure **a capability**: can
 * the verifier recognize this refutation pattern at all? Averaging them into
 * one precision number would let a rich set of hand-written challenges flatter
 * a pipeline that never encounters them — so no metric in this file is ever
 * combined with a metric from the analyzer corpus.
 *
 * # Three gold outcomes, not two
 *
 * ```
 * should_verify   independent evidence establishes the defect
 * should_reject   independent evidence refutes it
 * should_abstain  neither is establishable from the repository
 * ```
 *
 * `should_abstain` is the one that keeps the other two honest. Without it, the
 * only way to score better is to decide more often, and the corpus would apply
 * steady pressure toward inventing refutations. The target is **calibrated
 * abstention**, not minimal abstention — a verifier that abstains on a genuinely
 * undecidable claim is right, and scoring it as a miss would train the failure
 * this whole layer exists to prevent.
 *
 * # Paired lookalikes
 *
 * Several challenges come in pairs: a real defect and code that looks almost
 * identical and is correct. A mechanism taught against only the positive half
 * is pattern recognition wearing verification's clothes, and it will confirm
 * the lookalike on the first pull request that contains one.
 */

import type { FindingSeverity } from "@acalys/contracts/domain";

import type { VerificationInput } from "../verification/input.js";

export const GOLD_OUTCOMES = [
  "should_verify",
  "should_reject",
  "should_abstain",
] as const;

export type GoldOutcome = (typeof GOLD_OUTCOMES)[number];

/**
 * Where a challenge came from.
 *
 * `historical_regression` is a candidate the analyzer **actually produced**
 * before it was fixed, replayed with its real claim, evidence and location. It
 * is kept because the alternative is that fixing the analyzer silently deletes
 * the verifier's only evidence of catching a real mistake — and then a
 * regression in either component looks the same from outside.
 *
 * With both, the two failures are distinguishable:
 *
 * ```
 * analyzer regression   the live corpus case starts speaking again
 * verifier regression   the replayed candidate stops being filtered
 * ```
 *
 * Never counted in natural analyzer precision. These candidates are not
 * evidence about what the analyzer produces today.
 */
export const CHALLENGE_SOURCES = [
  "constructed",
  "injected_historical_regression",
] as const;

export type ChallengeSource = (typeof CHALLENGE_SOURCES)[number];

export interface VerifierChallenge {
  readonly id: string;
  readonly gold: GoldOutcome;
  readonly source?: ChallengeSource | undefined;
  readonly files: Readonly<Record<string, string>>;
  readonly input: Omit<VerificationInput, "repositoryId" | "revisionId">;
  readonly because: string;
  /**
   * The near-identical case this one contrasts with.
   *
   * Present on both halves. A mechanism whose two halves are not graded
   * together has not been shown to discriminate.
   */
  readonly pairedWith?: string | undefined;
}

const ASYNC_STORE =
  "export async function save(value: number): Promise<void> {\n  return;\n}";
const SYNC_STORE = "export function save(value: number): void {\n  return;\n}";

function claim(
  statement: string,
  path: string,
  startLine: number,
  options: {
    readonly severity?: FindingSeverity;
    readonly evidence?: readonly { type: string; observation: string }[];
  } = {},
): VerifierChallenge["input"] {
  return {
    candidateId: `${path}:${String(startLine)}`,
    claim: {
      statement,
      steps: [statement],
      trigger: "the changed line executes",
      consequence: "the described failure occurs",
    },
    location: { path, startLine, endLine: startLine },
    evidence: [...(options.evidence ?? [])],
    remediation: "address the described mechanism",
    proposedSeverity: options.severity ?? "medium",
  };
}

export const VERIFIER_CHALLENGES: readonly VerifierChallenge[] = [
  // ── the mechanism the verifier models ──────────────────────────────────
  {
    id: "floating-async-call",
    gold: "should_verify",
    files: {
      "src/caller.ts": [
        'import { save } from "./store.js";',
        "export function run(): void {",
        "  save(1);",
        "}",
      ].join("\n"),
      "src/store.ts": ASYNC_STORE,
    },
    input: claim(
      "the promise from save() is never settled",
      "src/caller.ts",
      3,
    ),
    because:
      "the declaration is asynchronous and the call is a bare expression statement — the one shape this verifier fully models",
    pairedWith: "sync-callee-lookalike",
  },
  {
    id: "sync-callee-lookalike",
    gold: "should_reject",
    files: {
      "src/caller.ts": [
        'import { save } from "./store.js";',
        "export function run(): void {",
        "  save(1);",
        "}",
      ].join("\n"),
      "src/store.ts": SYNC_STORE,
    },
    input: claim(
      "the promise from save() is never settled",
      "src/caller.ts",
      3,
    ),
    because:
      "byte-identical call site, synchronous declaration — the pair proves the verifier reads the declaration rather than the call shape",
    pairedWith: "floating-async-call",
  },
  {
    id: "guarded-by-void",
    gold: "should_reject",
    files: {
      "src/caller.ts": [
        'import { save } from "./store.js";',
        "export function run(): void {",
        "  void save(1);",
        "}",
      ].join("\n"),
      "src/store.ts": ASYNC_STORE,
    },
    input: claim(
      "the promise from save() is never settled",
      "src/caller.ts",
      3,
    ),
    because:
      "`void` is a deliberate fire-and-forget marker; the verifier observes the guard rather than taking the claim's word",
  },
  {
    id: "guarded-by-catch",
    gold: "should_reject",
    files: {
      "src/caller.ts": [
        'import { save } from "./store.js";',
        "export function run(): void {",
        "  save(1).catch(() => undefined);",
        "}",
      ].join("\n"),
      "src/store.ts": ASYNC_STORE,
    },
    input: claim("the rejection from save() is unhandled", "src/caller.ts", 3),
    because: "a rejection handler is present at the claimed site",
  },

  // ── mechanisms the verifier does not model yet ─────────────────────────
  //
  // Graded, not excluded. A capability corpus that only contained capabilities
  // the verifier has would report 100% and measure nothing.
  {
    id: "promise-in-condition-real",
    gold: "should_verify",
    files: {
      "src/gate.ts": [
        "async function isReady(): Promise<boolean> {",
        "  return false;",
        "}",
        "export function run(): void {",
        "  if (isReady()) {",
        "    return;",
        "  }",
        "}",
      ].join("\n"),
    },
    input: claim(
      "a Promise is always truthy, so this guard never fails",
      "src/gate.ts",
      5,
    ),
    because:
      "the mechanism is a call in a condition, which `observeSite` does not follow — currently abstained, and the cost of that abstention is what this case measures",
    pairedWith: "promise-in-condition-safe",
  },
  {
    id: "promise-in-condition-safe",
    gold: "should_reject",
    files: {
      "src/gate.ts": [
        "function isReady(): boolean {",
        "  return false;",
        "}",
        "export function run(): void {",
        "  if (isReady()) {",
        "    return;",
        "  }",
        "}",
      ].join("\n"),
    },
    input: claim(
      "a Promise is always truthy, so this guard never fails",
      "src/gate.ts",
      5,
    ),
    because:
      "identical shape, synchronous declaration — teaching the condition mechanism against only the positive half would confirm this one too",
    pairedWith: "promise-in-condition-real",
  },
  // ── condition value semantics: the rest of the pair set ────────────────
  {
    id: "condition-already-awaited",
    gold: "should_reject",
    files: {
      "src/gate.ts": [
        "async function enabled(): Promise<boolean> {",
        "  return false;",
        "}",
        "export async function run(): Promise<void> {",
        "  if (await enabled()) {",
        "    return;",
        "  }",
        "}",
      ].join("\n"),
    },
    input: claim(
      "`enabled()` returns a promise and is used directly as a condition, so the guard never fails",
      "src/gate.ts",
      5,
    ),
    because:
      "the value is unwrapped before the branch sees it, so the claimed mechanism cannot occur — and the declaration is still `async`, which is what makes this the case a declaration-based check gets wrong",
  },
  {
    id: "condition-shadowed-callee",
    gold: "should_reject",
    files: {
      "src/gate.ts": [
        "async function ready(): Promise<boolean> {",
        "  return false;",
        "}",
        "export function run(ready: () => boolean): void {",
        "  if (ready()) {",
        "    return;",
        "  }",
        "}",
      ].join("\n"),
    },
    input: claim(
      "`ready()` returns a promise and is used directly as a condition, so the guard never fails",
      "src/gate.ts",
      5,
    ),
    because:
      "the epistemic lesson again, in a third capability: an async declaration of the same name is present, and exact binding must resolve the synchronous parameter instead",
  },
  {
    id: "condition-callee-unresolvable",
    gold: "should_abstain",
    files: {
      "src/gate.ts": [
        "export function run(source: { ready: () => unknown }): void {",
        '  if ((source as { ready: () => unknown })["ready"]()) {',
        "    return;",
        "  }",
        "}",
      ].join("\n"),
    },
    input: claim(
      "the call returns a promise and is used directly as a condition, so the guard never fails",
      "src/gate.ts",
      2,
    ),
    because:
      "nothing binds, so the decisive fact is unavailable — and the pressure on this capability will be to raise recall, which is exactly when guessed typing gets introduced",
  },
  {
    id: "signature-callers-migrated",
    // ── A gold label corrected, and why that is not fitting-to-implementation
    //
    // This claim is *"the new parameter breaks existing callers of send()"* —
    // a claim about a population, against an **exported** declaration. Refuting
    // it requires proving the population was enumerated, and enumerating
    // references inside a repository does not prove that consumers outside it
    // do not exist.
    //
    // The original `should_reject` encoded the answer a naive implementation
    // gives: find the callers, see them migrated, refute. That is the commonest
    // static-analysis overclaim there is, and grading it as correct would have
    // rewarded building it.
    //
    // The label changed because the SPECIFICATION was wrong, not because the
    // implementation was inconvenient. The distinction is testable: the
    // stale-call-site pair below is refutable and its gold did not move.
    //
    //     old gold  should_reject
    //     new gold  should_abstain
    //     reason    specification correction — the verifier cannot establish
    //               closed-world consumer coverage for an exported callable
    //     when      decided from the closed-world rule, before the capability
    //               was evaluated against it, not in response to a failure
    //
    // Recorded in this shape so a later auditor can tell a legitimate gold
    // correction from moved goalposts without reconstructing the argument.
    gold: "should_abstain",
    files: {
      "src/api.ts":
        "export function send(a: number, b: string): void {\n  return;\n}",
      "src/caller.ts": [
        'import { send } from "./api.js";',
        "export function run(): void {",
        '  send(1, "x");',
        "}",
      ].join("\n"),
    },
    input: claim(
      "the new parameter breaks existing callers of send()",
      "src/api.ts",
      1,
    ),
    because:
      "every caller in the repository already passes the new argument; refuting this needs reference resolution the verifier does not have",
  },
  {
    id: "empty-catch-real",
    gold: "should_verify",
    files: {
      "src/f.ts": [
        "export function run(): void {",
        "  try {",
        "    commit();",
        "  } catch {}",
        "}",
        "function commit(): void {}",
      ].join("\n"),
    },
    input: claim(
      "the failure from commit() is discarded, so the caller proceeds as if it succeeded",
      "src/f.ts",
      4,
    ),
    because:
      "the swallowed-error mechanism is the handler, not a call — on the abstain list, and this measures what that costs",
    pairedWith: "empty-catch-unprovable-intent",
  },
  {
    id: "empty-catch-unprovable-intent",
    gold: "should_abstain",
    files: {
      "src/g.ts": [
        "export function shutdown(): void {",
        "  try {",
        "    releaseLock();",
        "  } catch {}",
        "}",
        "function releaseLock(): void {}",
      ].join("\n"),
    },
    input: claim(
      "the failure from releaseLock() is discarded, so the caller proceeds as if it succeeded",
      "src/g.ts",
      4,
    ),
    because:
      "best-effort cleanup during shutdown may be deliberate, and nothing in the repository establishes intent either way — abstaining is the correct answer, not a miss",
    pairedWith: "empty-catch-real",
  },

  // ── genuinely undecidable ──────────────────────────────────────────────
  //
  // The cases that stop "fewer abstentions" from being a score to chase.
  {
    id: "unknowable-provider-semantics",
    gold: "should_abstain",
    files: {
      "src/pay.ts": [
        'import { charge } from "./sdk.js";',
        "export async function run(): Promise<void> {",
        "  await charge(100);",
        "  await charge(100);",
        "}",
      ].join("\n"),
      "src/sdk.ts":
        "export async function charge(amount: number): Promise<void> {\n  return;\n}",
    },
    input: claim(
      "a retry double-charges because the provider call is not idempotent",
      "src/pay.ts",
      3,
    ),
    because:
      "whether the provider is idempotent is not in the repository at all; a verifier that decided this would be inventing an answer",
  },
  {
    // Exercises the branch where the checker binds nothing at all — distinct
    // from the file being absent. Added because a mutation that assumed an
    // unbindable callee was synchronous SURVIVED: no challenge reached that
    // line, so the "never guess" rule was asserted in prose and tested nowhere.
    id: "dynamic-callee-unbindable",
    gold: "should_abstain",
    files: {
      "src/dispatch.ts": [
        "export function run(getHandler: () => (value: number) => unknown): void {",
        "  getHandler()(1);",
        "}",
      ].join("\n"),
    },
    input: claim(
      "the promise returned by the handler is discarded",
      "src/dispatch.ts",
      2,
    ),
    because:
      "the callee is itself the result of a call, so the checker binds no symbol at all — and an unbindable callee must abstain rather than be assumed synchronous",
  },
  // ── signature compatibility: paired ────────────────────────────────────
  //
  // Each pair is a real break beside code that is almost identical and correct.
  // A capability taught against only the positive halves would count arguments
  // and score well here while being wrong about optionals, defaults and types —
  // which is to say wrong about most real signature changes.
  {
    id: "signature-stale-caller",
    gold: "should_verify",
    files: {
      "src/api.ts":
        "export function send(id: string, urgent: boolean): void {\n  return;\n}",
      "src/caller.ts": [
        'import { send } from "./api.js";',
        "export function run(id: string): void {",
        "  send(id);",
        "}",
      ].join("\n"),
    },
    input: claim(
      "`send()` is called without `urgent`, which this change made required",
      "src/caller.ts",
      3,
    ),
    because:
      "a specific named call site that the compiler rejects against the new contract — the one signature proposition a bounded consumer scope can settle",
    pairedWith: "signature-migrated-caller",
  },
  {
    id: "signature-migrated-caller",
    gold: "should_reject",
    files: {
      "src/api.ts":
        "export function send(id: string, urgent: boolean): void {\n  return;\n}",
      "src/caller.ts": [
        'import { send } from "./api.js";',
        "export function run(id: string): void {",
        "  send(id, false);",
        "}",
      ].join("\n"),
    },
    input: claim(
      "`send()` is called without `urgent`, which this change made required",
      "src/caller.ts",
      3,
    ),
    because:
      "the same claim against a call that already passes the new argument; the pair proves the verifier reads the call rather than the declaration's shape",
    pairedWith: "signature-stale-caller",
  },
  {
    id: "signature-optional-parameter",
    gold: "should_reject",
    files: {
      "src/api.ts":
        "export function send(id: string, urgent?: boolean): void {\n  return;\n}",
      "src/caller.ts": [
        'import { send } from "./api.js";',
        "export function run(id: string): void {",
        "  send(id);",
        "}",
      ].join("\n"),
    },
    input: claim(
      "`send()` is called without `urgent`, which this change made required",
      "src/caller.ts",
      3,
    ),
    because:
      "the parameter is optional, so the old call is still valid — this is the case that kills arity counting, and it looks identical to the stale one",
  },
  {
    id: "signature-default-parameter",
    gold: "should_reject",
    files: {
      "src/api.ts":
        "export function send(id: string, urgent = false): void {\n  return;\n}",
      "src/caller.ts": [
        'import { send } from "./api.js";',
        "export function run(id: string): void {",
        "  send(id);",
        "}",
      ].join("\n"),
    },
    input: claim(
      "`send()` is called without `urgent`, which this change made required",
      "src/caller.ts",
      3,
    ),
    because:
      "a default makes the parameter omittable; arity is unchanged from the caller's side and the old call remains correct",
  },
  {
    id: "signature-type-changed-same-arity",
    gold: "should_verify",
    files: {
      "src/api.ts": [
        "export interface RetryPolicy {",
        "  attempts: number;",
        "}",
        "export function retry(policy: RetryPolicy): void {",
        "  return;",
        "}",
      ].join("\n"),
      "src/caller.ts": [
        'import { retry } from "./api.js";',
        "export function run(): void {",
        "  retry(3);",
        "}",
      ].join("\n"),
    },
    input: claim(
      "`retry()` is called with an incompatible argument after the signature change",
      "src/caller.ts",
      3,
    ),
    because:
      "same argument count, incompatible type — proves the capability is asking the compiler rather than counting",
  },
  {
    id: "signature-shadowed-callee",
    gold: "should_reject",
    files: {
      "src/api.ts":
        "export function send(id: string, urgent: boolean): void {\n  return;\n}",
      "src/caller.ts": [
        'import { send } from "./api.js";',
        "export function outer(send: (id: string) => void, id: string): void {",
        "  send(id);",
        "}",
      ].join("\n"),
    },
    input: claim(
      "`send()` is called without `urgent`, which this change made required",
      "src/caller.ts",
      3,
    ),
    because:
      "the epistemic lesson, carried into the new capability: the callee is a parameter shadowing the import, and exact binding — not the name — decides which contract applies",
  },

  // ── historical regression ──────────────────────────────────────────────
  {
    id: "historical-shadowed-parameter",
    gold: "should_reject",
    source: "injected_historical_regression",
    files: {
      "src/shadow.ts": [
        'import { save } from "./store.js";',
        "export function run(save: (value: number) => void): void {",
        "  save(1);",
        "}",
      ].join("\n"),
      "src/store.ts": ASYNC_STORE,
    },
    // The claim and evidence the analyzer really emitted, not a simplified
    // restatement. An easier synthetic version would test a claim the analyzer
    // never made, and the regression cover would be for the wrong thing.
    input: {
      candidateId: "historical:shadow",
      claim: {
        statement: "The promise returned by `save()` is discarded.",
        steps: [
          "`save` is asynchronous, so this call returns a Promise",
          "nothing in this statement observes that Promise",
          "so a rejection becomes an unhandled rejection and the caller continues as if the work completed",
        ],
        trigger: "every execution that reaches this statement",
        consequence:
          "the caller proceeds before the work is done, and a failure is invisible",
      },
      location: { path: "src/shadow.ts", startLine: 3, endLine: 3 },
      evidence: [
        {
          type: "static_analysis",
          observation:
            "`save` is declared at src/store.ts:1 with the `async` modifier",
        },
      ],
      remediation: "await the call or attach a rejection handler",
      proposedSeverity: "high",
    },
    because:
      "the analyzer produced exactly this before it learned about lexical shadowing; the verifier binds the callee through the checker, finds the synchronous parameter, and must keep refusing it however the analyzer changes",
  },
  {
    id: "location-outside-context",
    gold: "should_abstain",
    files: {
      "src/present.ts": "export function run(): void {\n  return;\n}",
    },
    input: claim(
      "the promise from save() is never settled",
      "src/absent.ts",
      3,
    ),
    because:
      "the claimed file was never supplied — a planner gap. Rejecting here would make precision improve as the planner got worse",
  },
];
