import { useState } from "react";
import { CalendarDays, Check, Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Misc";
import { MenuItem, Popover } from "@/components/ui/Menu";
import { FormSkeleton, usePageLoad } from "@/components/ui/Skeleton";

const fields = [
  { id: "pr", label: "Pull request number, title, and URL", locked: true },
  { id: "repo", label: "Repository and default branch", locked: true },
  { id: "author", label: "Author and reviewers" },
  { id: "timing", label: "Review-ready, last commit, and merge timestamps" },
  { id: "comments", label: "Comment counts by severity and category" },
  { id: "acceptance", label: "Acceptance outcome per comment" },
  { id: "checks", label: "Pre-merge check results" },
  { id: "tools", label: "Tool findings (eslint, ruff, semgrep, …)" },
];

const ranges = [
  "Aug 9 – Aug 15",
  "Last 30 days",
  "Last 90 days",
  "Quarter to date",
  "Year to date",
];

export function DataExport() {
  const loading = usePageLoad();
  const [range, setRange] = useState(ranges[0]);
  const [selected, setSelected] = useState<string[]>([
    "pr",
    "repo",
    "author",
    "timing",
    "comments",
  ]);
  const [format, setFormat] = useState<"CSV" | "JSON">("CSV");

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );


  if (loading) return <FormSkeleton cards={2} />;

  return (
    <div className="max-w-3xl space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-fg">Review Metrics</h2>
        <p className="mt-1 text-sm leading-relaxed text-fg-subtle">
          Download review metrics for each merged pull request. See{" "}
          <a
            href="https://docs.coderabbit.ai/guides/dashboard"
            target="_blank"
            rel="noreferrer"
            className="text-brand underline-offset-2 hover:underline"
          >
            documentation
          </a>{" "}
          for field details.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Export settings"
          description="Exports run against the filters selected above."
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fg">Date range</span>
              <Popover
                trigger={({ toggle: openMenu }) => (
                  <Button
                    variant="outline"
                    icon={<CalendarDays className="h-3.5 w-3.5" />}
                    onClick={openMenu}
                  >
                    {range}
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    {ranges.map((option) => (
                      <MenuItem
                        key={option}
                        selected={option === range}
                        onClick={() => {
                          setRange(option);
                          close();
                        }}
                      >
                        {option}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Popover>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fg">Format</span>
              <div className="inline-flex items-center gap-0.5 rounded-md border border-line bg-canvas p-0.5">
                {(["CSV", "JSON"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setFormat(option)}
                    className={
                      option === format
                        ? "rounded bg-[var(--cr-active)] px-2.5 py-1 text-xs font-medium text-fg"
                        : "rounded px-2.5 py-1 text-xs font-medium text-fg-subtle transition-colors hover:text-fg"
                    }
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-fg">Fields</p>
            <ul className="space-y-1.5">
              {fields.map((field) => (
                <li key={field.id} className="flex items-center gap-2.5">
                  {field.locked ? (
                    <span className="flex h-4 w-4 items-center justify-center rounded border border-line bg-[var(--cr-hover)] text-fg-subtle">
                      <Check className="h-3 w-3" />
                    </span>
                  ) : (
                    <Checkbox
                      checked={selected.includes(field.id)}
                      onChange={() => toggle(field.id)}
                      label={field.label}
                    />
                  )}
                  <span
                    className={
                      field.locked
                        ? "text-sm text-fg-subtle"
                        : "text-sm text-fg-muted"
                    }
                  >
                    {field.label}
                    {field.locked && (
                      <span className="ml-2 text-2xs text-fg-faint">always included</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </CardBody>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-fg-subtle">
          {selected.length + 2} fields · {format} · {range}
        </p>
        <Button variant="brand" icon={<Download className="h-3.5 w-3.5" />}>
          Export
        </Button>
      </div>
    </div>
  );
}
