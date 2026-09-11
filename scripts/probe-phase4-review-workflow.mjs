#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const fail = (message) => {
  console.error(`phase4-review-workflow: FAIL: ${message}`);
  process.exitCode = 1;
};

const triage = read("apps/web/src/pages/review/Triage.tsx");
const liveTriage = read("apps/web/src/pages/review/LiveTriage.tsx");
const drawer = read("apps/web/src/pages/review/ReviewWorkflowDrawer.tsx");
const workflow = read("apps/web/src/lib/api/reviewWorkflow.ts");
const transport = read("apps/web/src/lib/api/client.ts");
const workflowTest = read("apps/web/tests/review-workflow.test.ts");
const transportTest = read("apps/web/tests/api-client.test.ts");

if (!triage.includes('lazy(async () =>') || !triage.includes('import("./TriageFixture")')) {
  fail("triage does not isolate fixtures behind an explicit lazy demo chunk");
}
if (/from\s+["']@\/data\//.test(triage) || /from\s+["']@\/data\//.test(liveTriage)) {
  fail("API-mode triage statically imports fixture data");
}
for (const page of [liveTriage, drawer]) {
  if (/lib\/api\/(client|result)/.test(page)) fail("review page bypasses the review-workflow adapter");
  if (/@acalys\/contracts\/api/.test(page)) fail("review page imports the HTTP contract directly");
}

const workflowAnchors = [
  'post("/reviews"',
  '"Idempotency-Key": idempotencyKey',
  'followReviewProgress',
  'lastEventId',
  'reviewProgressEventSchema.safeParse',
  'loadReviewArtifacts',
  'dismissFinding',
  'resolveConversation',
  'Date.parse(pullRequest.updatedAt) > Date.parse(run.createdAt)',
  'mapWithConcurrency(',
  'loadReviewRun(',
  'initialReviewRunId',
  'opened.kind === "contract"',
];
for (const anchor of workflowAnchors) if (!workflow.includes(anchor)) fail(`workflow adapter missing ${anchor}`);

const transportAnchors = [
  'eventStream(',
  'Accept: "text/event-stream"',
  '"Last-Event-ID": init.lastEventId',
  'Authorization: token',
  'contentType.toLowerCase().startsWith("text/event-stream")',
];
for (const anchor of transportAnchors) if (!transport.includes(anchor)) fail(`transport boundary missing ${anchor}`);

const witnessAnchors = [
  "parses SSE comments away and joins multi-line data",
  "queues exactly the selected repository + pull request with one stable mutation key",
  "follows a terminal SSE frame and validates it against the public progress contract",
  "rejects an event for another review instead of painting stale progress",
  "fails closed on an SSE contract response instead of reconnecting forever",
  "resumes a dropped stream from the last durable event id",
];
for (const anchor of witnessAnchors) if (!workflowTest.includes(anchor)) fail(`workflow witness missing: ${anchor}`);
for (const anchor of [
  "sends JSON mutations with authorization and the caller's idempotency key",
  "opens SSE with bearer auth and Last-Event-ID instead of relying on EventSource",
  "fails closed when an SSE endpoint responds with the wrong content type",
]) if (!transportTest.includes(anchor)) fail(`transport witness missing: ${anchor}`);

for (const anchor of ['params.get("review")', 'next.set("review", reviewRunId)', 'reviewRunId={selectedReviewRunId}']) {
  if (!liveTriage.includes(anchor)) fail(`triage review-run persistence missing ${anchor}`);
}

for (const state of ["loading", "misconfigured", "failed", "No pull requests", "No matching pull requests"]) {
  if (!liveTriage.includes(state)) fail(`live triage is missing state witness ${state}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log(
  `phase4-review-workflow: PASS (${String(workflowAnchors.length)} adapter invariants; ${String(witnessAnchors.length + 3)} focused transport/workflow witnesses; five-state triage present)`,
);
