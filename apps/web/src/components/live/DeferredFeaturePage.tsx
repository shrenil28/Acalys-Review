import { Suspense, type ReactNode } from "react";
import { Clock3 } from "lucide-react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/ui/Misc";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { resolveDataMode } from "@/lib/api/config";

interface DeferredFeatureProps {
  readonly title: string;
  readonly description: string;
  readonly owner: string;
  readonly reason: string;
  readonly fixture: ReactNode;
  readonly embedded?: boolean;
  readonly className?: string;
}

/**
 * Production fixture firewall for surfaces whose durable backend belongs to a
 * later phase. Explicit demo mode may still render the original UI, but API
 * mode never mounts the lazy fixture subtree.
 */
export function DeferredFeaturePage({
  title,
  description,
  owner,
  reason,
  fixture,
  embedded = false,
  className,
}: DeferredFeatureProps) {
  const mode = resolveDataMode();

  if (mode.kind === "fixtures") {
    return (
      <Suspense
        fallback={
          <div className="rounded-lg border border-line bg-surface p-8 text-sm text-fg-subtle">
            Loading demo data…
          </div>
        }
      >
        {fixture}
      </Suspense>
    );
  }

  const body =
    mode.kind === "misconfigured" ? (
      <LiveMisconfiguredState detail={mode.detail} />
    ) : (
      <EmptyState
        icon={<Clock3 />}
        title={`${title} is not available in live mode yet`}
        description={`${reason} Owning roadmap phase: ${owner}. Acalys does not substitute demo data for this live surface.`}
        className={embedded ? "min-h-[300px]" : undefined}
      />
    );

  if (embedded) return body;

  return (
    <Page className={className}>
      <PageHeader title={title} description={description} />
      <div className="mt-6">{body}</div>
    </Page>
  );
}
