/**
 * Deterministic sample data for the analytics dashboards. A seeded generator
 * keeps every render (and every reload) identical, so screenshots stay stable.
 */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function weekLabels(count: number) {
  const labels: string[] = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - cursor.getDay());
  for (let index = count - 1; index >= 0; index -= 1) {
    const day = new Date(cursor);
    day.setDate(cursor.getDate() - index * 7);
    labels.push(
      day.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    );
  }
  return labels;
}

function dayLabels(count: number) {
  const labels: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const day = new Date();
    day.setDate(day.getDate() - index);
    labels.push(day.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  }
  return labels;
}

function ramp(
  labels: string[],
  seed: number,
  base: number,
  spread: number,
  drift = 0.04,
) {
  const random = seeded(seed);
  return labels.map((label, index) => ({
    label,
    value: Math.round(base * (1 + drift * index) + random() * spread),
  }));
}

export const weeks = weekLabels(12);
export const days = dayLabels(14);

export const summary = {
  activeUsers: 18,
  activeRepositories: 11,
  mergedPullRequests: 146,
  reviewComments: 1_284,
  chatSessions: 92,
  reviewerTimeSavedHours: 213,
  medianTimeToMergeHours: 9.4,
  avgCommentsPerPr: 8.8,
};

export const weeklyActiveUsers = ramp(weeks, 11, 9, 6, 0.06);

export const weeklyPullRequests = weeks.map((label, index) => {
  const random = seeded(index + 21);
  const created = Math.round(14 + index * 0.7 + random() * 7);
  return { label, created, merged: Math.round(created * (0.74 + random() * 0.16)) };
});

export const weeklyComments = weeks.map((label, index) => {
  const random = seeded(index + 41);
  return {
    label,
    coderabbit: Math.round(62 + index * 3 + random() * 24),
    human: Math.round(21 + random() * 14),
  };
});

export const weeklyAvgPrPerUser = ramp(weeks, 61, 3, 2, 0.03).map((point) => ({
  label: point.label,
  value: Number((point.value / 2 + 1.2).toFixed(1)),
}));

export const weeklyChatSessions = ramp(weeks, 71, 5, 9, 0.08);

export const weeklyPipelineFailures = ramp(weeks, 81, 2, 5, -0.02);

export const reviewCommentsBySeverity = [
  { name: "Critical", value: 34 },
  { name: "High", value: 121 },
  { name: "Medium", value: 402 },
  { name: "Low", value: 517 },
  { name: "Info", value: 210 },
];

export const severityDistribution = reviewCommentsBySeverity;

export const commentsByCategory = [
  { label: "Correctness", value: 318 },
  { label: "Security", value: 96 },
  { label: "Performance", value: 141 },
  { label: "Maintainability", value: 264 },
  { label: "Testing", value: 187 },
  { label: "Documentation", value: 152 },
  { label: "Style", value: 126 },
];

export const acceptanceByCategory = [
  { label: "Correctness", value: 71 },
  { label: "Security", value: 83 },
  { label: "Performance", value: 58 },
  { label: "Maintainability", value: 49 },
  { label: "Testing", value: 64 },
  { label: "Documentation", value: 41 },
  { label: "Style", value: 33 },
];

export const acceptanceBySeverity = [
  { label: "Critical", value: 91 },
  { label: "High", value: 78 },
  { label: "Medium", value: 56 },
  { label: "Low", value: 38 },
  { label: "Info", value: 22 },
];

export const commentCountBySeverity = reviewCommentsBySeverity.map((entry) => ({
  label: entry.name,
  value: entry.value,
}));

/* ---------------------------------------------------------------- Time */

export const timeMetrics = {
  timeToMergeHours: 9.4,
  timeToLastCommitHours: 4.1,
  timeToLastHumanReviewHours: 6.8,
};

export const weeklyReviewReadyToMerge = ramp(weeks, 91, 11, 6, -0.03).map((point) => ({
  label: point.label,
  value: Number((point.value / 1.4).toFixed(1)),
}));

export const weeklyReviewReadyToLastCommit = ramp(weeks, 101, 6, 4, -0.02).map(
  (point) => ({ label: point.label, value: Number((point.value / 1.5).toFixed(1)) }),
);

