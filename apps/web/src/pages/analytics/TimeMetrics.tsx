import { lazy, Suspense } from "react";
import { resolveDataMode } from "@/lib/api/config";
import { DashboardSkeleton } from "@/components/ui/Skeleton";
import { LiveTimeMetrics } from "./AnalyticsLiveViews";

const Fixture = lazy(() => import("./TimeMetricsFixture").then((module) => ({ default: module.TimeMetrics })));

export function TimeMetrics() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={<DashboardSkeleton tiles={4} panels={2} />}><Fixture /></Suspense>;
  return <LiveTimeMetrics />;
}
