import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Eye,
  Globe2,
  Info,
  PlusCircle,
  Search,
  X,
} from "lucide-react";
import { LineTrend, series } from "@/components/charts/Charts";
import { FilterChip } from "@/components/ui/FilterChip";
import { Popover } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  prSecurityReviews,
  securityTrend,
  type PrSecurityReview,
} from "@/data/prSecurityReviews";
import { cn } from "@/lib/utils";

type DrawerView = "all" | "fixed" | "cost" | "repository" | "author";
type DetailTab = "architecture" | "findings";

interface DrawerState {
  view: DrawerView;
  repository?: string;
  author?: string;
}

const ranges = ["30d", "90d", "180d", "1y"] as const;
const severityOptions = ["Critical", "High", "Medium", "Low"];
const repositoryOptions = ["Acalys_voice_agent"];
const authorOptions = ["shrenil28"];

function ClickableCard({
  title,
  children,
  onClick,
}: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  const className = cn(
    "min-h-[188px] rounded-lg border border-line bg-surface p-5 text-left shadow-card",
    onClick &&
      "group cursor-pointer transition-[border-color,background-color,transform] hover:border-line-strong hover:bg-surface-raised active:translate-y-px",
  );
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium text-fg">{title}</h2>
        {onClick && (
          <ChevronRight className="h-4 w-4 text-fg-faint opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
        )}
      </div>
      <div className="mt-5">{children}</div>
    </>
  );

  return onClick ? (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  ) : (
    <section className={className}>{content}</section>
  );
}

function ProgressLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-fg-subtle">
        {label} <strong className="font-semibold text-ok">{value}</strong>
      </p>
      <div className="relative mt-2 h-1 rounded-full bg-line">
        <span className="block h-full w-[86%] rounded-full bg-ok" />
        <span className="absolute right-[14%] top-[-3px] h-2.5 w-px bg-fg" />
      </div>
    </div>
  );
}

function EmptyBreakdown({ title, info, label }: { title: string; info: string; label: string }) {
  return (
    <section className="min-h-[358px] rounded-lg border border-line bg-surface shadow-card">
      <header className="flex h-10 items-center gap-2 px-3">
        <h2 className="flex-1 text-sm font-medium text-fg">{title}</h2>
        <Tooltip label={info} side="top">
          <button type="button" aria-label={info} className="text-fg-subtle hover:text-fg">
            <Info className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </header>
      <div className="flex h-[305px] items-center justify-center text-xs text-fg-subtle">
        {label}
      </div>
    </section>
  );
}

function AppliedFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value?: string;
  options: string[];
  onChange: (value?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = options.filter((option) =>
    option.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Popover
      panelClassName="w-56 p-1"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          <span className="text-fg">{label}</span>
          <span className="ml-0.5 max-w-36 truncate rounded bg-hover px-1.5 py-0.5 text-2xs">
            {value ?? "All"}
          </span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="mb-1 flex h-8 items-center gap-2 rounded border border-line bg-canvas px-2">
            <Search className="h-3.5 w-3.5 text-fg-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}`}
              className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(undefined);
              close();
            }}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-fg-muted hover:bg-hover"
          >
            All
          </button>
          {filtered.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                onChange(option);
                close();
              }}
              className={cn(
                "w-full rounded px-2 py-1.5 text-left text-xs hover:bg-hover",
                value === option ? "bg-hover text-fg" : "text-fg-muted",
              )}
            >
              {option}
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

function SeverityDot({ severity }: { severity: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-danger">
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {severity}
    </span>
  );
}

