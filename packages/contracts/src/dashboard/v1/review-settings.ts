import { z } from "zod";

const iso = z.string().datetime({ offset: true });
const id = z.string().uuid();
const uniqueStrings = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.array(item).max(max).refine((value) => new Set(value).size === value.length, "Values must be unique");

export const dashboardKbScopeSchema = z.enum(["auto", "global", "local"]);
export const dashboardSeverityModeSchema = z.enum(["off", "warning", "error"]);
export const dashboardPathInstructionSchema = z.strictObject({
  id: z.string().min(1).max(200),
  path: z.string().trim().min(1).max(1_000),
  instructions: z.string().max(20_000),
});
export const dashboardPostMergeActionSchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  description: z.string().max(2_000),
  enabled: z.boolean(),
});

/** Exact durable shape edited by the existing organization settings UI. */
export const dashboardOrganizationReviewConfigSchema = z.strictObject({
  general: z.strictObject({
    language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/u),
    earlyAccess: z.boolean(),
    toneInstructions: z.string().max(20_000),
  }),
  summary: z.strictObject({
    highLevelSummary: z.boolean(),
    highLevelSummaryInstructions: z.string().max(20_000),
    highLevelSummaryInWalkthrough: z.boolean(),
    summaryPlaceholder: z.string().max(1_000),
    autoTitle: z.boolean(),
    autoTitleInstructions: z.string().max(20_000),
    assessLinkedIssues: z.boolean(),
    relatedIssues: z.boolean(),
    relatedPrs: z.boolean(),
    suggestedLabels: z.boolean(),
    autoApplyLabels: z.boolean(),
    suggestedReviewers: z.boolean(),
    autoAssignReviewers: z.boolean(),
  }),
  walkthrough: z.strictObject({
    enabled: z.boolean(),
    changedFilesSummary: z.boolean(),
    sequenceDiagrams: z.boolean(),
    estimateCodeReviewEffort: z.boolean(),
  }),
  behavior: z.strictObject({
    profile: z.enum(["chill", "assertive"]),
    requestChangesWorkflow: z.boolean(),
    autoReview: z.boolean(),
    autoReviewDrafts: z.boolean(),
    baseBranches: uniqueStrings(z.string().trim().min(1).max(500), 100),
    abortOnClose: z.boolean(),
    autoIncrementalReview: z.boolean(),
  }),
  preMergeChecks: z.strictObject({
    title: dashboardSeverityModeSchema,
    description: dashboardSeverityModeSchema,
    issueAssessment: dashboardSeverityModeSchema,
    docstrings: dashboardSeverityModeSchema,
  }),
  finishingTouches: z.strictObject({ docstrings: z.boolean(), unitTests: z.boolean() }),
  postMergeActions: z.array(dashboardPostMergeActionSchema).max(100),
  statuses: z.strictObject({
    reviewStatus: z.boolean(),
    commitStatus: z.boolean(),
    failCommitStatus: z.boolean(),
  }),
  fun: z.strictObject({ poem: z.boolean() }),
  tools: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,100}$/u), z.boolean()).superRefine((value, ctx) => {
    if (Object.keys(value).length > 250) ctx.addIssue({ code: "custom", message: "Too many tool switches" });
  }),
  chat: z.strictObject({ autoReply: z.boolean(), integrations: z.boolean(), artChat: z.boolean() }),
  knowledgeBase: z.strictObject({
    opt: dashboardKbScopeSchema,
    learnings: dashboardKbScopeSchema,
    issues: dashboardKbScopeSchema,
    pullRequests: dashboardKbScopeSchema,
    jiraProjectKeys: uniqueStrings(z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,30}$/u), 100),
    linearTeamKeys: uniqueStrings(z.string().trim().regex(/^[A-Z][A-Z0-9]{0,20}$/u), 100),
  }),
  codeGeneration: z.strictObject({
    docstringLanguage: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/u),
    docstringPathInstructions: z.array(dashboardPathInstructionSchema).max(250),
    unitTestPathInstructions: z.array(dashboardPathInstructionSchema).max(250),
  }),
  issueEnrichment: z.strictObject({
    enabled: z.boolean(),
    autoLabel: z.boolean(),
    linkDuplicates: z.boolean(),
    instructions: z.string().max(20_000),
  }),
});

