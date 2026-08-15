export interface Repository {
  name: string;
  provider: "github" | "gitlab";
  visibility: "Private" | "Public";
  language: string;
  reviewsEnabled: boolean;
  openPrs: number;
  reviewsLast30d: number;
  commentsLast30d: number;
  defaultBranch: string;
  lastReviewAt: string | null;
  /** Security posture — powers the Security → Repositories table. */
  security: {
    deepScan: number | null;
    dependencies: number | null;
    secrets: number | null;
    lastScanAt: string | null;
  };
}

const now = Date.now();
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

export const repositories: Repository[] = [
  {
    name: "acalys",
    provider: "github",
    visibility: "Private",
    language: "TypeScript",
    reviewsEnabled: true,
    openPrs: 6,
    reviewsLast30d: 48,
    commentsLast30d: 214,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(3),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "Acalys_Agent_Builder",
    provider: "github",
    visibility: "Private",
    language: "Python",
    reviewsEnabled: true,
    openPrs: 3,
    reviewsLast30d: 31,
    commentsLast30d: 142,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(9),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "Acalys_AI",
    provider: "github",
    visibility: "Private",
    language: "Python",
    reviewsEnabled: true,
    openPrs: 4,
    reviewsLast30d: 27,
    commentsLast30d: 118,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(21),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "Acalys_CLI",
    provider: "github",
    visibility: "Public",
    language: "Go",
    reviewsEnabled: true,
    openPrs: 1,
    reviewsLast30d: 12,
    commentsLast30d: 44,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(52),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "Acalys_Local_community",
    provider: "github",
    visibility: "Public",
    language: "TypeScript",
    reviewsEnabled: false,
    openPrs: 0,
    reviewsLast30d: 3,
    commentsLast30d: 9,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(190),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "Acalys-ai-assistant",
    provider: "github",
    visibility: "Private",
    language: "TypeScript",
    reviewsEnabled: true,
    openPrs: 2,
    reviewsLast30d: 22,
    commentsLast30d: 96,
    defaultBranch: "develop",
    lastReviewAt: hoursAgo(14),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "acalys-desktop",
    provider: "github",
    visibility: "Private",
    language: "Rust",
    reviewsEnabled: true,
    openPrs: 1,
    reviewsLast30d: 9,
    commentsLast30d: 38,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(72),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "Felicity-Event-Management-System",
    provider: "github",
    visibility: "Public",
    language: "JavaScript",
    reviewsEnabled: true,
    openPrs: 2,
    reviewsLast30d: 16,
    commentsLast30d: 61,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(30),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "n8n-clone",
    provider: "github",
    visibility: "Private",
    language: "TypeScript",
    reviewsEnabled: true,
    openPrs: 5,
    reviewsLast30d: 34,
    commentsLast30d: 158,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(6),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "Network-File-System",
    provider: "github",
    visibility: "Public",
    language: "C",
    reviewsEnabled: false,
    openPrs: 0,
    reviewsLast30d: 0,
    commentsLast30d: 0,
    defaultBranch: "master",
    lastReviewAt: null,
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "portfolio-site",
    provider: "github",
    visibility: "Public",
    language: "Astro",
    reviewsEnabled: true,
    openPrs: 0,
    reviewsLast30d: 4,
    commentsLast30d: 11,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(120),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "rag-pipeline-lab",
    provider: "github",
    visibility: "Private",
    language: "Python",
    reviewsEnabled: true,
    openPrs: 3,
    reviewsLast30d: 19,
    commentsLast30d: 87,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(40),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
  {
    name: "infra-terraform",
    provider: "github",
    visibility: "Private",
    language: "HCL",
    reviewsEnabled: true,
    openPrs: 1,
    reviewsLast30d: 7,
    commentsLast30d: 25,
    defaultBranch: "main",
    lastReviewAt: hoursAgo(88),
    security: { deepScan: null, dependencies: null, secrets: null, lastScanAt: null },
  },
];

export const repoNames = repositories.map((repo) => repo.name);

export const repoFilterOptions = ["All", ...repoNames];
