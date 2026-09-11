export interface McpServer {
  id: string;
  name: string;
  host: string;
  /** Single-letter fallback mark when we have no brand SVG. */
  letter: string;
  added?: boolean;
}

export const mcpServers: McpServer[] = [
  { id: "notion", name: "Notion", host: "mcp.notion.com", letter: "N" },
  { id: "context7", name: "Context7", host: "mcp.context7.com", letter: "C" },
  { id: "linear", name: "Linear", host: "mcp.linear.app", letter: "L" },
  { id: "copilot", name: "GitHub Copilot", host: "api.githubcopilot.com", letter: "G" },
  { id: "sentry", name: "Sentry", host: "mcp.sentry.dev", letter: "S" },
  { id: "asana", name: "Asana", host: "mcp.asana.com", letter: "A" },
  { id: "monday", name: "Monday.com", host: "mcp.monday.com", letter: "M" },
  { id: "clickup", name: "ClickUp", host: "mcp.clickup.com", letter: "C" },
  { id: "atlassian", name: "Atlassian", host: "mcp.atlassian.com", letter: "A" },
  { id: "figma", name: "Figma", host: "mcp.figma.com", letter: "F" },
  { id: "supabase", name: "Supabase", host: "mcp.supabase.com", letter: "S" },
  { id: "deepwiki", name: "DeepWiki", host: "mcp.deepwiki.com", letter: "D" },
];

export interface Capability {
  label: string;
  description: string;
  to: string;
}

export interface TrackerIntegration {
  id: string;
  name: string;
  tagline: string;
  /** Extra copy shown above the capability list, e.g. Jira's self-hosted note. */
  note?: { text: string; linkLabel: string; href: string };
  capabilities: Capability[];
}

export const issueTrackers: TrackerIntegration[] = [
  {
    id: "jira",
    name: "Jira",
    tagline: "Plan, track, and release great software.",
    note: {
      text: "For Jira Cloud, use the button above.",
      linkLabel: "Using Jira Data Center (Self-Hosted)? Click here",
      href: "https://docs.coderabbit.ai/integrations/jira",
    },
    capabilities: [
      {
        label: "Knowledge Base",
        description: "Configure PR context sources",
        to: "/analytics/pr-reviews/knowledge-base",
      },
      {
        label: "Coding Plan",
        description: "Automate coding plan creation",
        to: "/plan/configurations",
      },
    ],
  },
  {
    id: "linear",
    name: "Linear",
    tagline: "Streamline software projects, sprints, and bug tracking.",
    capabilities: [
      {
        label: "Knowledge Base",
        description: "Configure PR context sources",
        to: "/analytics/pr-reviews/knowledge-base",
      },
      {
        label: "Coding Plan",
        description: "Automate coding plan creation",
        to: "/plan/configurations",
      },
    ],
  },
];

export const ciIntegrations = [
  {
    id: "circleci",
    name: "CircleCI",
    description:
      "Continuous Integration and Delivery Platform. Connect your CircleCI builds for enhanced PR analysis.",
  },
];

/**
 * A connector the agent can be granted access to.
 *
 * `letter` is the fallback mark: the app ships brand SVGs for only a handful of
 * services, so everything else renders a tinted lettered tile rather than a
 * missing image.
 */
export interface Connector {
  id: string;
  name: string;
  /** Single-letter fallback mark when we have no brand SVG. */
  letter: string;
  /** Tile tint for the fallback mark. */
  tone: string;
}

export interface ConnectorCategory {
  id: string;
  label: string;
  connectors: Connector[];
}

export const connectorCatalogue: ConnectorCategory[] = [
  {
    id: "observability",
    label: "Observability & incidents",
    connectors: [
      { id: "datadog", name: "Datadog", letter: "D", tone: "#7c3aed" },
      { id: "pagerduty", name: "PagerDuty", letter: "P", tone: "#16a34a" },
      { id: "sentry", name: "Sentry", letter: "S", tone: "#7c3aed" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics & data",
    connectors: [
      { id: "bigquery", name: "BigQuery", letter: "B", tone: "#2563eb" },
      { id: "google-analytics", name: "Google Analytics", letter: "G", tone: "#f59e0b" },
      { id: "google-search-console", name: "Google Search Console", letter: "G", tone: "#2563eb" },
      { id: "posthog", name: "PostHog", letter: "P", tone: "#f97316" },
    ],
  },
  {
    id: "issue-tracking",
    label: "Project & issue tracking",
    connectors: [
      { id: "asana", name: "Asana", letter: "A", tone: "#e11d48" },
      { id: "jira", name: "Jira", letter: "J", tone: "#2563eb" },
      { id: "linear", name: "Linear", letter: "L", tone: "#6366f1" },
      { id: "monday", name: "Monday.com", letter: "M", tone: "#e11d48" },
      { id: "clickup", name: "ClickUp", letter: "C", tone: "#db2777" },
    ],
  },
  {
    id: "devops",
    label: "Development & DevOps",
    connectors: [
      { id: "circleci", name: "CircleCI", letter: "C", tone: "#4b5563" },
      { id: "jenkins", name: "Jenkins", letter: "J", tone: "#b91c1c" },
      { id: "github", name: "GitHub", letter: "G", tone: "#4b5563" },
      { id: "gitlab", name: "GitLab", letter: "G", tone: "#ea580c" },
      { id: "gitlab-self-hosted", name: "GitLab Self-Hosted", letter: "G", tone: "#ea580c" },
      { id: "bitbucket", name: "Bitbucket", letter: "B", tone: "#2563eb" },
      { id: "azure-devops", name: "Azure DevOps", letter: "A", tone: "#0ea5e9" },
      { id: "context7", name: "Context7", letter: "C", tone: "#db2777" },
      { id: "copilot", name: "GitHub Copilot", letter: "G", tone: "#4b5563" },
      { id: "deepwiki", name: "DeepWiki", letter: "D", tone: "#db2777" },
    ],
  },
  {
    id: "design",
    label: "Design & creative",
    connectors: [
      { id: "canva", name: "Canva", letter: "C", tone: "#06b6d4" },
      { id: "figma", name: "Figma", letter: "F", tone: "#e11d48" },
    ],
  },
  {
    id: "productivity",
    label: "Productivity & collaboration",
    connectors: [
      { id: "google-drive", name: "Google Drive", letter: "G", tone: "#16a34a" },
      { id: "google-calendar", name: "Google Calendar", letter: "G", tone: "#2563eb" },
      { id: "notion", name: "Notion", letter: "N", tone: "#4b5563" },
      { id: "onedrive", name: "OneDrive", letter: "O", tone: "#0ea5e9" },
    ],
  },
  {
    id: "cloud",
    label: "Cloud infrastructure",
    connectors: [
      { id: "aws", name: "AWS", letter: "A", tone: "#f59e0b" },
      { id: "google-cloud", name: "Google Cloud", letter: "G", tone: "#2563eb" },
    ],
  },
  {
    id: "support",
    label: "Customer support",
    connectors: [
      { id: "zendesk", name: "Zendesk", letter: "Z", tone: "#0f766e" },
      { id: "intercom", name: "Intercom", letter: "I", tone: "#2563eb" },
    ],
  },
];
