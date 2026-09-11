import { lazy, Suspense } from "react";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { Page } from "@/components/layout/PageHeader";
import { resolveDataMode } from "@/lib/api/config";
import { LiveCachesPage } from "./CachesLive";

const Fixture = lazy(() => import("./CachesFixture").then((module) => ({ default: module.CachesPage })));

export function CachesPage() {
  const mode = resolveDataMode();
  if (mode.kind === "fixtures") return <Suspense fallback={null}><Fixture /></Suspense>;
  if (mode.kind === "misconfigured") return <Page className="max-w-[1040px]"><LiveMisconfiguredState detail={mode.detail} /></Page>;
  return <LiveCachesPage />;
}