export const weeklyReviewReadyToHumanReview = ramp(weeks, 111, 9, 5, -0.02).map(
  (point) => ({ label: point.label, value: Number((point.value / 1.3).toFixed(1)) }),
);

/* ------------------------------------------------------- Organization */

export const weeklyReviews = ramp(weeks, 121, 22, 12, 0.05);
export const weeklyReviewCommentsTotal = ramp(weeks, 131, 96, 48, 0.05);
export const weeklyAvgReviewsPerUser = ramp(weeks, 141, 3, 3, 0.02).map((point) => ({
  label: point.label,
  value: Number((point.value / 2 + 0.8).toFixed(1)),
}));

export const toolFindingsBySeverity = [
  { name: "Critical", value: 12 },
  { name: "High", value: 47 },
  { name: "Medium", value: 138 },
  { name: "Low", value: 226 },
];

export const toolFindingsByTool = [
  { label: "eslint", value: 184 },
  { label: "ruff", value: 122 },
  { label: "gitleaks", value: 18 },
  { label: "semgrep", value: 76 },
  { label: "markdownlint", value: 41 },
  { label: "actionlint", value: 22 },
  { label: "hadolint", value: 14 },
];

/* -------------------------------------------------- Pre-merge checks */

export const customChecks = [
  {
    name: "No secrets in source",
    mode: "Blocking",
    runs: 214,
    passRate: 99.1,
    updatedAt: "2026-07-28",
  },
  {
    name: "Unit tests accompany new modules",
    mode: "Warning",
    runs: 186,
    passRate: 74.2,
    updatedAt: "2026-08-02",
  },
  {
    name: "Public API changes documented",
    mode: "Warning",
    runs: 91,
    passRate: 61.5,
    updatedAt: "2026-08-09",
  },
  {
    name: "Migrations are reversible",
    mode: "Blocking",
    runs: 38,
    passRate: 92.1,
    updatedAt: "2026-06-30",
  },
];

export const preMergeResults = [
  { name: "Passed", value: 402 },
  { name: "Failed", value: 63 },
  { name: "Skipped", value: 27 },
];

export const weeklyPreMergeRuns = ramp(weeks, 151, 26, 16, 0.06);

/* ------------------------------------------------------ Knowledge base */

export const knowledgeBase = {
  learnings: 128,
  pathInstructions: 14,
  linkedIssues: 63,
  memoryHitRate: 71,
};

export const weeklyLearningsApplied = ramp(weeks, 161, 18, 12, 0.07);

export const learningsByRepo = [
  { label: "acalys", value: 41 },
  { label: "n8n-clone", value: 27 },
  { label: "Acalys_AI", value: 22 },
  { label: "Acalys_Agent_Builder", value: 18 },
  { label: "rag-pipeline-lab", value: 12 },
  { label: "Acalys-ai-assistant", value: 8 },
];

/* ---------------------------------------------------------- Data grid */

export interface ActiveUserRow {
  user: string;
  team: string;
  reviews: number;
  comments: number;
  accepted: number;
  chatSessions: number;
  lastActive: string;
}

export const activeUserDetails: ActiveUserRow[] = [
  { user: "shrenil28", team: "Platform", reviews: 42, comments: 318, accepted: 214, chatSessions: 27, lastActive: "2h ago" },
  { user: "aditya-r", team: "Platform", reviews: 31, comments: 244, accepted: 151, chatSessions: 19, lastActive: "5h ago" },
  { user: "meera.k", team: "AI", reviews: 28, comments: 201, accepted: 138, chatSessions: 22, lastActive: "1d ago" },
  { user: "jonas-b", team: "Infra", reviews: 19, comments: 142, accepted: 88, chatSessions: 11, lastActive: "1d ago" },
  { user: "priya.s", team: "AI", reviews: 17, comments: 128, accepted: 79, chatSessions: 14, lastActive: "2d ago" },
  { user: "dev-ops-bot", team: "Infra", reviews: 12, comments: 61, accepted: 31, chatSessions: 0, lastActive: "3d ago" },
  { user: "haruto.y", team: "Product", reviews: 9, comments: 54, accepted: 33, chatSessions: 6, lastActive: "4d ago" },
  { user: "lucia-m", team: "Product", reviews: 7, comments: 41, accepted: 24, chatSessions: 4, lastActive: "6d ago" },
];

