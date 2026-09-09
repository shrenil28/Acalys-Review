import { AlertTriangle, DatabaseZap, Settings2 } from "lucide-react";
import { EmptyState } from "@/components/ui/Misc";
import { TableSkeleton } from "@/components/ui/Skeleton";
import type { LiveFailure } from "@/lib/api/liveDashboard";
import { failureSentence } from "@/lib/api/liveDashboard";

export function LiveTableLoading({ columns = 5 }: { columns?: number }) {
  return <TableSkeleton filters={2} rows={8} columns={columns} />;
}

export function LiveFailureState({ failure }: { failure: LiveFailure }) {
  return (
    <EmptyState
      icon={<AlertTriangle />}
      title="Couldn’t load this view"
      description={failureSentence(failure)}
    />
  );
}

export function LiveMisconfiguredState({ detail }: { detail: string }) {
  return (
    <EmptyState
      icon={<Settings2 />}
      title="Dashboard data source is not configured"
      description={detail}
    />
  );
}

export function LiveEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return <EmptyState icon={<DatabaseZap />} title={title} description={description} />;
}
