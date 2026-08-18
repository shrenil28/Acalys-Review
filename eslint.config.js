import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Repo-wide lint baseline. Phase 0 establishes the first one — there was no
 * previous ESLint or Prettier setup to honour (P0.txt §102).
 *
 * The architectural rules below are the ESLint half of boundary enforcement
 * (§59, §84); dependency-cruiser is the other half and catches transitive
 * violations that a per-file import rule cannot see.
 */
export default tseslint.config(
  {
    // apps/web is inherited verbatim and is not part of the Phase 0 surface.
    // Its stray Playwright/screenshot scratch scripts (*.mjs) are imported by
    // nothing and are intentionally left untouched.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/generated/**",
      "**/*.tsbuildinfo",
      "apps/web/**",
      // Repository-level CI helpers. Plain Node scripts outside any package's
      // TypeScript project, so the type-aware rules have no program to resolve
      // them against; they are exercised by being run in CI rather than typed.
      "scripts/*.mjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // §86 — no unchecked `any`. External data enters through `unknown`.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // §59 / §60 / §61 — provider, persistence, and model SDKs must never be
  // reachable from the canonical contracts package.
  // ---------------------------------------------------------------------
  {
    files: ["packages/contracts/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@octokit/*",
                "octokit",
                "@gitbeaker/*",
                "probot",
                "@slack/*",
              ],
              message:
                "Provider SDKs must terminate at the provider adapter boundary (P0.txt §59). Canonical contracts stay provider-neutral.",
            },
            {
              group: [
                "@prisma/*",
                "prisma",
                "drizzle-orm*",
                "typeorm",
                "mongoose",
                "pg",
                "kysely",
              ],
              message:
                "Canonical contracts are persistence-neutral (P0.txt §60). Map to storage models in a persistence adapter.",
            },
            {
              group: [
                "@anthropic-ai/*",
                "openai",
                "@google/*",
                "@google-cloud/*",
                "cohere-ai",
              ],
              message:
                "Canonical contracts are agent/model-neutral (P0.txt §61). Model types belong behind an agent adapter.",
            },
            {
              group: ["bullmq", "ioredis", "amqplib", "kafkajs", "express"],
              message:
                "Transport and queue technology must not leak into canonical contracts (P0.txt §2, §60).",
            },
          ],
        },
      ],
    },
  },

  // §58 — hashing must go through canonicalJson(); raw JSON.stringify has
  // no key-order guarantee and would make fingerprints non-deterministic.
  {
    files: ["packages/contracts/src/**/*.ts"],
    ignores: [
      "packages/contracts/src/domain/primitives/canonical-json.ts",
      "packages/contracts/src/domain/primitives/format.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='JSON'][property.name='stringify']",
          message:
            "Use canonicalJson() — JSON.stringify has no key-order guarantee, so hashing its output is non-deterministic (P0.txt §58).",
        },
      ],
    },
  },

  // Tests may assert on the shapes production code is forbidden from producing.
  {
    files: ["**/tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },

  // Root config files are plain JS/CJS and belong to no TS project, so the
  // type-aware rules cannot run against them.
  {
    files: ["*.js", "*.cjs", "*.mjs", "*.config.js", "*.config.ts"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false, project: false },
    },
  },
);
