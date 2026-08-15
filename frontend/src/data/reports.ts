export type ReportKind = "recurring" | "ondemand";

export interface ReportChannel {
  id: "slack" | "discord" | "teams" | "email";
  name: string;
  description: string;
  /** Slack carries an extra pointer to the agent, as in the app. */
  extra?: { label: string; href: string };
}

export const reportChannels: ReportChannel[] = [
  {
    id: "slack",
    name: "Slack",
    description:
      "Connect your Slack workspace to set up the channel for sending the report.",
    extra: { label: "Slack agent!", href: "/slack/scopes" },
  },
  {
    id: "discord",
    name: "Discord",
    description: "Connect your Discord server to set up the channel for sending the report.",
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    description: "Enable and configure the Teams webhook to send the report to.",
  },
  {
    id: "email",
    name: "Email",
    description: "Configure the email addresses to send the report to.",
  },
];

export const promptTemplates = [
  {
    id: "daily-standup",
    label: "Daily Standup Report",
    prompt: `Use the <overall_instructions> to guide the content of the summary. Use the format shown in <example> but do not include or refer the example's content in the final summary/report.`,
  },
  {
    id: "weekly-quality",
    label: "Weekly Quality Report",
    prompt: `Summarise review quality for the period: acceptance rate by severity, the checks that failed most often, and the repositories trending in the wrong direction.`,
  },
  {
    id: "security-posture",
    label: "Security Posture Report",
    prompt: `List findings opened and resolved in the period, grouped by severity. Call out repositories that have never been scanned.`,
  },
  {
    id: "release-notes",
    label: "Release Notes",
    prompt: `Turn merged pull requests into release notes grouped by New features, Bug fixes, and Chores. Keep each entry to one line.`,
  },
];

export const groupByOptions = [
  "None",
  "Repository",
  "Team",
  "Author",
  "Severity",
];

export const parameterOptions = [
  { id: "repository", label: "Repository", hint: "Limit the report to specific repositories." },
  { id: "team", label: "Team", hint: "Limit the report to specific teams." },
  { id: "author", label: "PR author", hint: "Limit the report to pull requests by these authors." },
  { id: "label", label: "PR label", hint: "Only include pull requests carrying these labels." },
  { id: "state", label: "PR state", hint: "Filter by open, merged, or closed." },
];

export const dateRangePresets = ["7 days", "14 days", "30 days", "90 days", "Custom"];

export const timezones = [
  "Asia/Calcutta",
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
