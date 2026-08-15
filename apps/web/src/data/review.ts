export type Priority = "P1" | "P2" | "P3" | "Safe to close" | "No priority";

export type ChangeType = "Feature" | "Fix" | "Refactor" | "Chore" | "Docs";
export type RiskLevel = "High" | "Medium" | "Low";

export interface TriagePr {
  id: string;
  number: number;
  title: string;
  summary: string;
  repo: string;
  author: string;
  reviewers: string[];
  priority: Priority;
  reviewState: "Needs review" | "Changes requested" | "Approved" | "Draft";
  reviewGuidance: string;
  changeType: ChangeType;
  risk: RiskLevel;
  securityRisk: RiskLevel;
  /** Rough share of the codebase the change touches, as a percentage. */
  blastRadius: number;
  /** Minutes a careful human review is expected to take. */
  reviewEffort: number;
  issueSeverity: "Critical" | "High" | "Medium" | "Low" | "None";
  additions: number;
  deletions: number;
  comments: number;
  updatedAt: string;
  authoredByMe: boolean;
  needsMyReview: boolean;
  labels: string[];
}

export const triagePrs: TriagePr[] = [
  { id: "t1", number: 412, title: "Stream agent responses over SSE", summary: "Replaces the buffered response with an SSE stream and adds backpressure handling.", repo: "acalys", author: "shrenil28", reviewers: ["jonas-b", "meera.k"], priority: "P1", reviewState: "Needs review", reviewGuidance: "Focus on the org scope check and the stream teardown path.", changeType: "Feature", risk: "High", securityRisk: "High", blastRadius: 18, reviewEffort: 45, issueSeverity: "High", additions: 412, deletions: 96, comments: 14, updatedAt: "2h ago", authoredByMe: true, needsMyReview: false, labels: ["backend", "streaming"] },
  { id: "t2", number: 298, title: "Add workflow node registry", summary: "Introduces a registry so workflow nodes are discovered from a manifest instead of a static import list.", repo: "n8n-clone", author: "aditya-r", reviewers: ["shrenil28"], priority: "P1", reviewState: "Changes requested", reviewGuidance: "The expression evaluator is unsandboxed — block until that is resolved.", changeType: "Feature", risk: "High", securityRisk: "High", blastRadius: 31, reviewEffort: 90, issueSeverity: "Critical", additions: 884, deletions: 212, comments: 21, updatedAt: "7h ago", authoredByMe: false, needsMyReview: true, labels: ["core"] },
  { id: "t3", number: 88, title: "Introduce plan templates", summary: "Adds reusable plan templates and a picker on the New Plan screen.", repo: "Acalys_Agent_Builder", author: "priya.s", reviewers: [], priority: "P2", reviewState: "Draft", reviewGuidance: "Still a draft — skim for direction rather than detail.", changeType: "Feature", risk: "Low", securityRisk: "Low", blastRadius: 7, reviewEffort: 20, issueSeverity: "Low", additions: 240, deletions: 18, comments: 3, updatedAt: "1d ago", authoredByMe: false, needsMyReview: false, labels: ["planner"] },
  { id: "t4", number: 61, title: "Vector store connection pooling", summary: "Pools connections to the vector store and retries on transient failures.", repo: "rag-pipeline-lab", author: "meera.k", reviewers: ["shrenil28", "jonas-b"], priority: "P2", reviewState: "Needs review", reviewGuidance: "Check the pool size defaults against the ingest concurrency.", changeType: "Refactor", risk: "Medium", securityRisk: "Low", blastRadius: 12, reviewEffort: 30, issueSeverity: "Medium", additions: 156, deletions: 74, comments: 8, updatedAt: "1d ago", authoredByMe: false, needsMyReview: true, labels: ["perf"] },
  { id: "t5", number: 143, title: "Desktop auto-update channel", summary: "Adds an early update channel and a setting to switch between channels.", repo: "acalys-desktop", author: "haruto.y", reviewers: [], priority: "P3", reviewState: "Needs review", reviewGuidance: "Verify the signature check runs before the update is staged.", changeType: "Feature", risk: "Medium", securityRisk: "Medium", blastRadius: 5, reviewEffort: 25, issueSeverity: "Low", additions: 92, deletions: 30, comments: 2, updatedAt: "2d ago", authoredByMe: false, needsMyReview: false, labels: ["desktop"] },
  { id: "t6", number: 22, title: "Bump lint config to flat format", summary: "Migrates ESLint to the flat config format and drops the legacy rc file.", repo: "portfolio-site", author: "shrenil28", reviewers: ["lucia-m"], priority: "P3", reviewState: "Approved", reviewGuidance: "Mechanical change — confirm CI is green and merge.", changeType: "Chore", risk: "Low", securityRisk: "Low", blastRadius: 3, reviewEffort: 10, issueSeverity: "None", additions: 40, deletions: 61, comments: 1, updatedAt: "3d ago", authoredByMe: true, needsMyReview: false, labels: ["chore"] },
  { id: "t7", number: 19, title: "Drop unused analytics beacon", summary: "Removes the analytics beacon and its config, superseded by the new pipeline.", repo: "Acalys_Local_community", author: "lucia-m", reviewers: [], priority: "Safe to close", reviewState: "Approved", reviewGuidance: "Superseded by #24 — close unless the beacon is still referenced.", changeType: "Chore", risk: "Low", securityRisk: "Low", blastRadius: 2, reviewEffort: 5, issueSeverity: "None", additions: 4, deletions: 118, comments: 0, updatedAt: "6d ago", authoredByMe: false, needsMyReview: false, labels: ["cleanup"] },
  { id: "t8", number: 7, title: "Draft: experiment with rerankers", summary: "Spike comparing three rerankers on the internal eval set.", repo: "rag-pipeline-lab", author: "meera.k", reviewers: [], priority: "No priority", reviewState: "Draft", reviewGuidance: "Exploratory — no review needed until it leaves draft.", changeType: "Docs", risk: "Low", securityRisk: "Low", blastRadius: 1, reviewEffort: 15, issueSeverity: "None", additions: 310, deletions: 12, comments: 0, updatedAt: "9d ago", authoredByMe: false, needsMyReview: false, labels: ["spike"] },
  { id: "t9", number: 55, title: "Terraform: rotate state bucket keys", summary: "Rotates the state bucket credentials and moves them into the secret manager.", repo: "infra-terraform", author: "jonas-b", reviewers: ["shrenil28"], priority: "P1", reviewState: "Approved", reviewGuidance: "Confirm the old key is revoked before merging.", changeType: "Fix", risk: "High", securityRisk: "High", blastRadius: 22, reviewEffort: 35, issueSeverity: "Critical", additions: 68, deletions: 22, comments: 4, updatedAt: "3d ago", authoredByMe: false, needsMyReview: true, labels: ["security"] },
];

