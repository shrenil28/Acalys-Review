import { lazy, Suspense } from "react";
import { resolveDataMode } from "@/lib/api/config";
import { DashboardSkeleton } from "@/components/ui/Skeleton";
import { PrSecurityReviewsLive } from "./PrSecurityReviewsLive";

const Fixture = lazy(() =>
  import("./PrSecurityReviewsFixture").then((module) => ({
    default: module.PrSecurityReviewsFixturePage,
  })),
);

export function PrSecurityReviewsPage() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") {
    return (
      <Suspense fallback={<DashboardSkeleton tiles={4} panels={2} />}>
        <Fixture />
      </Suspense>
    );
  }
  return <PrSecurityReviewsLive />;
}
