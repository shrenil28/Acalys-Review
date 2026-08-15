import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ExternalLink,
  ListTodo,
  Paperclip,
  Puzzle,
  Search,
} from "lucide-react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Misc";
import { FormSkeleton, usePageLoad } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { Page } from "@/components/layout/PageHeader";
import { plans, type PlanItem } from "@/data/review";
import { repoNames } from "@/data/repos";
import { DotField } from "./DotField";

/** Card whose body is a line of copy with the action on the right. */
function ActionCard({
  title,
  body,
  actionLabel,
  to,
}: {
  title: string;
  body: string;
  actionLabel: string;
  to: string;
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-sm text-sm leading-relaxed text-fg-muted">{body}</p>
        <Link to={to} className={`${buttonClass("secondary", "md")} shrink-0`}>
          {actionLabel}
          <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
        </Link>
      </CardBody>
    </Card>
  );
}

export function PlanDiscover() {
  const loading = usePageLoad();

  if (loading)
    return (
      <Page className="max-w-4xl">
        <FormSkeleton cards={2} />
      </Page>
    );

  return (
    <Page className="max-w-4xl">
      <div className="rounded-lg border border-line bg-surface px-6 py-8 shadow-card">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-fg">
          Plan before you build
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-fg-muted">
          Describe what you want to change and Acalys turns it into a reviewed,
          step-by-step coding plan grounded in the repository it will run against.
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <ActionCard
          title="Try it out"
          body="Describe your idea and have Acalys generate a coding plan."
          actionLabel="Create a plan"
          to="/plan/new"
        />
        <ActionCard
          title="Automate plan creation"
          body="Configure rulesets to automatically generate plans based on issue status."
          actionLabel="Configure rulesets"
          to="/plan/configurations"
        />
      </div>
    </Page>
  );
}

