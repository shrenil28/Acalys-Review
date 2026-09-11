import { lazy } from "react";
import { DeferredFeaturePage } from "@/components/live/DeferredFeaturePage";

const Fixture = lazy(() => import("./ReportingFixture").then((module) => ({ default: module.Reporting })));

export function Reporting() {
  return <DeferredFeaturePage embedded title="Review reporting" description="" owner="Phase 13" reason="Reporting datasets and delivery semantics require the reporting backend." fixture={<Fixture />} />;
}
