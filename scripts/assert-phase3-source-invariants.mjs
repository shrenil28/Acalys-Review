/**
 * Dependency-free Phase 3 source invariant check.
 *
 * This is intentionally runnable before npm install. It protects the frozen
 * public surface and the two architecture boundaries that must remain true in
 * every Phase 3 acceptance environment.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const ROUTES_FILE = "packages/contracts/src/api/v1/routes.ts";
const APP_FILE = "apps/api/src/app.ts";
const EXPECTED_ROUTE_COUNT = 14;

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `could not locate source section ${startMarker} .. ${endMarker}`,
    );
  }
  return source.slice(start, end);
}

function walk(dir, predicate, out = []) {
  for (const entry of readdirSync(dir)) {
    // `.claude` holds agent worktrees: untracked, gitignored full copies of this
    // repository. Scanning them reports one violation per copy for source that is
    // not repository source, so a clean tree fails on the presence of scratch
    // checkouts alone.
    if (
      [
        "node_modules",
        ".git",
        ".claude",
        "dist",
        "build",
        ".next",
        "coverage",
      ].includes(entry)
    )
      continue;
    const absolute = join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) walk(absolute, predicate, out);
    else if (predicate(absolute)) out.push(absolute);
  }
  return out;
}

function importsPackage(source, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\bfrom\\s+["']${escaped}["']`),
    new RegExp(`\\bimport\\s*\\(\\s*["']${escaped}["']\\s*\\)`),
    new RegExp(`\\brequire\\s*\\(\\s*["']${escaped}["']\\s*\\)`),
  ];
  return patterns.some((pattern) => pattern.test(source));
}

const problems = [];
const routeSource = read(ROUTES_FILE);
const manifestBody = section(
  routeSource,
  "export const API_ROUTES = {",
  "} as const satisfies Record<string, RouteDefinition>;",
);
const routeNames = [
  ...manifestBody.matchAll(/^  ([A-Za-z][A-Za-z0-9_]*): \{$/gm),
].map((match) => match[1]);

const appSource = read(APP_FILE);
const handlerBody = section(
  appSource,
  "  const handlers:",
  "\n\n  for (const [name, route]",
);
const handlerNames = [
  ...handlerBody.matchAll(/^    async ([A-Za-z][A-Za-z0-9_]*)\(/gm),
].map((match) => match[1]);

if (routeNames.length !== EXPECTED_ROUTE_COUNT) {
  problems.push(
    `API_ROUTES has ${routeNames.length} entries; expected ${EXPECTED_ROUTE_COUNT}`,
  );
}
if (new Set(routeNames).size !== routeNames.length)
  problems.push("API_ROUTES contains duplicate route names");
if (new Set(handlerNames).size !== handlerNames.length)
  problems.push("API handler table contains duplicate handler names");

const missingHandlers = routeNames.filter(
  (name) => !handlerNames.includes(name),
);
const extraHandlers = handlerNames.filter((name) => !routeNames.includes(name));
if (missingHandlers.length > 0)
  problems.push(`missing handlers: ${missingHandlers.join(", ")}`);
if (extraHandlers.length > 0)
  problems.push(`extra handlers: ${extraHandlers.join(", ")}`);

if (!routeSource.includes('path: "/reviews/:id/events"')) {
  problems.push("frozen review-event SSE route is missing");
}
if (!appSource.includes("REVIEW_EVENTS_STREAM.path")) {
  problems.push(
    "review-event SSE route is not mounted from the frozen contract",
  );
}

const apiFiles = walk(join(ROOT, "apps", "api", "src"), (path) =>
  /\.(?:ts|tsx)$/.test(path),
);
const apiWorkerImports = [];
for (const file of apiFiles) {
  const source = readFileSync(file, "utf8");
  if (
    /\breview-worker\b/.test(source) &&
    /\b(?:from|import|require)\b/.test(source)
  ) {
    apiWorkerImports.push(relative(ROOT, file));
  }
}
if (apiWorkerImports.length > 0) {
  problems.push(
    `apps/api imports review-worker internals: ${apiWorkerImports.join(", ")}`,
  );
}

const tsFiles = walk(ROOT, (path) => /\.(?:ts|tsx)$/.test(path));
const illegalPgImports = [];
for (const file of tsFiles) {
  const rel = relative(ROOT, file).split(sep).join("/");
  if (rel.startsWith("packages/database/")) continue;
  const source = readFileSync(file, "utf8");
  if (importsPackage(source, "pg")) illegalPgImports.push(rel);
}
if (illegalPgImports.length > 0) {
  problems.push(
    `direct pg imports outside @acalys/database: ${illegalPgImports.join(", ")}`,
  );
}

const packageJson = JSON.parse(read("package.json"));
const requiredScripts = [
  "verify",
  "mutate:phase3",
  "probe:phase3-architecture",
  "accept:phase3",
  "accept:phase3:preflight",
];
for (const script of requiredScripts) {
  if (typeof packageJson.scripts?.[script] !== "string")
    problems.push(`missing package script ${script}`);
}

const result = {
  ok: problems.length === 0,
  routes: routeNames.length,
  handlers: handlerNames.length,
  missingHandlers,
  extraHandlers,
  apiWorkerImports: apiWorkerImports.length,
  illegalPgImports: illegalPgImports.length,
  typescriptFilesScanned: tsFiles.length,
  problems,
};

if (process.argv.includes("--json"))
  console.log(JSON.stringify(result, null, 2));
else {
  console.log(
    `Phase 3 source invariants: routes ${routeNames.length}/${EXPECTED_ROUTE_COUNT}; ` +
      `handlers ${handlerNames.length}/${EXPECTED_ROUTE_COUNT}; API→worker imports ${apiWorkerImports.length}; ` +
      `out-of-package pg imports ${illegalPgImports.length}.`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
}

process.exit(result.ok ? 0 : 1);
