import { lazy, Suspense } from "react";
import { resolveDataMode } from "@/lib/api/config";
import { DashboardSkeleton } from "@/components/ui/Skeleton";
import { LiveQualityMetrics } from "./AnalyticsLiveViews";

const Fixture = lazy(() => import("./QualityMetricsFixture").then((module) => ({ default: module.QualityMetrics })));

export function QualityMetrics() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={<DashboardSkeleton tiles={4} panels={2} />}><Fixture /></Suspense>;
  return <LiveQualityMetrics />;
}
