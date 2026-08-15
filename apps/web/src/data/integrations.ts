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
