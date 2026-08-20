import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const contracts = (subpath: string) =>
  fileURLToPath(
    new URL(`./packages/contracts/src/${subpath}`, import.meta.url),
  );

/** Workspace packages resolve to source, for the same reason contracts do. */
const workspace = (relative: string) =>
  fileURLToPath(new URL(`./${relative}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against contracts' *source*, not its build output, so the
    // suite never depends on build ordering and a contract change is exercised
    // the moment it is written. Production resolution still goes through the
    // package's `exports` field.
    alias: [
      {
        // apps/web's own alias, so a module under test resolves `@/…` the way
        // Vite and TypeScript do. Without it a hook importing `@/lib/…` fails
        // only when a test finally imports it — which is exactly when the
        // frontend seams started being tested.
        find: /^@\/(.*)/,
        replacement: workspace("apps/web/src/$1"),
      },
      {
        find: "@acalys/contracts/api/v1",
        replacement: contracts("api/v1/index.ts"),
      },
      {
        find: "@acalys/contracts/internal",
        replacement: contracts("internal/index.ts"),
      },
      {
        find: "@acalys/contracts/domain",
        replacement: contracts("domain/index.ts"),
      },
      { find: /^@acalys\/contracts$/, replacement: contracts("index.ts") },
      {
        find: /^@acalys\/database$/,
        replacement: workspace("packages/database/src/index.ts"),
      },
      {
        find: /^@acalys\/provider-github$/,
        replacement: workspace("packages/providers/github/src/index.ts"),
      },
      {
        find: /^@acalys\/webhook-gateway$/,
        replacement: workspace("apps/webhook-gateway/src/index.ts"),
      },
      {
        find: /^@acalys\/code-intelligence$/,
        replacement: workspace("packages/code-intelligence/src/index.ts"),
      },
      {
        find: /^@acalys\/review-engine$/,
        replacement: workspace("packages/review-engine/src/index.ts"),
      },
    ],
  },
  test: {
    // Workspace packages, and apps/web's logic tests.
    //
    // apps/web was inherited verbatim and carried no tests. It now has some —
    // for the clipboard contract and the triage ordering — matched by the
    // existing `apps/*/tests/**` pattern rather than a new one.
    include: [
      "packages/*/tests/**/*.test.ts",
      "packages/providers/*/tests/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
    environment: "node",
    // Phase 0 is pure contract code: no I/O, no timers, no network. A test
    // that needs more than a second is a design smell, not a slow machine.
    testTimeout: 5_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/index.ts", "**/*.d.ts"],
    },
  },
});
