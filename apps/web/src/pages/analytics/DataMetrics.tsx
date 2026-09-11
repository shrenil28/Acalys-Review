import { lazy, Suspense } from "react";
import { resolveDataMode } from "@/lib/api/config";
import { DashboardSkeleton } from "@/components/ui/Skeleton";
import { LiveDataMetrics } from "./AnalyticsLiveViews";

const Fixture = lazy(() => import("./DataMetricsFixture").then((module) => ({ default: module.DataMetrics })));

export function DataMetrics() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={<DashboardSkeleton tiles={4} panels={2} />}><Fixture /></Suspense>;
  return <LiveDataMetrics />;
}
