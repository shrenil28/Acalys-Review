import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  GitBranch,
  Lock,
  Trash2,
  Unlock,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Misc";
import { Tabs } from "@/components/ui/Tabs";
import { Table, TableShell, Td, Th, Tr } from "@/components/ui/Table";
import { UnsavedBar, useUnsaved } from "@/components/ui/UnsavedBar";
import { useToast } from "@/components/ui/Toast";
import { StatPanel } from "@/components/charts/Panel";
import { AreaTrend, series } from "@/components/charts/Charts";
import { GitHubIcon } from "@/components/icons";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import { NotFoundPage } from "@/pages/NotFound";
import { repositories } from "@/data/repos";
import { learnings } from "@/data/review";
import { weeklyReviews } from "@/data/analytics";
import { formatNumber, relativeTime } from "@/lib/utils";

type Tab = "overview" | "settings" | "learnings" | "activity";

export function RepositoryDetailPage() {
  const { name } = useParams();
  const toast = useToast();
  const repo = repositories.find((entry) => entry.name === name);

  const [tab, setTab] = useState<Tab>("overview");
  const [enabled, setEnabled] = useState(repo?.reviewsEnabled ?? false);
  const {
    draft: settings,
    patch: patchSettings,
    dirty,
    reset,
    commit,
  } = useUnsaved({
    inherit: true,
    instructions: "",
    ignorePaths: "dist/**\n**/*.snap",
  });
  const { inherit, instructions, ignorePaths } = settings;
  const [removing, setRemoving] = useState(false);

  if (!repo) return <NotFoundPage />;

  const repoLearnings = learnings.filter((entry) => entry.repo === repo.name);

  return (
    <Page>
      <TopBarActions>
        <a
          href={`https://github.com/shrenil28/${repo.name}`}
          target="_blank"
          rel="noreferrer"
          className={buttonClass("outline", "sm")}
        >
          <GitHubIcon className="mr-1.5 h-3.5 w-3.5" />
          Open on GitHub
          <ExternalLink className="ml-1.5 h-3 w-3" />
        </a>
      </TopBarActions>

      <Link
        to="/review/repositories"
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-fg-subtle transition-colors hover:text-fg"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All repositories
      </Link>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <GitHubIcon className="h-4 w-4 text-fg-subtle" />
            {repo.name}
            {repo.visibility === "Private" ? (
              <Lock className="h-3.5 w-3.5 text-fg-faint" />
            ) : (
              <Unlock className="h-3.5 w-3.5 text-fg-faint" />
            )}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="outline">
              <GitBranch className="h-3 w-3" />
              {repo.defaultBranch}
            </Badge>
            <Badge tone="outline">{repo.language}</Badge>
            <span className="text-xs text-fg-subtle">
              {repo.lastReviewAt
                ? `Last review ${relativeTime(repo.lastReviewAt)}`
                : "Never reviewed"}
            </span>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-subtle">Reviews</span>
            <Switch
              checked={enabled}
              onChange={(value) => {
                setEnabled(value);
                toast({
                  title: value ? "Reviews enabled" : "Reviews paused",
                  description: `${repo.name} ${value ? "will be" : "will not be"} reviewed on new pull requests.`,
                  tone: value ? "success" : "info",
                });
              }}
              label={`Reviews for ${repo.name}`}
            />
          </div>
        }
      />

      <Tabs
        className="mt-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "settings", label: "Settings" },
          { value: "learnings", label: "Learnings", count: repoLearnings.length },
          { value: "activity", label: "Activity" },
        ]}
      />

      <div className="mt-4 space-y-3">
        {tab === "overview" && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatPanel title="Open pull requests" value={repo.openPrs} tone="info" />
              <StatPanel title="Reviews (30d)" value={repo.reviewsLast30d} />
              <StatPanel
                title="Comments (30d)"
                value={formatNumber(repo.commentsLast30d)}
                tone="purple"
              />
              <StatPanel
                title="Security findings"
                value={repo.security.deepScan ?? "—"}
                tone={repo.security.deepScan ? "danger" : "neutral"}
                footer={repo.security.lastScanAt ? "Last scan complete" : "Never scanned"}
              />
            </div>

            <Card>
              <CardHeader title="Weekly reviews" />
              <CardBody>
                <AreaTrend
                  data={weeklyReviews}
                  seriesDefs={[
                    { key: "value", label: "Reviews", color: series.brand },
                  ]}
                />
              </CardBody>
            </Card>
          </>
        )}

        {tab === "settings" && (
          <>
            <Card>
              <CardHeader
                title="Configuration source"
                description="Inherit the organization defaults, or configure this repository on its own."
              />
              <CardBody className="flex items-center justify-between gap-4">
                <p className="text-sm text-fg-muted">
                  {inherit
                    ? "Using organization settings from shrenil28."
                    : "Using this repository's own settings and committed .acalys.yaml."}
                </p>
                <Switch
                  checked={inherit}
                  onChange={(value) => patchSettings({ inherit: value })}
                  label="Inherit organization settings"
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Review instructions"
                description="Applied on top of the organization instructions for this repository only."
              />
              <CardBody>
                <Textarea
                  rows={4}
                  value={instructions}
                  onChange={(event) => patchSettings({ instructions: event.target.value })}
                  placeholder="Workflow nodes must declare an explicit schema; do not infer parameter shapes at runtime."
                  disabled={inherit}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Ignore paths"
                description="One glob per line. Matching files are excluded from reviews in this repository."
              />
              <CardBody>
                <Textarea
                  rows={4}
                  className="font-mono text-xs"
                  value={ignorePaths}
                  onChange={(event) => patchSettings({ ignorePaths: event.target.value })}
                  disabled={inherit}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Remove repository"
                description="Acalys stops reviewing this repository and deletes its cache. Learnings are kept."
              />
              <CardBody>
                <Button
                  variant="danger"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => setRemoving(true)}
                >
                  Remove {repo.name}
                </Button>
              </CardBody>
            </Card>
          </>
        )}

        {tab === "learnings" &&
          (repoLearnings.length === 0 ? (
            <Card>
              <CardBody>
                <p className="py-8 text-center text-sm text-fg-subtle">
                  No learnings recorded for this repository yet. Reply to a review
                  comment with a correction and it will appear here.
                </p>
              </CardBody>
            </Card>
          ) : (
            <ul className="space-y-2">
              {repoLearnings.map((learning) => (
                <li
                  key={learning.id}
                  className="rounded-lg border border-line bg-surface p-3.5"
                >
                  <p className="text-sm leading-relaxed text-fg-muted">
                    {learning.content}
                  </p>
                  <p className="mt-1.5 text-2xs text-fg-faint">
                    From {learning.source.toLowerCase()} · applied{" "}
                    {learning.appliedCount}×
                  </p>
                </li>
              ))}
            </ul>
          ))}

        {tab === "activity" && (
          <TableShell>
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Event</Th>
                  <Th>Pull request</Th>
                  <Th align="right">Comments</Th>
                </tr>
              </thead>
              <tbody>
                {[
                  { when: "2h ago", event: "Review completed", pr: "#412", comments: 14 },
                  { when: "1d ago", event: "Review completed", pr: "#411", comments: 9 },
                  { when: "2d ago", event: "Incremental review", pr: "#411", comments: 3 },
                  { when: "4d ago", event: "Review completed", pr: "#408", comments: 6 },
                  { when: "6d ago", event: "Cache rebuilt", pr: "—", comments: 0 },
                ].map((row, index) => (
                  <Tr key={index}>
                    <Td className="whitespace-nowrap">{row.when}</Td>
                    <Td className="font-medium text-fg">{row.event}</Td>
                    <Td className="font-mono text-xs">{row.pr}</Td>
                    <Td align="right" className="tabular-nums">
                      {row.comments}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableShell>
        )}
      </div>

      <Modal
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Remove ${repo.name}?`}
        description="Reviews stop immediately and the analysis cache is deleted. You can add the repository back at any time."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setRemoving(false);
                toast({
                  title: "Repository removed",
                  description: `${repo.name} is no longer reviewed.`,
                  tone: "info",
                });
              }}
            >
              Remove repository
            </Button>
          </>
        }
      >
        <Input placeholder={repo.name} aria-label="Type the repository name to confirm" />
      </Modal>
      <UnsavedBar
        open={dirty}
        onReset={reset}
        onSave={() => {
          commit();
          toast({
            title: "Repository settings saved",
            description: `${repo.name} will use these settings on its next review.`,
          });
        }}
      />
    </Page>
  );
}