export const priorityOrder: Priority[] = [
  "P1",
  "P2",
  "P3",
  "Safe to close",
  "No priority",
];

export interface Integration {
  id: string;
  name: string;
  category: "Source control" | "Issue tracking" | "Chat" | "CI" | "Observability";
  description: string;
  connected: boolean;
  connectedAt?: string;
  scopes?: string[];
}

export const integrations: Integration[] = [
  { id: "github", name: "GitHub", category: "Source control", description: "Review pull requests, post comments, and open fix PRs.", connected: true, connectedAt: "2026-02-14", scopes: ["repo", "read:org", "write:discussion"] },
  { id: "gitlab", name: "GitLab", category: "Source control", description: "Review merge requests on self-managed or SaaS GitLab.", connected: false },
  { id: "jira", name: "Jira", category: "Issue tracking", description: "Link findings to issues and pull acceptance criteria into reviews.", connected: true, connectedAt: "2026-04-02", scopes: ["read:jira-work", "write:jira-work"] },
  { id: "linear", name: "Linear", category: "Issue tracking", description: "Attach reviews to Linear issues and sync status on merge.", connected: false },
  { id: "slack", name: "Slack", category: "Chat", description: "Get review summaries and run Acalys commands from Slack.", connected: false },
  { id: "discord", name: "Discord", category: "Chat", description: "Mirror review activity into Discord channels.", connected: false },
  { id: "circleci", name: "CircleCI", category: "CI", description: "Read pipeline failures so reviews can explain broken builds.", connected: true, connectedAt: "2026-05-21", scopes: ["read:pipelines"] },
  { id: "sentry", name: "Sentry", category: "Observability", description: "Correlate findings with production errors.", connected: false },
];

export interface Learning {
  id: string;
  scope: "Organization" | "Repository";
  repo?: string;
  content: string;
  source: "Chat" | "Review reply" | "Manual";
  appliedCount: number;
  createdAt: string;
  author: string;
}

