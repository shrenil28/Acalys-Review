import { z } from "zod";
import { dashboardAnalyticsResponseSchema } from "./analytics.js";
import { dashboardIdSchema } from "./resources.js";

const iso = z.string().datetime({ offset: true });
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

export const dashboardReportKindSchema = z.enum(["recurring", "ondemand"]);
export const dashboardReportChannelSchema = z.enum([
  "slack",
  "discord",
  "teams",
  "email",
]);
export const dashboardReportGroupBySchema = z.enum([
  "none",
  "repository",
  "team",
  "author",
  "severity",
]);
export const dashboardReportWeekdaySchema = z.enum([
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
]);

export const dashboardReportRelativeRangeSchema = z.object({
  kind: z.literal("relative"),
  days: z.number().int().min(1).max(1830),
});
export const dashboardReportAbsoluteRangeSchema = z
  .object({
    kind: z.literal("absolute"),
    from: iso,
    to: iso,
  })
  .superRefine((value, context) => {
    const from = new Date(value.from).getTime();
    const to = new Date(value.to).getTime();
    if (!(to > from) || to - from > 5 * 366 * 24 * 60 * 60_000) {
      context.addIssue({
        code: "custom",
        message: "Report range must be positive and no longer than five years",
      });
    }
  });
export const dashboardReportRangeSchema = z.union([
  dashboardReportRelativeRangeSchema,
  dashboardReportAbsoluteRangeSchema,
]);

export const dashboardReportScheduleSchema = z
  .object({
    frequency: z.enum(["week", "month"]),
    every: z.number().int().min(1).max(12),
    weekdays: z.array(dashboardReportWeekdaySchema).max(7).default([]),
    monthDays: z.array(z.number().int().min(1).max(31)).max(31).default([]),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
    timezone: nonEmpty(100),
  })
  .superRefine((value, context) => {
    if (value.frequency === "week" && value.weekdays.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["weekdays"],
        message: "At least one weekday is required",
      });
    }
    if (value.frequency === "month" && value.monthDays.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["monthDays"],
        message: "At least one day of month is required",
      });
    }
  });

export const dashboardReportParametersSchema = z.object({
  repositoryIds: z.array(dashboardIdSchema).max(100).default([]),
  usernames: z.array(nonEmpty(256)).max(100).default([]),
  teams: z.array(nonEmpty(100)).max(100).default([]),
});

export const dashboardReportDestinationSchema = z.object({
  channel: dashboardReportChannelSchema,
  emails: z.array(z.string().email().max(320)).max(100).default([]),
});

const commonDefinition = {
  name: nonEmpty(200),
  range: dashboardReportRangeSchema,
  parameters: dashboardReportParametersSchema.default({
    repositoryIds: [],
    usernames: [],
    teams: [],
  }),
  prompt: z.string().max(10_000).default(""),
  groupBy: dashboardReportGroupBySchema.default("none"),
  destination: dashboardReportDestinationSchema,
};

export const dashboardCreateReportBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recurring"),
    ...commonDefinition,
    schedule: dashboardReportScheduleSchema,
  }),
  z.object({
    kind: z.literal("ondemand"),
    ...commonDefinition,
    schedule: z.null().default(null),
  }),
]);

export const dashboardReportDefinitionSchema = z.object({
  id: dashboardIdSchema,
  kind: dashboardReportKindSchema,
  name: nonEmpty(200),
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  schedule: dashboardReportScheduleSchema.nullable(),
  range: dashboardReportRangeSchema,
  parameters: dashboardReportParametersSchema,
  prompt: z.string().max(10_000),
  groupBy: dashboardReportGroupBySchema,
  destination: dashboardReportDestinationSchema,
  createdAt: iso,
  updatedAt: iso,
  lastGeneratedAt: iso.nullable(),
  lastDeliveredAt: iso.nullable(),
  automationStatus: z.enum(["manual", "dispatcher_unavailable"]),
  deliveryStatus: z.literal("not_delivered"),
});
export const dashboardReportsResponseSchema = z.object({
  items: z.array(dashboardReportDefinitionSchema).max(500),
});
export const dashboardDeleteReportBodySchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export const dashboardDeleteReportResponseSchema = z.object({
  deleted: z.literal(true),
});
export const dashboardGenerateReportBodySchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export const dashboardReportRunSchema = z.object({
  id: dashboardIdSchema,
  reportId: dashboardIdSchema,
  from: iso,
  to: iso,
  generatedAt: iso,
  snapshot: dashboardAnalyticsResponseSchema,
  deliveryStatus: z.literal("not_delivered"),
});

export type DashboardCreateReportBody = z.infer<
  typeof dashboardCreateReportBodySchema
>;
export type DashboardReportDefinition = z.infer<
  typeof dashboardReportDefinitionSchema
>;
export type DashboardReportRun = z.infer<typeof dashboardReportRunSchema>;
