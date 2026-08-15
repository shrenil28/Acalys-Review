/** Mirrors the shape of `.acalys.yaml`, which is what this screen edits. */
export interface OrgConfig {
  general: {
    language: string;
    earlyAccess: boolean;
    toneInstructions: string;
  };
  summary: {
    highLevelSummary: boolean;
    highLevelSummaryInstructions: string;
    highLevelSummaryInWalkthrough: boolean;
    summaryPlaceholder: string;
    autoTitle: boolean;
    autoTitleInstructions: string;
    assessLinkedIssues: boolean;
    relatedIssues: boolean;
    relatedPrs: boolean;
    suggestedLabels: boolean;
    autoApplyLabels: boolean;
    suggestedReviewers: boolean;
    autoAssignReviewers: boolean;
  };
  walkthrough: {
    enabled: boolean;
    changedFilesSummary: boolean;
    sequenceDiagrams: boolean;
    estimateCodeReviewEffort: boolean;
  };
  behavior: {
    profile: "chill" | "assertive";
    requestChangesWorkflow: boolean;
    autoReview: boolean;
    autoReviewDrafts: boolean;
    baseBranches: string[];
    abortOnClose: boolean;
    autoIncrementalReview: boolean;
  };
  preMergeChecks: {
    title: "off" | "warning" | "error";
    description: "off" | "warning" | "error";
    issueAssessment: "off" | "warning" | "error";
    docstrings: "off" | "warning" | "error";
  };
  finishingTouches: {
    docstrings: boolean;
    unitTests: boolean;
  };
  postMergeActions: {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
  }[];
  statuses: {
    reviewStatus: boolean;
    commitStatus: boolean;
    failCommitStatus: boolean;
  };
  fun: {
    poem: boolean;
  };
  tools: Record<string, boolean>;
  chat: {
    autoReply: boolean;
    integrations: boolean;
    artChat: boolean;
  };
  knowledgeBase: {
    opt: KbScope;
    learnings: KbScope;
    issues: KbScope;
    pullRequests: KbScope;
    jiraProjectKeys: string[];
    linearTeamKeys: string[];
  };
  codeGeneration: {
    docstringLanguage: string;
    docstringPathInstructions: PathInstruction[];
    unitTestPathInstructions: PathInstruction[];
  };
  issueEnrichment: {
    enabled: boolean;
    autoLabel: boolean;
    linkDuplicates: boolean;
    instructions: string;
  };
}

/** Knowledge-base sources can be scoped per organization or per repository. */
export type KbScope = "auto" | "global" | "local";

export interface PathInstruction {
  id: string;
  path: string;
  instructions: string;
}

export const defaultOrgConfig: OrgConfig = {
  general: {
    language: "en-US",
    earlyAccess: false,
    toneInstructions: "",
  },
  summary: {
    highLevelSummary: true,
    highLevelSummaryInstructions: "",
    highLevelSummaryInWalkthrough: false,
    summaryPlaceholder: "@acalysai summary",
    autoTitle: true,
    autoTitleInstructions: "",
    assessLinkedIssues: true,
    relatedIssues: true,
    relatedPrs: true,
    suggestedLabels: true,
    autoApplyLabels: false,
    suggestedReviewers: true,
    autoAssignReviewers: false,
  },
  walkthrough: {
    enabled: true,
    changedFilesSummary: true,
    sequenceDiagrams: true,
    estimateCodeReviewEffort: true,
  },
  behavior: {
    profile: "chill",
    requestChangesWorkflow: false,
    autoReview: true,
    autoReviewDrafts: false,
    baseBranches: ["main", "develop"],
    abortOnClose: true,
    autoIncrementalReview: true,
  },
  preMergeChecks: {
    title: "warning",
    description: "warning",
    issueAssessment: "warning",
    docstrings: "off",
  },
  finishingTouches: {
    docstrings: true,
    unitTests: true,
  },
  postMergeActions: [
    {
      id: "changelog",
      name: "Update the changelog",
      description: "Append a entry describing the merged change.",
      enabled: false,
    },
    {
      id: "docs",
      name: "Refresh generated docs",
      description: "Regenerate API docs when public signatures change.",
      enabled: false,
    },
  ],
  statuses: {
    reviewStatus: true,
    commitStatus: true,
    failCommitStatus: false,
  },
  fun: {
    poem: true,
  },
  tools: {
    ast_grep: false,
    actionlint: true,
    biome: false,
    brakeman: false,
    buf: false,
    checkov: false,
    circleci: true,
    clippy: false,
    cppcheck: false,
    detekt: false,
    eslint: true,
    gitleaks: true,
    golangci_lint: true,
    hadolint: false,
    languagetool: false,
    luacheck: false,
    markdownlint: true,
    oxc: false,
    phpstan: false,
    pmd: false,
    prisma_lint: false,
    regal: false,
    rubocop: false,
    ruff: true,
    semgrep: true,
    shellcheck: true,
    shopify_theme_check: false,
    sqlfluff: false,
    swiftlint: false,
    yamllint: true,
  },
  chat: {
    autoReply: true,
    integrations: true,
    artChat: false,
  },
  knowledgeBase: {
    opt: "auto",
    learnings: "auto",
    issues: "auto",
    pullRequests: "auto",
    jiraProjectKeys: [],
    linearTeamKeys: [],
  },
  codeGeneration: {
    docstringLanguage: "en-US",
    docstringPathInstructions: [],
    unitTestPathInstructions: [],
  },
  issueEnrichment: {
    enabled: false,
    autoLabel: false,
    linkDuplicates: false,
    instructions: "",
  },
};

export const languages = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "de-DE", label: "German" },
  { code: "es-ES", label: "Spanish" },
  { code: "fr-FR", label: "French" },
  { code: "hi-IN", label: "Hindi" },
  { code: "ja-JP", label: "Japanese" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "zh-CN", label: "Chinese (Simplified)" },
];

/** Sample change set rendered in the live preview pane. */
export const previewChanges = [
  {
    path: "src/middleware/auth.ts",
    summary:
      "Session resolution now derives the organization from the token instead of the request body.",
  },
  {
    path: "src/services/token-service.ts",
    summary:
      "Adds refresh-token rotation and revokes the previous token on every exchange.",
  },
  {
    path: "src/routes/agents.ts",
    summary: "Scopes the agent lookup by the resolved organization.",
  },
];
