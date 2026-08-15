import { Link } from "react-router-dom";
import { NoData, Panel } from "@/components/charts/Panel";
import { DashboardSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { buttonClass } from "@/components/ui/Button";
import { reporting } from "@/data/analytics";

export function Reporting() {
  const loading = usePageLoad();
  if (loading) return <DashboardSkeleton tiles={4} panels={0} wide={false} />;

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Panel title="Scheduled Reports Delivered" bodyClassName="flex items-center">
        <button
          type="button"
          title="Reports Sent"
          className="text-left text-[32px] font-semibold leading-none tabular-nums text-fg transition-colors hover:text-brand"
        >
          {reporting.scheduledDelivered}
          <span className="mt-2 block text-xs font-normal text-fg-subtle">
            Reports Sent
          </span>
        </button>
      </Panel>

      <Panel title="Reports Delivered by Channel">
        {reporting.byChannel.length === 0 ? (
          <NoData />
        ) : (
          <NoData label="Channel breakdown" />
        )}
      </Panel>

      <Panel title="Reports Configured" bodyClassName="flex items-center">
        <div className="flex w-full gap-6">
          <button type="button" className="text-left transition-colors hover:text-brand">
            <span className="block text-xs text-fg-subtle">Scheduled</span>
            <span className="mt-1 block text-[28px] font-semibold leading-none tabular-nums text-fg">
              {reporting.scheduledConfigured}
            </span>
          </button>
          <button type="button" className="text-left transition-colors hover:text-brand">
            <span className="block text-xs text-fg-subtle">On-Demand</span>
            <span className="mt-1 block text-[28px] font-semibold leading-none tabular-nums text-fg">
              {reporting.onDemandConfigured}
            </span>
          </button>
        </div>
      </Panel>

      <Panel title="Weekly Reports Delivered">
        <NoData />
      </Panel>

      <Panel title="Get started with reporting" className="md:col-span-2 xl:col-span-4">
        <div className="flex flex-col items-start gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-sm leading-relaxed text-fg-subtle">
            Reports turn dashboard data into a scheduled digest for your team.
            Create one to start tracking delivery here.
          </p>
          <Link to="/analytics/reports" className={buttonClass("brand", "sm")}>
            Create Report
          </Link>
        </div>
      </Panel>
    </div>
  );
}
