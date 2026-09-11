import { lazy, Suspense } from "react";
import { resolveDataMode } from "@/lib/api/config";
import { DashboardSkeleton } from "@/components/ui/Skeleton";
import { LivePreMergeChecks } from "./AnalyticsLiveViews";

const Fixture = lazy(() => import("./PreMergeChecksFixture").then((module) => ({ default: module.PreMergeChecks })));

export function PreMergeChecks() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={<DashboardSkeleton tiles={4} panels={2} />}><Fixture /></Suspense>;
  return <LivePreMergeChecks />;
}
