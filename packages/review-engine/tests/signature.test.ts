import { describe, expect, it } from "vitest";

import {
  classifySignatureClaim,
  verifySignatureCompatibility,
} from "../src/verification/signature.js";
import type { VerificationContext, VerificationInput } from "../src/index.js";

const contextOf = (files: Record<string, string>): VerificationContext => ({
  items: Object.entries(files).map(([path, content]) => ({
    path,
    content,
    reason: "unit",
  })),
  digest: "unit",
  incomplete: false,
});

const claimAt = (
  statement: string,
  path: string,
  line: number,
): VerificationInput => ({
  candidateId: "c",
  claim: {
    statement,
    steps: [],
    trigger: "the call executes",
    consequence: "the contract is violated",
  },
  location: { path, startLine: line, endLine: line },
  evidence: [],
  remediation: "update the call",
  revisionId: "r",
  repositoryId: "repo",
  proposedSeverity: "high",
});

/**
 * The capability's boundary, tested where it lives.
 *
 * The confusion matrix says what the verdicts are. This says *why they are
 * allowed to be*, which is the part that governs whether the capability can be
 * extended safely.
 */
describe("Signature compatibility respects its consumer scope", () => {
  const API =
    "export function send(id: string, urgent: boolean): void {\n  return;\n}";

  it("classifies a population claim apart from a call-site claim", () => {
    // The same declaration, two different propositions. Routing both into one
    // procedure is how a capability answers a question it was not asked.
    expect(
      classifySignatureClaim(
        claimAt("`send()` is called without `urgent`", "src/c.ts", 3),
      ),
    ).toBe("stale_call_site");

    expect(
      classifySignatureClaim(
        claimAt(
          "the new parameter breaks existing callers of send()",
          "src/api.ts",
          1,
        ),
      ),
    ).toBe("public_api_break");
  });

  it("never refutes a population claim from enumerated references", () => {
    // ── The load-bearing rule ─────────────────────────────────────────────
    //
    // Every caller in this context is migrated. That does NOT establish that
    // every caller in existence is migrated, and `send` is exported. The
    // capability abstains, and the reason names why rather than blaming the
    // context.
    //
    // "findReferences returned four" becoming "four consumers exist" is the
    // commonest static-analysis overclaim there is, and it is invisible when it
    // happens: the review simply says nothing about a breaking API change.
    const outcome = verifySignatureCompatibility(
      claimAt(
        "the new parameter breaks existing callers of send()",
        "src/api.ts",
        1,
      ),
      contextOf({
        "src/api.ts": API,
        "src/caller.ts":
          'import { send } from "./api.js";\nexport function run(id: string): void {\n  send(id, false);\n}',
      }),
    );

    expect(outcome?.attempt.status).toBe("completed");
    if (outcome?.attempt.status !== "completed") throw new Error("unreachable");
    expect(outcome.attempt.decision).toBe("inconclusive");
    expect(outcome.attempt.reasons).toEqual(["consumer_scope_unbounded"]);
    expect(outcome.coverage.scope).toBe("repo_local_only");
  });

  it("settles a call-site claim, because one site is the whole population", () => {
    const stale = verifySignatureCompatibility(
      claimAt(
        "`send()` is called without `urgent`, which this change made required",
        "src/caller.ts",
        3,
      ),
      contextOf({
        "src/api.ts": API,
        "src/caller.ts":
          'import { send } from "./api.js";\nexport function run(id: string): void {\n  send(id);\n}',
      }),
    );
    expect(stale?.attempt).toMatchObject({ decision: "verified" });
    expect(stale?.coverage).toEqual({
      scope: "single_call_site",
      discoveredReferences: 1,
      unresolvedReferences: 0,
    });
  });

  it("abstains when the claimed call site cannot be resolved at all", () => {
    // Not "compatible". A call site the verifier could not find is one it did
    // not examine, and the difference between those two is the whole subject of
    // this checkpoint.
    const outcome = verifySignatureCompatibility(
      claimAt(
        "`send()` is called without `urgent`, which this change made required",
        "src/absent.ts",
        3,
      ),
      contextOf({ "src/api.ts": API }),
    );

    expect(outcome?.attempt).toMatchObject({
      decision: "inconclusive",
      reasons: ["context_incomplete"],
    });
    expect(outcome?.coverage.unresolvedReferences).toBe(1);
  });

  it("asks the compiler rather than counting arguments", () => {
    // Four declarations that differ only in ways arity cannot see. A capability
    // that compared parameter counts would get the first right and the rest
    // wrong, and would look correct in a demo.
    const cases: readonly [string, string, "verified" | "rejected"][] = [
      [
        "export function send(id: string, urgent: boolean): void {\n  return;\n}",
        "  send(id);",
        "verified",
      ],
      [
        "export function send(id: string, urgent?: boolean): void {\n  return;\n}",
        "  send(id);",
        "rejected",
      ],
      [
        "export function send(id: string, urgent = false): void {\n  return;\n}",
        "  send(id);",
        "rejected",
      ],
      [
        "export function send(id: string, ...rest: boolean[]): void {\n  return;\n}",
        "  send(id);",
        "rejected",
      ],
    ];

    for (const [api, call, expected] of cases) {
      const outcome = verifySignatureCompatibility(
        claimAt(
          "`send()` is called without `urgent`, which this change made required",
          "src/caller.ts",
          3,
        ),
        contextOf({
          "src/api.ts": api,
          "src/caller.ts": `import { send } from "./api.js";\nexport function run(id: string): void {\n${call}\n}`,
        }),
      );
      expect(outcome?.attempt, api).toMatchObject({ decision: expected });
    }
  });

  it("ignores compile errors that are not about this call's arguments", () => {
    // ── Two filters, both load-bearing, both easy to drop ─────────────────
    //
    // The program has no standard library and is a subset of a repository, so
    // unrelated diagnostics are normal. Two separate mistakes are available:
    //
    //     count any diagnostic code     an unresolved name "proves" a break
    //     count diagnostics anywhere    an error ten lines away decides this call
    //
    // Either turns the capability into one that verifies almost everything, and
    // both look like simplifications. They are asserted separately, because a
    // single fixture killed neither: the diagnostics have to fall inside the
    // target call for the first and outside it for the second.
    const files = {
      "src/api.ts":
        "export function send(id: string, urgent?: boolean): void {\n  return;\n}",
      "src/caller.ts": [
        'import { send } from "./api.js";',
        "export function run(id: string): void {",
        "  send(id, missingFlag);",
        "  send(id);",
        "  const broken: number = alsoMissing;",
        // A genuine ARGUMENT error, elsewhere in the file. Without the position
        // filter this one decides line 4, which is the whole point: the first
        // version of this fixture used only `Cannot find name`, which the CODE
        // filter already excluded, so the position mutation survived against a
        // test written to kill it.
        "  send();",
        "}",
      ].join("\n"),
    };
    const statement =
      "`send()` is called without `urgent`, which this change made required";

    // Line 3 carries an unresolved name INSIDE the call. The call still
    // satisfies `send`; the undefined identifier is a different defect and is
    // not this claim's subject.
    expect(
      verifySignatureCompatibility(
        claimAt(statement, "src/caller.ts", 3),
        contextOf(files),
      )?.attempt,
    ).toMatchObject({
      decision: "rejected",
      reasons: ["call_site_satisfies_contract"],
    });

    // Line 4 is clean, and the file is not. Errors on lines 3 and 5 must not
    // decide it.
    expect(
      verifySignatureCompatibility(
        claimAt(statement, "src/caller.ts", 4),
        contextOf(files),
      )?.attempt,
    ).toMatchObject({
      decision: "rejected",
      reasons: ["call_site_satisfies_contract"],
    });
  });

  it("declines the signature claim kinds it has no procedure for", () => {
    // Declared and not implemented, which is the honest state. Each is a named
    // target rather than a silent gap, and none of them may reach the
    // call-site procedure and get a confident answer to a different question.
    for (const statement of [
      "the consumer assumes the old return type of send()",
      "this callback no longer satisfies interface Sink",
      "the subclass override no longer satisfies the base contract",
      "a previously valid overload is no longer accepted",
    ]) {
      const outcome = verifySignatureCompatibility(
        claimAt(statement, "src/api.ts", 1),
        contextOf({ "src/api.ts": API }),
      );
      expect(outcome?.attempt, statement).toMatchObject({
        decision: "inconclusive",
      });
    }
  });
});