export const learnings: Learning[] = [
  { id: "l1", scope: "Organization", content: "Prefer `Result`-style returns over thrown errors in service modules; reserve exceptions for programmer errors.", source: "Review reply", appliedCount: 41, createdAt: "2026-06-11", author: "shrenil28" },
  { id: "l2", scope: "Repository", repo: "n8n-clone", content: "Workflow nodes must declare an explicit schema; do not infer parameter shapes at runtime.", source: "Chat", appliedCount: 27, createdAt: "2026-06-28", author: "aditya-r" },
  { id: "l3", scope: "Repository", repo: "acalys", content: "All server routes derive the organization from the session, never from the request body.", source: "Review reply", appliedCount: 22, createdAt: "2026-07-04", author: "shrenil28" },
  { id: "l4", scope: "Organization", content: "New public functions ship with a docstring that states the units of every numeric argument.", source: "Manual", appliedCount: 18, createdAt: "2026-07-19", author: "meera.k" },
  { id: "l5", scope: "Repository", repo: "rag-pipeline-lab", content: "Embedding calls go through the batching helper — no direct client calls in ingest code.", source: "Chat", appliedCount: 12, createdAt: "2026-07-25", author: "meera.k" },
  { id: "l6", scope: "Repository", repo: "infra-terraform", content: "Every module exposes `tags` and merges it into all taggable resources.", source: "Review reply", appliedCount: 8, createdAt: "2026-08-01", author: "jonas-b" },
];

export type CacheWorkflow = "Review" | "Chat" | "Fix";

export interface CacheEntry {
  id: string;
  repo: string;
  workflow: CacheWorkflow;
  /** ISO timestamp of when the sandbox snapshot was taken. */
  timestamp: string;
  cacheId: string;
  sizeMb: number;
}

const cacheHours = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

export const caches: CacheEntry[] = [
  { id: "c1", repo: "acalys", workflow: "Review", timestamp: cacheHours(3), cacheId: "cr-cache-8f2a41cd9b70", sizeMb: 184.2 },
  { id: "c2", repo: "acalys", workflow: "Chat", timestamp: cacheHours(9), cacheId: "cr-cache-2b91de44a105", sizeMb: 96.7 },
  { id: "c3", repo: "n8n-clone", workflow: "Review", timestamp: cacheHours(7), cacheId: "cr-cache-51ccb0f7e332", sizeMb: 142.8 },
  { id: "c4", repo: "n8n-clone", workflow: "Fix", timestamp: cacheHours(26), cacheId: "cr-cache-77a3f10c58de", sizeMb: 61.4 },
  { id: "c5", repo: "Acalys_Agent_Builder", workflow: "Review", timestamp: cacheHours(31), cacheId: "cr-cache-c40e9ab21f6d", sizeMb: 96.4 },
  { id: "c6", repo: "rag-pipeline-lab", workflow: "Review", timestamp: cacheHours(52), cacheId: "cr-cache-19fd7e6b0ac4", sizeMb: 61.9 },
  { id: "c7", repo: "Acalys_AI", workflow: "Chat", timestamp: cacheHours(74), cacheId: "cr-cache-a08b53cc7e21", sizeMb: 58.1 },
  { id: "c8", repo: "infra-terraform", workflow: "Review", timestamp: cacheHours(120), cacheId: "cr-cache-6d2f84be9013", sizeMb: 12.3 },
];

export interface Report {
  id: string;
  name: string;
  schedule: "Daily" | "Weekly" | "Monthly" | "On demand";
  recipients: string[];
  channel: "Email" | "Slack" | "Webhook";
  enabled: boolean;
  lastSentAt: string | null;
  scope: string;
}

/** The Reports page starts empty, matching a workspace that has not built one yet. */
export const reports: Report[] = [];

export const reportTemplates = [
  {
    id: "daily-standup",
    name: "Daily standup digest",
    description:
      "Yesterday's merged pull requests, open reviews, and anything blocked, grouped by author.",
  },
  {
    id: "weekly-quality",
    name: "Weekly quality report",
    description:
      "Review volume, acceptance rate by severity, and the checks that failed most often.",
  },
  {
    id: "security-posture",
    name: "Security posture",
    description:
      "New and resolved findings by severity, plus repositories that have never been scanned.",
  },
  {
    id: "custom",
    name: "Start from scratch",
    description: "Pick your own metrics, schedule, and delivery channel.",
  },
];

export interface PlanItem {
  id: string;
  title: string;
  repo: string;
  status: "Draft" | "Ready" | "In progress" | "Shipped";
  steps: number;
  completedSteps: number;
  createdAt: string;
  owner: string;
  source: "Manual" | "Issue" | "Ruleset";
}

/** Reference workspace has not saved a plan yet. */
export const plans: PlanItem[] = [];

export interface Ruleset {
  id: string;
  name: string;
  trigger: string;
  repos: string[];
  enabled: boolean;
}

export const rulesets: Ruleset[] = [
  { id: "r1", name: "Plan on `ready-for-dev`", trigger: "Issue label added: ready-for-dev", repos: ["acalys", "n8n-clone"], enabled: true },
  { id: "r2", name: "Plan on epic created", trigger: "Jira issue type: Epic", repos: ["acalys"], enabled: false },
];
