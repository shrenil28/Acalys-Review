import { Link } from "react-router-dom";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Avatar } from "@/components/ui/Misc";
import { Sparkline, series } from "@/components/charts/Charts";
import { Page } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import { FeedbackButton } from "@/components/layout/SecurityBanner";
import {
  summary,
  weeklyActiveUsers,
  weeklyPullRequests,
  weeklyReviewCommentsTotal,
} from "@/data/analytics";
import { repositories } from "@/data/repos";
import { triagePrs } from "@/data/review";
import { securityActivity } from "@/data/security";
import { currentUser } from "@/lib/session";
import { cn, formatNumber, relativeTime } from "@/lib/utils";

const openPrs = repositories.reduce((sum, repo) => sum + repo.openPrs, 0);

const metrics = [
  {
    label: "Reviewed",
    value: formatNumber(summary.mergedPullRequests),
    caption: "pull requests this month",
    delta: "+18%",
    color: series.brand,
    data: weeklyPullRequests.map((point) => ({ value: point.merged })),
    to: "/analytics/pr-reviews",
  },
  {
    label: "Open",
    value: String(openPrs),
    caption: "awaiting review",
    delta: null,
    color: series.info,
    data: weeklyActiveUsers.map((point) => ({ value: point.value })),
    to: "/review/triage",
  },
  {
    label: "Caught",
    value: formatNumber(1_284),
    caption: "issues, 155 critical or high",
    delta: "+11%",
    color: series.purple,
    data: weeklyReviewCommentsTotal.map((point) => ({ value: point.value })),
    to: "/analytics/pr-reviews/quality-metrics",
  },
];

const recommended = [
  {
    title: "Personalize your reviews",
    description: "Path instructions tailor every review to your conventions.",
    to: "/organization/settings/general",
  },
  {
    title: "Enforce your quality bar",
    description: "Pre-merge checks block pull requests that miss your standards.",
    to: "/analytics/pr-reviews/pre-merge-checks",
  },
  {
    title: "Automate the busywork",
    description: "Finishing Touches generates tests and docs on request.",
    to: "/organization/settings/finishing-touches",
  },
];

const stateTone = {
  "Needs review": "text-warn",
  "Changes requested": "text-danger",
  Approved: "text-ok",
  Draft: "text-fg-subtle",
} as const;

function Heading({
  children,
  to,
  label,
}: {
  children: React.ReactNode;
  to?: string;
  label?: string;
}) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-fg-faint">
        {children}
      </h2>
      {to && (
        <Link
          to={to}
          className="flex items-center gap-1 text-xs text-fg-subtle transition-colors hover:text-fg"
        >
          {label}
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}

export function ExplorePage() {
  const firstName = currentUser.firstName;
  const waiting = triagePrs.filter((pr) => pr.needsMyReview).slice(0, 4);
  const activity = securityActivity.slice(0, 4);

  return (
    <Page className="max-w-5xl">
      <TopBarActions>
        <FeedbackButton />
      </TopBarActions>

      <header className="pt-6">
        <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.025em] text-fg">
          Welcome back, {firstName}
        </h1>
        <p className="mt-2 text-sm text-fg-subtle">
          {summary.activeRepositories} repositories active · last review 2h ago
        </p>
      </header>

      {/* Metrics carry no card chrome — hairlines and space do the separating. */}
      <section className="mt-10 grid border-t border-line sm:grid-cols-3">
        {metrics.map((metric) => (
          <Link
            key={metric.label}
            to={metric.to}
            className="group border-b border-line px-1 py-6 transition-colors sm:border-b-0 sm:border-r sm:px-6 sm:first:pl-0 sm:last:border-r-0"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[34px] font-semibold leading-none tabular-nums text-fg">
                {metric.value}
              </span>
              {metric.delta && (
                <span className="text-xs font-medium tabular-nums text-ok">
                  {metric.delta}
                </span>
              )}
            </div>
            <p className="mt-2.5 text-sm text-fg">{metric.label}</p>
            <p className="mt-0.5 text-xs text-fg-subtle">{metric.caption}</p>
            <div className="-mx-1 mt-4 opacity-70 transition-opacity group-hover:opacity-100">
              <Sparkline data={metric.data} color={metric.color} height={40} />
            </div>
          </Link>
        ))}
      </section>

      <section className="mt-12 grid gap-x-12 gap-y-10 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Heading to="/review/triage" label="Open triage">
            Waiting on you
          </Heading>

          {waiting.length === 0 ? (
            <p className="py-8 text-sm text-fg-subtle">
              Nothing is waiting on your review.
            </p>
          ) : (
            <ul>
              {waiting.map((pr) => (
                <li key={pr.id}>
                  <Link
                    to="/review/triage"
                    className="group flex items-center gap-3 border-b border-line py-3.5"
                  >
                    <span className="w-6 shrink-0 font-mono text-2xs text-fg-faint">
                      {pr.priority === "No priority" ? "—" : pr.priority}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg transition-colors group-hover:text-brand">
                        {pr.title}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-2xs text-fg-subtle">
                        {pr.repo} #{pr.number}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "hidden shrink-0 text-xs sm:block",
                        stateTone[pr.reviewState],
                      )}
                    >
                      {pr.reviewState}
                    </span>
                    <Avatar name={pr.author} size={20} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="lg:col-span-2">
          <Heading to="/security/activity-log" label="All activity">
            Recent
          </Heading>

          <ol>
            {activity.map((event) => (
              <li
                key={event.id}
                className="flex items-baseline gap-3 border-b border-line py-3.5"
              >
                {/* A hairline reads calmer than a coloured dot on every row —
                    only a failure earns colour. */}
                <span
                  className={cn(
                    "mt-1.5 h-px w-3 shrink-0",
                    event.outcome === "Failed" ? "bg-danger" : "bg-line-strong",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">
                    {event.action}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-2xs text-fg-subtle">
                    {event.target}
                  </span>
                </span>
                <span className="shrink-0 text-2xs text-fg-faint">
                  {relativeTime(event.at)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mt-12">
        <Heading>Recommended</Heading>
        <ul>
          {recommended.map((item) => (
            <li key={item.title}>
              <Link
                to={item.to}
                className="group flex items-center justify-between gap-6 border-b border-line py-4"
              >
                <span className="min-w-0">
                  <span className="block text-sm text-fg transition-colors group-hover:text-brand">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-fg-subtle">
                    {item.description}
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-fg-faint transition-all group-hover:translate-x-0.5 group-hover:text-fg" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
