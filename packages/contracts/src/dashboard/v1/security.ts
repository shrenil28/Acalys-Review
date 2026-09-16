import { z } from "zod";
import {
  findingLifecycleStateSchema,
  findingSeveritySchema,
} from "../../domain/finding/index.js";
import { dashboardIdSchema } from "./resources.js";

const iso = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();

export const dashboardSecurityFindingsQuerySchema = z.object({
  repositoryIds: z.array(dashboardIdSchema).max(100).default([]),
  severities: z.array(findingSeveritySchema).max(5).default([]),
  lifecycle: z.array(findingLifecycleStateSchema).max(6).default([]),
  limit: z.number().int().min(1).max(1000).default(500),
});

export const dashboardSecurityFindingSchema = z.object({
  id: dashboardIdSchema,
  repositoryId: dashboardIdSchema,
  repositoryName: z.string().min(1).max(500),
  reviewRunId: dashboardIdSchema,
  pullRequestId: dashboardIdSchema.nullable(),
  pullRequestNumber: z.number().int().positive().nullable(),
  pullRequestTitle: z.string().max(1000).nullable(),
  author: z.string().max(500).nullable(),
  pullRequestState: z.enum(["open", "closed", "merged"]).nullable(),
  severity: findingSeveritySchema,
  lifecycle: findingLifecycleStateSchema,
  title: z.string().min(1),
  explanation: z.string().min(1),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  createdAt: iso,
  updatedAt: iso,
});

export const dashboardSecurityFindingsResponseSchema = z.object({
  summary: z.object({
    total: count,
    active: count,
    criticalHighActive: count,
    verified: count,
    published: count,
    resolved: count,
    dismissed: count,
    stale: count,
    superseded: count,
    repositoriesWithFindings: count,
  }),
  items: z.array(dashboardSecurityFindingSchema).max(1000),
});

export type DashboardSecurityFindingsQuery = z.infer<
  typeof dashboardSecurityFindingsQuerySchema
>;
export type DashboardSecurityFinding = z.infer<
  typeof dashboardSecurityFindingSchema
>;
export type DashboardSecurityFindingsResponse = z.infer<
  typeof dashboardSecurityFindingsResponseSchema
>;
