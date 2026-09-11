import { lazy, Suspense } from "react";
import { resolveDataMode } from "@/lib/api/config";
import { DashboardSkeleton } from "@/components/ui/Skeleton";
import { LiveOrganizationTrends } from "./AnalyticsLiveViews";

const Fixture = lazy(() => import("./OrganizationTrendsFixture").then((module) => ({ default: module.OrganizationTrends })));

export function OrganizationTrends() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={<DashboardSkeleton tiles={4} panels={2} />}><Fixture /></Suspense>;
  return <LiveOrganizationTrends />;
}
