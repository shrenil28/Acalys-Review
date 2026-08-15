import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only workspace packages authored in Phase 0 and later. apps/web is
    // inherited verbatim and carries no tests.
    include: ["packages/*/tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
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
