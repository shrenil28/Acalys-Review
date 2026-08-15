export type Severity = "Critical" | "High" | "Medium" | "Low" | "Info";

export type FindingStatus = "Open" | "Fixed" | "Ignored" | "In review";

export interface DeepScanFinding {
  id: string;
  category: string;
  repo: string;
  subsystem: string;
  status: FindingStatus;
  severity: Severity;
  file: string;
  line: number;
  summary: string;
  detail: string;
  remediation: string;
  detectedAt: string;
  cwe?: string;
}

export const deepScanFindings: DeepScanFinding[] = [
  {
    id: "DS-1041",
    category: "Injection",
    repo: "n8n-clone",
    subsystem: "workflow-engine",
    status: "Open",
    severity: "Critical",
    file: "src/engine/expression.ts",
    line: 184,
    summary: "User-supplied expression reaches `vm.runInNewContext` unsandboxed",
    detail:
      "Workflow node parameters flow from the HTTP webhook payload into the expression evaluator without a sandbox boundary. An attacker who can trigger a workflow can execute arbitrary code on the worker.",
    remediation:
      "Evaluate expressions inside an isolated realm with no host bindings, and allowlist the globals the evaluator needs.",
    detectedAt: "2026-08-14T09:12:00Z",
    cwe: "CWE-94",
  },
  {
    id: "DS-1039",
    category: "Access control",
    repo: "acalys",
    subsystem: "api",
    status: "Open",
    severity: "High",
    file: "src/server/routes/agents.ts",
    line: 62,
    summary: "Agent detail route trusts the organization id from the request body",
    detail:
      "`GET /agents/:id` reads `organizationId` from the payload rather than the session, so a member of one organization can read another organization's agent configuration.",
    remediation:
      "Resolve the organization from the authenticated session and scope the query by it.",
    detectedAt: "2026-08-13T17:40:00Z",
    cwe: "CWE-639",
  },
  {
    id: "DS-1036",
    category: "Secrets",
    repo: "infra-terraform",
    subsystem: "state",
    status: "In review",
    severity: "Critical",
    file: "modules/storage/main.tf",
    line: 27,
    summary: "Static access key committed to the storage module",
    detail:
      "A long-lived access key is inlined as a default variable value. It is present in the git history and grants write access to the state bucket.",
    remediation:
      "Rotate the key, move it to the secret manager, and rewrite the affected history.",
    detectedAt: "2026-08-12T11:02:00Z",
    cwe: "CWE-798",
  },
  {
    id: "DS-1030",
    category: "Dependencies",
    repo: "rag-pipeline-lab",
    subsystem: "ingest",
    status: "Open",
    severity: "High",
    file: "requirements.txt",
    line: 14,
    summary: "`langchain-core` pinned to a version with a known deserialization flaw",
    detail:
      "GHSA-3q4f-c9xw-8mvq affects the pinned version. The ingest path deserializes cached documents, which is the vulnerable code path.",
    remediation: "Upgrade to 0.3.29 or later.",
    detectedAt: "2026-08-11T08:20:00Z",
  },
  {
    id: "DS-1028",
    category: "IaC",
    repo: "infra-terraform",
    subsystem: "network",
    status: "Open",
    severity: "Medium",
    file: "modules/network/security_groups.tf",
    line: 48,
    summary: "Security group allows 0.0.0.0/0 on port 5432",
    detail:
      "The database security group exposes Postgres to the public internet. Only the application subnet needs access.",
    remediation: "Restrict the ingress rule to the application subnet CIDR.",
    detectedAt: "2026-08-10T15:55:00Z",
    cwe: "CWE-284",
  },
  {
    id: "DS-1024",
    category: "Cryptography",
    repo: "acalys-desktop",
    subsystem: "auth",
    status: "Fixed",
    severity: "Medium",
    file: "src/auth/token_store.rs",
    line: 91,
    summary: "Refresh tokens stored unencrypted on disk",
    detail:
      "Tokens were written to the application data directory in plaintext, readable by any local process running as the user.",
    remediation: "Store tokens in the OS keychain.",
    detectedAt: "2026-08-06T13:31:00Z",
    cwe: "CWE-312",
  },
  {
    id: "DS-1019",
    category: "Injection",
    repo: "Felicity-Event-Management-System",
    subsystem: "admin",
    status: "Open",
    severity: "High",
    file: "server/controllers/report.js",
    line: 118,
    summary: "Report filter concatenated into a SQL query",
    detail:
      "The admin report endpoint builds its WHERE clause by string concatenation from a query parameter.",
    remediation: "Use parameterized queries.",
    detectedAt: "2026-08-04T10:05:00Z",
    cwe: "CWE-89",
  },
  {
    id: "DS-1012",
    category: "Access control",
    repo: "Acalys_AI",
    subsystem: "inference",
    status: "Ignored",
    severity: "Low",
    file: "app/routes/health.py",
    line: 22,
    summary: "Health endpoint leaks model and version details",
    detail: "Unauthenticated callers can enumerate the deployed model versions.",
    remediation: "Return a bare status code from the public health endpoint.",
    detectedAt: "2026-07-30T09:47:00Z",
  },
];

