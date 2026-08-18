/**
 * Architectural boundary enforcement (P0.txt §59, §84).
 *
 * ESLint's no-restricted-imports catches direct violations in a single file.
 * dependency-cruiser catches what it cannot: transitive reachability. A
 * contracts module that imports a helper that imports @octokit/rest is still a
 * violation, and only a graph walk finds it.
 *
 * The dependency direction this file protects:
 *
 *     provider-github / provider-gitlab / review-engine / api / worker
 *                              │
 *                              ▼
 *                     @acalys/contracts        (never points back up)
 *
 * And, inside contracts:
 *
 *     api/  ──> domain/        internal/ ──> domain/
 *     domain/ ──> (nothing but its own primitives)
 */
module.exports = {
  forbidden: [
    {
      name: "contracts-no-provider-sdk",
      severity: "error",
      comment:
        "Canonical contracts must not reach a source-provider SDK, directly or transitively (§59).",
      from: { path: "^packages/contracts/src" },
      to: {
        path: "node_modules/(@octokit|octokit|@gitbeaker|probot)",
      },
    },
    {
      name: "contracts-no-persistence",
      severity: "error",
      comment:
        "Canonical contracts must not reach an ORM or database driver (§60).",
      from: { path: "^packages/contracts/src" },
      to: {
        path: "node_modules/(@prisma|prisma|drizzle-orm|typeorm|mongoose|kysely|pg)",
      },
    },
    {
      name: "contracts-no-model-sdk",
      severity: "error",
      comment:
        "Canonical contracts must not reach a model-provider SDK (§61). Models live behind agent adapters.",
      from: { path: "^packages/contracts/src" },
      to: {
        path: "node_modules/(@anthropic-ai|openai|cohere-ai|@google-cloud)",
      },
    },
    {
      name: "contracts-no-transport",
      severity: "error",
      comment:
        "Canonical contracts must not reach HTTP or queue infrastructure (§2, §60).",
      from: { path: "^packages/contracts/src" },
      to: { path: "node_modules/(express|bullmq|ioredis|amqplib|kafkajs)" },
    },

    {
      name: "domain-must-not-import-api",
      severity: "error",
      comment:
        "The canonical domain layer is the base of the dependency graph. DTOs project FROM domain, never the reverse.",
      from: { path: "^packages/contracts/src/domain" },
      to: { path: "^packages/contracts/src/api" },
    },
    {
      name: "domain-must-not-import-internal",
      severity: "error",
      comment:
        "Events and commands are built ON the domain; the domain must not know they exist.",
      from: { path: "^packages/contracts/src/domain" },
      to: { path: "^packages/contracts/src/internal" },
    },
    {
      name: "public-api-must-not-import-internal",
      severity: "error",
      comment:
        "The frontend-facing API layer must not expose internal execution contracts (worker attempts, queue state, sandbox leases).",
      from: { path: "^packages/contracts/src/api" },
      to: { path: "^packages/contracts/src/internal" },
    },
    {
      name: "web-must-not-import-internal-contracts",
      severity: "error",
      comment:
        "The UI must never depend on review-worker implementation details. It meets the backend at @acalys/contracts/api/v1 only.",
      from: { path: "^apps/web/" },
      to: { path: "^packages/contracts/src/internal" },
    },
    {
      name: "contracts-must-not-import-persistence",
      severity: "error",
      comment:
        "Persistence technology must not leak into canonical contracts (P0.txt §60). A domain type that knows about the database makes the storage engine a contract change.",
      from: { path: "^packages/contracts/" },
      to: { path: "^packages/database/" },
    },
    {
      name: "web-must-not-import-persistence",
      severity: "error",
      comment:
        "The UI reaching the database bypasses the API layer entirely, and would put SQL and connection handling into a browser bundle.",
      from: { path: "^apps/web/" },
      to: { path: "^packages/database/" },
    },
    {
      name: "code-intelligence-must-not-import-persistence",
      severity: "error",
      comment:
        "Code intelligence is a pure analysis library over source text. Reaching the database would make it untestable without one and would couple context planning to storage.",
      from: { path: "^packages/code-intelligence/" },
      to: { path: "^packages/database/" },
    },
    {
      name: "code-intelligence-must-not-import-providers",
      severity: "error",
      comment:
        "Symbols and context planning are provider-neutral. A GitHub import here would make the planner unusable for GitLab or a local CLI review (§1).",
      from: { path: "^packages/code-intelligence/" },
      to: { path: "^packages/providers/" },
    },
    {
      name: "web-must-not-import-providers",
      severity: "error",
      comment:
        "A provider adapter is where GitHub's vocabulary lives. The UI reaching one would put provider payload shapes into the frontend — the leak the whole adapter boundary exists to prevent (P0.txt §1).",
      from: { path: "^apps/web/" },
      to: { path: "^packages/providers/" },
    },
    {
      name: "providers-must-not-import-api-layer",
      severity: "error",
      comment:
        "An adapter normalizes to the DOMAIN. Importing the public DTO layer would let provider concepts reach the frontend contract, and would couple ingestion to the API's versioning.",
      from: { path: "^packages/providers/" },
      to: { path: "^packages/contracts/src/api" },
    },
    {
      name: "providers-must-not-import-each-other",
      severity: "error",
      comment:
        "GitHub and GitLab adapters must stay independent. A shared helper between them is a shared assumption, and shared assumptions are how one provider's model becomes the other's.",
      from: { path: "^packages/providers/([^/]+)/" },
      to: {
        path: "^packages/providers/([^/]+)/",
        pathNot: "^packages/providers/$1/",
      },
    },
    {
      name: "api-client-must-not-import-internal",
      severity: "error",
      comment:
        "The typed SDK is what apps/web calls. Anything it can import, the UI can transitively see, so it is held to the same boundary as the UI itself.",
      from: { path: "^packages/api-client" },
      to: { path: "^packages/contracts/src/internal" },
    },
    {
      name: "api-client-must-not-import-domain",
      severity: "error",
      comment:
        "The SDK speaks DTOs. Importing the domain layer would put branded ids and execution contracts on the wire path, and would make a domain refactor a client-breaking change.",
      from: { path: "^packages/api-client" },
      to: { path: "^packages/contracts/src/domain" },
    },
    {
      name: "backend-must-not-import-web",
      severity: "error",
      comment:
        "Workers and services must never depend on frontend component structure.",
      from: { path: "^(packages|apps)/(?!web/)" },
      to: { path: "^apps/web/" },
    },

    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make module boundaries meaningless.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Unreachable modules are usually leftovers.",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.[^/]+\\.json$",
          "(^|/)(eslint|vitest|vite|postcss|tailwind)\\.config\\.(js|cjs|mjs|ts)$",
        ],
      },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "node_modules",
        "(^|/)dist/",
        "(^|/)generated/",
        "\\.test\\.ts$",
        "(^|/)tests/",
        // apps/web is inherited verbatim; its scratch .mjs scripts are
        // imported by nothing and are not part of the Phase 0 graph.
        "^apps/web/.*\\.mjs$",
      ],
    },
    tsPreCompilationDeps: true,
    // A tooling-only config that unions two resolution schemes — workspace
    // package exports and apps/web's private "@/*" alias. See its "docs" field.
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
