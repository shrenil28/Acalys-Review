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
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { acquireSession, releaseSession } from "./mutation-session.mjs";

const run = promisify(execFile);
const ROOT = process.cwd();

const ALL_MUTATIONS = [
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
    // Aimed at the mechanism rather than the data. The earlier version matched
    // the external-semantics `dominates` array literally and went stale on
    // every capability added — three times — reporting INVALID when the
    // property was in fact untested. A mutation whose pattern rots is a
    // mutation that quietly stops being evidence.
    name: "declared dominance is ignored",
    file: "packages/review-engine/src/verification/competence.ts",
    find: "  const dominated = new Set(matched.flatMap((matcher) => matcher.dominates));",
    replace: "  const dominated = new Set<string>();",
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
    id: 31,
    name: "a population claim is refuted from repo-local callers",
    file: "packages/review-engine/src/verification/signature.ts",
    find: '  if (kind !== "stale_call_site") {',
    replace: "  if (false) {",
    suite: "packages/review-engine/tests/signature.test.ts",
  },
  {
    id: 32,
    name: "an unresolvable call site counts as compatible",
    file: "packages/review-engine/src/verification/signature.ts",
    find: "  if (outcome === undefined) {",
    replace: "  if (false) {",
    suite: "packages/review-engine/tests/signature.test.ts",
  },
  {
    id: 33,
    name: "any diagnostic counts as an incompatible call",
    file: "packages/review-engine/src/verification/signature.ts",
    find: "        ARGUMENT_ERRORS.has(diagnostic.code) &&",
    replace: "        true &&",
    suite: "packages/review-engine/tests/signature.test.ts",
  },
  {
    id: 34,
    name: "diagnostics anywhere in the file count against this call",
    file: "packages/review-engine/src/verification/signature.ts",
    find: "        diagnostic.start >= from &&\n        diagnostic.start <= to,",
    replace: "        true,",
    suite: "packages/review-engine/tests/signature.test.ts",
  },
  {
    id: 35,
    name: "an unbindable condition callee is assumed to be a promise",
    file: "packages/review-engine/src/verification/condition.ts",
    find: '    return decide("inconclusive", ["insufficient_evidence"], 0.25);',
    replace:
      '    return decide("verified", ["condition_branches_on_promise"], 0.25);',
    suite: "packages/review-engine/tests/condition.test.ts",
  },
  {
    id: 36,
    name: "an awaited condition is still treated as branching on a promise",
    file: "packages/review-engine/src/verification/condition.ts",
    find: "  if (site.unwrapped) {",
    replace: "  if (false) {",
    suite: "packages/review-engine/tests/condition.test.ts",
  },
  {
    id: 37,
    name: "the condition capability also claims forEach callbacks",
    file: "packages/review-engine/src/verification/competence.ts",
    find: "      /\\bbranch(?:es)? on\\b/i,",
    replace: "      /\\bawait\\w*\\b/i,",
    suite: "packages/review-engine/tests/condition.test.ts",
  },
  {
    id: 38,
    name: "an empty catch alone counts as a violation",
    file: "packages/review-engine/src/verification/exception.ts",
    find: '  return decide("inconclusive", ["intent_not_establishable"], 0.2);',
    replace:
      '  return decide("verified", ["suppressed_failure_reported_as_success"], 0.2);',
    suite: "packages/review-engine/tests/exception.test.ts",
  },
  {
    id: 39,
    name: "a rethrow no longer counts as contracted suppression",
    file: "packages/review-engine/src/verification/exception.ts",
    find: "    if (ts.isThrowStatement(node)) rethrows = true;",
    replace: "    if (false) rethrows = true;",
    suite: "packages/review-engine/tests/exception.test.ts",
  },
  {
    id: 40,
    name: "any return after the catch counts as reporting success",
    file: "packages/review-engine/src/verification/exception.ts",
    find: "        if (ts.isReturnStatement(after) && reportsSuccess(after.expression)) {",
    replace: "        if (ts.isReturnStatement(after)) {",
    suite: "packages/review-engine/tests/exception.test.ts",
  },
  {
    id: 41,
    name: "the receiver is identified by method name instead of binding",
    file: "packages/review-engine/src/verification/callback.ts",
    find: '  if (contract.kind === "consumes" || contract.kind === "propagates") {',
    replace: "  if (false) {",
    suite: "packages/review-engine/tests/callback.test.ts",
  },
  {
    id: 42,
    name: "an ignored callback promise alone proves the defect",
    file: "packages/review-engine/src/verification/callback.ts",
    find: "  if (!proceedsAfterwards(call)) {",
    replace: "  if (false) {",
    suite: "packages/review-engine/tests/callback.test.ts",
  },
  {
    id: 43,
    name: "an unreadable receiver contract is assumed to drop the promise",
    file: "packages/review-engine/src/verification/callback.ts",
    find: '    return decide("inconclusive", ["receiver_contract_unavailable"], 0.2);\n  }\n  if (contract.kind === "consumes"',
    replace:
      '    return decide("verified", ["callback_result_discarded_by_receiver"], 0.2);\n  }\n  if (contract.kind === "consumes"',
    suite: "packages/review-engine/tests/callback.test.ts",
  },
  {
    id: 44,
    name: "the startup limiter admits every process at once",
    file: "packages/database/tests/startup-limit.ts",
    find: "  const deadline = Date.now() + STALE_AFTER_MS * 2;",
    replace: "  const deadline = Date.now() - 1;",
    suite: "packages/database/tests/startup-limit.test.ts",
  },
  {
    id: 45,
    name: "a slot is never released after the work throws",
    file: "packages/database/tests/startup-limit.ts",
    find: "    if (held !== undefined) rmSync(held, { recursive: true, force: true });",
    replace:
      '    if (false) rmSync(held ?? "", { recursive: true, force: true });',
    suite: "packages/database/tests/startup-limit.test.ts",
  },
  {
    id: 46,
    name: "absent provider usage is reported as zero",
    file: "packages/review-engine/src/telemetry/report.ts",
    find: "      modelCalls === 0\n        ? notApplicable(noModels)\n        : measured(\n            measurements.reduce(\n              (total, entry) => total + (entry.inference?.inputTokens ?? 0),",
    replace:
      "      false\n        ? notApplicable(noModels)\n        : measured(\n            measurements.reduce(\n              (total, entry) => total + (entry.inference?.inputTokens ?? 0),",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 47,
    // Retargeted after P1-J.5 made `totalCostUsd` derive through the
    // composition rules instead of being asserted. The third time a mutation
    // pattern has gone stale on a refactor — the harness reports INVALID and
    // exits non-zero, which is the whole reason that is a loud outcome rather
    // than a quiet pass.
    name: "unmeasured total cost becomes $0.00",
    file: "packages/review-engine/src/telemetry/report.ts",
    find:
      "    totalCostUsd: add(\n      measured(0),\n      unmeasured(\n" +
      '        "CPU, container, database and storage cost are not accounted for",\n' +
      "      ),\n    ),",
    replace: "    totalCostUsd: measured(0),",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 48,
    name: "a zero denominator yields zero instead of undefined",
    file: "packages/review-engine/src/telemetry/measurement.ts",
    find: '  return denominator === 0\n    ? { kind: "undefinedRatio", because }',
    replace: '  return false\n    ? { kind: "undefinedRatio", because }',
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 49,
    name: "the timing wrapper swallows the work's error",
    file: "packages/review-engine/src/telemetry/recorder.ts",
    find: "    throw error;\n  }\n}",
    replace: "    return undefined as never;\n  }\n}",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 50,
    name: "a failing metric sink fails the review",
    file: "packages/review-engine/src/telemetry/recorder.ts",
    find: "  try {\n    recorder.record(measurement);\n  } catch {",
    replace:
      "  try {\n    recorder.record(measurement);\n  } catch (error) {\n    throw error;\n  }\n  if (false) {",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 51,
    name: "retries are counted as distinct logical invocations",
    file: "packages/review-engine/src/telemetry/report.ts",
    find: "  const logicalInvocations = new Set(\n    measurements.map((entry) => entry.invocationId),\n  ).size;",
    replace: "  const logicalInvocations = measurements.length;",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 52,
    name: "summed execution time is reported as stage latency",
    file: "packages/review-engine/src/telemetry/report.ts",
    find: "    p50: percentile(sorted, 0.5),",
    replace: "    p50: measured(sorted.reduce((t, v) => t + v, 0)),",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 53,
    name: "an unknown component no longer absorbs the total",
    file: "packages/review-engine/src/telemetry/measurement.ts",
    find: '  if (left.kind === "unmeasured") return left;\n  if (right.kind === "unmeasured") return right;',
    replace: "",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 54,
    name: "provider usage without model calls passes consistency",
    file: "packages/review-engine/src/telemetry/report.ts",
    find: '    if (report.providerInputTokens.kind !== "notApplicable") {',
    replace: "    if (false) {",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 55,
    name: "fewer executions than work units passes consistency",
    file: "packages/review-engine/src/telemetry/report.ts",
    find: "  if (report.physicalAttempts < report.logicalInvocations) {",
    replace: "  if (false) {",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 56,
    name: "clean-case tokens counted against the finding denominator",
    file: "packages/review-engine/src/eval/funnel.ts",
    find: "    tokensPerCleanCase: ratio(\n      cleanTokens,",
    replace:
      "    tokensPerCleanCase: ratio(\n      analysisTokens + verificationTokens,",
    suite: "packages/review-engine/tests/funnel-baseline.test.ts",
  },
  {
    id: 57,
    name: "durations measured with a wall clock instead of a monotonic one",
    file: "packages/review-engine/src/telemetry/recorder.ts",
    find: "  const from = monotonicNow();",
    replace: "  const from = Number.NaN;",
    suite: "packages/review-engine/tests/telemetry.test.ts",
  },
  {
    id: 58,
    name: "every suite shares one database name",
    file: "packages/database/tests/postgres.ts",
    find: "  const database = `acalys_test_${RUN_ID.slice(0, 12)}_${label}`.replace(",
    replace: "  const database = `acalys_test_shared`.replace(",
    suite: "packages/database/tests/isolation.test.ts",
  },
  {
    id: 59,
    name: "suite code receives the maintenance connection",
    file: "packages/database/tests/postgres.ts",
    find: "  return await connect(port, database);",
    replace: "  return await connect(port, MAINTENANCE_DATABASE);",
    suite: "packages/database/tests/isolation.test.ts",
  },
  {
    id: 60,
    // Aimed at the constant, not the call site. The previous pattern matched
    // the `withStartupSlot(...)` invocation and went stale the moment that call
    // gained a third argument and prettier wrapped it — the fourth pattern in
    // this file to rot on a reformat. A value is harder to reformat than a
    // call.
    name: "the shared server boots without single-flight coordination",
    file: "packages/database/tests/postgres.ts",
    find: "const MAX_CONCURRENT_STARTUPS = 1;",
    replace: "const MAX_CONCURRENT_STARTUPS = 99;",
    suite: "packages/database/tests/shared-server.test.ts",
  },
  // ── frontend semantic boundary ─────────────────────────────────────────
  //
  // Aimed at meaning, never at presentation. Mutating a Tailwind class would
  // cost a full run and prove nothing; these change what a developer is told
  // about their code.
  {
    id: 61,
    name: "a verified-but-withheld finding is shown as Open",
    file: "apps/web/src/lib/findings.ts",
    find: '      return { visibility: "visible", status: "In review" };\n    case "published":',
    replace:
      '      return { visibility: "visible", status: "Open" };\n    case "published":',
    suite: "apps/web/tests/findings.test.ts",
  },
  {
    id: 62,
    name: "a superseded finding becomes visible",
    file: "apps/web/src/lib/findings.ts",
    find: '      return { visibility: "hidden", reason: "superseded" };',
    replace: '      return { visibility: "visible", status: "Open" };',
    suite: "apps/web/tests/findings.test.ts",
  },
  {
    id: 63,
    name: "a stale finding is reported as fixed",
    file: "apps/web/src/lib/findings.ts",
    find: '    case "stale":\n      // The code beneath it moved',
    replace:
      '    case "stale":\n      return { visibility: "visible", status: "Fixed" };\n    // The code beneath it moved',
    suite: "apps/web/tests/findings.test.ts",
  },
  {
    id: 64,
    name: "a hidden finding is dropped without its reason",
    file: "apps/web/src/lib/findings.ts",
    find: '    if (presentation.visibility === "hidden") continue;',
    replace: "    if (false) continue;",
    suite: "apps/web/tests/findings.test.ts",
  },
  {
    id: 65,
    name: "a failed request validates as an empty success",
    file: "apps/web/src/lib/api/client.ts",
    find: "      if (!response.ok) {",
    replace: "      if (false) {",
    suite: "apps/web/tests/api-client.test.ts",
  },
  {
    id: 66,
    name: "an unvalidated response is accepted",
    file: "apps/web/src/lib/api/client.ts",
    find: "      if (!parsed.success) {",
    replace: "      if (false) {",
    suite: "apps/web/tests/api-client.test.ts",
  },
  {
    id: 67,
    name: "missing configuration silently becomes fixtures",
    file: "apps/web/src/lib/api/config.ts",
    find: "  if (isProduction) {",
    replace: "  if (false) {",
    suite: "apps/web/tests/data-mode.test.ts",
  },
  {
    id: 68,
    name: "the backend's finding identity is replaced by position",
    file: "apps/web/src/lib/findings.ts",
    find: "      id: finding.id,",
    replace: "      id: String(views.length),",
    suite: "apps/web/tests/findings.test.ts",
  },
  {
    id: 70,
    name: "an unfinished blocking check reads as permission",
    file: "apps/web/src/lib/premerge.ts",
    find: "  if (unsettledBlocking.length > 0) {",
    replace: "  if (false) {",
    suite: "apps/web/tests/premerge.test.ts",
  },
  {
    id: 71,
    name: "a review with no checks reads as permission",
    file: "apps/web/src/lib/premerge.ts",
    find: "  if (views.length === 0) {",
    replace: "  if (false) {",
    suite: "apps/web/tests/premerge.test.ts",
  },
  {
    id: 72,
    name: "a failed check with blocking=false renders as passed",
    file: "apps/web/src/lib/premerge.ts",
    find: '    case "failed":\n      return { kind: "settled", label: "Failed" };',
    replace:
      '    case "failed":\n      return { kind: "settled", label: "Passed" };',
    suite: "apps/web/tests/premerge.test.ts",
  },
  {
    id: 73,
    name: "an inconclusive check is reported as passed",
    file: "apps/web/src/lib/premerge.ts",
    find: '      return { kind: "settled", label: "Inconclusive" };',
    replace: '      return { kind: "settled", label: "Passed" };',
    suite: "apps/web/tests/premerge.test.ts",
  },
  {
    id: 74,
    name: "production fixtures without demo authorization are allowed",
    file: "apps/web/src/lib/api/config.ts",
    find: "    if (isProduction && !demoAuthorized) {",
    replace: "    if (false) {",
    suite: "apps/web/tests/data-mode.test.ts",
  },
  {
    id: 75,
    name: "a dev API URL with no mode silently serves fixtures",
    file: "apps/web/src/lib/api/config.ts",
    find: "  if (baseUrl !== undefined) {",
    replace: "  if (false) {",
    suite: "apps/web/tests/data-mode.test.ts",
  },
  {
    // Replaces a frontend twin that went INVALID when the rule moved into the
    // contract. One policy, one mutation: retargeting the old one at the same
    // line would have been two mutations proving one thing, and the second
    // would rot the next time either file moved.
    id: 76,
    name: "the shared blocking rule ignores status",
    file: "packages/contracts/src/domain/premerge/premerge.ts",
    find: '  return check.blocking && check.status === "failed";',
    replace: "  return check.blocking;",
    suite: "apps/web/tests/premerge.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-L.1 — the repository index.
  //
  // 77-85 target the facts; 86-88 target the production seam. The split is
  // the checkpoint's whole point: a mechanism mutation that dies proves the
  // index is correct, and only a wiring mutation that dies proves anything
  // uses it. P1-K closed once on a false claim with the first kind passing
  // and the second kind absent.
  // ---------------------------------------------------------------------
  {
    id: 77,
    name: "the index identity ignores the revision",
    file: "packages/code-intelligence/src/repository-index/identity.ts",
    find: "    left.revision.algorithm === right.revision.algorithm &&\n    left.revision.value === right.revision.value &&\n",
    replace: "",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 78,
    name: "the extractor version leaves the digest preimage",
    file: "packages/code-intelligence/src/repository-index/digest.ts",
    find: '    line(["identity", "extractor", identity.extractorVersion]),\n',
    replace: "",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 79,
    name: "symbols are grouped by name instead of by the checker's symbol",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: '    const key = site.symbol ?? (Symbol("unbound") as unknown as ts.Node);',
    replace: "    const key = site.name as unknown as ts.Node;",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 80,
    name: "`not_indexed` collapses into `absent`",
    file: "packages/code-intelligence/src/repository-index/query.ts",
    find: '  if (module.coverage !== "indexed") {',
    replace: "  if (false as boolean) {",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 81,
    name: "canonical form follows the array order it was handed",
    file: "packages/code-intelligence/src/repository-index/digest.ts",
    find: "for (const record of [...index.symbols].sort(byLine(symbolLine))) {",
    replace: "for (const record of index.symbols) {",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 82,
    name: "the digest drops its length prefixes",
    file: "packages/code-intelligence/src/repository-index/digest.ts",
    find: "  return `${String(value.length)}:${value}`;",
    replace: "  return value;",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 83,
    name: "an unsupported language is skipped rather than recorded",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: "    if (!isSupported(path)) {",
    replace: "    if (false as boolean) {",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 84,
    name: "a module that failed to parse is recorded as indexed",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: '    const coverage: ModuleCoverage =\n      syntactic.length === 0 ? "indexed" : "parse_failed";',
    replace: '    const coverage: ModuleCoverage = "indexed";',
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 85,
    name: "an unavailable index is built as an ordinary empty one",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: "  return {\n    identity,\n    availability,\n    coverage: {\n      modulesTotal: 0,",
    replace:
      '  return {\n    identity,\n    availability: { kind: "built" },\n    coverage: {\n      modulesTotal: 0,',
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 86,
    name: "the production path plans without the repository index",
    file: "apps/review-worker/src/analysis.ts",
    find: "      sources: repository,\n      index,\n",
    replace: "      sources: repository,\n",
    suite: "apps/review-worker/tests/index-wiring.test.ts",
  },
  {
    id: 87,
    name: "the index is built for a revision that is not the head",
    file: "apps/review-worker/src/analysis.ts",
    find: "    revision: gitObjectId(options.headSha),",
    replace: '    revision: gitObjectId("0".repeat(40)),',
    suite: "apps/review-worker/tests/index-wiring.test.ts",
  },
  {
    id: 88,
    name: "an index-derived context item claims direct-source provenance",
    file: "packages/code-intelligence/src/planner.ts",
    find: '          source: "repository_index",\n          indexIdentity: describeIdentity(record.index.identity),\n          recordId: declaration.declarationId,',
    replace:
      '          source: "direct_source" as "repository_index",\n          indexIdentity: describeIdentity(record.index.identity),\n          recordId: declaration.declarationId,',
    suite: "apps/review-worker/tests/index-wiring.test.ts",
  },
  {
    id: 89,
    name: "declaration multiplicity is reported as resolution ambiguity",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: '  return { resolution: "exact", symbol };',
    replace:
      '  return {\n    resolution: declarations.length > 1 ? "ambiguous" : "exact",\n    symbol,\n  };',
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 90,
    name: "an unscoped index reports itself as persistable",
    file: "packages/code-intelligence/src/repository-index/identity.ts",
    find: '  return identity.tenant.kind === "tenant";',
    replace: "  return true;",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 91,
    name: "the syntactic representation wins over the indexed one",
    file: "packages/code-intelligence/src/planner.ts",
    find: '  return candidate.provenance?.source === "repository_index" ? 1 : 0;',
    replace: "  return 0;",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 92,
    name: "an unusable index still suppresses the syntactic fallback",
    file: "packages/code-intelligence/src/planner.ts",
    find: "  if (index === undefined || !isUsable(index)) return [];\n\n  const found = new Map<string, DeclarationRecord>();",
    replace:
      "  if (index === undefined) return [];\n\n  const found = new Map<string, DeclarationRecord>();",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 93,
    name: "an absent field is encoded as an empty one",
    file: "packages/code-intelligence/src/repository-index/digest.ts",
    find: '  parts.map((part) => (part === undefined ? ABSENT : encode(part))).join("");',
    replace: '  parts.map((part) => encode(part ?? "")).join("");',
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-L.2 — references and bindings.
  //
  // 94-99 target the facts; 100 targets the production seam. 94 is the one
  // the checkpoint exists for: resolving by name rather than by symbol does
  // not fail loudly, it hands a reviewer a real declaration from a real file
  // that the changed code never calls.
  // ---------------------------------------------------------------------
  {
    id: 94,
    name: "bindings resolve by name instead of by the checker's symbol",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: "      site.symbol === undefined ? undefined : symbolIds.get(site.symbol);",
    replace: "      symbols.find((s) => s.name === site.name)?.symbolId;",
    suite: "packages/code-intelligence/tests/repository-bindings.test.ts",
  },
  {
    id: 95,
    name: "import aliases are not followed to the declaration",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: "  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) {\n    return { symbol, viaAlias: false };\n  }",
    replace:
      "  return { symbol, viaAlias: false };\n  if (false as boolean) {\n  }",
    suite: "packages/code-intelligence/tests/repository-bindings.test.ts",
  },
  {
    id: 96,
    name: "`external` collapses into `unresolved`",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: '        : symbolId === undefined\n          ? "external"\n          : "exact";',
    replace:
      '        : symbolId === undefined\n          ? "unresolved"\n          : "exact";',
    suite: "packages/code-intelligence/tests/repository-bindings.test.ts",
  },
  {
    id: 97,
    name: "unresolvable references are dropped instead of recorded",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: "  for (const site of referenceSites) {",
    replace:
      "  for (const site of referenceSites.filter((s) => s.symbol !== undefined)) {",
    suite: "packages/code-intelligence/tests/repository-bindings.test.ts",
  },
  {
    id: 98,
    name: "`not_indexed` collapses into `unbound` for bindings",
    file: "packages/code-intelligence/src/repository-index/query.ts",
    find: '  if (module === undefined || module.coverage !== "indexed") {',
    replace: "  if (false as boolean) {",
    suite: "packages/code-intelligence/tests/repository-bindings.test.ts",
  },
  {
    id: 99,
    name: "an unusable index still yields bound callees",
    file: "packages/code-intelligence/src/planner.ts",
    find: "  if (index === undefined || !isUsable(index)) return [];\n\n  const seen = new Set<string>();",
    replace:
      "  if (index === undefined) return [];\n\n  const seen = new Set<string>();",
    suite: "packages/code-intelligence/tests/repository-bindings.test.ts",
  },
  {
    id: 100,
    name: "the production path stops consuming bindings",
    file: "packages/code-intelligence/src/planner.ts",
    find: "      ? boundCallees(input.index, changed.path)",
    replace: "      ? ([] as ReturnType<typeof boundCallees>)",
    suite: "apps/review-worker/tests/binding-wiring.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-L.3 — incremental invalidation.
  //
  // 101-109 target the plan and its execution; 110-111 target the production
  // seam. Every one is an UNDER-invalidation: keeping a stale fact rather
  // than losing one. That direction is the dangerous one — over-invalidating
  // is slower and still correct, while under-invalidating produces a
  // confident wrong answer with full provenance attached.
  // ---------------------------------------------------------------------
  {
    id: 101,
    name: "dependent modules are not invalidated",
    file: "packages/code-intelligence/src/repository-index/incremental-plan.ts",
    find: '          if (touched.has(dependency)) return "references_changed_module";',
    replace:
      '          if (false as boolean) return "references_changed_module";',
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 102,
    name: "a modified module is treated as unchanged",
    file: "packages/code-intelligence/src/repository-index/incremental-plan.ts",
    find: '      if (manifest.modified.includes(module.moduleId)) return "modified";',
    replace: '      if (false as boolean) return "modified";',
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 103,
    name: "an unresolved reference stops forcing recomputation",
    file: "packages/code-intelligence/src/repository-index/incremental-plan.ts",
    find: "      if (universal.has(module.moduleId)) {",
    replace: "      if (false as boolean) {",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 104,
    name: "a module that failed to parse at H1 is retained",
    file: "packages/code-intelligence/src/repository-index/incremental-plan.ts",
    find: '      if (module.coverage !== "indexed") return "not_indexed_previously";',
    replace: '      if (false as boolean) return "not_indexed_previously";',
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 105,
    name: "the change manifest reports nothing as modified",
    file: "packages/code-intelligence/src/repository-index/incremental-plan.ts",
    find: "    else if (known !== digestOf(content)) modified.push(path);",
    replace: "    else if (false as boolean) modified.push(path);",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 106,
    name: "a deleted module is counted as retained",
    file: "packages/code-intelligence/src/repository-index/incremental-plan.ts",
    find: "    if (removedSet.has(module.moduleId)) continue;",
    replace: "    if (false as boolean) continue;",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 107,
    name: "carried records keep their H1 revision stamp",
    file: "packages/code-intelligence/src/repository-index/incremental.ts",
    find: "      provenance: { ...reference.provenance, revision },",
    replace: "      provenance: { ...reference.provenance },",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 108,
    name: "a revision mismatch is accepted instead of refused",
    file: "packages/code-intelligence/src/repository-index/incremental.ts",
    find: "    manifest.previousRevision.value !== previous.identity.revision.value ||",
    replace: "    (false as boolean) ||",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 109,
    name: "an unusable previous index is used as a basis",
    file: "packages/code-intelligence/src/repository-index/incremental.ts",
    find: '  if (previous.availability.kind !== "built") {',
    replace: "  if (false as boolean) {",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 110,
    name: "production ignores the previous index",
    file: "apps/review-worker/src/analysis.ts",
    find: "    if (options.previousIndex !== undefined) {",
    replace: "    if (false as boolean) {",
    suite: "apps/review-worker/tests/incremental-wiring.test.ts",
  },
  {
    id: 111,
    name: "the incremental path reports no stats",
    file: "apps/review-worker/src/analysis.ts",
    find: "      return { index: outcome.index, indexStats: outcome.stats };",
    replace: "      return { index: outcome.index };",
    suite: "apps/review-worker/tests/incremental-wiring.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-L.3 — the production commit barrier.
  //
  // 112-120 target one consistency rule each; 121 removes the barrier from
  // the production path; 122 makes the statistics describe intentions rather
  // than what executed.
  //
  // These exist because a call-graph trace disproved the reason this file
  // previously had none: the full-rebuild oracle runs only in tests, so in
  // production `validateIndexConsistency` is the sole check before an index
  // is labelled H2.
  // ---------------------------------------------------------------------
  {
    id: 112,
    name: "an exact binding may name no symbol",
    file: "packages/code-intelligence/src/repository-index/consistency.ts",
    find: "        if (edge.symbolId === undefined) {",
    replace: "        if (false as boolean) {",
    suite: "packages/code-intelligence/tests/index-consistency.test.ts",
  },
  {
    id: 113,
    name: "an exact binding may point at no declaration",
    file: "packages/code-intelligence/src/repository-index/consistency.ts",
    find: '        if (edge.declarationIds.length === 0) {\n          return {\n            rule: "exact_without_declarations",',
    replace:
      '        if (false as boolean) {\n          return {\n            rule: "exact_without_declarations",',
    suite: "packages/code-intelligence/tests/index-consistency.test.ts",
  },
  {
    id: 114,
    name: "a declaration may belong to a different symbol",
    file: "packages/code-intelligence/src/repository-index/consistency.ts",
    find: "          if (declarationOwner.get(declarationId) !== edge.symbolId) {",
    replace: "          if (false as boolean) {",
    suite: "packages/code-intelligence/tests/index-consistency.test.ts",
  },
  {
    id: 115,
    name: "an external binding may name an internal symbol",
    file: "packages/code-intelligence/src/repository-index/consistency.ts",
    find: '        if (edge.symbolId !== undefined) {\n          return {\n            rule: "external_with_symbol",',
    replace:
      '        if (false as boolean) {\n          return {\n            rule: "external_with_symbol",',
    suite: "packages/code-intelligence/tests/index-consistency.test.ts",
  },
  {
    id: 116,
    name: "an unresolved binding may name a symbol",
    file: "packages/code-intelligence/src/repository-index/consistency.ts",
    find: '        if (edge.symbolId !== undefined) {\n          return {\n            rule: "unresolved_with_symbol",',
    replace:
      '        if (false as boolean) {\n          return {\n            rule: "unresolved_with_symbol",',
    suite: "packages/code-intelligence/tests/index-consistency.test.ts",
  },
  {
    id: 117,
    name: "an ambiguous binding may name exactly one symbol",
    file: "packages/code-intelligence/src/repository-index/consistency.ts",
    find: '        if (edge.symbolId !== undefined) {\n          return {\n            rule: "ambiguous_with_symbol",',
    replace:
      '        if (false as boolean) {\n          return {\n            rule: "ambiguous_with_symbol",',
    suite: "packages/code-intelligence/tests/index-consistency.test.ts",
  },
  {
    id: 118,
    name: "a reference may carry no binding at all",
    file: "packages/code-intelligence/src/repository-index/consistency.ts",
    find: "    if (!bound.has(record.referenceId)) {",
    replace: "    if (false as boolean) {",
    suite: "packages/code-intelligence/tests/index-consistency.test.ts",
  },
  {
    id: 119,
    name: "one reference may carry two bindings",
    file: "packages/code-intelligence/src/repository-index/consistency.ts",
    find: "    if (bound.has(edge.referenceId)) {",
    replace: "    if (false as boolean) {",
    suite: "packages/code-intelligence/tests/index-consistency.test.ts",
  },
  {
    id: 120,
    name: "a record may carry another revision's stamp",
    file: "packages/code-intelligence/src/repository-index/consistency.ts",
    find: '    if (record.provenance.revision !== revision) {\n      return {\n        rule: "declaration_revision_mismatch",',
    replace:
      '    if (false as boolean) {\n      return {\n        rule: "declaration_revision_mismatch",',
    suite: "packages/code-intelligence/tests/index-consistency.test.ts",
  },
  {
    id: 121,
    name: "the production path skips the commit barrier",
    file: "packages/code-intelligence/src/repository-index/incremental.ts",
    find: "  const violation = validateIndexConsistency(candidate);",
    replace:
      "  const violation = undefined as ReturnType<typeof validateIndexConsistency>;",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 122,
    name: "the stats count planned work instead of executed work",
    file: "packages/code-intelligence/src/repository-index/incremental.ts",
    find: "      referencesRecomputed: fresh.references.length,",
    replace: "      referencesRecomputed: recomputed.size,",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  // Statistics are observational, not load-bearing: these mutations leave the
  // index identical and fail because the MEASUREMENT became false. That is
  // legitimate here only because L.3 claims those numbers are true — a claim
  // it would otherwise be making without evidence.
  {
    id: 123,
    name: "the stats count result cardinality instead of work",
    file: "packages/code-intelligence/src/repository-index/incremental.ts",
    find: "      referencesRecomputed: fresh.references.length,",
    replace:
      "      referencesRecomputed:\n        fresh.references.length + carriedReferences.length,",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  {
    id: 124,
    name: "binding extraction work is reported as zero",
    file: "packages/code-intelligence/src/repository-index/incremental.ts",
    find: "      bindingsRecomputed: fresh.bindings.length,",
    replace: "      bindingsRecomputed: 0,",
    suite: "packages/code-intelligence/tests/incremental-equivalence.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-L.4.1 — code-to-test relationships.
  //
  // 125-129 target the association and its evidence semantics; 130-132 target
  // the reverse binding lookup and the production seam. 130 is the one the
  // slice exists for: a reverse lookup that matches on names offers the
  // reviewer files that mention a different symbol of the same name.
  // ---------------------------------------------------------------------
  {
    id: 125,
    name: "test association ignores the module role",
    file: "packages/code-intelligence/src/repository-index/test-relationships.ts",
    find: "    if (!testModules.has(reference.moduleId)) return [];",
    replace: "    if (false as boolean) return [];",
    suite: "packages/code-intelligence/tests/test-relationships.test.ts",
  },
  {
    id: 126,
    name: "a test module is related to itself",
    file: "packages/code-intelligence/src/repository-index/test-relationships.ts",
    find: "      if (targetModuleId === reference.moduleId) continue;",
    replace: "      if (false as boolean) continue;",
    suite: "packages/code-intelligence/tests/test-relationships.test.ts",
  },
  {
    id: 127,
    name: "an unreadable test module no longer withholds absence",
    file: "packages/code-intelligence/src/repository-index/test-relationships.ts",
    find: '  const blindSpot = index.modules.find(\n    (record) => record.role === "test" && record.coverage !== "indexed",\n  );',
    replace:
      "  const blindSpot = undefined as (typeof index.modules)[number] | undefined;",
    suite: "packages/code-intelligence/tests/test-relationships.test.ts",
  },
  {
    id: 128,
    name: "a blind spot suppresses positive test evidence too",
    file: "packages/code-intelligence/src/repository-index/test-relationships.ts",
    find: '  const relationships = testsForSymbol(index, symbolId);\n  if (relationships.length > 0) {\n    return { kind: "referenced_by_tests", relationships };\n  }',
    replace: "  const relationships = testsForSymbol(index, symbolId);",
    suite: "packages/code-intelligence/tests/test-relationships.test.ts",
  },
  {
    id: 129,
    name: "a symbol absent from the index reports no_test_references",
    file: "packages/code-intelligence/src/repository-index/test-relationships.ts",
    find: '  if (symbol === undefined) {\n    return {\n      kind: "not_indexed",',
    replace:
      '  if (false as boolean) {\n    return {\n      kind: "not_indexed",',
    suite: "packages/code-intelligence/tests/test-relationships.test.ts",
  },
  {
    id: 130,
    name: "the reverse lookup returns modules that only share a name",
    file: "packages/code-intelligence/src/repository-index/query.ts",
    find: "    const targets = binding.declarationIds.some(\n      (id) => declarationModule.get(id) === moduleId,\n    );\n    if (!targets) continue;",
    replace: "    const targets = true;\n    if (!targets) continue;",
    suite: "apps/review-worker/tests/index-wiring.test.ts",
  },
  {
    id: 131,
    name: "the reverse lookup runs against an unusable index",
    file: "packages/code-intelligence/src/repository-index/query.ts",
    find: "  if (!isUsable(index)) return [];\n\n  const declarationModule = new Map(",
    replace:
      "  if (false as boolean) return [];\n\n  const declarationModule = new Map(",
    suite: "packages/code-intelligence/tests/test-relationships.test.ts",
  },
  {
    id: 132,
    name: "the name-matched fallback is offered beside the indexed answer",
    file: "packages/code-intelligence/src/planner.ts",
    find: '              module.moduleId === caller.path && module.coverage === "indexed",',
    replace: "              false as boolean,",
    suite: "apps/review-worker/tests/index-wiring.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-L.4.2 Wave 2 / Agent F — config red-team band.
  //
  // 133-144 are contiguous by reservation. These targets exercise only code
  // that exists and has a declared, runnable suite.
  // ---------------------------------------------------------------------
  {
    id: 133,
    name: "an unrelated outage erases positive governance",
    file: "packages/code-intelligence/src/repository-index/config-governance.ts",
    find: "  if (relationships.length > 0) {",
    replace: "  if (relationships.length > 0 && unevaluable.length === 0) {",
    suite: "packages/code-intelligence/tests/config-governance.test.ts",
  },
  {
    id: 134,
    name: "incomplete coverage is reported as not_governed",
    file: "packages/code-intelligence/src/repository-index/config-governance.ts",
    find: "  if (discoveryComplete && evaluationComplete) {",
    replace: "  if (discoveryComplete) {",
    suite: "packages/code-intelligence/tests/config-governance.test.ts",
  },
  {
    id: 135,
    name: "plural governance collapses to the first relationship",
    file: "packages/code-intelligence/src/repository-index/config-governance.ts",
    find: "  relationships.sort((a, b) => compare(a.projectPath, b.projectPath));",
    replace:
      "  relationships.splice(1);\n  relationships.sort((a, b) => compare(a.projectPath, b.projectPath));",
    suite: "packages/code-intelligence/tests/config-governance.test.ts",
  },
  {
    id: 136,
    name: "nearest-directory discovery drops nested projects",
    file: "packages/code-intelligence/src/repository-index/config-discovery.ts",
    find: "  const discoveredList = [...discovered].sort(compare);",
    replace:
      '  const discoveredList = [...discovered].filter((path) => !path.includes("/")).sort(compare);',
    suite: "packages/code-intelligence/tests/config-discovery.test.ts",
  },
  {
    id: 137,
    name: "an unavailable config is treated as an empty available project",
    file: "packages/code-intelligence/src/repository-index/config-projects.ts",
    find: '    availability: { kind: "unavailable", failure, detail },',
    replace: '    availability: { kind: "available" },',
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 138,
    name: "unresolved extends destroys explicit membership qualification",
    file: "packages/code-intelligence/src/repository-index/config-projects.ts",
    find: "    : extendsBroken && !hasExplicitMembershipSelector",
    replace: "    : extendsBroken",
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 139,
    name: "unresolved extends leaves inherited options complete",
    file: "packages/code-intelligence/src/repository-index/config-projects.ts",
    find: '    extendsBroken || compilerOptionsInvalid ? "incomplete" : "complete";',
    replace: '    compilerOptionsInvalid ? "incomplete" : "complete";',
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 140,
    name: "extends leaks its base into SourceGovernance",
    file: "packages/code-intelligence/src/repository-index/config-governance.ts",
    find: "      projectPath: project.configPath,\n      reason,",
    replace:
      "      projectPath: project.extendsPath ?? project.configPath,\n      reason,",
    suite: "packages/code-intelligence/tests/config-governance.test.ts",
  },
  {
    id: 141,
    name: "project references leak into SourceGovernance",
    file: "packages/code-intelligence/src/repository-index/config-governance.ts",
    find: "      projectPath: project.configPath,\n      reason,",
    replace:
      "      projectPath: project.referencedProjects[0] ?? project.configPath,\n      reason,",
    suite: "packages/code-intelligence/tests/config-governance.test.ts",
  },
  {
    id: 142,
    name: "analyzer identity ignores supplied context changes",
    file: "apps/review-worker/src/analysis.ts",
    find: "      contextDigest: input.contextDigest,",
    replace: '      contextDigest: "ignored",',
    suite: "apps/review-worker/tests/analysis.test.ts",
  },
  {
    id: 143,
    name: "the production planner ignores ConfigFacts governance",
    file: "packages/code-intelligence/src/planner.ts",
    find: "      ? (input.configFacts?.governance ?? [])",
    replace: "      ? []",
    suite: "apps/review-worker/tests/config-wiring.test.ts",
  },
  {
    id: 144,
    name: "a config-only change leaves analyzer identity unchanged",
    file: "apps/review-worker/src/analysis.ts",
    find: "    configFactsDigest: config.digest,",
    replace: '    configFactsDigest: "ignored",',
    suite: "apps/review-worker/tests/config-wiring.test.ts",
  },
  {
    id: 145,
    name: "invalid files is treated as usable membership",
    file: "packages/code-intelligence/src/repository-index/config-projects.ts",
    find: '  let membership: FactCompleteness["membership"] = membershipSelectorInvalid\n    ? "unusable"',
    replace:
      '  let membership: FactCompleteness["membership"] =\n    membershipSelectorInvalid && record["files"] === undefined\n      ? "unusable"',
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 146,
    name: "invalid include is treated as usable membership",
    file: "packages/code-intelligence/src/repository-index/config-projects.ts",
    find: '  let membership: FactCompleteness["membership"] = membershipSelectorInvalid\n    ? "unusable"',
    replace:
      '  let membership: FactCompleteness["membership"] =\n    membershipSelectorInvalid && record["include"] === undefined\n      ? "unusable"',
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 147,
    name: "malformed membership exposes recovered compiler file names",
    file: "packages/code-intelligence/src/repository-index/config-projects.ts",
    find: '    coverage?.membership === "unusable"',
    replace: "    false",
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 148,
    name: "malformed membership permits not_governed",
    file: "packages/code-intelligence/src/repository-index/config-governance.ts",
    find: '        project.coverage.membership !== "complete"',
    replace: '        project.coverage.membership === "incomplete"',
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 149,
    name: "malformed membership erases governance from a valid project",
    file: "packages/code-intelligence/src/repository-index/config-governance.ts",
    find: "  if (relationships.length > 0) {",
    replace: "  if (relationships.length > 0 && unevaluable.length === 0) {",
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 150,
    name: "malformed references report reference facts complete",
    file: "packages/code-intelligence/src/repository-index/config-projects.ts",
    find: '    referenceSelectorInvalid ? "incomplete" : "complete";',
    replace: '    "complete";',
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 151,
    name: "a reference diagnostic makes source membership unusable",
    file: "packages/code-intelligence/src/repository-index/config-projects.ts",
    find: '  let membership: FactCompleteness["membership"] = membershipSelectorInvalid',
    replace:
      '  let membership: FactCompleteness["membership"] =\n    referenceSelectorInvalid || membershipSelectorInvalid',
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 152,
    name: "an unknown semantic config diagnostic is treated as harmless",
    file: "packages/code-intelligence/src/repository-index/config-projects.ts",
    find: "  if (unknownCodes.length > 0) {",
    replace: "  if (false) {",
    suite: "packages/code-intelligence/tests/config-projects.test.ts",
  },
  {
    id: 153,
    name: "invalid reference entries leave project discovery complete",
    file: "packages/code-intelligence/src/repository-index/config-discovery.ts",
    find: "      ? { gap: `${configPath} has one or more invalid project references` }\n      : {}),",
    replace: "      ? {}\n      : {}),",
    suite: "packages/code-intelligence/tests/config-discovery.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-L.4.3 Wave 2 — code-to-instruction production seam.
  //
  // 154-168 are contiguous by reservation. They cover classification, scope,
  // plurality, precedence/trust separation, outage semantics, production
  // planner consumption, independent identities, deletion, and provenance.
  // ---------------------------------------------------------------------
  {
    id: 154,
    name: "README prose is promoted to an instruction",
    file: "packages/code-intelligence/src/repository-index/instruction-discovery.ts",
    find: '  if (filename === "AGENTS.md") {',
    replace: '  if (filename === "AGENTS.md" || filename === "README.md") {',
    suite: "packages/code-intelligence/tests/instruction-discovery.test.ts",
  },
  {
    id: 155,
    name: "directory scope leaks into a path-prefix sibling",
    file: "packages/code-intelligence/src/repository-index/instruction-applicability.ts",
    find:
      "  return scopeSegments.every(\n" +
      "    (scopeSegment, index) => scopeSegment === targetSegments[index],\n" +
      "  );",
    replace: "  return targetPath.startsWith(scopeRoot);",
    suite: "packages/code-intelligence/tests/instruction-applicability.test.ts",
  },
  {
    id: 156,
    name: "planner drops the root instruction when nested context exists",
    file: "packages/code-intelligence/src/planner.ts",
    find: "  const applicableCandidates = [...applications]",
    replace: "  const applicableCandidates = [...applications].slice(-1)",
    suite: "apps/review-worker/tests/instruction-wiring.test.ts",
  },
  {
    id: 157,
    name: "plural applicability collapses to one relationship",
    file: "packages/code-intelligence/src/repository-index/instruction-applicability.ts",
    find: "  return { relationships, evaluated, unevaluable };",
    replace:
      "  relationships.splice(1);\n  return { relationships, evaluated, unevaluable };",
    suite: "packages/code-intelligence/tests/instruction-applicability.test.ts",
  },
  {
    id: 158,
    name: "computed precedence is ignored by prompt order",
    file: "packages/code-intelligence/src/planner.ts",
    find: "    if (instructionPrecedence !== 0) return instructionPrecedence;",
    replace: "    if (false) return instructionPrecedence;",
    suite: "packages/code-intelligence/tests/instruction-planner.test.ts",
  },
  {
    id: 159,
    name: "declared trust is used as semantic precedence",
    file: "packages/code-intelligence/src/repository-index/instruction-precedence.ts",
    find:
      "  const leftSpecificity = leftApplicability.precedence.scopeSpecificity;\n" +
      "  const rightSpecificity = rightApplicability.precedence.scopeSpecificity;",
    replace:
      '  const leftSpecificity = leftApplicability.trust === "authoritative" ? 1 : 0;\n' +
      '  const rightSpecificity = rightApplicability.trust === "authoritative" ? 1 : 0;',
    suite: "packages/code-intelligence/tests/instruction-precedence.test.ts",
  },
  {
    id: 160,
    name: "scope precedence is used as declared trust",
    file: "packages/code-intelligence/src/repository-index/instruction-precedence.ts",
    find: '  const higher = left.applicability.trust === "authoritative" ? left : right;',
    replace:
      "  const higher =\n" +
      "    left.applicability.precedence.scopeSpecificity >\n" +
      "    right.applicability.precedence.scopeSpecificity\n" +
      "      ? left\n" +
      "      : right;",
    suite: "packages/code-intelligence/tests/instruction-precedence.test.ts",
  },
  {
    id: 161,
    name: "an unreadable nested artifact erases a known root positive",
    file: "apps/review-worker/src/analysis.ts",
    find: "  if (scope.relationships.length > 0) {",
    replace:
      "  if (scope.relationships.length > 0 && coverage.unevaluable.length === 0) {",
    suite: "apps/review-worker/tests/instruction-wiring.test.ts",
  },
  {
    id: 162,
    name: "incomplete discovery becomes no applicable instructions",
    file: "apps/review-worker/src/analysis.ts",
    find: "  if (isInstructionCoverageComplete(coverage)) {",
    replace: "  if (coverage.unevaluable.length === 0) {",
    suite: "apps/review-worker/tests/instruction-wiring.test.ts",
  },
  {
    id: 163,
    name: "the production planner ignores factual instruction context",
    file: "packages/code-intelligence/src/planner.ts",
    find: "  candidates.push(...factualInstructionCandidates(input.instructionFacts));",
    replace: "  candidates.push(...factualInstructionCandidates(undefined));",
    suite: "apps/review-worker/tests/instruction-wiring.test.ts",
  },
  {
    id: 164,
    name: "instruction fact identity is omitted from analyzer context identity",
    file: "apps/review-worker/src/analysis.ts",
    find:
      '          : item.provenance?.source === "instruction_facts"\n' +
      "            ? item.provenance.factIdentity",
    replace:
      '          : item.provenance?.source === "instruction_facts"\n' +
      "            ? undefined",
    suite: "apps/review-worker/tests/instruction-wiring.test.ts",
  },
  {
    id: 165,
    name: "instruction artifacts contaminate RepositoryIndex identity",
    file: "apps/review-worker/src/analysis.ts",
    find:
      "        instruction === undefined ||\n" +
      '        instruction.instructionClass === "documentation"',
    replace: "        true",
    suite: "apps/review-worker/tests/instruction-wiring.test.ts",
  },
  {
    id: 166,
    name: "instruction facts contaminate ConfigFacts identity",
    file: "apps/review-worker/src/analysis.ts",
    find: "    configFactsDigest: config.digest,",
    replace: "    configFactsDigest: instructionIdentity,",
    suite: "apps/review-worker/tests/instruction-wiring.test.ts",
  },
  {
    id: 167,
    name: "deleted instruction artifacts remain in production context",
    file: "apps/review-worker/src/analysis.ts",
    find:
      "  const instructionFacts = discoverInstructionArtifacts({\n" +
      "    revision: options.headSha,\n" +
      "    ...(instructionObservation ?? repositoryInstructionObservation(repository)),\n" +
      "  });",
    replace:
      "  const discoveredInstructionFacts = discoverInstructionArtifacts({\n" +
      "    revision: options.headSha,\n" +
      "    ...(instructionObservation ?? repositoryInstructionObservation(repository)),\n" +
      "  });\n" +
      "  const statefulRun = runRealAnalysis as typeof runRealAnalysis & {\n" +
      "    previousInstructionFacts?: InstructionDiscoveryResult;\n" +
      "  };\n" +
      "  const previousInstructionFacts = statefulRun.previousInstructionFacts;\n" +
      "  const instructionFacts =\n" +
      "    previousInstructionFacts === undefined\n" +
      "      ? discoveredInstructionFacts\n" +
      "      : {\n" +
      "          ...discoveredInstructionFacts,\n" +
      "          artifacts: [\n" +
      "            ...discoveredInstructionFacts.artifacts,\n" +
      "            ...previousInstructionFacts.artifacts.filter(\n" +
      "              (previous) =>\n" +
      "                !discoveredInstructionFacts.artifacts.some(\n" +
      "                  (current) => current.artifactPath === previous.artifactPath,\n" +
      "                ),\n" +
      "            ),\n" +
      "          ],\n" +
      "        };\n" +
      "  statefulRun.previousInstructionFacts = instructionFacts;",
    suite: "apps/review-worker/tests/instruction-wiring.test.ts",
  },
  {
    id: 168,
    name: "weaker provenance replaces factual instruction context",
    file: "packages/code-intelligence/src/planner.ts",
    find: '  if (candidate.provenance?.source === "instruction_facts") return 2;',
    replace:
      '  if (candidate.provenance?.source === "instruction_facts") return 0;',
    suite: "packages/code-intelligence/tests/instruction-planner.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-L.5 — pre-registered quality and economics measurement.
  //
  // These mutants attack the measurement claims themselves. They are kept
  // separate from L.1-L.4 capability mutants because L.5 must be able to say
  // "no benefit" without weakening the facts it measures.
  // ---------------------------------------------------------------------
  {
    id: 169,
    name: "quality matching accepts a candidate extending past the gold anchor",
    file: "apps/review-worker/src/eval/l5-quality.ts",
    find: "    candidate.endLine <= allowed.endLine",
    replace: "    true",
    suite: "apps/review-worker/tests/l5-quality.test.ts",
  },
  {
    id: 170,
    name: "one candidate can satisfy multiple gold findings",
    file: "apps/review-worker/src/eval/l5-quality.ts",
    find: "      used.add(indexed.ordinal);",
    replace: "      used.delete(indexed.ordinal);",
    suite: "apps/review-worker/tests/l5-quality.test.ts",
  },
  {
    id: 171,
    name: "structural index is omitted from causal attribution",
    file: "apps/review-worker/src/eval/l5-quality.ts",
    find: 'export const L5_FACT_FAMILIES = [\n  "structural_index",\n  "binding",',
    replace: 'export const L5_FACT_FAMILIES = [\n  "binding",',
    suite: "apps/review-worker/tests/l5-quality.test.ts",
  },
  {
    id: 172,
    name: "inequivalent control and treatment inputs are scored",
    file: "apps/review-worker/src/eval/l5-run.ts",
    find: "  if (controlEquivalence.hash !== treatmentEquivalence.hash) {",
    replace: "  if (false) {",
    suite: "apps/review-worker/tests/l5-run.test.ts",
  },
  {
    id: 173,
    name: "recorder substantive interference is ignored",
    file: "apps/review-worker/src/eval/l5-run.ts",
    find: "  if (differences.length > 0) {",
    replace: "  if (false) {",
    suite: "apps/review-worker/tests/l5-run.test.ts",
  },
  {
    id: 174,
    name: "disabled-family provenance can survive attestation",
    file: "apps/review-worker/src/eval/l5-run.ts",
    find: "      if (!mode.families[family] && count !== 0) {",
    replace: "      if (false) {",
    suite: "apps/review-worker/tests/l5-run.test.ts",
  },
  {
    id: 175,
    name: "unknown production context reasons are silently accepted",
    file: "packages/code-intelligence/src/eval/l5-context.ts",
    find: "  if (!PRODUCTION_REASON_SET.has(reason)) {",
    replace: "  if (false) {",
    suite: "packages/code-intelligence/tests/l5-context.test.ts",
  },
  {
    id: 176,
    name: "context duplicate suppression is always reported as zero",
    file: "packages/code-intelligence/src/eval/l5-context.ts",
    find: "    duplicatesSuppressed: input.offered.length - scored.size,",
    replace: "    duplicatesSuppressed: 0,",
    suite: "packages/code-intelligence/tests/l5-context.test.ts",
  },
  {
    id: 177,
    name: "incremental primary timing excludes failed attempts",
    file: "packages/code-intelligence/src/eval/l5-incremental.ts",
    find: "  const primary = distributionsFor(rows);",
    replace:
      "  const primary = distributionsFor(\n" +
      "    rows.filter((row) => row.incrementalStats.succeeded),\n" +
      "  );",
    suite: "packages/code-intelligence/tests/l5-incremental.test.ts",
  },
  {
    id: 178,
    name: "incremental economics passes when only one stop condition holds",
    file: "packages/code-intelligence/src/eval/l5-incremental.ts",
    find:
      "      successRate >= L5_MINIMUM_INCREMENTAL_SUCCESS_RATE &&\n" +
      "      primary.pairedSpeedup.median >= L5_MINIMUM_MEDIAN_PAIRED_SPEEDUP,",
    replace:
      "      successRate >= L5_MINIMUM_INCREMENTAL_SUCCESS_RATE ||\n" +
      "      primary.pairedSpeedup.median >= L5_MINIMUM_MEDIAN_PAIRED_SPEEDUP,",
    suite: "packages/code-intelligence/tests/l5-incremental.test.ts",
  },
  {
    id: 179,
    name: "dangerous false cache reuse is called correct invalidation",
    file: "apps/review-worker/src/eval/l5-identity.ts",
    find:
      '  return disposition === "key_changed"\n' +
      '    ? "correct_invalidation"\n' +
      '    : "dangerous_false_reuse";',
    replace: '  return "correct_invalidation";',
    suite: "apps/review-worker/tests/l5-identity.test.ts",
  },
  {
    id: 180,
    name: "binding facts remain offered when their planner family is disabled",
    file: "packages/code-intelligence/src/planner.ts",
    find:
      '    if (\n      factFamilyEnabled(input, "binding") &&\n' +
      "      input.index !== undefined &&\n" +
      "      isUsable(input.index)\n" +
      "    ) {\n" +
      "      for (const dependant of modulesReferencing(input.index, changed.path)) {",
    replace:
      "    if (input.index !== undefined && isUsable(input.index)) {\n" +
      "      for (const dependant of modulesReferencing(input.index, changed.path)) {",
    suite: "packages/code-intelligence/tests/l5-planner-seam.test.ts",
  },
  {
    id: 181,
    name: "quality gold matches context exposure instead of analyzer family",
    file: "apps/review-worker/src/eval/l5-production.ts",
    find: "      family: finding.correctnessFamily,",
    replace: "      family: finding.exposureFamily,",
    suite: "apps/review-worker/tests/l5-production.test.ts",
  },
  {
    id: 182,
    name: "L5 premerge enforcement is derived from publication output",
    file: "apps/review-worker/src/eval/l5-production.ts",
    find: "      : evaluatePreMerge(promotedFindings, adapted.policies.premergePolicy);",
    replace:
      "      : evaluatePreMerge(publication?.publish ?? [], adapted.policies.premergePolicy);",
    suite: "apps/review-worker/tests/l5-production.test.ts",
  },
  {
    id: 183,
    name: "candidate claim is omitted from L5 substantive recorder identity",
    file: "apps/review-worker/src/eval/l5-production.ts",
    find: "        claim: finding.claim,",
    replace: '        claim: "",',
    suite: "apps/review-worker/tests/l5-production.test.ts",
  },
  {
    id: 184,
    name: "production direct-source attestation reuses the control trace",
    file: "apps/review-worker/src/eval/l5-production.ts",
    find:
      "    directSourceCandidateIdentitiesBeforeCompetition: stageCandidateIds(\n" +
      "      trace.directSourceCandidatesBeforeCompetition,\n" +
      "      trace.directSourceCandidatesBeforeCompetition,",
    replace:
      "    directSourceCandidateIdentitiesBeforeCompetition: stageCandidateIds(\n" +
      "      traces.CONTROL.directSourceCandidatesBeforeCompetition,\n" +
      "      traces.CONTROL.directSourceCandidatesBeforeCompetition,",
    suite: "apps/review-worker/tests/l5-production.test.ts",
  },
  {
    id: 185,
    name: "ambiguous candidate fingerprints remain quality-scorable",
    file: "apps/review-worker/src/eval/l5-production.ts",
    find: "    if (previous !== undefined) {",
    replace: "    if (false) {",
    suite: "apps/review-worker/tests/l5-production.test.ts",
  },
  {
    id: 186,
    name: "authored cache reuse changes production head identity",
    file: "apps/review-worker/src/eval/l5-corpus.ts",
    find: "      bindingReuse.syntheticRevision,\n      { files: reverseTraversalOrder(bindingReuse.files) },",
    replace:
      '      "l5/cache/reuse-binding/different-head",\n      { files: reverseTraversalOrder(bindingReuse.files) },',
    suite: "apps/review-worker/tests/l5-production-cache.test.ts",
  },
  {
    id: 187,
    name: "thrown incremental pair failures disappear from the report",
    file: "apps/review-worker/src/eval/l5-production-incremental.ts",
    find: "    } catch (error) {\n      invalidOrExcluded.push({",
    replace:
      "    } catch (error) {\n      throw error;\n      invalidOrExcluded.push({",
    suite: "apps/review-worker/tests/l5-production-incremental.test.ts",
  },
  {
    id: 188,
    name: "cache after-context observation reuses the before digest",
    file: "apps/review-worker/src/eval/l5-production-cache.ts",
    find:
      "      afterContextDigest: (await observeL5ProductionContext(after))\n" +
      "        .contextDigest,",
    replace: "      afterContextDigest: beforeContextDigest,",
    suite: "apps/review-worker/tests/l5-production-cache.test.ts",
  },
  {
    id: 189,
    name: "pre-competition direct-source trace inherits factual mode gates",
    file: "packages/code-intelligence/src/planner.ts",
    find: "    factFamilyAvailability: NO_PLANNER_FACT_FAMILIES,",
    replace: "    factFamilyAvailability: input.factFamilyAvailability,",
    suite: "apps/review-worker/tests/l5-production.test.ts",
  },
  {
    id: 190,
    name: "P1-M historical baseline invents an extra candidate",
    file: "apps/review-worker/src/eval/m1-corpus.ts",
    find: "  candidates: 2,\n  publishedTruePositives: 2,",
    replace: "  candidates: 3,\n  publishedTruePositives: 2,",
    suite: "apps/review-worker/tests/m1-corpus.test.ts",
  },
  {
    id: 191,
    name: "P1-M miss attribution claims required evidence was unavailable",
    file: "apps/review-worker/src/eval/m1-corpus.ts",
    find: '    caseId: "config-exact-optional-assignment",\n    goldId: "exact-optional-undefined-assignment",\n    capabilityFamily: "configuration_sensitive_type_safety",\n    correctnessFamily: "nullability",\n    analyzer: "absent",\n    verifier: "not_run",\n    policy: "not_run",\n    rootCause: "analyzer_capability",\n    requiredEvidenceAvailable: true,',
    replace:
      '    caseId: "config-exact-optional-assignment",\n    goldId: "exact-optional-undefined-assignment",\n    capabilityFamily: "configuration_sensitive_type_safety",\n    correctnessFamily: "nullability",\n    analyzer: "absent",\n    verifier: "not_run",\n    policy: "not_run",\n    rootCause: "analyzer_capability",\n    requiredEvidenceAvailable: false,',
    suite: "apps/review-worker/tests/m1-corpus.test.ts",
  },
  {
    id: 192,
    name: "P1-M holdout fixture is reclassified as development",
    file: "apps/review-worker/src/eval/m1-corpus.ts",
    find: '    id: "holdout-config-indexed-header",\n    split: "holdout",',
    replace:
      '    id: "holdout-config-indexed-header",\n    split: "development",',
    suite: "apps/review-worker/tests/m1-corpus.test.ts",
  },
  {
    id: 193,
    name: "P1-M sealed holdout digest accepts changed content",
    file: "apps/review-worker/src/eval/m1-corpus.ts",
    find: '  "277bad0df521765e5f570adc40c7a65ea9e847317f3e7e991e2f74fe738c7012" as const;',
    replace:
      '  "377bad0df521765e5f570adc40c7a65ea9e847317f3e7e991e2f74fe738c7012" as const;',
    suite: "apps/review-worker/tests/m1-corpus.test.ts",
  },
  {
    id: 194,
    name: "P1-M natural false positive is relabelled as constructed",
    file: "apps/review-worker/src/eval/m1-corpus.ts",
    find: '    analyzerBehavior: "historically_produced_candidate",',
    replace: '    analyzerBehavior: "constructed_candidate",',
    suite: "apps/review-worker/tests/m1-corpus.test.ts",
  },
  {
    id: 195,
    name: "P1-M taxonomy drops a historical miss",
    file: "apps/review-worker/src/eval/m1-corpus.ts",
    find: '    family: "public_api_compatibility",\n    historicalMisses: 2,',
    replace:
      '    family: "public_api_compatibility",\n    historicalMisses: 1,',
    suite: "apps/review-worker/tests/m1-corpus.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-M.1 — the quality gate and the corpus seal.
  //
  // 196-201 attack the function that decides whether P1-M may close. 202
  // attacks the canonical ordering of the sealed corpus. Both are evaluation
  // machinery rather than review behaviour, and both are load-bearing for
  // every claim P1-M will later make about itself.
  // ---------------------------------------------------------------------
  {
    id: 196,
    name: "the gate treats an undefined ratio as satisfying a threshold",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: '  return quantity.kind === "measured" && quantity.value >= threshold;',
    replace:
      '  return quantity.kind !== "measured" || quantity.value >= threshold;',
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 197,
    name: "the gate treats an undefined ratio as satisfying equality",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: '  return quantity.kind === "measured" && quantity.value === value;',
    replace:
      '  return quantity.kind !== "measured" || quantity.value === value;',
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 198,
    name: "the gate accepts a natural-FP guard that never ran",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: "        measurement.naturalFalsePositivesPublished === 0 &&\n        measurement.naturalFalsePositivesReplayed > 0,",
    replace: "        measurement.naturalFalsePositivesPublished === 0,",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 199,
    name: "the gate stops checking historical regression",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: "      satisfied: regressed.length === 0,",
    replace: "      satisfied: true,",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 200,
    name: "the gate closes with no capability attested",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: "        measurement.capabilities.length > 0 && withoutWitness.length === 0,",
    replace: "        withoutWitness.length === 0,",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 201,
    name: "the gate's inclusive threshold becomes exclusive",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: "      satisfied: atLeast(historicalRecall, 8 / 12),",
    replace: "      satisfied: atLeast(historicalRecall, 8 / 12 + 0.0001),",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 202,
    name: "the corpus seal orders keys by machine locale",
    file: "apps/review-worker/src/eval/m1-corpus.ts",
    find: "        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))",
    replace: "        .sort(([left], [right]) => left.localeCompare(right))",
    suite: "apps/review-worker/tests/m1-corpus.test.ts",
  },
  // ---------------------------------------------------------------------
  // P1-M.2 — exact-optional property writes.
  //
  // 203-209 attack the analyzer's hypothesis; 210-215 the verifier's ability
  // to confirm AND refute; 216 the production seam that carries a governing
  // config into the cluster it governs; 217 the guard that stops the f7b49af
  // baseline being silently re-measured.
  //
  // 203 and 214 are the two real bugs found while building this capability:
  // an AST kind that matched nothing, and a project file set silently dropped
  // by a path-prefix mismatch. Bugs discovered during implementation make the
  // highest-value mutations, because they are the mistakes this code has
  // already proven it can make.
  // ---------------------------------------------------------------------
  {
    id: 203,
    name: "M.2 analyzer matches UndefinedKeyword instead of the identifier",
    file: "packages/review-engine/src/correctness/exact-optional-write.ts",
    find: 'ts.isIdentifier(node.right) &&\n      node.right.text === "undefined"',
    replace: "node.right.kind === ts.SyntaxKind.UndefinedKeyword",
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 204,
    name: "M.2 analyzer never checks the governing option",
    file: "packages/review-engine/src/correctness/exact-optional-write.ts",
    find: "    if (!enablesExactOptional(item.suppliedContent)) continue;",
    replace: "    if (false as boolean) continue;",
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 205,
    name: "M.2 analyzer never checks optionality",
    file: "packages/review-engine/src/correctness/exact-optional-write.ts",
    find: "      if (!optional.has(write.propertyName)) continue;",
    replace: "      if (false as boolean) continue;",
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 206,
    name: "M.2 analyzer ignores which source a config governs",
    file: "packages/review-engine/src/correctness/exact-optional-write.ts",
    find: "    if (!provenance.citation.includes(`governs ${sourcePath}`)) continue;",
    replace: "    if (false as boolean) continue;",
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 207,
    name: "M.2 analyzer treats absent governance as usable",
    file: "packages/review-engine/src/correctness/exact-optional-write.ts",
    find: "    if (projects.length === 0) continue;",
    replace: "    if (false as boolean) continue;",
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 208,
    name: "M.2 analyzer reports unchanged lines",
    file: "packages/review-engine/src/correctness/exact-optional-write.ts",
    find: "      if (!changedLines.has(write.line)) continue;",
    replace: "      if (false as boolean) continue;",
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 209,
    name: "M.2 analyzer drops its config evidence citation",
    file: "packages/review-engine/src/correctness/exact-optional-write.ts",
    find: "      ...projects.map((project) => ({",
    replace: "      ...projects.slice(0, 0).map((project) => ({",
    suite: "apps/review-worker/tests/m2-wiring.test.ts",
  },
  {
    id: 210,
    name: "M.2 verifier reports a missing diagnostic as VERIFIED",
    file: "packages/review-engine/src/verification/exact-optional.ts",
    find: '  return {\n    kind: "rejected",',
    replace: '  return {\n    kind: "verified",',
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 211,
    name: "M.2 verifier reports a refutation as INCONCLUSIVE",
    file: "packages/review-engine/src/verification/exact-optional.ts",
    find: '  return {\n    kind: "rejected",',
    replace: '  return {\n    kind: "inconclusive",',
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 212,
    name: "M.2 verifier accepts any diagnostic code",
    file: "packages/review-engine/src/verification/exact-optional.ts",
    find: "        (diagnostic) => diagnostic.code === EXACT_OPTIONAL_DIAGNOSTIC_CODE,",
    replace: "        () => true,",
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 213,
    name: "M.2 verifier accepts a diagnostic outside the claimed region",
    file: "packages/review-engine/src/verification/exact-optional.ts",
    find: "      .filter((diagnostic) => overlapsClaim(diagnostic, source, query));",
    replace: "      .filter(() => true);",
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 214,
    name: "M.2 verifier builds a one-file program instead of the project",
    file: "packages/review-engine/src/verification/exact-optional.ts",
    find: "        [...parsed.fileNames.map(relative), query.path].filter((f) =>",
    replace: "        [query.path].filter((f) =>",
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 215,
    name: "M.2 verifier reports an unbuildable project as a refutation",
    file: "packages/review-engine/src/verification/exact-optional.ts",
    find: '  if (configPaths.length === 0) {\n    return {\n      kind: "inconclusive",',
    replace:
      '  if (configPaths.length === 0) {\n    return {\n      kind: "rejected",',
    suite: "packages/review-engine/tests/exact-optional-write.test.ts",
  },
  {
    id: 216,
    name: "governing configs no longer reach the clusters they govern",
    file: "packages/review-engine/src/cluster.ts",
    find: "        governsThisCluster(item),",
    replace: "        false,",
    suite: "apps/review-worker/tests/m2-wiring.test.ts",
  },
  {
    id: 217,
    name: "the f7b49af baseline reproducibility guard is removed",
    file: "apps/review-worker/src/eval/l5-production.ts",
    find: "  if (canonicalJson(production) !== canonicalJson(frozen)) {\n    const added",
    replace: "  if (false as boolean) {\n    const added",
    suite: "apps/review-worker/tests/l5-production.test.ts",
  },
  {
    id: 218,
    name: "M.3.0 comparison identity is dropped from the analyzer cache key",
    file: "apps/review-worker/src/analysis.ts",
    find: "      comparisonIdentity: input.comparisonIdentity ?? null,",
    replace: "      comparisonIdentity: null,",
    suite: "apps/review-worker/tests/base-revision-wiring.test.ts",
  },
  {
    id: 219,
    name: "M.3.0 the cache key identifies the comparison by HEAD instead of base",
    file: "apps/review-worker/src/analysis.ts",
    find: "    ...(base === undefined ? {} : { comparisonIdentity: base.digest }),",
    replace:
      "    ...(base === undefined ? {} : { comparisonIdentity: options.headSha }),",
    suite: "apps/review-worker/tests/base-revision-wiring.test.ts",
  },
  {
    id: 220,
    name: "M.3.0 a base that is ABSENT is reported as NOT_INDEXED",
    file: "packages/code-intelligence/src/planner.ts",
    find: "        resolution: base.resolution.kind,",
    replace:
      '        resolution:\n          base.resolution.kind === "absent"\n            ? "not_indexed"\n            : base.resolution.kind,',
    suite: "packages/code-intelligence/tests/base-revision.test.ts",
  },
  {
    id: 221,
    name: "M.3.0 a base that is UNAVAILABLE is reported as ABSENT",
    file: "packages/code-intelligence/src/planner.ts",
    find: "        resolution: base.resolution.kind,",
    replace:
      '        resolution:\n          base.resolution.kind === "unavailable"\n            ? "absent"\n            : base.resolution.kind,',
    suite: "packages/code-intelligence/tests/base-revision.test.ts",
  },
  {
    id: 222,
    name: "M.3.0 a base that is NOT_INDEXED is reported as ABSENT",
    file: "packages/code-intelligence/src/planner.ts",
    find: "        resolution: base.resolution.kind,",
    replace:
      '        resolution:\n          base.resolution.kind === "not_indexed"\n            ? "absent"\n            : base.resolution.kind,',
    suite: "packages/code-intelligence/tests/base-revision.test.ts",
  },
  {
    id: 223,
    name: "M.3.0 no context item is emitted for an UNAVAILABLE base",
    file: "packages/code-intelligence/src/planner.ts",
    find: "    if (seen.has(base.path)) continue;",
    replace:
      '    if (seen.has(base.path) || base.resolution.kind === "unavailable")\n      continue;',
    suite: "packages/code-intelligence/tests/base-revision.test.ts",
  },
  {
    id: 224,
    name: "M.3.0 no context item is emitted for a NOT_INDEXED base",
    file: "packages/code-intelligence/src/planner.ts",
    find: "    if (seen.has(base.path)) continue;",
    replace:
      '    if (seen.has(base.path) || base.resolution.kind === "not_indexed")\n      continue;',
    suite: "packages/code-intelligence/tests/base-revision.test.ts",
  },
  {
    id: 225,
    name: "M.3.0 a changed path the source never mentioned gets no base entry",
    file: "apps/review-worker/src/analysis.ts",
    find: "  const revisions: PlannerBaseRevision[] = changed",
    replace:
      "  const revisions: PlannerBaseRevision[] = changed.filter(\n    (entry) => entry.base !== undefined,\n  )",
    suite: "apps/review-worker/tests/base-revision-wiring.test.ts",
  },
  {
    id: 226,
    name: "M.3.0 an unobserved path is synthesized as ABSENT instead of NOT_INDEXED",
    file: "apps/review-worker/src/analysis.ts",
    find: '      resolution: file.base ?? ({ kind: "not_indexed" } as const),',
    replace: '      resolution: file.base ?? ({ kind: "absent" } as const),',
    suite: "apps/review-worker/tests/base-revision-wiring.test.ts",
  },
  {
    id: 227,
    name: "M.3.0 base_revision is allowed to follow the L.5 mode definition",
    file: "apps/review-worker/src/eval/l5-production.ts",
    find: "    base_revision: false,",
    replace: "    base_revision: mode.families.base_revision ?? true,",
    suite: "apps/review-worker/tests/base-revision-l5-guard.test.ts",
  },
  {
    id: 228,
    name: "M.3.0 the L.5 vocabulary accepts a base-revision observation",
    file: "packages/code-intelligence/src/eval/l5-context.ts",
    find: '    throw new InvalidL5ContextObservationError(\n      "Base-revision context cannot appear in an L.5 observation: the L.5 " +',
    replace:
      '    return "none";\n    throw new InvalidL5ContextObservationError(\n      "Base-revision context cannot appear in an L.5 observation: the L.5 " +',
    suite: "packages/code-intelligence/tests/l5-context.test.ts",
  },
  {
    id: 229,
    name: "M.3.0 the containment guard stops requiring a recorded reason",
    file: "apps/review-worker/src/eval/l5-production.ts",
    find: "        !experiment.has(family) && declaredExclusions[family] === undefined,",
    replace: "        !experiment.has(family) && false,",
    suite: "apps/review-worker/tests/base-revision-l5-guard.test.ts",
  },
  {
    id: 230,
    name: "M.3 base items collide with head text on the dedupe key",
    file: "packages/code-intelligence/src/planner.ts",
    find: "      deduplicationKey: `base_revision|${base.path}`,",
    replace: "",
    suite: "apps/review-worker/tests/base-head-collision.test.ts",
  },
  {
    id: 231,
    name: "M.3 a base revision collapses into a pointer at head material",
    file: "packages/code-intelligence/src/planner.ts",
    find: '      candidate.kind !== "base_revision" &&',
    replace: "",
    suite: "apps/review-worker/tests/base-head-collision.test.ts",
  },
  {
    id: 232,
    name: "M.3 the verifier compiles the planner selection, not the revision",
    file: "packages/review-engine/src/verification/compatibility-route.ts",
    find: "    context.revision?.files ??\n    new Map(context.items.map((item) => [item.path, item.content]));",
    replace:
      "    new Map(context.items.map((item) => [item.path, item.content]));",
    suite: "packages/review-engine/tests/verifier-revision-scope.test.ts",
  },
  {
    id: 233,
    name: "M.3 the BASE-validity premise is skipped entirely",
    file: "packages/review-engine/src/verification/compatibility-probe.ts",
    find: "  if (!base.compiled) {",
    replace: "  if (false as boolean) {",
    suite: "packages/review-engine/tests/compatibility-verifier.test.ts",
  },
  {
    id: 234,
    name: "M.3 a boundary missing from the head snapshot is treated as removal",
    file: "packages/review-engine/src/verification/compatibility-probe.ts",
    find: "  if (!options.headFiles.has(options.boundaryPath)) {",
    replace: "  if (false as boolean) {",
    suite: "packages/review-engine/tests/compatibility-verifier.test.ts",
  },
  {
    id: 236,
    name: "M.3 any diagnostic code counts as the capability's evidence",
    file: "packages/review-engine/src/verification/compatibility-probe.ts",
    find: "    relevant: probeLocal.filter((diagnostic) =>\n      options.recognisedCodes.has(diagnostic.code),\n    ),",
    replace: "    relevant: probeLocal.filter(() => true),",
    suite: "packages/review-engine/tests/compatibility-verifier.test.ts",
  },
  {
    id: 237,
    name: "M.3 a head that still compiles is reported as a break",
    file: "packages/review-engine/src/verification/compatibility-probe.ts",
    find: "  if (head.relevant.length > 0) {",
    replace: "  if (true as boolean) {",
    suite: "packages/review-engine/tests/compatibility-verifier.test.ts",
  },
  {
    id: 238,
    name: "M.3.4 recognises TS2693, the value-probe-on-a-type error",
    file: "packages/review-engine/src/verification/export-reachability.ts",
    find: "  2459, 2460, 2305, 2724,",
    replace: "  2459, 2460, 2305, 2724, 2693,",
    suite: "packages/review-engine/tests/export-reachability.test.ts",
  },
  {
    id: 239,
    name: "M.3.4 recognises TS2307, which an absent snapshot also produces",
    file: "packages/review-engine/src/verification/export-reachability.ts",
    find: "  2459, 2460, 2305, 2724,",
    replace: "  2459, 2460, 2305, 2724, 2307,",
    suite: "packages/review-engine/tests/export-reachability.test.ts",
  },
  {
    id: 241,
    name: "M.3.1 reports a new file as an abstention",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: '    if (provenance.resolution === "absent") return undefined;',
    replace:
      '    if (provenance.resolution === "absent") return { abstain: "absent" };',
    suite: "apps/review-worker/tests/m31-removed-export.test.ts",
  },
  {
    id: 242,
    name: "M.3.1 treats an unestablished base as an established one",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: '    if ("abstain" in base) {',
    replace: "    if (false as boolean) {",
    suite: "apps/review-worker/tests/m31-removed-export.test.ts",
  },
  {
    id: 243,
    name: "M.3.1 compares the head against any item sharing the path",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: '    if (item.kind !== "source_file") continue;\n    if (item.reason !== "changed_hunk") continue;',
    replace: "",
    suite: "apps/review-worker/tests/m31-removed-export.test.ts",
  },
  {
    id: 244,
    name: "M.3.2 accepts any diagnostic as an arity break",
    file: "packages/review-engine/src/verification/required-parameter.ts",
    find: "new Set([2554])",
    replace: "new Set([2554, 2345, 2322])",
    suite: "packages/review-engine/tests/compatibility-verifier.test.ts",
  },
  {
    id: 245,
    name: "M.3.2 probes with the head's arity instead of the base's",
    file: "packages/review-engine/src/verification/required-parameter.ts",
    find: "{ length: query.baseArity }",
    replace: "{ length: query.baseArity + 1 }",
    suite: "packages/review-engine/tests/compatibility-verifier.test.ts",
  },
  {
    id: 246,
    name: "M.3.2 takes the widest overload instead of the narrowest",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: "Math.min(existing.required, required)",
    replace: "Math.max(existing.required, required)",
    suite: "apps/review-worker/tests/m32-required-parameter.test.ts",
  },
  {
    id: 247,
    name: "M.3.2 counts optional parameters as required",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: "        parameter.questionToken === undefined &&",
    replace: "        true &&",
    suite: "apps/review-worker/tests/m32-required-parameter.test.ts",
  },
  {
    id: 248,
    name: "M.3.2 forms no candidate unless required arity grew",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: "      if (headShape.total <= baseShape.total) continue;",
    replace: "      if (headShape.required <= baseShape.required) continue;",
    suite: "apps/review-worker/tests/m32-required-parameter.test.ts",
  },
  {
    id: 249,
    name: "M.3 a comparison capability proceeds without a comparison revision",
    file: "packages/review-engine/src/verification/compatibility-route.ts",
    find: "  if (context.comparison === undefined) return abstain();",
    replace: "",
    suite: "apps/review-worker/tests/m31-removed-export.test.ts",
  },
  {
    id: 250,
    name: "M.3.3 the published anchor reverts to the hardcoded line 1",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: "  const location = { path, startLine: anchor.line, endLine: anchor.line };",
    replace: "  const location = { path, startLine: 1, endLine: 1 };",
    suite: "apps/review-worker/tests/m33-anchor.test.ts",
  },
  {
    id: 251,
    name: "M.3.3 a finding with no established anchor is published anyway",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: '      if (anchor.kind !== "exact_head") {',
    replace: "      if (false as boolean) {",
    suite: "apps/review-worker/tests/m33-anchor.test.ts",
  },
  {
    id: 252,
    name: "M.3.3 a base-side line is published as a head-side line",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: '      kind: "exact_base",',
    replace: '      kind: "exact_head",',
    suite: "apps/review-worker/tests/m33-anchor.test.ts",
  },
  {
    id: 254,
    name: "M.3.3 the wholesale re-export is not treated as the boundary",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: "  const wholesaleLine = wholesaleReexportLine(head);",
    replace: "  const wholesaleLine: number | undefined = undefined;",
    suite: "apps/review-worker/tests/m33-anchor.test.ts",
  },
  {
    id: 255,
    name: "M.3.3 the internal declaration is used instead of the export statement",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: "  for (const statement of source.statements) {\n    if (!ts.isExportDeclaration(statement)) continue;\n    const clause = statement.exportClause;",
    replace:
      "  for (const statement of source.statements) {\n    if (true as boolean) continue;\n    const clause = statement.exportClause;",
    suite: "apps/review-worker/tests/m33-anchor.test.ts",
  },
  {
    id: 256,
    name: "M.3.3 the anchor's own provenance is dropped from the finding",
    file: "packages/review-engine/src/correctness/api-compatibility.ts",
    find: '      {\n        type: "static_analysis",\n        strength: "supporting",\n        observation: `The published location is established evidence: ${anchor.because}.`,\n        location,\n      },\n',
    replace: "",
    suite: "apps/review-worker/tests/m33-anchor.test.ts",
  },
  {
    id: 257,
    name: "Epoch scoring: enumerated anchors collapse back into a hull",
    file: "apps/review-worker/src/eval/anchor-scoring.ts",
    find: "  return allowed.some(\n    (entry) =>\n      entry.path === published.path &&\n      sideAgrees(published, entry) &&\n      overlaps(published, entry.startLine, entry.endLine),\n  );",
    replace:
      "  const onPath = allowed.filter((entry) => entry.path === published.path);\n  if (onPath.length === 0) return false;\n  return overlaps(\n    published,\n    Math.min(...onPath.map((entry) => entry.startLine)),\n    Math.max(...onPath.map((entry) => entry.endLine)),\n  );",
    suite: "apps/review-worker/tests/anchor-scoring.test.ts",
  },
  {
    id: 258,
    name: "Epoch scoring: only the first enumerated anchor is considered",
    file: "apps/review-worker/src/eval/anchor-scoring.ts",
    find: "  return allowed.some(",
    replace: "  return allowed.slice(0, 1).some(",
    suite: "apps/review-worker/tests/anchor-scoring.test.ts",
  },
  {
    id: 259,
    name: "Epoch scoring: the side constraint is ignored",
    file: "apps/review-worker/src/eval/anchor-scoring.ts",
    find: "      sideAgrees(published, entry) &&",
    replace: "      true &&",
    suite: "apps/review-worker/tests/anchor-scoring.test.ts",
  },
  {
    id: 260,
    name: "Epoch scoring: an empty enumeration accepts any anchor",
    file: "apps/review-worker/src/eval/anchor-scoring.ts",
    find: "  if (allowed.length === 0) return false;",
    replace: "  if (allowed.length === 0) return true;",
    suite: "apps/review-worker/tests/anchor-scoring.test.ts",
  },
  {
    id: 261,
    name: "Epoch scoring: a stated side constraint is treated as absent",
    file: "apps/review-worker/src/eval/anchor-scoring.ts",
    find: "  if (allowed.side === undefined) return true;",
    replace: "  if (true as boolean) return true;",
    suite: "apps/review-worker/tests/anchor-scoring.test.ts",
  },
  {
    id: 262,
    name: "M.4 the base is not required to have consumed the result",
    file: "packages/review-engine/src/correctness/discarded-replacement.ts",
    find: "    if (!consumedAtBase.has(call.callee)) continue;",
    replace: "",
    suite: "apps/review-worker/tests/m4-discarded-replacement.test.ts",
  },
  {
    id: 263,
    name: "M.4 a result still consumed elsewhere at head is reported anyway",
    file: "packages/review-engine/src/correctness/discarded-replacement.ts",
    find: "    if (consumedAtHead.has(call.callee)) continue;",
    replace: "",
    suite: "apps/review-worker/tests/m4-discarded-replacement.test.ts",
  },
  {
    id: 264,
    name: "M.4 the finding is anchored at line 1 instead of the discarding call",
    file: "packages/review-engine/src/correctness/discarded-replacement.ts",
    find: "  const location = { path, startLine: call.line, endLine: call.line };",
    replace: "  const location = { path, startLine: 1, endLine: 1 };",
    suite: "apps/review-worker/tests/m4-discarded-replacement.test.ts",
  },
  {
    id: 265,
    name: "M.4 a void callee is treated as returning a replacement",
    file: "packages/review-engine/src/verification/discarded-replacement.ts",
    find: "  if (returnType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {",
    replace: "  if (false as boolean) {",
    suite: "packages/review-engine/tests/discarded-replacement.test.ts",
  },
  {
    id: 266,
    name: "M.4 replacement compatibility is never checked",
    file: "packages/review-engine/src/verification/discarded-replacement.ts",
    find: "  if (!checker.isTypeAssignableTo(returnType, parameterType)) {",
    replace: "  if (false as boolean) {",
    suite: "packages/review-engine/tests/discarded-replacement.test.ts",
  },
  {
    id: 267,
    name: "M.4 assignability is checked in the wrong direction",
    file: "packages/review-engine/src/verification/discarded-replacement.ts",
    find: "  if (!checker.isTypeAssignableTo(returnType, parameterType)) {",
    replace: "  if (!checker.isTypeAssignableTo(parameterType, returnType)) {",
    suite: "packages/review-engine/tests/discarded-replacement.test.ts",
  },
  {
    id: 268,
    name: "M.4 returning the argument itself counts as a transformation",
    file: "packages/review-engine/src/verification/discarded-replacement.ts",
    find: '    if (symbol === parameter) return "identity";',
    replace: '    if (symbol === parameter) return "transformed";',
    suite: "packages/review-engine/tests/discarded-replacement.test.ts",
  },
  {
    id: 269,
    name: "M.4 local const aliases are not followed",
    file: "packages/review-engine/src/verification/discarded-replacement.ts",
    find: "      return deriveFrom(declaration.initializer, parameter, checker, depth + 1);",
    replace: '      return "unknown";',
    suite: "packages/review-engine/tests/discarded-replacement.test.ts",
  },
  {
    id: 270,
    name: "M.4 an untraceable return is assumed to be a transformation",
    file: "packages/review-engine/src/verification/discarded-replacement.ts",
    find: '  return mentions(expression, parameter, checker) ? "transformed" : "unknown";',
    replace: '  return "transformed";',
    suite: "packages/review-engine/tests/discarded-replacement.test.ts",
  },
  {
    id: 271,
    name: "M.4 an all-identity callee is not refuted",
    file: "packages/review-engine/src/verification/discarded-replacement.ts",
    find: '  if (derivations.every((entry) => entry === "identity")) {',
    replace: "  if (false as boolean) {",
    suite: "packages/review-engine/tests/discarded-replacement.test.ts",
  },
  {
    id: 272,
    name: "Gate attribution: the L.5 baseline is not subtracted from added true positives",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: "    BASELINE_PUBLISHED_TRUE_POSITIVES.length +",
    replace: "    0 +",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 273,
    name: "Gate attribution: holdout true positives are dropped from the numerator",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: "    measurement.holdout.publishedTruePositives;",
    replace: "    0;",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 274,
    name: "Gate attribution: published false positives do not grow the denominator",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: "      measurement.historical.publishedFalsePositives +",
    replace: "      0 * measurement.historical.publishedFalsePositives +",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 275,
    name: "Gate attribution: the visible development split is admitted into the economics",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: "    measurement.holdout.publishedTruePositives;",
    replace:
      "    measurement.holdout.publishedTruePositives +\n    measurement.development.publishedTruePositives;",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 276,
    name: "Gate attribution: a capability recall miss is blamed on the verifier",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: '    (entry) => entry.kind === "incorrect_verifier_reject",',
    replace: "    () => true,",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 277,
    name: "Gate attribution: an incorrect verifier reject stops failing condition 6",
    file: "apps/review-worker/src/eval/m1-gate.ts",
    find: "        incorrectRejects.length === 0 && measurement.verifier.unavailable === 0,",
    replace: "        measurement.verifier.unavailable === 0,",
    suite: "apps/review-worker/tests/m1-gate.test.ts",
  },
  {
    id: 278,
    name: "M.3.4 the analyzer requires the removed name to appear in head",
    file: "packages/review-engine/src/correctness/export-reachability.ts",
    find: "      if (after.has(exposed.name)) continue;",
    replace:
      "      if (\n        after.has(exposed.name) ||\n        exposingLine(source.head, exposed.name) === undefined\n      )\n        continue;",
    suite: "apps/review-worker/tests/m34-export-reachability.test.ts",
  },
  {
    id: 279,
    name: "M.3.4 a base-side anchor falls back to line 1",
    file: "packages/review-engine/src/correctness/export-reachability.ts",
    find: '      kind: "base",\n      line: base,',
    replace: '      kind: "base",\n      line: 1,',
    suite: "apps/review-worker/tests/m33-anchor.test.ts",
  },
  {
    id: 280,
    name: "M.3.4 a base-side anchor is published as a head-side one",
    file: "packages/review-engine/src/correctness/export-reachability.ts",
    find: '      kind: "base",\n      line: base,',
    replace: '      kind: "head",\n      line: base,',
    suite: "apps/review-worker/tests/m33-anchor.test.ts",
  },
  {
    id: 281,
    name: "M.3.4 TS2724 is dropped from the recognised diagnostics",
    file: "packages/review-engine/src/verification/export-reachability.ts",
    find: "  2459, 2460, 2305, 2724,",
    replace: "  2459, 2460, 2305,",
    suite: "packages/review-engine/tests/export-reachability.test.ts",
  },
  {
    id: 282,
    name: "M.3.4 boundary resolution skips the repository root",
    file: "packages/review-engine/src/verification/export-reachability.ts",
    find: "  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {",
    replace: "  for (let depth = segments.length - 1; depth > 0; depth -= 1) {",
    suite: "packages/review-engine/tests/export-reachability.test.ts",
  },
  {
    id: 283,
    name: "M.3.4 the verifier resolves from the declaring module, not the boundary",
    file: "packages/review-engine/src/verification/export-reachability.ts",
    find: "  const boundaryPath = resolvePublicBoundary(\n    revisions.baseFiles,\n    query.declarationPath,\n  );",
    replace: "  const boundaryPath = query.declarationPath;",
    suite: "packages/review-engine/tests/export-reachability.test.ts",
  },
  {
    id: 284,
    name: "M.3.4 the probe collapses the type and value namespaces",
    file: "packages/review-engine/src/verification/export-reachability.ts",
    find: '  if (query.namespace === "type") {',
    replace: "  if (false as boolean) {",
    suite: "packages/review-engine/tests/export-reachability.test.ts",
  },
  {
    id: 285,
    name: "M.3.4 the scorer ignores side under the historical policy",
    file: "apps/review-worker/src/eval/anchor-scoring.ts",
    find: "      .filter((entry) => sideAgrees(published, entry));",
    replace: "      .filter(() => true);",
    suite: "apps/review-worker/tests/anchor-scoring.test.ts",
  },
  {
    id: 286,
    name: "M.3.4 the M.3.4 analyzer is not registered in production",
    file: "apps/review-worker/src/analysis.ts",
    find: "        analyzeExportReachability(input),",
    replace: "",
    suite: "apps/review-worker/tests/m34-export-reachability.test.ts",
  },
  {
    id: 287,
    name: "M.3.4 two generations of the capability run side by side",
    file: "apps/review-worker/src/analysis.ts",
    find: "        analyzeExportReachability(input),",
    replace:
      "        analyzeExportReachability(input),\n        analyzeExportReachability(input),",
    suite: "apps/review-worker/tests/m34-export-reachability.test.ts",
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

const requestedMutationIds = process.env["ACALYS_MUTATION_IDS"];
const MUTATIONS =
  requestedMutationIds === undefined
    ? ALL_MUTATIONS
    : ALL_MUTATIONS.filter((mutation) =>
        new Set(requestedMutationIds.split(",").map(Number)).has(mutation.id),
      );

const backupDir = mkdtempSync(join(tmpdir(), "acalys-mutate-"));

/**
 * Files currently mutated, and how to put them back.
 *
 * The normal path restores after each mutation. An INTERRUPTED run does not —
 * and one killed by a timeout left `ON CONFLICT` deleted from the promotion
 * insert, sitting in the working tree looking like an edit somebody meant.
 *
 * The same lesson the Docker containers taught, in a second place: cleanup
 * that only runs on the happy path is not cleanup. Signals cannot cover
 * SIGKILL, so the harness also refuses to start if it finds a mutation
 * outstanding from a previous run.
 */
const outstanding = new Map();

// Held for the whole run, so a `test:ci` started in another terminal refuses
// rather than testing whichever mutant happens to be on disk.
const SESSION_NONCE = randomUUID();

const restoreAll = () => {
  for (const [file, saved] of outstanding) {
    try {
      copyFileSync(saved, join(ROOT, file));
    } catch {
      // Nothing useful to do while exiting.
    }
  }
  outstanding.clear();
};

process.once("SIGINT", () => {
  restoreAll();
  releaseSession();
  process.exit(130);
});
process.once("SIGTERM", () => {
  restoreAll();
  releaseSession();
  process.exit(143);
});
process.once("exit", () => {
  restoreAll();
  releaseSession();
});

function backup(file) {
  const target = join(backupDir, file.replaceAll("/", "__"));
  copyFileSync(join(ROOT, file), target);
  return target;
}

function restore(file, saved) {
  copyFileSync(saved, join(ROOT, file));
  outstanding.delete(file);
}

async function runSuite(suite) {
  try {
    const { stdout } = await run(
      "node",
      ["./node_modules/vitest/vitest.mjs", "run", suite, "--reporter=json"],
      {
        cwd: ROOT,
        maxBuffer: 200 * 1024 * 1024,
        // The nonce marks this as the session's own child, so it is allowed
        // through the interlock every other run is refused by.
        env: { ...process.env, ACALYS_MUTATION_SESSION: SESSION_NONCE },
      },
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

// Refuse to start on a tree already carrying an edit to a file this harness
// mutates. Signals cannot cover SIGKILL, so the last line of defence is
// noticing on the way in — an outstanding mutation would otherwise be measured
// as the baseline, and every verdict in the run would be against the wrong
// code.
if (!process.argv.includes("--preflight-only")) {
  const targets = [...new Set(MUTATIONS.map((mutation) => mutation.file))];
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--", ...targets],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  ).trim();

  if (dirty !== "" && process.env["ACALYS_MUTATE_ALLOW_DIRTY"] !== "1") {
    console.error(
      "Refusing to run: files this harness mutates have uncommitted changes.\n\n" +
        dirty +
        "\n\nAn interrupted run leaves a mutation applied, and measuring against " +
        "it would make every verdict a verdict about the wrong code. Commit or " +
        "restore first, or set ACALYS_MUTATE_ALLOW_DIRTY=1 if the changes are " +
        "deliberate.",
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Manifest preflight
// ---------------------------------------------------------------------------
//
// Every mutation is checked for structural applicability BEFORE the first
// expensive suite runs.
//
// This exists because of a specific failure. Mutation 79 was retargeted, the
// file was then reformatted, the anchor no longer matched, and nobody noticed
// until a full run had finished and reported it INVALID. The cost was an
// entire run; the information — "this anchor is stale" — was available in
// milliseconds.
//
// Anchor rot is the expected failure mode of text-fragment targets, not an
// unusual one. Formatting must not be able to silently invalidate a mutation
// definition, so the manifest is validated as a unit and the run refuses to
// start unless every definition still describes a real transformation:
//
//   target matched EXACTLY once   an ambiguous anchor mutates an arbitrary site
//   replacement differs           a no-op mutation is unkillable and meaningless
//   applying changes the source   the transformation is real, not notional
//
// Runtime-invalid verdicts are still possible afterwards (a mutation can apply
// and still fail to reach its premise). This only removes the class that is
// knowable without running anything.
{
  // ---------------------------------------------------------------------
  // Layer 0: does the manifest contain what it is supposed to contain?
  //
  // Preflight validates that each declared mutation targets current source.
  // It cannot notice that a mutation was never declared. P1-M.1 shipped a
  // manifest whose anchors had rotted so badly that preflight refused
  // outright — and the useful reading of that incident is not "two stale
  // anchors" but:
  //
  //     definitions existed -> loader produced nothing usable
  //                         -> preflight had nothing to validate
  //                         -> "mutation protection" existed only nominally
  //
  // So the inventory proves its own completeness first. `> 0` is not enough:
  // a loader that silently drops one definition is also unacceptable, so the
  // check is on the exact id set, and the count is declared here where a
  // reviewer sees it change.
  // ---------------------------------------------------------------------
  const ids = MUTATIONS.map((mutation) => mutation.id);
  const unique = new Set(ids);

  if (MUTATIONS.length === 0) {
    console.error(
      "\nMutation manifest is EMPTY. A harness that loads no definitions " +
        "reports a clean run for a tree it never tested.\n",
    );
    process.exit(2);
  }

  if (unique.size !== ids.length) {
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    console.error(
      `\nMutation manifest declares duplicate ids: ${duplicates.join(", ")}. ` +
        "Two definitions under one id hide one of the two results.\n",
    );
    process.exit(2);
  }

  for (const mutation of MUTATIONS) {
    if (
      typeof mutation.id !== "number" ||
      typeof mutation.name !== "string" ||
      typeof mutation.file !== "string" ||
      typeof mutation.find !== "string" ||
      typeof mutation.replace !== "string" ||
      typeof mutation.suite !== "string"
    ) {
      console.error(
        `\nMutation #${String(mutation.id)} is structurally incomplete. ` +
          "A definition missing a field cannot be executed or classified.\n",
      );
      process.exit(2);
    }
  }

  console.log(
    `Mutation manifest inventory: ${String(MUTATIONS.length)} definitions ` +
      `loaded, ${String(unique.size)} unique ids, 0 structurally incomplete.`,
  );
}

{
  const problems = [];
  const seen = new Map();
  const sources = new Map();

  for (const mutation of MUTATIONS) {
    const id = String(mutation.id);
    if (seen.has(id)) {
      problems.push(
        `#${id} is declared twice (${seen.get(id)} and ${mutation.name})`,
      );
    }
    seen.set(id, mutation.name);

    let source = sources.get(mutation.file);
    if (source === undefined) {
      try {
        source = readFileSync(join(ROOT, mutation.file), "utf8");
        sources.set(mutation.file, source);
      } catch {
        problems.push(`#${id} targets ${mutation.file}, which cannot be read`);
        continue;
      }
    }

    // Exactly once. A fragment that matches twice mutates whichever site comes
    // first, which is not the site the definition names.
    const occurrences = source.split(mutation.find).length - 1;
    if (occurrences === 0) {
      problems.push(
        `#${id} "${mutation.name}": anchor not found in ${mutation.file}`,
      );
      continue;
    }
    if (occurrences > 1) {
      problems.push(
        `#${id} "${mutation.name}": anchor matches ${String(occurrences)} sites in ` +
          `${mutation.file}; it must identify one`,
      );
      continue;
    }

    if (mutation.replace === mutation.find) {
      problems.push(`#${id} "${mutation.name}": replacement is the original`);
      continue;
    }

    const mutated = source.replace(mutation.find, mutation.replace);
    if (mutated === source) {
      problems.push(`#${id} "${mutation.name}": applying it changes nothing`);
    }
  }

  const total = MUTATIONS.length;
  if (problems.length > 0) {
    console.error(
      `\nMutation manifest preflight FAILED — ` +
        `${String(total - problems.length)} of ${String(total)} applicable.\n`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      "\nA stale anchor reports INVALID after a full run and quietly shrinks " +
        "the denominator. Fix the definitions, then re-run.\n",
    );
    process.exit(2);
  }

  console.log(
    `Mutation manifest preflight: ${String(total)} declared, ` +
      `${String(total)} matched uniquely, ${String(total)} change source, ` +
      `0 invalid before execution.\n`,
  );

  // `--preflight-only` validates the manifest without running anything. The
  // whole point of the preflight is that anchor rot is knowable in
  // milliseconds, and a check that can only be reached by paying for a full
  // run is a check nobody performs while editing definitions.
  if (process.argv.includes("--preflight-only")) process.exit(0);
}

acquireSession(SESSION_NONCE);

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
  outstanding.set(mutation.file, saved);
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

  // `skipped` as well as `pending`. Vitest reports a test whose suite failed to
  // start as "skipped", and the first version of this parser only knew
  // "pending" — so five un-run tests counted as five executed, zero failed, and
  // a mutation that broke `beforeAll` outright was reported as SURVIVED.
  const notRun = new Set(["pending", "skipped", "todo"]);
  const executed = tests.filter((test) => !notRun.has(test.status)).length;
  const skipped = tests.filter((test) => notRun.has(test.status)).length;
  const failed = tests.filter((test) => test.status === "failed");

  // Four verdict classes, not two.
  //
  //   SEMANTIC_KILL   a relevant test ran, nothing was skipped, and the
  //                   intended assertion failed. The strongest evidence: the
  //                   specific wrong behaviour was caught by a specific
  //                   expectation.
  //
  //   SETUP_KILL      the mutant applied and made the suite unable to
  //                   establish its preconditions, so nothing ran. Real
  //                   detection — the mutant is not hiding — but weaker: it
  //                   proves the mutation is DETECTABLE, not that an
  //                   expectation caught the specific wrong behaviour.
  //
  //   SURVIVED        relevant behaviour ran and the mutant escaped.
  //
  //   INVALID         the mutation was not meaningfully exercised.
  //
  // Collapsing the first two into "KILLED" says more than the evidence
  // supports; calling a SETUP_KILL invalid says less. #58 ("every suite shares
  // one database name") is the standing example: colliding database names stop
  // `beforeAll` establishing isolated state, so the suite cannot run. That is
  // a genuine consequence of the mutant, and it is not an assertion failing.
  //
  // The fix for a SETUP_KILL is NOT to weaken the test until one assertion
  // executes. Forcing a suite past broken setup builds a test that no longer
  // resembles production execution. Classify honestly instead.

  // A test FILE that failed to run at all.
  //
  // Counted as a kill, and separately from a failed assertion: a mutation that
  // makes the suite unable to start has been detected just as surely as one
  // that trips an expectation, and the previous parser called it SURVIVED
  // because it only looked at assertions that never ran.
  //
  // Distinct from a compile failure, which produces no report to parse and is
  // still INVALID.
  const brokenSuites = (report.testResults ?? [])
    .filter((file) => file.status === "failed")
    .map((file) => file.name ?? "unknown file");

  results.push({
    ...mutation,
    applied: true,
    executed,
    skipped,
    failedCount: failed.length,
    failing: failed.slice(0, 3).map((test) => test.name),
    brokenSuites,
    verdict:
      brokenSuites.length > 0 && failed.length === 0
        ? "SETUP_KILL — suite could not run"
        : executed > 0 && skipped === 0 && failed.length > 0
          ? "SEMANTIC_KILL"
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

const semantic = results.filter((r) => r.verdict === "SEMANTIC_KILL").length;
const setup = results.filter((r) => r.verdict.startsWith("SETUP_KILL")).length;
const survived = results.filter((r) => r.verdict === "SURVIVED").length;
const invalid = results.filter((r) => r.verdict.startsWith("INVALID")).length;
const detected = semantic + setup;

// Detection and semantic detection are reported on separate lines on purpose.
// "92/92 killed" is true and says more than the evidence supports; a reader
// deciding whether a checkpoint closes needs to know how many mutants were
// caught by an assertion rather than by a suite falling over.
console.log(
  `\n\n${String(detected)}/${String(results.length)} mutants detected\n` +
    `  ${String(semantic)} semantic assertion kills\n` +
    `  ${String(setup)} setup/startup kills\n` +
    `  ${String(survived)} survived\n` +
    `  ${String(invalid)} invalid`,
);

if (setup > 0) {
  console.log(
    "\nSetup/startup kills are real detection and weaker evidence. They are " +
      "listed here so a closure claim can cite the right number:",
  );
  for (const result of results.filter((r) =>
    r.verdict.startsWith("SETUP_KILL"),
  )) {
    console.log(`  #${String(result.id)}  ${result.name}`);
  }
}

process.exit(survived > 0 || invalid > 0 ? 1 : 0);
