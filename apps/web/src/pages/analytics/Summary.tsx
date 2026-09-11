import { lazy, Suspense } from "react";
import { resolveDataMode } from "@/lib/api/config";
import { DashboardSkeleton } from "@/components/ui/Skeleton";
import { LiveAnalyticsSummary } from "./AnalyticsLiveViews";

const Fixture = lazy(() => import("./SummaryFixture").then((module) => ({ default: module.AnalyticsSummary })));

export function AnalyticsSummary() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={<DashboardSkeleton tiles={4} panels={2} />}><Fixture /></Suspense>;
  return <LiveAnalyticsSummary />;
}
