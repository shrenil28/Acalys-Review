import {
  BookOpen,
  Activity,
  BarChart3,
  Boxes,
  Braces,
  Compass,
  Database,
  FileCode2,
  FlaskConical,
  GitPullRequestArrow,
  Github,
  Key,
  Link2,
  ListChecks,
  Plug,
  ScrollText,
  Search,
  Settings,
  Shield,
  Slack,
  Sparkles,
  Users,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { DiscordIcon } from "@/components/icons";

export type NavBadge = { label: string; tone: "brand" | "neutral" };

export interface NavLeaf {
  label: string;
  to: string;
  icon?: LucideIcon | typeof DiscordIcon;
  badge?: NavBadge;
  /** Rendered with a lock and a muted label until the integration is connected. */
  gated?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: LucideIcon | typeof DiscordIcon;
  badge?: NavBadge;
  /** Matching prefixes used to auto-expand the group on navigation. */
  match: string;
  alsoMatch?: string[];
  items: NavLeaf[];
}

export type NavEntry =
  | { kind: "link"; leaf: NavLeaf }
  | { kind: "group"; group: NavGroup }
  | { kind: "divider"; id: string };

export const navigation: NavEntry[] = [
  { kind: "link", leaf: { label: "Explore", to: "/", icon: Compass } },
  {
    kind: "group",
    group: {
      id: "analytics",
      label: "Analytics",
      icon: BarChart3,
      match: "/analytics",
      items: [
        { label: "PR reviews", to: "/analytics/pr-reviews" },
        { label: "IDE/CLI reviews", to: "/analytics/ide-cli-reviews" },
        {
          label: "PR Security reviews",
          to: "/analytics/pr-security-reviews",
        },
        { label: "Reports", to: "/reports" },
      ],
    },
  },
  {
    kind: "link",
    leaf: { label: "Connections", to: "/integrations", icon: Plug },
  },
  { kind: "divider", id: "d1" },
  {
    kind: "group",
    group: {
      id: "review",
      label: "Review",
      icon: GitPullRequestArrow,
      match: "/review",
      alsoMatch: ["/organization/settings"],
      items: [
        { label: "Triage", to: "/review/triage" },
        { label: "Repositories", to: "/review/repositories" },
        { label: "Learnings", to: "/review/learnings" },
        { label: "Caches", to: "/review/cache" },
        { label: "Organization Settings", to: "/organization/settings/general" },
      ],
    },
  },
  {
    kind: "group",
    group: {
      id: "slack",
      label: "Slack",
      icon: Slack,
      match: "/slack",
      items: [
        { label: "Scopes", to: "/slack/scopes" },
        { label: "Automations", to: "/slack/automations" },
        { label: "Knowledge base", to: "/slack/knowledge-base" },
        { label: "Connections", to: "/slack/connections" },
        { label: "Sandbox", to: "/slack/sandbox" },
        { label: "Activity", to: "/slack/activity" },
        { label: "PR auto fix", to: "/slack/pr-auto-fix" },
      ],
    },
  },
  {
    kind: "group",
    group: {
      id: "discord",
      label: "Discord",
      icon: DiscordIcon,
      match: "/discord",
      items: [
        { label: "Scopes", to: "/discord/scopes" },
        { label: "Connections", to: "/discord/connections" },
        { label: "Automations", to: "/discord/automations" },
        { label: "Knowledge base", to: "/discord/knowledge-base" },
        { label: "Sandbox", to: "/discord/sandbox" },
        { label: "Activity", to: "/discord/activity" },
      ],
    },
  },
  {
    kind: "group",
    group: {
      id: "security",
      label: "Security",
      icon: Shield,
      match: "/security",
      items: [
        { label: "Overview", to: "/security/overview" },
        { label: "Repositories", to: "/security/repositories" },
        { label: "AI Deep Scan", to: "/security/ai-deep-scan" },
        { label: "PR Findings", to: "/security/pr-findings" },
        { label: "Activity Log", to: "/security/activity-log" },
      ],
    },
  },
  {
    kind: "group",
    group: {
      id: "plan",
      label: "Plan",
      icon: ListChecks,
      match: "/plan",
      items: [
        { label: "Discover", to: "/plan/discover" },
        { label: "New Plan", to: "/plan/new" },
        { label: "Plans", to: "/plan/plans" },
        { label: "Configurations", to: "/plan/configurations" },
      ],
    },
  },
  { kind: "divider", id: "d2" },
  {
    kind: "group",
    group: {
      id: "account",
      label: "Account",
      icon: Settings,
      match: "/settings",
      items: [
        { label: "Settings", to: "/settings" },
        { label: "Team Management", to: "/settings/team" },
        { label: "API Keys", to: "/settings/api-keys" },
      ],
    },
  },
];

/** Left rail shown inside the PR reviews dashboard. */
export const prReviewViews = [
  { label: "Summary", to: "/analytics/pr-reviews" },
  { label: "Quality Metrics", to: "/analytics/pr-reviews/quality-metrics" },
  { label: "Time Metrics", to: "/analytics/pr-reviews/time-metrics" },
  { label: "Knowledge Base", to: "/analytics/pr-reviews/knowledge-base" },
  { label: "Organization Trends", to: "/analytics/pr-reviews/organization-trends" },
  { label: "Pre-merge Checks", to: "/analytics/pr-reviews/pre-merge-checks" },
  { label: "Reporting", to: "/analytics/pr-reviews/reporting" },
  { label: "Data Metrics", to: "/analytics/pr-reviews/data-metrics" },
  { label: "Data Export", to: "/analytics/pr-reviews/data-export" },
];

/** The IDE/CLI dashboard exposes a shorter set of views. */
export const ideCliViews = [
  { label: "Summary", to: "/analytics/ide-cli-reviews" },
  { label: "Organization Trends", to: "/analytics/ide-cli-reviews/organization-trends" },
  { label: "Data Metrics", to: "/analytics/ide-cli-reviews/data-metrics" },
];

/** Icons reused by the command palette and empty states. */
export const featureIcons = {
  activity: Activity,
  automations: Wand2,
  caches: Database,
  connections: Link2,
  github: Github,
  integrations: Plug,
  key: Key,
  knowledge: BookOpen,
  learnings: Sparkles,
  logs: ScrollText,
  members: Users,
  repos: Boxes,
  sandbox: FlaskConical,
  scopes: Braces,
  search: Search,
  config: FileCode2,
} as const;
