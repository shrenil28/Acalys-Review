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
    name: "symbol identity ignores the module, merging same-name symbols",
    file: "packages/code-intelligence/src/repository-index/build.ts",
    find: "        const symbolId = shortId([\n          revision,\n          path,\n          kind,",
    replace:
      "        const symbolId = shortId([\n          revision,\n          kind,",
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
    find: '        provenance: {\n          source: "repository_index",',
    replace:
      '        provenance: {\n          source: "direct_source" as "repository_index",',
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
    find: "  if (index === undefined || !isUsable(index)) return [];",
    replace: "  if (index === undefined) return [];",
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
  },
  {
    id: 93,
    name: "absence is encoded inside the value alphabet",
    file: "packages/code-intelligence/src/repository-index/digest.ts",
    find: 'const ABSENT = "-:";',
    replace: 'const ABSENT = "~";',
    suite: "packages/code-intelligence/tests/repository-index.test.ts",
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
{
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
        ? "KILLED — suite could not run"
        : executed > 0 && skipped === 0 && failed.length > 0
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

const killed = results.filter((r) => r.verdict.startsWith("KILLED")).length;
const survived = results.filter((r) => r.verdict === "SURVIVED").length;
const invalid = results.filter((r) => r.verdict.startsWith("INVALID")).length;
console.log(
  `\n\nKILLED ${String(killed)} / SURVIVED ${String(survived)} / INVALID ${String(invalid)}  (of ${String(results.length)})`,
);
process.exit(survived > 0 || invalid > 0 ? 1 : 0);