export function NewPlan() {
  const navigate = useNavigate();
  const toast = useToast();
  const [repo, setRepo] = useState("");
  const [brief, setBrief] = useState("");
  const [generated, setGenerated] = useState<string[] | null>(null);

  const generate = () => {
    if (!brief.trim()) return;
    setGenerated([
      "Map the current implementation and list every call site that will change.",
      "Introduce the new interface behind a feature flag, leaving the old path intact.",
      "Port the primary call site and add tests that cover both paths.",
      "Migrate the remaining call sites one module at a time.",
      "Remove the old path and the flag once the metrics look clean.",
      "Update the docs and the changelog entry.",
    ]);
    toast({
      title: "Plan generated",
      description: repo ? `Grounded in ${repo}.` : "Select a repository to ground it in your code.",
    });
  };

  return (
    <div className="relative min-h-full">
      <DotField />

      <div className="relative mx-auto w-full max-w-3xl px-4 py-14 sm:px-6">
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-fg">
            Ready to build?
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            Create coding plans for your agents from issues, PRDs, designs, and more.
          </p>
        </header>

        <div className="mt-7 overflow-hidden rounded-lg border border-line bg-surface shadow-card">
          <label htmlFor="plan-brief" className="sr-only">
            Describe what you want to build
          </label>
          <textarea
            id="plan-brief"
            rows={6}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="Describe what you want to build. Include goals, scope, constraints, and other context."
            className="w-full resize-none bg-transparent px-4 py-3.5 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-subtle"
          />

          <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
            <Button size="icon-sm" variant="ghost" aria-label="Attach a file">
              <Paperclip className="h-4 w-4" />
            </Button>

            <div className="ml-auto flex items-center gap-2">
              <select
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                aria-label="Select repository"
                style={{
                  backgroundImage:
                    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b8493' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
                }}
                className="h-8 w-[180px] appearance-none rounded-md border border-line bg-canvas bg-[length:14px] bg-[right_8px_center] bg-no-repeat pl-2.5 pr-7 text-sm text-fg-muted outline-none transition-colors hover:border-line-strong"
              >
                <option value="">Select repository</option>
                {repoNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>

              <Button variant="primary" disabled={!brief.trim()} onClick={generate}>
                Create plan
              </Button>
            </div>
          </div>
        </div>

        <p className="mt-2 text-center text-xs text-fg-faint">
          This chat is LLM-generated and may be inaccurate.
        </p>

        {generated && (
          <Card className="mt-6">
            <CardHeader
              title="Generated plan"
              description={`${generated.length} steps${repo ? ` · ${repo}` : ""}`}
              actions={
                <Button size="sm" variant="secondary" onClick={() => navigate("/plan/plans")}>
                  Save plan
                </Button>
              }
            />
            <CardBody>
              <ol className="space-y-3">
                {generated.map((step, index) => (
                  <li key={index} className="flex gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--cr-hover)] text-2xs tabular-nums text-fg-muted">
                      {index + 1}
                    </span>
                    <p className="text-sm leading-relaxed text-fg-muted">{step}</p>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        )}

        <Card className="mt-6">
          <CardHeader title="Automate plan creation using custom Rulesets" />
          <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-md text-sm leading-relaxed text-fg-muted">
              Speed up developer workflows by setting up rulesets that trigger plan
              creation as soon as conditions in the issue trackers are met.
            </p>
            <Link
              to="/plan/configurations"
              className={`${buttonClass("secondary", "md")} shrink-0`}
            >
              Configure rulesets
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Link>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

export function PlansList() {
  const loading = usePageLoad();
  const [query, setQuery] = useState("");
  const [items] = useState<PlanItem[]>(plans);

  const rows = items.filter((plan) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (
      plan.title.toLowerCase().includes(needle) ||
      plan.repo.toLowerCase().includes(needle)
    );
  });

  if (loading)
    return (
      <Page>
        <FormSkeleton cards={2} />
      </Page>
    );

  return (
    <Page>
      <Card>
        <CardHeader title="Automate plan creation using custom Rulesets" />
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-relaxed text-fg-muted">
            Speed up developer workflows by setting up rulesets that trigger plan
            creation as soon as conditions in the issue trackers are met.
          </p>
          <Link
            to="/plan/configurations"
            className={`${buttonClass("secondary", "md")} shrink-0`}
          >
            Configure rulesets
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
          </Link>
        </CardBody>
      </Card>

      <div className="mt-4">
        <Input
          icon={<Search className="h-3.5 w-3.5" />}
          placeholder="Search by title or ticket ID..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          wrapperClassName="max-w-[280px]"
        />
      </div>

      <div className="mt-3 rounded-lg border border-line bg-surface">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <ListTodo className="h-8 w-8 text-fg-subtle" strokeWidth={1.5} />
            <div className="space-y-1.5">
              <h2 className="text-base font-medium text-fg">No plans yet</h2>
              <p className="mx-auto max-w-md text-sm leading-relaxed text-fg-subtle">
                Create a new plan or comment "@acalysai plan" on your issue to
                generate ad-hoc plans.
              </p>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <a
                href="https://docs.coderabbit.ai/guides/planner"
                target="_blank"
                rel="noreferrer"
                className={buttonClass("outline", "md")}
              >
                Learn more
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </a>
              <Link to="/plan/new" className={buttonClass("primary", "md")}>
                New plan
              </Link>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((plan) => (
              <li key={plan.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{plan.title}</span>
                  <span className="mt-0.5 block font-mono text-2xs text-fg-subtle">
                    {plan.repo}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
                  {plan.completedSteps}/{plan.steps} steps
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}

const platforms = ["GitHub Issues", "GitLab Issues", "Jira", "Linear"];

export function PlanConfigurations() {
  const loading = usePageLoad();
  const toast = useToast();
  const [issuePlanning, setIssuePlanning] = useState(false);
  const [platform, setPlatform] = useState("");

  if (loading)
    return (
      <Page className="max-w-4xl">
        <FormSkeleton cards={2} />
      </Page>
    );

  return (
    <Page className="max-w-4xl">
      <Card>
        <CardHeader title="Feature controls" />
        <CardBody className="flex items-start justify-between gap-6">
          <div>
            <p className="text-sm text-fg">Issue planning</p>
            <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
              Enables Issue Planning on your integrated issue tracking platform.
            </p>
          </div>
          <Switch
            checked={issuePlanning}
            onChange={(value) => {
              setIssuePlanning(value);
              toast({
                title: value ? "Issue planning enabled" : "Issue planning disabled",
                tone: value ? "success" : "info",
              });
            }}
            label="Issue planning"
          />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody className="flex flex-col items-center gap-3 px-6 py-14 text-center">
          <Puzzle className="h-8 w-8 text-fg-subtle" strokeWidth={1.5} />
          <div className="space-y-1.5">
            <h2 className="text-base font-medium text-fg">
              Connect your issue tracking platform
            </h2>
            <p className="mx-auto max-w-md text-sm leading-relaxed text-fg-subtle">
              Automatically generate Coding Plans by integrating with your issue
              tracking platform.
            </p>
            <p className="text-sm text-fg-subtle">
              Set up GitHub / GitLab issues in your org settings{" "}
              <Link
                to="/organization/settings/general"
                className="text-brand hover:underline"
              >
                here
              </Link>
              .
            </p>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            <select
              value={platform}
              onChange={(event) => setPlatform(event.target.value)}
              aria-label="Select platform"
              style={{
                backgroundImage:
                  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b8493' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
              }}
              className="h-9 w-[170px] appearance-none rounded-md border border-line bg-canvas bg-[length:14px] bg-[right_10px_center] bg-no-repeat pl-3 pr-8 text-sm text-fg-muted outline-none transition-colors hover:border-line-strong"
            >
              <option value="">Select platform</option>
              {platforms.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>

            <a
              href="https://docs.coderabbit.ai/guides/planner"
              target="_blank"
              rel="noreferrer"
              className={buttonClass("outline", "lg")}
            >
              Learn more
              <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </a>

            <Button
              variant="primary"
              size="lg"
              disabled={!platform}
              onClick={() =>
                toast({
                  title: `${platform} connected`,
                  description: "Plans will be generated as issues reach the configured state.",
                })
              }
            >
              Continue
            </Button>
          </div>
        </CardBody>
      </Card>
    </Page>
  );
}
