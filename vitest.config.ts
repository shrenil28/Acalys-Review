import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const contracts = (subpath: string) =>
  fileURLToPath(
    new URL(`./packages/contracts/src/${subpath}`, import.meta.url),
  );

export default defineConfig({
  resolve: {
    // Tests run against contracts' *source*, not its build output, so the
    // suite never depends on build ordering and a contract change is exercised
    // the moment it is written. Production resolution still goes through the
    // package's `exports` field.
    alias: [
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
    ],
  },
  test: {
    // Only workspace packages authored in Phase 0 and later. apps/web is
    // inherited verbatim and carries no tests.
    include: [
      "packages/*/tests/**/*.test.ts",
      "packages/providers/*/tests/**/*.test.ts",
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
