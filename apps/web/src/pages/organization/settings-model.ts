import {
  DASHBOARD_DEFAULT_ORGANIZATION_REVIEW_CONFIG,
  type DashboardOrganizationReviewConfig,
} from "@acalys/contracts/dashboard/v1";

export type OrgConfig = DashboardOrganizationReviewConfig;
export type KbScope = OrgConfig["knowledgeBase"]["opt"];
export type PathInstruction = OrgConfig["codeGeneration"]["docstringPathInstructions"][number];

export const defaultOrgConfig: OrgConfig = DASHBOARD_DEFAULT_ORGANIZATION_REVIEW_CONFIG;

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
] as const;

/** Stable example change set rendered by the settings preview in either data mode. */
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
] as const;
