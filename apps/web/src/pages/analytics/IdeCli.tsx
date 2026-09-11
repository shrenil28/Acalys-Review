import { lazy } from "react";
import { DeferredFeaturePage } from "@/components/live/DeferredFeaturePage";

const Fixture = lazy(() => import("./IdeCliFixture").then((module) => ({ default: module.IdeCliSummary })));

export function IdeCliSummary() {
  return <DeferredFeaturePage embedded title="IDE & CLI analytics" description="" owner="Phase 11 + Phase 13" reason="IDE/CLI product integration arrives in Phase 11 and its analytics in Phase 13." fixture={<Fixture />} />;
}
