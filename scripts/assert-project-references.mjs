/**
 * Every workspace dependency must be a TypeScript project reference.
 *
 * `apps/review-worker` depended on `@acalys/review-engine` and
 * `@acalys/code-intelligence` for four checkpoints without referencing either,
 * so `tsc -b` had no reason to build them first. It compiled anyway, because
 * earlier runs had left their `dist/` in place — a warm build passing where a
 * clean checkout fails.
 *
 * `build:clean` catches that, and it costs a full rebuild. This is the cheap
 * structural check that catches the same class in milliseconds and names the
 * missing reference instead of printing a wall of `TS2307`.
 *
 * The two are complementary rather than redundant:
 *
 *     this check    the declared graph is closed
 *     build:clean   the actual build is closed from sources alone
 *
 * A reference can be present and the build still fail; a build can pass warm
 * with the reference missing. Both gates, or neither is worth much.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Workspace package name → directory, from the root workspace globs. */
function workspacePackages() {
  const root = read(join(ROOT, "package.json"));
  const dirs = [];
  for (const pattern of root.workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, "");
    const baseDir = join(ROOT, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(baseDir, entry.name);
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) dirs.push({ dir, manifest: read(manifest) });
    }
  }
  return new Map(dirs.map((entry) => [entry.manifest.name, entry]));
}

const packages = workspacePackages();
const problems = [];

for (const [name, entry] of packages) {
  const buildConfig = join(entry.dir, "tsconfig.build.json");
  if (!existsSync(buildConfig)) continue;

  // JSONC: the build configs carry comments in places.
  const raw = readFileSync(buildConfig, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(raw);
  const referenced = new Set(
    (config.references ?? []).map((reference) =>
      // Normalized to the directory the reference points at, so a reference
      // written with a different relative prefix still matches.
      join(entry.dir, reference.path).replace(/\/tsconfig\.build\.json$/, ""),
    ),
  );

  for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
    const target = packages.get(dependency);
    if (target === undefined) continue; // an external package
    if (!existsSync(join(target.dir, "tsconfig.build.json"))) continue;
    if (!referenced.has(target.dir)) {
      problems.push(
        `${name} depends on ${dependency} but does not reference ` +
          `${target.dir.replace(`${ROOT}/`, "")}/tsconfig.build.json`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(
    "\nMissing TypeScript project references:\n\n" +
      problems.map((problem) => `  ${problem}`).join("\n") +
      "\n\nA warm build hides this: the dependency's `dist/` is already on disk " +
      "from an earlier run, so `tsc -b` finds the declarations it was never told " +
      "to produce. A clean checkout fails.\n",
  );
  process.exit(1);
}

console.log(
  `Project references closed across ${String(packages.size)} workspace packages.`,
);