function ReviewDetails({ review }: { review: PrSecurityReview }) {
  const [tab, setTab] = useState<DetailTab>("findings");
  const [deepDetails, setDeepDetails] = useState(false);

  return (
    <div className="border-b border-line bg-shell px-3 pb-3 pt-2">
      <div className="inline-flex rounded-lg border border-line bg-canvas p-0.5">
        <button
          type="button"
          onClick={() => setTab("architecture")}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs",
            tab === "architecture" ? "bg-surface-raised text-fg" : "text-fg-subtle",
          )}
        >
          Architecture review
        </button>
        <button
          type="button"
          onClick={() => setTab("findings")}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs",
            tab === "findings" ? "bg-surface-raised text-fg" : "text-fg-subtle",
          )}
        >
          Security findings
        </button>
      </div>

      {tab === "findings" ? (
        <div className="mt-3 overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-surface-raised text-fg-subtle">
              <tr>
                <th className="px-3 py-2 font-medium">Finding</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Severity</th>
                <th className="px-3 py-2 font-medium">Reachability</th>
                <th className="px-3 py-2 font-medium">Effort</th>
              </tr>
            </thead>
            <tbody>
              {review.findings.map((finding) => (
                <tr key={finding.id} className="border-t border-line">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-fg">
                      {finding.title} <ExternalLink className="inline h-3 w-3" />
                    </div>
                    <div className="mt-1 font-mono text-2xs text-fg-subtle">
                      {finding.file} · {finding.cwe}
                    </div>
                  </td>
                  <td className={cn("px-3 py-2.5", finding.status === "Fixed" ? "text-ok" : "text-warn")}>
                    {finding.status === "Fixed" ? (
                      <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5" />
                    ) : (
                      <CircleAlert className="mr-1.5 inline h-3.5 w-3.5" />
                    )}
                    {finding.status}
                  </td>
                  <td className="px-3 py-2.5"><SeverityDot severity={finding.severity} /></td>
                  <td className="px-3 py-2.5 text-fg-muted">
                    <Globe2 className="mr-1.5 inline h-3.5 w-3.5" />{finding.reachability}
                  </td>
                  <td className="px-3 py-2.5 text-fg-subtle">{finding.effort ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-line p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-fg">Assessment</strong>
            <span className="rounded border border-line px-1.5 py-0.5 text-fg-muted">
              {review.architecture.risk}
            </span>
          </div>
          <p className="mt-2 leading-5 text-fg-muted">{review.architecture.assessment}</p>
          <p className="mt-1 font-mono text-fg-subtle">⌘ {review.architecture.commit}</p>
          <h4 className="mt-4 font-semibold text-fg">Retained concerns</h4>
          <div className="mt-2 space-y-2">
            {review.architecture.concerns.map((concern, index) => (
              <div key={index} className="flex items-start gap-2 text-fg-muted">
                <span className={cn("rounded px-1.5 py-0.5", concern.severity === "Medium" ? "bg-warn/15 text-warn" : "bg-info/15 text-info")}>
                  {concern.severity}
                </span>
                <span className="rounded border border-line px-1.5 py-0.5 text-2xs">
                  {concern.evidence === "Observed" ? <Eye className="mr-1 inline h-3 w-3" /> : <Search className="mr-1 inline h-3 w-3" />}
                  {concern.evidence}
                </span>
                <p className="leading-5">{concern.text}</p>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setDeepDetails((value) => !value)}
            className="mt-3 inline-flex items-center gap-1.5 rounded px-1 py-1 text-2xs text-fg-muted hover:bg-hover hover:text-fg"
          >
            {deepDetails ? "Hide review details" : "See review details"}
            <ChevronDown className={cn("h-3 w-3 transition-transform", deepDetails && "rotate-180")} />
          </button>
          {deepDetails && (
            <div className="mt-2 rounded-md border border-line bg-canvas p-3">
              <div className="flex flex-wrap gap-x-5 gap-y-2 border-b border-line pb-2 text-fg-subtle">
                <span className="font-medium text-fg">Security blast radius</span>
                <span>Security findings and attack paths</span>
                <span>Trust boundaries and controls</span>
                <span>Hardening proposals</span>
              </div>
              <p className="mt-2 leading-5 text-fg-muted">
                <Eye className="mr-1 inline h-3 w-3" /> The enforcement change covers Assistant,
                notifier, and settings state stored under three browser-storage keys.
              </p>
              <p className="mt-2 leading-5 text-fg-muted">
                <Search className="mr-1 inline h-3 w-3" /> The independently attackable scope is
                client-side state available to code able to write the same browser origin.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SecurityReviewDrawer({ state, onClose }: { state: DrawerState | null; onClose: () => void }) {
  const [repository, setRepository] = useState<string | undefined>();
  const [author, setAuthor] = useState<string | undefined>();
  const [severity, setSeverity] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string[]>([]);

  useEffect(() => {
    setRepository(state?.repository);
    setAuthor(state?.author);
    setSeverity(undefined);
    setExpanded([]);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKeyDown = (event: KeyboardEvent) =>
      event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [state, onClose]);

  const reviews = useMemo(
    () =>
      prSecurityReviews.filter((review) => {
        if (repository && review.repository !== repository) return false;
        if (author && review.author !== author) return false;
        if (severity && review.severity !== severity) return false;
        if (state?.view === "fixed" && !review.findings.some((finding) => finding.status === "Fixed")) return false;
        if (state?.view === "cost" && !review.findings.some((finding) => finding.status === "Fixed" && ["Critical", "High"].includes(finding.severity))) return false;
        return true;
      }),
    [author, repository, severity, state?.view],
  );

  if (!state) return null;

  const title =
    state.view === "fixed"
      ? "Findings fixed"
      : state.view === "cost"
        ? "Est. cost saving"
        : state.view === "repository"
          ? state.repository
          : state.view === "author"
            ? state.author
            : "All findings";

  return createPortal(
    <div className="fixed inset-0 z-[110]">
      <button
        type="button"
        aria-label="Close security review details"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[3px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute inset-y-4 right-2 flex w-[calc(100%-16px)] max-w-[1280px] animate-fade-in flex-col overflow-hidden rounded-lg border border-line-strong bg-surface shadow-pop md:right-3 md:w-[calc(100%-300px)]"
      >
        <header className="flex items-start border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-fg">{title}</h2>
            <p className="mt-0.5 text-sm text-fg-muted">
              Security findings from PR reviews · last 90 days
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1.5 text-fg-subtle hover:bg-hover hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {state.view === "cost" && (
            <section className="mb-4 grid gap-4 rounded-lg border border-line p-3 sm:grid-cols-2 lg:grid-cols-4">
              <div><span className="text-2xs text-fg-subtle">Critical fixed</span><strong className="block text-base text-fg">0 × $12K</strong></div>
              <div><span className="text-2xs text-fg-subtle">High fixed</span><strong className="block text-base text-fg">6 × $3K</strong></div>
              <div><span className="text-2xs text-fg-subtle">Total saving</span><strong className="block text-base text-fg">$18K</strong></div>
              <div><span className="text-2xs text-fg-subtle">Model</span><strong className="block text-base text-fg">Production-fix cost</strong></div>
            </section>
          )}

          <div className="mb-3 flex flex-wrap gap-2">
            {state.view !== "cost" && (
              <AppliedFilter label="Severity" value={severity} options={severityOptions} onChange={setSeverity} />
            )}
            <AppliedFilter label="Author" value={author} options={authorOptions} onChange={setAuthor} />
            <AppliedFilter label="Repository" value={repository} options={repositoryOptions} onChange={setRepository} />
          </div>

          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full min-w-[850px] text-left text-xs">
              <thead className="bg-surface-raised text-fg-muted">
                <tr>
                  <th className="w-[42%] px-4 py-2.5 font-medium">Pull request</th>
                  <th className="px-3 py-2.5 font-medium">Severity</th>
                  <th className="px-3 py-2.5 font-medium">Author</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium">Found</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((review) => {
                  const open = expanded.includes(review.id);
                  const fixed = state.view === "fixed" || state.view === "cost" || review.findings.every((finding) => finding.status === "Fixed");
                  const openCount = review.findings.filter((finding) => finding.status === "Open").length;
                  const visibleFindings =
                    state.view === "fixed" || state.view === "cost"
                      ? review.findings.filter(
                          (finding) =>
                            finding.status === "Fixed" &&
                            (state.view !== "cost" ||
                              ["Critical", "High"].includes(finding.severity)),
                        )
                      : review.findings;
                  const visibleReview = { ...review, findings: visibleFindings };
                  return (
                    <Fragment key={review.id}>
                      <tr
                        onClick={() => setExpanded((current) => current.includes(review.id) ? current.filter((id) => id !== review.id) : [...current, review.id])}
                        className="cursor-pointer border-t border-line transition-colors first:border-t-0 hover:bg-hover"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <ChevronRight className={cn("h-3.5 w-3.5 text-fg-subtle transition-transform", open && "rotate-90")} />
                            <div>
                              <div className="font-medium text-fg">#{review.number} <ExternalLink className="inline h-3 w-3" /></div>
                              <div className="mt-1 text-fg-subtle">{review.repository} · {visibleFindings.length} findings</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3"><SeverityDot severity={review.severity} /></td>
                        <td className="px-3 py-3 text-fg-muted">{review.author ?? "—"}</td>
                        <td className={cn("px-3 py-3", fixed ? "text-ok" : "text-warn")}>
                          {fixed ? <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5" /> : <CircleAlert className="mr-1.5 inline h-3.5 w-3.5" />}
                          {fixed ? "Fixed" : `${openCount} open`}
                        </td>
                        <td className="px-3 py-3 text-right text-fg-muted">{review.found}</td>
                      </tr>
                      {open && (
                        <tr><td colSpan={5} className="p-0"><ReviewDetails review={visibleReview} /></td></tr>
                      )}
                    </Fragment>
                  );
                })}
                {reviews.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-16 text-center text-fg-subtle">No findings match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex justify-end">
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-surface-raised px-4 text-sm text-fg"
            >
              50 <ChevronDown className="h-3.5 w-3.5 text-fg-subtle" />
            </button>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

export function PrSecurityReviewsFixturePage() {
  const [range, setRange] = useState<(typeof ranges)[number]>("90d");
  const [repo, setRepo] = useState<string[]>([]);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  return (
    <div className="mx-auto w-full max-w-[1020px] px-4 pb-12 pt-9 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
          {ranges.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRange(option)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm transition-colors",
                range === option ? "bg-surface-raised font-semibold text-fg" : "text-fg-subtle hover:text-fg",
              )}
            >
              {option}
            </button>
          ))}
        </div>
        <FilterChip label="Repository" options={repositoryOptions} selected={repo} onChange={setRepo} />
        <p className="ml-auto text-xs text-fg-subtle">Data may take up to 15 minutes to reflect recent reviews and fixes.</p>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ClickableCard title="PRs reviewed">
          <p className="text-3xl font-semibold tabular-nums text-fg">13</p>
          <p className="mt-3 text-xs text-fg-subtle">opened in the last {range}</p>
        </ClickableCard>
        <ClickableCard title="Issue summary" onClick={() => setDrawer({ view: "all" })}>
          <div className="space-y-4">
            <ProgressLine label="Fixed" value="6/7" />
            <ProgressLine label="High/critical fixed" value="6/7" />
            <p className="text-xs text-fg-subtle">About 54 findings per 100 PRs</p>
          </div>
        </ClickableCard>
        <ClickableCard title="Fix rate" onClick={() => setDrawer({ view: "fixed" })}>
          <p className="text-3xl font-semibold tabular-nums text-fg">86%</p>
          <p className="mt-3 text-xs text-fg-subtle">6 of 7 findings fixed</p>
        </ClickableCard>
        <ClickableCard title="Est. cost saving" onClick={() => setDrawer({ view: "cost" })}>
          <p className="flex items-center gap-2 text-3xl font-semibold text-fg">
            $18K
            <Tooltip label="$12K per critical and $3K per high finding fixed before merge." side="top">
              <Info className="h-4 w-4 text-fg-subtle" />
            </Tooltip>
          </p>
          <p className="mt-3 text-xs text-fg-subtle">6 critical/high fixed before merge</p>
        </ClickableCard>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        <EmptyBreakdown title="Findings by severity" info="Security findings observed in PR reviews, by severity. Select a severity to see those findings." label="No findings in this range" />
        <EmptyBreakdown title="Findings by category" info="Security findings from PR reviews, grouped by vulnerability category. Select a category to view its findings." label="No categorized findings in this range" />
      </div>

      <section className="mt-6">
        <h2 className="text-base font-semibold text-fg">Caught vs. fixed over time</h2>
        <p className="text-xs text-fg-subtle">Security findings surfaced in PR reviews per week, and how many are fixed.</p>
        <div className="mt-2">
          <LineTrend
            data={securityTrend}
            seriesDefs={[
              { key: "caught", label: "Caught", color: series.info },
              { key: "fixed", label: "Fixed", color: series.ok },
            ]}
            height={220}
          />
        </div>
      </section>

      <div className="mt-5 grid gap-8 pb-4 lg:grid-cols-2">
        <section>
          <h2 className="text-base font-semibold text-fg">Top repositories</h2>
          <p className="text-xs text-fg-subtle">Findings per 100 reviewed PRs, by repository. Select a repository to see its findings.</p>
          <button
            type="button"
            onClick={() => setDrawer({ view: "repository", repository: "Acalys_voice_agent" })}
            className="group mt-3 flex w-full items-center gap-4 rounded-md px-2 py-2 text-left transition-colors hover:bg-hover"
          >
            <span className="min-w-36 text-sm text-fg-muted group-hover:text-fg">Acalys_voice_agent</span>
            <span className="h-4 flex-1 overflow-hidden rounded bg-line"><span className="block h-full w-full rounded bg-[#7276d9]" /></span>
            <strong className="text-sm tabular-nums text-fg">53.8</strong>
          </button>
        </section>
        <section>
          <h2 className="text-base font-semibold text-fg">Leaderboard</h2>
          <p className="text-xs text-fg-subtle">Authors by security findings fixed. Select an author to see their findings.</p>
          <button
            type="button"
            onClick={() => setDrawer({ view: "author", author: "shrenil28" })}
            className="mt-3 grid w-full grid-cols-[1fr_80px_80px] rounded-md border border-line bg-surface text-left text-xs transition-colors hover:border-line-strong"
          >
            <span className="col-span-full grid grid-cols-subgrid border-b border-line bg-surface-raised px-3 py-2 text-fg-muted">
              <span>Author</span><span className="text-right">Fixed</span><span className="text-right">Found</span>
            </span>
            <span className="px-3 py-2.5 text-fg-muted">1. &nbsp; shrenil28</span>
            <strong className="px-3 py-2.5 text-right text-fg">4</strong>
            <span className="px-3 py-2.5 text-right text-fg-muted">5</span>
          </button>
        </section>
      </div>

      <SecurityReviewDrawer state={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