export interface PullRequestRow {
  number: number;
  title: string;
  repo: string;
  author: string;
  state: "Open" | "Merged" | "Draft" | "Closed";
  comments: number;
  severityMax: "Critical" | "High" | "Medium" | "Low" | "Info";
  timeToMergeHours: number | null;
  updatedAt: string;
}

export const pullRequestDetails: PullRequestRow[] = [
  { number: 412, title: "Stream agent responses over SSE", repo: "acalys", author: "shrenil28", state: "Open", comments: 14, severityMax: "High", timeToMergeHours: null, updatedAt: "2h ago" },
  { number: 411, title: "Cache embeddings between runs", repo: "rag-pipeline-lab", author: "meera.k", state: "Merged", comments: 9, severityMax: "Medium", timeToMergeHours: 6.2, updatedAt: "5h ago" },
  { number: 298, title: "Add workflow node registry", repo: "n8n-clone", author: "aditya-r", state: "Open", comments: 21, severityMax: "Critical", timeToMergeHours: null, updatedAt: "7h ago" },
  { number: 297, title: "Fix retry backoff on webhook failures", repo: "n8n-clone", author: "jonas-b", state: "Merged", comments: 6, severityMax: "Medium", timeToMergeHours: 3.8, updatedAt: "1d ago" },
  { number: 88, title: "Introduce plan templates", repo: "Acalys_Agent_Builder", author: "priya.s", state: "Draft", comments: 3, severityMax: "Low", timeToMergeHours: null, updatedAt: "1d ago" },
  { number: 87, title: "Tighten tool-call schema validation", repo: "Acalys_Agent_Builder", author: "shrenil28", state: "Merged", comments: 11, severityMax: "High", timeToMergeHours: 12.4, updatedAt: "2d ago" },
  { number: 55, title: "Terraform: rotate state bucket keys", repo: "infra-terraform", author: "jonas-b", state: "Merged", comments: 4, severityMax: "Critical", timeToMergeHours: 21.7, updatedAt: "3d ago" },
  { number: 143, title: "Desktop auto-update channel", repo: "acalys-desktop", author: "haruto.y", state: "Closed", comments: 2, severityMax: "Info", timeToMergeHours: null, updatedAt: "4d ago" },
];

/* -------------------------------------------------------- IDE and CLI */

export const ideCli = {
  totalReviews: 386,
  totalUsers: 12,
  repositories: 9,
  reviewComments: 1_142,
  toolFindings: 268,
};

export const activeUsersByExtension = [
  { name: "VS Code", value: 7 },
  { name: "JetBrains", value: 3 },
  { name: "CLI", value: 2 },
];

export const reviewsByExtension = [
  { name: "VS Code", value: 214 },
  { name: "JetBrains", value: 98 },
  { name: "CLI", value: 74 },
];

export const weeklyIdeReviews = ramp(weeks, 171, 24, 14, 0.05);
export const weeklyIdeActiveUsers = ramp(weeks, 181, 6, 4, 0.04);

export const pathInstructionsUsage = [
  { label: "**/*.ts", value: 142 },
  { label: "src/api/**", value: 96 },
  { label: "**/*.py", value: 74 },
  { label: "infra/**", value: 31 },
  { label: "**/*.test.*", value: 28 },
];

export const learningsUsage = ramp(days, 191, 12, 9, 0.05);

/* ---------------------------------------------------------- Reporting */

export const reporting = {
  scheduledDelivered: 0,
  scheduledConfigured: 0,
  onDemandConfigured: 0,
  byChannel: [] as { name: string; value: number }[],
  weeklyDelivered: [] as { label: string; value: number }[],
};

export const teamOptions = ["All", "Platform", "AI", "Infra", "Product"];
export const usernameOptions = [
  "All",
  ...activeUserDetails.map((row) => row.user),
];
