import { z } from "zod";
import { dashboardIdSchema } from "./resources.js";

const iso = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();

export const dashboardRepositoryMetricSchema = z.object({
  repositoryId: dashboardIdSchema,
  openPullRequests: count,
  reviewsLast30Days: count,
  publishedCommentsLast30Days: count,
  lastReviewAt: iso.nullable(),
});

export const dashboardRepositoryMetricsResponseSchema = z.object({
  items: z.array(dashboardRepositoryMetricSchema).max(10_000),
});

export const dashboardRepositoryActivitySchema = z.object({
  reviewRunId: dashboardIdSchema,
  pullRequestNumber: z.number().int().positive().nullable(),
  pullRequestTitle: z.string().max(1000).nullable(),
  state: z.enum([
    "queued",
    "preparing",
    "analyzing",
    "reviewing",
    "verifying",
    "reconciling",
    "publishing",
    "completed",
    "failed",
    "cancelled",
    "superseded",
  ]),
  trigger: z.string().min(1).max(100),
  createdAt: iso,
  completedAt: iso.nullable(),
  publishedComments: count,
});

export const dashboardRepositoryTrendPointSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  reviews: count,
});

export const dashboardRepositoryOverviewSchema = z.object({
  repositoryId: dashboardIdSchema,
  metrics: dashboardRepositoryMetricSchema,
  trend: z.array(dashboardRepositoryTrendPointSchema).max(31),
  recentActivity: z.array(dashboardRepositoryActivitySchema).max(100),
});

export type DashboardRepositoryMetric = z.infer<
  typeof dashboardRepositoryMetricSchema
>;
export type DashboardRepositoryOverview = z.infer<
  typeof dashboardRepositoryOverviewSchema
>;