export interface PrFinding {
  id: string;
  prNumber: number;
  prTitle: string;
  repo: string;
  author: string;
  state: "Open" | "Merged" | "Closed";
  fixed: number;
  total: number;
  criticalHigh: number;
  lastActivity: string;
  findings: {
    severity: Severity;
    category: string;
    file: string;
    summary: string;
    fixed: boolean;
  }[];
}

export const prFindings: PrFinding[] = [
  {
    id: "PR-412",
    prNumber: 412,
    prTitle: "Stream agent responses over SSE",
    repo: "acalys",
    author: "shrenil28",
    state: "Open",
    fixed: 1,
    total: 4,
    criticalHigh: 2,
    lastActivity: "2h ago",
    findings: [
      { severity: "High", category: "Access control", file: "src/server/routes/stream.ts", summary: "Stream endpoint skips the org scope check", fixed: false },
      { severity: "High", category: "Injection", file: "src/server/routes/stream.ts", summary: "Event name interpolated from user input", fixed: false },
      { severity: "Medium", category: "Denial of service", file: "src/server/sse.ts", summary: "No cap on concurrent streams per client", fixed: false },
      { severity: "Low", category: "Logging", file: "src/server/sse.ts", summary: "Session token written to debug logs", fixed: true },
    ],
  },
  {
    id: "PR-298",
    prNumber: 298,
    prTitle: "Add workflow node registry",
    repo: "n8n-clone",
    author: "aditya-r",
    state: "Open",
    fixed: 0,
    total: 3,
    criticalHigh: 1,
    lastActivity: "7h ago",
    findings: [
      { severity: "Critical", category: "Injection", file: "src/engine/expression.ts", summary: "Unsandboxed expression evaluation", fixed: false },
      { severity: "Medium", category: "Validation", file: "src/registry/load.ts", summary: "Node manifest parsed before schema validation", fixed: false },
      { severity: "Low", category: "Maintainability", file: "src/registry/load.ts", summary: "Registry cache never invalidated", fixed: false },
    ],
  },
  {
    id: "PR-55",
    prNumber: 55,
    prTitle: "Terraform: rotate state bucket keys",
    repo: "infra-terraform",
    author: "jonas-b",
    state: "Merged",
    fixed: 2,
    total: 2,
    criticalHigh: 2,
    lastActivity: "3d ago",
    findings: [
      { severity: "Critical", category: "Secrets", file: "modules/storage/main.tf", summary: "Static access key in module defaults", fixed: true },
      { severity: "High", category: "IaC", file: "modules/storage/main.tf", summary: "Bucket versioning disabled", fixed: true },
    ],
  },
  {
    id: "PR-87",
    prNumber: 87,
    prTitle: "Tighten tool-call schema validation",
    repo: "Acalys_Agent_Builder",
    author: "shrenil28",
    state: "Merged",
    fixed: 3,
    total: 3,
    criticalHigh: 1,
    lastActivity: "2d ago",
    findings: [
      { severity: "High", category: "Validation", file: "src/tools/schema.py", summary: "Tool arguments coerced without bounds", fixed: true },
      { severity: "Medium", category: "Correctness", file: "src/tools/schema.py", summary: "Optional fields defaulted to None silently", fixed: true },
      { severity: "Low", category: "Testing", file: "tests/test_schema.py", summary: "Edge cases not covered", fixed: true },
    ],
  },
];

