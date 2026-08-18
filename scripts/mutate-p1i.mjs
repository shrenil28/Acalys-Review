/**
 * Mutation harness for the P1-I trust boundary.
 *
 * A mutation counts as killed only when ALL of these hold:
 *
 *     the mutated source is present on disk   (verified by re-reading it)
 *     the target suite compiled and ran
 *     executed > 0 and skipped = 0
 *     at least one test failed
 *
 * Anything else is reported as INVALID, not as a kill. A mutation that did not
 * apply, or one that broke compilation before a test ran, proves nothing about
 * the tests — and counting it is how a suite acquires a reputation it has not
 * earned.
 *
 * Files are backed up individually, by path. Not `cp -r src /tmp/bak` followed
 * by `cp -r /tmp/bak src`: when the destination already exists that produces
 * `src/src/`, and eighteen duplicated modules once reached a commit that way.
 */
import { execFile } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = process.cwd();

const MUTATIONS = [
  {
    id: 1,
    name: "promote a rejected candidate (store gate removed)",
    file: "packages/database/src/review/verification-store.ts",
    find: 'if (attempt.rows[0]?.decision !== "verified") {',
    replace: "if (false) {",
    suite: "packages/database/tests/verification.test.ts",
  },
  {
    id: 2,
    name: "promote an inconclusive candidate (kernel gate widened)",
    file: "packages/review-engine/src/publication/promote.ts",
    find: 'if (attempt.decision === "verified") {',
    replace: 'if (attempt.decision !== "rejected") {',
    suite: "packages/review-engine/tests/publication.test.ts",
  },
  {
    id: 3,
    name: "treat unavailable as a completed verification",
    file: "packages/review-engine/src/publication/promote.ts",
    find: "if (unavailable.length > 0) {",
    replace: "if (false) {",
    suite: "packages/review-engine/tests/publication.test.ts",
  },
  {
    id: 4,
    name: "redelivery creates a second attempt (request key made unique)",
    file: "apps/review-worker/src/funnel.ts",
    find: "return `acalys:verify:run:${reviewRunId}:candidate:${candidateId}:pass:${String(pass)}`;",
    replace:
      "return `acalys:verify:run:${reviewRunId}:candidate:${candidateId}:pass:${String(pass)}:${String(Math.random())}`;",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 5,
    name: "every invocation reuses ordinal 1",
    file: "packages/database/src/review/verification-scheduler.ts",
    find: "const attempt = next.rows[0]?.attempt ?? 1;",
    replace: "const attempt = 1;",
    suite: "packages/database/tests/verification-scheduling.test.ts",
  },
  {
    id: 6,
    name: "allocate the ordinal without the candidate lock",
    file: "packages/database/src/review/verification-scheduler.ts",
    find: '"SELECT id FROM candidate_findings WHERE id = $1 FOR UPDATE"',
    replace: '"SELECT id FROM candidate_findings WHERE id = $1"',
    suite: "packages/database/tests/verification-scheduling.test.ts",
  },
  {
    id: 7,
    name: "bypass durable scheduling (worker mints its own invocation)",
    file: "apps/review-worker/src/funnel.ts",
    find: "const invocation = await stores.scheduler.schedule({",
    replace:
      "const invocation = { invocationId: randomUUID(), attempt: 1 } as never as Awaited<ReturnType<typeof stores.scheduler.schedule>>;\n    void ({",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 8,
    name: "promotion drops verification_attempt_id causality",
    file: "packages/database/src/review/verification-store.ts",
    find: "          record.verificationAttemptId,\n          now,",
    replace: "          null,\n          now,",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 9,
    name: "concurrent promotion inserts twice (ON CONFLICT removed)",
    file: "packages/database/src/review/verification-store.ts",
    find: "         ON CONFLICT (review_run_id, fingerprint_value)\n           DO UPDATE SET updated_at = review_findings.updated_at",
    replace: "",
    suite: "packages/database/tests/verification.test.ts",
  },
  {
    id: 10,
    name: "reconciliation ignores the fingerprint",
    file: "apps/review-worker/src/funnel.ts",
    find: "        fingerprintValue: candidate.fingerprintValue,",
    replace:
      "        fingerprintValue: randomUUID().padEnd(64, '0').slice(0, 64),",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 11,
    name: "publication policy consumes candidates instead of findings",
    file: "apps/review-worker/src/funnel.ts",
    find: "  const plan = planPublication(\n    findings,",
    replace:
      "  const plan = planPublication(\n    candidates.map((c) => ({ findingId: c.candidateId, fingerprint: c.fingerprintValue, severity: c.severity, category: c.category, path: c.path })),",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 12,
    name: "withheld findings still reach the ledger",
    file: "apps/review-worker/src/funnel.ts",
    find: "  for (const finding of plan.publish) {",
    replace: "  for (const finding of findings) {",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 13,
    name: "zero actionable findings becomes a run failure",
    file: "apps/review-worker/src/funnel.ts",
    find: "  const summary = plan.noActionableFindings",
    replace:
      "  if (plan.noActionableFindings) throw new Error('nothing to publish');\n  const summary = plan.noActionableFindings",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 14,
    name: "pre-merge enforcement derived from what was published",
    file: "apps/review-worker/src/funnel.ts",
    find: "  const checks = evaluatePreMerge(\n    findings,",
    replace: "  const checks = evaluatePreMerge(\n    plan.publish,",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 15,
    name: "advance to reconciling with a candidate unexamined",
    file: "packages/database/src/review/stage-store.ts",
    find: "        if (failWhenZero === true ? count === 0 : count > 0) {",
    replace: "        if (failWhenZero === true ? count === 0 : false) {",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 16,
    name: "an unavailable attempt satisfies the examined entailment",
    file: "packages/database/src/review/stage-store.ts",
    find: "                             AND v.status = 'completed'\n                        )`,",
    replace: "                        )`,",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 19,
    name: "promote citing a rejected attempt (referent widened to any attempt)",
    file: "packages/database/migrations/0008_promotion_referent.sql",
    find: "        REFERENCES verification_attempts (verified_id);",
    replace: "        REFERENCES verification_attempts (id);",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 20,
    name: "the promotion citation becomes optional again",
    file: "packages/database/migrations/0008_promotion_referent.sql",
    find: "    ALTER COLUMN verification_attempt_id SET NOT NULL;",
    replace: "    ALTER COLUMN verification_attempt_id DROP NOT NULL;",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
  {
    id: 21,
    name: "one invocation may record two different results",
    file: "packages/database/src/review/verification-store.ts",
    find: "    if (storedResult !== requestedResult) {",
    replace: "    if (false) {",
    suite: "packages/database/tests/verification.test.ts",
  },
  {
    id: 22,
    name: "an unexamined candidate is reported as an outage",
    file: "packages/review-engine/src/publication/promote.ts",
    find: "  if (missing.length > 0) {",
    replace: "  if (false) {",
    suite: "packages/review-engine/tests/publication.test.ts",
  },
  {
    id: 23,
    name: "adjudicate a claim no procedure covers (competence gate removed)",
    file: "packages/review-engine/src/verification/deterministic.ts",
    find: '  if (competence.kind === "unsupported") {',
    replace: "  if (false) {",
    suite: "packages/review-engine/tests/verifier-capability.test.ts",
  },
  {
    id: 24,
    name: "external semantics no longer dominates the async family",
    file: "packages/review-engine/src/verification/competence.ts",
    find: '    dominates: ["async_value_use", "other_families"],',
    replace: "    dominates: [],",
    suite: "packages/review-engine/tests/competence.test.ts",
  },
  {
    id: 25,
    name: "a capability may produce any reason in the vocabulary",
    file: "packages/review-engine/src/verification/competence.ts",
    find: "  const wrong = reasons.filter((reason) => !allowed.includes(reason));",
    replace: "  const wrong = [];",
    suite: "packages/review-engine/tests/competence.test.ts",
  },
  {
    id: 26,
    // Retargeted after 2b. It was aimed at the funnel suite, and it SURVIVED
    // once the analyzer stopped producing the shadowed candidate: the natural
    // pipeline no longer exercises the verifier's defence against it at all.
    //
    // That is the exact reason the defect is preserved in three forms. The
    // mechanism test and the historical replay are where this guarantee now
    // lives, and the mutation has to be pointed at them or it measures a path
    // that no longer runs.
    name: "a shadowing parameter is treated as asynchronous (name-based answer)",
    file: "packages/review-engine/src/verification/binding.ts",
    find: "    return ts.isFunctionTypeNode(type)\n      ? isPromiseAnnotation(type.type)\n      : undefined;",
    replace: "    return ts.isFunctionTypeNode(type) ? true : undefined;",
    suite: "packages/review-engine/tests/binding.test.ts",
  },
  {
    id: 27,
    name: "an unbindable callee is assumed synchronous",
    file: "packages/review-engine/src/verification/binding.ts",
    find: '    return { kind: "unresolved", why: "the checker could not bind the callee" };',
    replace:
      '    return { kind: "resolved", producesPromise: false, via: "typescript_checker", declaredAt: undefined };',
    suite: "packages/review-engine/tests/verifier-capability.test.ts",
  },
  {
    id: 28,
    name: "analyzer ignores lexical shadowing again",
    file: "packages/code-intelligence/src/symbols.ts",
    find: "        if (declarations.some(declaresName)) {",
    replace: "        if (false) {",
    suite: "packages/review-engine/tests/binding.test.ts",
  },
  {
    id: 29,
    name: "any same-named declaration counts as a shadow",
    file: "packages/code-intelligence/src/symbols.ts",
    find: "      if (span.start <= line && line <= span.end) {",
    replace: "      if (true) {",
    suite: "packages/review-engine/tests/binding.test.ts",
  },
  {
    id: 30,
    name: "competence routing depends on registration order",
    file: "packages/review-engine/src/verification/competence.ts",
    find: "  const surviving = matched.filter((matcher) => !dominated.has(matcher.id));",
    replace: "  const surviving = matched.slice(0, 1);",
    suite: "packages/review-engine/tests/competence.test.ts",
  },
  {
    id: 17,
    name: "promotion writes `published` instead of `verified`",
    file: "packages/database/src/review/verification-store.ts",
    find: "$14,$15,'verified',$16,$17,$17)",
    replace: "$14,$15,'published',$16,$17,$17)",
    suite: "apps/review-worker/tests/lifecycle.test.ts",
  },
  {
    id: 18,
    name: "an unavailable verification no longer fails the run",
    file: "apps/review-worker/src/orchestrator.ts",
    find: 'if (outcome.kind === "unavailable") {',
    replace: "if (false) {",
    suite: "apps/review-worker/tests/funnel.test.ts",
  },
];

const backupDir = mkdtempSync(join(tmpdir(), "acalys-mutate-"));

function backup(file) {
  const target = join(backupDir, file.replaceAll("/", "__"));
  copyFileSync(join(ROOT, file), target);
  return target;
}

function restore(file, saved) {
  copyFileSync(saved, join(ROOT, file));
}

async function runSuite(suite) {
  try {
    const { stdout } = await run(
      "node",
      ["./node_modules/vitest/vitest.mjs", "run", suite, "--reporter=json"],
      { cwd: ROOT, maxBuffer: 200 * 1024 * 1024, env: { ...process.env } },
    );
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function parseReport(stdout) {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

const results = [];

for (const mutation of MUTATIONS) {
  const saved = backup(mutation.file);
  const original = readFileSync(join(ROOT, mutation.file), "utf8");

  const applied = original.includes(mutation.find);
  if (!applied) {
    results.push({
      ...mutation,
      applied: false,
      verdict: "INVALID — pattern not found",
    });
    continue;
  }

  const mutated = original.replace(mutation.find, mutation.replace);
  writeFileSync(join(ROOT, mutation.file), mutated);

  // Verify from disk that the mutation is really there, rather than trusting
  // the write. A harness that assumes its own edit landed is how a mutation
  // that never applied gets counted as killed.
  // Checked by looking for the REPLACEMENT, not by the absence of the pattern.
  // A prepend-style mutation legitimately keeps the original line, and an
  // absence check reported those as "did not apply" — a harness bug that would
  // have hidden a surviving mutant behind an INVALID verdict.
  const onDisk = readFileSync(join(ROOT, mutation.file), "utf8");
  const present = onDisk !== original && onDisk.includes(mutation.replace);

  if (!present) {
    restore(mutation.file, saved);
    results.push({
      ...mutation,
      applied: false,
      verdict: "INVALID — mutation not present on disk",
    });
    continue;
  }

  const outcome = await runSuite(mutation.suite);
  const report = parseReport(outcome.stdout);

  restore(mutation.file, saved);

  if (report === undefined) {
    results.push({
      ...mutation,
      applied: true,
      executed: 0,
      skipped: 0,
      verdict: "INVALID — suite did not run (compile failure or crash)",
      detail: (outcome.stderr ?? "").split("\n").slice(0, 3).join(" "),
    });
    continue;
  }

  const tests = (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({
      name: test.fullName ?? test.title,
      status: test.status,
    })),
  );
  const executed = tests.filter((test) => test.status !== "pending").length;
  const skipped = tests.filter((test) => test.status === "pending").length;
  const failed = tests.filter((test) => test.status === "failed");

  results.push({
    ...mutation,
    applied: true,
    executed,
    skipped,
    failedCount: failed.length,
    failing: failed.slice(0, 3).map((test) => test.name),
    verdict:
      executed > 0 && skipped === 0 && failed.length > 0
        ? "KILLED"
        : executed === 0
          ? "INVALID — executed = 0"
          : skipped > 0
            ? "INVALID — skipped > 0"
            : "SURVIVED",
  });
}

for (const result of results) {
  console.log(
    `\n#${result.id}  ${result.name}\n` +
      `    file      ${result.file}\n` +
      `    suite     ${result.suite}\n` +
      `    applied   ${String(result.applied)}\n` +
      `    executed  ${String(result.executed ?? "-")}   skipped ${String(result.skipped ?? "-")}   failed ${String(result.failedCount ?? "-")}\n` +
      `    verdict   ${result.verdict}` +
      (result.failing?.length
        ? `\n    killed by ${result.failing.join("\n              ")}`
        : "") +
      (result.detail ? `\n    detail    ${result.detail}` : ""),
  );
}

const killed = results.filter((r) => r.verdict === "KILLED").length;
const survived = results.filter((r) => r.verdict === "SURVIVED").length;
const invalid = results.filter((r) => r.verdict.startsWith("INVALID")).length;
console.log(
  `\n\nKILLED ${String(killed)} / SURVIVED ${String(survived)} / INVALID ${String(invalid)}  (of ${String(results.length)})`,
);
process.exit(survived > 0 || invalid > 0 ? 1 : 0);
