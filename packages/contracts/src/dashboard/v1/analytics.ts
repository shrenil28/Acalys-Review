import { z } from "zod";
import { dashboardIdSchema } from "./resources.js";

const iso = z.string().datetime({ offset: true });
const finite = z.number().finite();
const count = z.number().int().nonnegative();

export const dashboardAnalyticsQuerySchema = z.object({
  from: iso,
  to: iso,
  repositoryIds: z.array(dashboardIdSchema).max(100).default([]),
  usernames: z.array(z.string().trim().min(1).max(256)).max(100).default([]),
  teams: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});

export const dashboardUpdateMemberAnalyticsTeamBodySchema = z.object({
  team: z.string().trim().min(1).max(100).nullable(),
});

export const dashboardAnalyticsBucketSchema = z.object({
  start: iso,
  reviews: count,
  completed: count,
  failed: count,
  findings: count,
});

export const dashboardAnalyticsResponseSchema = z.object({
  range: z.object({ from: iso, to: iso, bucketSeconds: z.number().int().positive() }),
  summary: z.object({
    reviews: count,
    completed: count,
    failed: count,
    cancelled: count,
    findings: count,
    resolvedFindings: count,
    repositories: count,
    authors: count,
    averageDurationSeconds: finite.nonnegative().nullable(),
  }),
  trends: z.array(dashboardAnalyticsBucketSchema).max(1000),
  severities: z.array(z.object({ severity: z.string(), count })).max(32),
  categories: z.array(z.object({ category: z.string(), count })).max(200),
  checks: z.object({ total: count, passed: count, failed: count, inconclusive: count, skipped: count }),
  knowledge: z.object({
    total: count,
    newInRange: count,
    byRepository: z.array(z.object({ repositoryId: dashboardIdSchema.nullable(), repositoryName: z.string().nullable(), count })).max(500),
  }),
  repositories: z.array(z.object({
    repositoryId: dashboardIdSchema,
    name: z.string(),
    reviews: count,
    findings: count,
    averageDurationSeconds: finite.nonnegative().nullable(),
    lastReviewAt: iso.nullable(),
  })).max(500),
  authors: z.array(z.object({ username: z.string(), team: z.string().nullable(), reviews: count, findings: count })).max(1000),
  dimensions: z.object({ usernames: z.array(z.string()).max(2000), teams: z.array(z.string()).max(500) }),
});

export type DashboardAnalyticsQuery = z.infer<typeof dashboardAnalyticsQuerySchema>;
export type DashboardAnalyticsResponse = z.infer<typeof dashboardAnalyticsResponseSchema>;