export interface SecurityEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  outcome: "Success" | "Failed" | "Skipped";
  detail: string;
}

export const securityActivity: SecurityEvent[] = [
  { id: "ev-91", at: "2026-08-15T06:41:00Z", actor: "shrenil28", action: "Deep scan started", target: "n8n-clone", outcome: "Success", detail: "Manual scan from the Security → Repositories table" },
  { id: "ev-90", at: "2026-08-15T06:52:00Z", actor: "system", action: "Deep scan completed", target: "n8n-clone", outcome: "Success", detail: "3 findings (1 critical, 1 medium, 1 low)" },
  { id: "ev-89", at: "2026-08-14T09:12:00Z", actor: "system", action: "Finding opened", target: "DS-1041", outcome: "Success", detail: "Injection · src/engine/expression.ts:184" },
  { id: "ev-88", at: "2026-08-13T17:40:00Z", actor: "system", action: "Finding opened", target: "DS-1039", outcome: "Success", detail: "Access control · src/server/routes/agents.ts:62" },
  { id: "ev-87", at: "2026-08-13T11:20:00Z", actor: "jonas-b", action: "Finding status changed", target: "DS-1036", outcome: "Success", detail: "Open → In review" },
  { id: "ev-86", at: "2026-08-12T08:02:00Z", actor: "system", action: "Secrets scan completed", target: "infra-terraform", outcome: "Success", detail: "1 verified secret detected" },
  { id: "ev-85", at: "2026-08-11T08:20:00Z", actor: "system", action: "Dependency scan completed", target: "rag-pipeline-lab", outcome: "Success", detail: "1 high advisory (GHSA-3q4f-c9xw-8mvq)" },
  { id: "ev-84", at: "2026-08-10T15:55:00Z", actor: "system", action: "IaC scan completed", target: "infra-terraform", outcome: "Success", detail: "1 medium misconfiguration" },
  { id: "ev-83", at: "2026-08-09T14:12:00Z", actor: "meera.k", action: "Finding ignored", target: "DS-1012", outcome: "Success", detail: "Accepted risk — internal network only" },
  { id: "ev-82", at: "2026-08-08T10:30:00Z", actor: "system", action: "SBOM generated", target: "acalys", outcome: "Success", detail: "CycloneDX 1.5 · 412 components" },
  { id: "ev-81", at: "2026-08-07T19:04:00Z", actor: "shrenil28", action: "Deep scan started", target: "Acalys_AI", outcome: "Failed", detail: "Repository has no default branch configured" },
  { id: "ev-80", at: "2026-08-06T13:31:00Z", actor: "system", action: "Finding fixed", target: "DS-1024", outcome: "Success", detail: "Resolved in acalys-desktop#143" },
];

export const scanCoverage = [
  {
    title: "AI Deep Scan",
    description:
      "AI Deep Scan reasons across your codebase and traces data flow the way an attacker would, surfacing exploitable vulnerabilities before they ship.",
  },
  {
    title: "Security PR Review",
    description:
      "Another pair of eyes on your pull requests with a security lens, making sure you never push a vulnerability to production.",
  },
  {
    title: "Secrets detection",
    description:
      "Catch leaked API keys, tokens, and credentials committed to your code, with verification to cut false positives so you only chase real exposures.",
  },
  {
    title: "IaC",
    description:
      "Flag misconfigurations in Terraform, Kubernetes, CloudFormation, and Dockerfiles before they ship to production.",
  },
  {
    title: "Dependencies",
    description:
      "Detect vulnerable dependencies with full advisory detail (CVE / GHSA), then ship grouped upgrade pull requests automatically.",
  },
  {
    title: "SBOM",
    description:
      "Generate a software bill of materials for compliance, license review, audit readiness, and component inventory.",
  },
];

export const findingCategories = [
  "All",
  "Injection",
  "Access control",
  "Secrets",
  "Dependencies",
  "IaC",
  "Cryptography",
];

export const findingStatuses: (FindingStatus | "All")[] = [
  "All",
  "Open",
  "In review",
  "Fixed",
  "Ignored",
];

export const severities: (Severity | "All")[] = [
  "All",
  "Critical",
  "High",
  "Medium",
  "Low",
  "Info",
];
