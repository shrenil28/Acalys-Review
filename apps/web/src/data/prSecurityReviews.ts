export type PrSecuritySeverity = "Critical" | "High" | "Medium" | "Low";

export interface PrSecurityFinding {
  id: string;
  title: string;
  file: string;
  cwe: string;
  status: "Fixed" | "Open";
  severity: PrSecuritySeverity;
  reachability: "External" | "Internal";
  effort?: "Easy" | "Moderate" | "Difficult";
}

export interface PrSecurityReview {
  id: string;
  number: number;
  repository: string;
  author: string | null;
  severity: PrSecuritySeverity;
  found: string;
  findings: PrSecurityFinding[];
  architecture: {
    assessment: string;
    risk: string;
    commit: string;
    concerns: { severity: "Medium" | "Low"; evidence: "Inferred" | "Observed"; text: string }[];
  };
}

const architecture = {
  assessment:
    "The change strengthens browser-storage writes by allowlisting persisted fields and removing unsafe keys. Residual risk is limited to client-side state; no server, deployment, or cross-service change was identified.",
  risk: "Overall: Low risk",
  commit: "542e320",
  concerns: [
    {
      severity: "Medium" as const,
      evidence: "Inferred" as const,
      text: "Persistence schemas are enforced on writes but not on reads, so undeclared non-secret properties from browser storage can cross the storage trust boundary.",
    },
    {
      severity: "Low" as const,
      evidence: "Observed" as const,
      text: "The shared array persistence contract converts incompatible elements into null placeholders rather than dropping them.",
    },
  ],
};

export const prSecurityReviews: PrSecurityReview[] = [
  {
    id: "security-pr-11",
    number: 11,
    repository: "Acalys_voice_agent",
    author: null,
    severity: "High",
    found: "Aug 26, 2026",
    findings: [
      {
        id: "SEC-922",
        title: "Exclude pollution keys from header-shape detection",
        file: "frontend/src/lib/secret-safe-storage.ts:234",
        cwe: "CWE-922",
        status: "Fixed",
        severity: "High",
        reachability: "External",
        effort: "Difficult",
      },
      {
        id: "SEC-1321",
        title: "Make denylisted-key removal trigger a storage rewrite",
        file: "frontend/src/lib/secret-safe-storage.ts:234",
        cwe: "CWE-1321",
        status: "Fixed",
        severity: "High",
        reachability: "External",
      },
    ],
    architecture,
  },
  {
    id: "security-pr-10",
    number: 10,
    repository: "Acalys_voice_agent",
    author: "shrenil28",
    severity: "High",
    found: "Aug 26, 2026",
    findings: [
      {
        id: "SEC-89",
        title: "Validate webhook signatures before parsing the request body",
        file: "server/routes/webhook.ts:89",
        cwe: "CWE-345",
        status: "Fixed",
        severity: "High",
        reachability: "External",
        effort: "Moderate",
      },
      {
        id: "SEC-96",
        title: "Bound voice payload size before allocating the decode buffer",
        file: "server/routes/webhook.ts:96",
        cwe: "CWE-770",
        status: "Fixed",
        severity: "High",
        reachability: "External",
      },
      {
        id: "SEC-114",
        title: "Rotate the exposed development signing secret",
        file: "server/config/env.ts:114",
        cwe: "CWE-798",
        status: "Open",
        severity: "High",
        reachability: "Internal",
        effort: "Easy",
      },
    ],
    architecture,
  },
  {
    id: "security-pr-9",
    number: 9,
    repository: "Acalys_voice_agent",
    author: "shrenil28",
    severity: "High",
    found: "Aug 26, 2026",
    findings: [
      {
        id: "SEC-41",
        title: "Scope assistant transcript access to the active organization",
        file: "server/routes/transcripts.ts:41",
        cwe: "CWE-639",
        status: "Fixed",
        severity: "High",
        reachability: "External",
        effort: "Moderate",
      },
      {
        id: "SEC-73",
        title: "Escape caller metadata before rendering it in the dashboard",
        file: "frontend/src/pages/calls/detail.tsx:73",
        cwe: "CWE-79",
        status: "Fixed",
        severity: "High",
        reachability: "External",
        effort: "Easy",
      },
    ],
    architecture,
  },
];

export const securityTrend = [
  { label: "Jun 12", caught: 0, fixed: 0 },
  { label: "Jun 19", caught: 0, fixed: 0 },
  { label: "Jun 26", caught: 0, fixed: 0 },
  { label: "Jul 3", caught: 0, fixed: 0 },
  { label: "Jul 10", caught: 0, fixed: 0 },
  { label: "Jul 17", caught: 0, fixed: 0 },
  { label: "Jul 24", caught: 0, fixed: 0 },
  { label: "Jul 31", caught: 0, fixed: 0 },
  { label: "Aug 7", caught: 0, fixed: 0 },
  { label: "Aug 14", caught: 0, fixed: 0 },
  { label: "Aug 21", caught: 7, fixed: 6 },
  { label: "Aug 28", caught: 0, fixed: 0 },
  { label: "Sep 4", caught: 0, fixed: 0 },
];

