export type MemberType = "User" | "Bot" | "Non-Org User" | "Archived";

export interface TeamMember {
  id: string;
  name: string;
  handle: string;
  email: string;
  role: "Admin" | "Member";
  team: string;
  lastActive: string;
  /** Empty string when the account has never opened a pull request. */
  latestPr: string;
  type: MemberType;
  avatarUrl?: string;
}

export const teamMembers: TeamMember[] = [
  { id: "m1", name: "Patel Shrenil Shaileshkumar", handle: "shrenil28", email: "shrenilshaileshkumar@gmail.com", role: "Admin", team: "Platform", lastActive: "2h ago", latestPr: "", type: "User", avatarUrl: "https://avatars.githubusercontent.com/u/217703268?v=4" },
  { id: "m2", name: "Aditya Raghavan", handle: "aditya-r", email: "aditya@acalys.dev", role: "Member", team: "Platform", lastActive: "5h ago", latestPr: "5 hours ago", type: "User" },
  { id: "m3", name: "Meera Kulkarni", handle: "meera.k", email: "meera@acalys.dev", role: "Member", team: "AI", lastActive: "1d ago", latestPr: "1 day ago", type: "User" },
  { id: "m4", name: "Jonas Brandt", handle: "jonas-b", email: "jonas@acalys.dev", role: "Admin", team: "Infra", lastActive: "1d ago", latestPr: "2 days ago", type: "User" },
  { id: "m5", name: "Priya Sharma", handle: "priya.s", email: "priya@acalys.dev", role: "Member", team: "AI", lastActive: "2d ago", latestPr: "", type: "User" },
  { id: "m6", name: "Haruto Yamada", handle: "haruto.y", email: "haruto@acalys.dev", role: "Member", team: "Product", lastActive: "4d ago", latestPr: "6 days ago", type: "User" },
  { id: "m7", name: "Lucia Moreau", handle: "lucia-m", email: "lucia@acalys.dev", role: "Member", team: "Unassigned", lastActive: "6d ago", latestPr: "", type: "Non-Org User" },
  { id: "m8", name: "release-bot", handle: "release-bot", email: "bots@acalys.dev", role: "Member", team: "Unassigned", lastActive: "3h ago", latestPr: "3 hours ago", type: "Bot" },
  { id: "m9", name: "Tomas Ilic", handle: "tomas-i", email: "tomas@acalys.dev", role: "Member", team: "Infra", lastActive: "38d ago", latestPr: "2 months ago", type: "Archived" },
];

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  createdBy: string;
}

export const apiKeys: ApiKey[] = [
  { id: "k1", label: "CI pipeline", prefix: "acl_live_8f2a", scopes: ["reviews:read", "reports:read"], createdAt: "2026-03-08", lastUsedAt: "3h ago", createdBy: "shrenil28" },
  { id: "k2", label: "Local CLI", prefix: "acl_live_41cd", scopes: ["reviews:read", "reviews:write"], createdAt: "2026-05-19", lastUsedAt: "2d ago", createdBy: "shrenil28" },
  { id: "k3", label: "Metrics exporter", prefix: "acl_live_b7e0", scopes: ["reports:read"], createdAt: "2026-06-30", lastUsedAt: null, createdBy: "jonas-b" },
];

export const orgSettings = {
  reviewProfile: "Chill" as "Chill" | "Assertive",
  autoReview: true,
  autoReviewDrafts: false,
  requestChangesWorkflow: false,
  highLevelSummary: true,
  poemEnabled: true,
  sequenceDiagrams: true,
  autoTitle: true,
  relatedIssues: true,
  finishingTouches: { unitTests: true, docstrings: true },
  tools: {
    eslint: true,
    ruff: true,
    gitleaks: true,
    semgrep: true,
    markdownlint: true,
    actionlint: true,
    hadolint: false,
  },
  pathInstructions: [
    { path: "**/*.ts", instruction: "Flag any `any` that is not accompanied by a comment justifying it." },
    { path: "src/api/**", instruction: "Every route must resolve the organization from the session." },
    { path: "**/*.py", instruction: "Require type hints on public functions." },
    { path: "infra/**", instruction: "Terraform changes must state the blast radius in the PR description." },
  ],
  labelInstructions: [
    { label: "security", instruction: "Escalate anything that touches authentication or secrets." },
  ],
  ignorePaths: ["dist/**", "**/*.snap", "vendor/**"],
};

export const slackWorkspaceState = {
  connected: false,
  workspace: null as string | null,
  channels: [] as { id: string; name: string; purpose: string }[],
};

export const discordServerState = {
  connected: false,
  server: null as string | null,
  channels: [] as { id: string; name: string; purpose: string }[],
};

export const chatScopes = [
  { id: "reviews", label: "Reviews", description: "Read review results and post summaries." },
  { id: "repos", label: "Repositories", description: "List repositories and their review settings." },
  { id: "findings", label: "Security findings", description: "Read findings and change their status." },
  { id: "plans", label: "Plans", description: "Create and update coding plans." },
  { id: "reports", label: "Reports", description: "Trigger on-demand report delivery." },
];

export const chatAutomations = [
  {
    id: "a1",
    name: "Post review summary on merge",
    trigger: "Pull request merged",
    action: "Send the review summary to #engineering",
    enabled: false,
  },
  {
    id: "a2",
    name: "Alert on critical findings",
    trigger: "Finding opened with severity Critical",
    action: "Send an alert to #security with the finding link",
    enabled: false,
  },
  {
    id: "a3",
    name: "Daily open review digest",
    trigger: "Every weekday at 09:00",
    action: "Post the list of reviews waiting on the team",
    enabled: false,
  },
];
