#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const fail = (message) => {
  console.error(`phase4-live-foundation: FAIL: ${message}`);
  process.exitCode = 1;
};

const inventory = read("docs/review/phase-4/page-capability-inventory.md");
const router = read("apps/web/src/router.tsx");
const liveAdapter = read("apps/web/src/lib/api/liveDashboard.ts");
const test = read("apps/web/tests/live-dashboard.test.ts");
const requestPool = read("apps/web/src/lib/api/sharedRequest.ts");
const requestPoolTest = read("apps/web/tests/shared-request.test.ts");

const routeLiterals = [...router.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]);
for (const route of routeLiterals) {
  if (route === "*") continue;
  const normalized = route.startsWith("/") ? route : `/${route}`;
  if (
    !inventory.includes(`\`${normalized}\``) &&
    !inventory.includes(`\`${route}\``) &&
    !inventory.includes(route)
  ) {
    fail(`inventory does not name router path ${route}`);
  }
}

const connectedPages = [
  "apps/web/src/pages/review/Repositories.tsx",
  "apps/web/src/pages/review/RepositoryDetail.tsx",
  "apps/web/src/pages/review/Learnings.tsx",
  "apps/web/src/pages/security/SecurityRepositories.tsx",
  "apps/web/src/pages/analytics/DashboardLayout.tsx",
  "apps/web/src/pages/analytics/KnowledgeBase.tsx",
];
for (const page of connectedPages) {
  const source = read(page);
  if (/from\s+["']@\/data\//.test(source)) fail(`${page} still statically imports fixture data`);
  if (/lib\/api\/(client|result)/.test(source)) fail(`${page} imports the transport/result boundary directly`);
  if (/@acalys\/contracts\/api/.test(source)) fail(`${page} imports API contracts directly`);
}

const requiredAdapterAnchors = [
  'await import("@/data/repos")',
  'await import("@/data/review")',
  "repository pagination exceeded the dashboard safety bound",
  "knowledge pagination exceeded the dashboard safety bound",
];
for (const anchor of requiredAdapterAnchors) {
  if (!liveAdapter.includes(anchor)) fail(`live adapter is missing ${anchor}`);
}
for (const anchor of ["class SharedRequestPool", "controller.abort()", "expiresAt", "entry.refs += 1"]) {
  if (!requestPool.includes(anchor)) fail(`shared request primitive is missing ${anchor}`);
}
for (const anchor of [
  "deduplicates concurrent consumers",
  "aborts a pending fetch only after the last consumer",
  "does not retain a settled result the caller marks non-reusable",
  "reuses a settled result only inside the configured TTL",
]) {
  if (!requestPoolTest.includes(anchor)) fail(`shared request witness missing: ${anchor}`);
}

const witnessAnchors = [
  "projects repository identity without inventing analytics",
  "joins live knowledge to repository identity without fabricating usage",
  "preserves path-scoped knowledge instead of flattening it to repository scope",
  "keeps transport, contract, authorization and throttling failures distinct",
  "does not turn an absent resource into an empty-success sentence",
];
for (const anchor of witnessAnchors) {
  if (!test.includes(anchor)) fail(`web witness missing: ${anchor}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log(
  `phase4-live-foundation: PASS (${String(routeLiterals.length)} router paths inventoried; ${String(connectedPages.length)} connected surfaces fixture-safe in API mode; ${String(witnessAnchors.length)}/${String(witnessAnchors.length)} focused witnesses present)`,
);