export const DASHBOARD_DEFAULT_ORGANIZATION_REVIEW_CONFIG = dashboardOrganizationReviewConfigSchema.parse({
  general: { language: "en-US", earlyAccess: false, toneInstructions: "" },
  summary: {
    highLevelSummary: true, highLevelSummaryInstructions: "", highLevelSummaryInWalkthrough: false,
    summaryPlaceholder: "@acalysai summary", autoTitle: true, autoTitleInstructions: "",
    assessLinkedIssues: true, relatedIssues: true, relatedPrs: true, suggestedLabels: true,
    autoApplyLabels: false, suggestedReviewers: true, autoAssignReviewers: false,
  },
  walkthrough: { enabled: true, changedFilesSummary: true, sequenceDiagrams: true, estimateCodeReviewEffort: true },
  behavior: {
    profile: "chill", requestChangesWorkflow: false, autoReview: true, autoReviewDrafts: false,
    baseBranches: ["main", "develop"], abortOnClose: true, autoIncrementalReview: true,
  },
  preMergeChecks: { title: "warning", description: "warning", issueAssessment: "warning", docstrings: "off" },
  finishingTouches: { docstrings: true, unitTests: true },
  postMergeActions: [
    { id: "changelog", name: "Update the changelog", description: "Append a entry describing the merged change.", enabled: false },
    { id: "docs", name: "Refresh generated docs", description: "Regenerate API docs when public signatures change.", enabled: false },
  ],
  statuses: { reviewStatus: true, commitStatus: true, failCommitStatus: false },
  fun: { poem: true },
  tools: {
    ast_grep:false, actionlint:true, biome:false, brakeman:false, buf:false, checkov:false, circleci:true,
    clippy:false, cppcheck:false, detekt:false, eslint:true, gitleaks:true, golangci_lint:true, hadolint:false,
    languagetool:false, luacheck:false, markdownlint:true, oxc:false, phpstan:false, pmd:false, prisma_lint:false,
    regal:false, rubocop:false, ruff:true, semgrep:true, shellcheck:true, shopify_theme_check:false, sqlfluff:false,
    swiftlint:false, yamllint:true,
  },
  chat: { autoReply: true, integrations: true, artChat: false },
  knowledgeBase: { opt:"auto", learnings:"auto", issues:"auto", pullRequests:"auto", jiraProjectKeys:[], linearTeamKeys:[] },
  codeGeneration: { docstringLanguage:"en-US", docstringPathInstructions:[], unitTestPathInstructions:[] },
  issueEnrichment: { enabled:false, autoLabel:false, linkDuplicates:false, instructions:"" },
});

export const dashboardReviewCapabilitySchema = z.strictObject({
  path: z.string().min(1).max(300),
  runtimeEnforced: z.boolean(),
  reason: z.string().min(1).max(1_000),
});

export const DASHBOARD_REVIEW_CAPABILITIES = [
  { path: "general.toneInstructions", runtimeEnforced: true, reason: "Included in the trusted review-policy system frame." },
  { path: "behavior.autoReview", runtimeEnforced: true, reason: "Evaluated before webhook ReviewRequest admission." },
  { path: "behavior.autoReviewDrafts", runtimeEnforced: true, reason: "Draft webhook admission is blocked when disabled." },
  { path: "behavior.baseBranches", runtimeEnforced: true, reason: "Base refs are matched with the canonical glob dialect before admission." },
  { path: "behavior.abortOnClose", runtimeEnforced: true, reason: "Close events cancel only pre-publication review runs." },
  { path: "behavior.autoIncrementalReview", runtimeEnforced: true, reason: "New-push webhook admission is blocked when disabled." },
  { path: "behavior.profile", runtimeEnforced: true, reason: "Controls the trusted review tone profile supplied to the model." },
  { path: "knowledgeBase.linearTeamKeys", runtimeEnforced: true, reason: "Filters Linear issue identifiers resolved from the admitted PR subject." },
  { path: "tools.circleci", runtimeEnforced: true, reason: "Controls whether CircleCI provider evidence is consulted when connected." },
] as const;

export const dashboardOrganizationReviewSettingsSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  config: dashboardOrganizationReviewConfigSchema,
  capabilities: z.array(dashboardReviewCapabilitySchema),
  updatedAt: iso.nullable(),
});
export const dashboardUpdateOrganizationReviewSettingsBodySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  config: dashboardOrganizationReviewConfigSchema,
});

export const dashboardRepositoryReviewSettingsSchema = z.strictObject({
  repositoryId: id,
  revision: z.number().int().nonnegative(),
  lifecycle: z.enum(["enabled", "paused", "archived"]),
  inherit: z.boolean(),
  instructions: z.string().max(20_000),
  ignorePaths: uniqueStrings(z.string().trim().min(1).max(1_000), 500),
  capabilities: z.array(dashboardReviewCapabilitySchema),
  updatedAt: iso.nullable(),
});
export const dashboardUpdateRepositoryReviewSettingsBodySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  inherit: z.boolean(),
  instructions: z.string().max(20_000),
  ignorePaths: uniqueStrings(z.string().trim().min(1).max(1_000), 500),
});
export const dashboardRepositoryLifecycleBodySchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  lifecycle: z.enum(["enabled", "paused"]),
});

export const dashboardEffectiveReviewPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  organizationRevision: z.number().int().nonnegative(),
  repositoryRevision: z.number().int().nonnegative(),
  repositoryLifecycle: z.enum(["enabled", "paused", "archived"]),
  organizationConfig: dashboardOrganizationReviewConfigSchema,
  repository: z.strictObject({
    inherit: z.boolean(),
    instructions: z.string().max(20_000),
    ignorePaths: z.array(z.string().min(1).max(1_000)).max(500),
  }),
});
export const dashboardEffectiveReviewPolicyEnvelopeSchema = z.strictObject({
  policy: dashboardEffectiveReviewPolicySchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type DashboardOrganizationReviewConfig = z.infer<typeof dashboardOrganizationReviewConfigSchema>;
export type DashboardOrganizationReviewSettings = z.infer<typeof dashboardOrganizationReviewSettingsSchema>;
export type DashboardRepositoryReviewSettings = z.infer<typeof dashboardRepositoryReviewSettingsSchema>;
export type DashboardEffectiveReviewPolicy = z.infer<typeof dashboardEffectiveReviewPolicySchema>;
