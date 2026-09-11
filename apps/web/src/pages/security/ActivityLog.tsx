import { lazy } from "react";
import { DeferredFeaturePage } from "@/components/live/DeferredFeaturePage";
const Fixture = lazy(() => import("./ActivityLogFixture").then((module) => ({ default: module.SecurityActivityLog })));
export function SecurityActivityLog() {
  return <DeferredFeaturePage title="Security activity log" description="Live security data is not fabricated from demo fixtures." owner="Phase 13 + Phase 14" reason="Security audit aggregation and operational activity views require later analytics/operations backends." fixture={<Fixture />} />;
}
