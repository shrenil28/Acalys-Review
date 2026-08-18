/**
 * The build gate, made able to fail.
 *
 * `npm run build` was reporting PASS on a tree whose from-scratch build fails.
 * `apps/review-worker` gained `@acalys/review-engine` and
 * `@acalys/code-intelligence` as dependencies in P1-G without gaining the
 * corresponding project references, so `tsc -b` had no reason to build them
 * first — and the app compiled only because earlier runs had left their `dist/`
 * behind.
 *
 * Incremental state made a broken build look green for four checkpoints. So the
 * gate now removes that state before it runs: no `dist/`, no `.tsbuildinfo`,
 * nothing but sources.
 *
 * This is the same failure the architecture census exists for, one layer down —
 * a gate that cannot detect the class of defect it claims to prevent.
 */
import { execFileSync } from "node:child_process";
import { rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Every `dist` and `*.tsbuildinfo` under a workspace root, and nowhere else. */
function purge(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.name === "dist") {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      purge(path);
    } else if (entry.name.endsWith(".tsbuildinfo")) {
      rmSync(path, { force: true });
    }
  }
}

for (const root of ["apps", "packages"]) {
  if (existsSync(join(ROOT, root))) purge(join(ROOT, root));
}

try {
  execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: ROOT });
} catch {
  console.error(
    "\nClean build failed. A workspace almost certainly depends on a package it " +
      "does not list in `references` — which passes incrementally, because a " +
      "previous run left the dependency's `dist/` in place.",
  );
  process.exit(1);
}

console.log("\nClean build succeeded from sources alone.");
