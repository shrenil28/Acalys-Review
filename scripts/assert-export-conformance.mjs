/**
 * The dev alias and the published export are the same public surface.
 *
 * The frontend resolves `@acalys/contracts/api/v1` to **source**, so the dev
 * server does not depend on the package having been built. Everything else —
 * CI, the clean build, any future consumer — resolves the **export map**, which
 * points at `dist/`.
 *
 * Two resolution paths for one import specifier is a place where a surface can
 * silently fork:
 *
 * ```
 * Vite dev compiles against shape A
 * the built package publishes shape B
 * both are green, and they are not the same API
 * ```
 *
 * This compares what each path actually exposes. It asserts nothing about
 * internal file layout — only that a consumer using the documented public
 * import sees the same names either way.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const TSX = `${ROOT}/node_modules/tsx/dist/cli.mjs`;

/** Every subpath the package promises, and where each resolves in source. */
const SUBPATHS = [
  { specifier: ".", source: "src/index.ts", dist: "dist/index.js" },
  {
    specifier: "./domain",
    source: "src/domain/index.ts",
    dist: "dist/domain/index.js",
  },
  {
    specifier: "./api/v1",
    source: "src/api/v1/index.ts",
    dist: "dist/api/v1/index.js",
  },
  {
    specifier: "./dashboard/v1",
    source: "src/dashboard/v1/index.ts",
    dist: "dist/dashboard/v1/index.js",
  },
  {
    specifier: "./internal",
    source: "src/internal/index.ts",
    dist: "dist/internal/index.js",
  },
];

const pkg = `${ROOT}/packages/contracts`;

const missing = SUBPATHS.filter((entry) => !existsSync(`${pkg}/${entry.dist}`));
if (missing.length > 0) {
  console.error(
    "Contracts are not built, so the published surface cannot be compared.\n" +
      "Run `npm run build --workspace @acalys/contracts` first.",
  );
  process.exit(2);
}

let failed = false;

for (const entry of SUBPATHS) {
  // The source side is TypeScript, so its exported names are read by asking
  // tsc rather than by importing it.
  const declared = execFileSync(
    "node",
    [
      // Through tsx, not `--experimental-strip-types`: the contract source
      // imports its siblings with `.js` specifiers, which type stripping
      // executes but does not rewrite. The same lesson the shared-server probe
      // learned, in a second place.
      TSX,
      "-e",
      `import(${JSON.stringify(pathToFileURL(`${pkg}/${entry.source}`).href)})
         .then((m) => console.log(Object.keys(m).sort().join("\\n")))`,
    ],
    { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const built = execFileSync(
    "node",
    [
      "-e",
      `import(${JSON.stringify(pathToFileURL(`${pkg}/${entry.dist}`).href)})
         .then((m) => console.log(Object.keys(m).sort().join("\\n")))`,
    ],
    { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const onlySource = declared.filter((name) => !built.includes(name));
  const onlyBuilt = built.filter((name) => !declared.includes(name));

  if (onlySource.length > 0 || onlyBuilt.length > 0) {
    failed = true;
    console.error(
      `\n${entry.specifier} exposes different names through source and dist:\n` +
        (onlySource.length > 0
          ? `  source only: ${onlySource.join(", ")}\n`
          : "") +
        (onlyBuilt.length > 0
          ? `  dist only:   ${onlyBuilt.join(", ")}\n`
          : ""),
    );
  }
}

if (failed) {
  console.error(
    "\nThe dev alias and the published export must be one public surface. " +
      "Otherwise the dev server compiles against something CI never publishes, " +
      "and both stay green while disagreeing.",
  );
  process.exit(1);
}

console.log(
  `Public surface identical through source and dist across ${String(SUBPATHS.length)} subpaths.`,
);
