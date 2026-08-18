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

export interface VerifierChallenge {
  readonly id: string;
  readonly gold: GoldOutcome;
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
  {
    id: "signature-callers-migrated",
    gold: "should_reject",
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
