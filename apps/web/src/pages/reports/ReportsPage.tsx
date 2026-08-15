import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileText, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { Page } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import { reports as seed, type Report } from "@/data/review";
import { type ReportKind } from "@/data/reports";
import { cn } from "@/lib/utils";

function Radio({
  checked,
  label,
  description,
  onSelect,
}: {
  checked: boolean;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-[var(--cr-hover)]"
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          checked ? "border-brand bg-brand" : "border-line-strong",
        )}
      >
        {checked && <span className="h-1.5 w-1.5 rounded-full bg-canvas" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{label}</span>
        <span className="mt-1 block text-xs leading-relaxed text-fg-subtle">
          {description}
        </span>
      </span>
    </button>
  );
}

export function ReportsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [reports, setReports] = useState<Report[]>(seed);
  const [picking, setPicking] = useState(false);
  const [kind, setKind] = useState<ReportKind>("recurring");

  return (
    <Page>
      {reports.length > 0 && (
        <TopBarActions>
          <Button
            size="sm"
            variant="brand"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setPicking(true)}
          >
            Create Report
          </Button>
        </TopBarActions>
      )}

      {reports.length === 0 ? (
        <div className="flex min-h-[60vh] items-center justify-center">
          {/* Dotted field behind the empty card, as the app renders it. */}
          <div
            className="w-full max-w-2xl rounded-xl border border-dashed border-line px-6 py-14 text-center"
            style={{
              backgroundImage:
                "radial-gradient(var(--cr-line) 1px, transparent 1px)",
              backgroundSize: "14px 14px",
            }}
          >
            <span className="mx-auto flex h-11 w-11 items-center justify-center text-fg-subtle">
              <FileText className="h-9 w-9" strokeWidth={1.5} />
            </span>
            <h2 className="mt-3 text-lg font-semibold text-fg">
              Create your first report
            </h2>
            <p className="mt-1.5 text-sm text-fg-subtle">
              Let's tell your data's story together!
            </p>
            <Button
              variant="primary"
              className="mt-5"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => setPicking(true)}
            >
              Create Report
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {reports.map((report) => (
            <Card key={report.id}>
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium text-fg">
                      {report.name}
                    </h3>
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      {report.schedule} · {report.channel} · {report.scope}
                    </p>
                  </div>
                  <Badge tone={report.enabled ? "success" : "neutral"} dot>
                    {report.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-fg-subtle">
                    {report.lastSentAt ? `Last sent ${report.lastSentAt}` : "Not sent yet"}
                  </p>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${report.name}`}
                    onClick={() => {
                      setReports((current) =>
                        current.filter((entry) => entry.id !== report.id),
                      );
                      toast({ title: "Report deleted", tone: "info" });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title="Select Report Type"
        size="sm"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setPicking(false);
              navigate(`/reports/${kind}/new`);
            }}
          >
            Create Report
          </Button>
        }
      >
        <div role="radiogroup" aria-label="Report type" className="space-y-1">
          <Radio
            checked={kind === "recurring"}
            onSelect={() => setKind("recurring")}
            label="Recurring"
            description="The report will be generated at the cadence you select and will run repeatedly"
          />
          <Radio
            checked={kind === "ondemand"}
            onSelect={() => setKind("ondemand")}
            label="On-Demand Test"
            description="A one-time test report for a selected date range. Use Recurring Reports for professional reporting."
          />
        </div>
      </Modal>

      {reports.length === 0 && (
        <p className="mt-6 text-center text-xs text-fg-faint">
          Reports turn dashboard data into a digest for your team. See{" "}
          <Link
            to="/analytics/pr-reviews/reporting"
            className="text-fg-subtle underline underline-offset-2 hover:text-fg"
          >
            delivery metrics
          </Link>{" "}
          once a report has run.
        </p>
      )}
    </Page>
  );
}
