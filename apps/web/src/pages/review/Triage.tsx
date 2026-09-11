import { lazy, Suspense } from "react";
import { Page } from "@/components/layout/PageHeader";
import { LiveTableLoading } from "@/components/live/LiveDataState";
import { resolveDataMode } from "@/lib/api/config";
import { LiveTriagePage } from "./LiveTriage";

const FixtureTriagePage = lazy(async () => {
  const module = await import("./TriageFixture");
  return { default: module.TriageFixturePage };
});

export function TriagePage() {
  const mode = resolveDataMode();
  if (mode.kind === "api") return <LiveTriagePage />;
  if (mode.kind === "misconfigured") {
    return (
      <Page>
        <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          Dashboard data source is not configured: {mode.detail}
        </div>
      </Page>
    );
  }
  return (
    <Suspense fallback={<Page><LiveTableLoading columns={5} /></Page>}>
      <FixtureTriagePage />
    </Suspense>
  );
}
