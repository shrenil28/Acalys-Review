import { z } from "zod";

const iso = z.string().datetime({ offset: true });

export const dashboardNotificationValuesSchema = z.object({
  reviewComplete: z.boolean(),
  criticalFinding: z.boolean(),
  weeklyDigest: z.boolean(),
  productUpdates: z.boolean(),
});

export const dashboardNotificationPreferencesSchema =
  dashboardNotificationValuesSchema.extend({
    revision: z.number().int().nonnegative(),
    updatedAt: iso.nullable(),
  });

export const dashboardUpdateNotificationPreferencesBodySchema =
  dashboardNotificationValuesSchema.extend({
    expectedRevision: z.number().int().nonnegative(),
  });

export type DashboardNotificationValues = z.infer<
  typeof dashboardNotificationValuesSchema
>;
export type DashboardNotificationPreferences = z.infer<
  typeof dashboardNotificationPreferencesSchema
>;
