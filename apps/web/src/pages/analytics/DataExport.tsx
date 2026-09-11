import { lazy } from "react";
import { DeferredFeaturePage } from "@/components/live/DeferredFeaturePage";

const Fixture = lazy(() => import("./DataExportFixture").then((module) => ({ default: module.DataExport })));

export function DataExport() {
  return <DeferredFeaturePage embedded title="Data export" description="" owner="Phase 13" reason="Export jobs require a durable reporting/export contract." fixture={<Fixture />} />;
}
