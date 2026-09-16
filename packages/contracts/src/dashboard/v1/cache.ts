import { z } from "zod";
import { dashboardIdSchema } from "./resources.js";

const iso = z.string().datetime({ offset: true });

export const dashboardReviewCacheSchema = z.object({
  id: dashboardIdSchema,
  repositoryId: dashboardIdSchema,
  repositoryName: z.string().min(1).max(500),
  workflow: z.literal("review"),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: iso,
  updatedAt: iso,
  lastUsedAt: iso,
  expiresAt: iso,
});

export const dashboardReviewCachesResponseSchema = z.object({
  items: z.array(dashboardReviewCacheSchema).max(10_000),
});

export const dashboardDeleteReviewCachesBodySchema = z.object({
  ids: z
    .array(dashboardIdSchema)
    .min(1)
    .max(100)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Cache ids must be unique",
    ),
});

export const dashboardDeleteReviewCachesResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
});

export type DashboardReviewCache = z.infer<typeof dashboardReviewCacheSchema>;
