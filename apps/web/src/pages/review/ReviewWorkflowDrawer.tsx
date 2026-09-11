import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Clock3,
  MessageSquare,
  Play,
  RefreshCw,
  Square,
  XCircle,
} from "lucide-react";

import { Drawer } from "@/components/ui/Modal";
import { Badge, severityTone, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { failureSentence } from "@/lib/api/liveDashboard";
import {
  dismissFinding,
  resolveConversation,
  useReviewRun,
  type LivePullRequest,
} from "@/lib/api/reviewWorkflow";
import { newIdempotencyKey } from "@/lib/api/browserSession";
import { cn } from "@/lib/utils";

const runTone: Record<string, BadgeTone> = {
  queued: "neutral",
  preparing: "info",
  analyzing: "info",
  reviewing: "brand",
  verifying: "purple",
  reconciling: "purple",
  publishing: "info",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  superseded: "warning",
};

const checkTone: Record<string, BadgeTone> = {
  passed: "success",
  failed: "danger",
  inconclusive: "warning",
  skipped: "neutral",
  pending: "neutral",
  running: "info",
};

function pretty(value: string): string {
  return value.replaceAll("_", " ").replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

function progressFor(state: string): number {
  switch (state) {
    case "queued": return 0;
    case "preparing": return 10;
    case "analyzing": return 30;
    case "reviewing": return 60;
    case "verifying": return 80;
    case "reconciling": return 90;
    case "publishing": return 95;
    default: return 100;
  }
}

export function ReviewWorkflowDrawer({
  pullRequest,
  reviewRunId,
  onReviewRunId,
  onClose,
}: {
  pullRequest: LivePullRequest | undefined;
  reviewRunId?: string | undefined;
  onReviewRunId?: ((reviewRunId: string) => void) | undefined;
  onClose: () => void;
}) {
  const workflow = useReviewRun(pullRequest, reviewRunId);
  const [dismissTarget, setDismissTarget] = useState<string>();
  const [dismissReason, setDismissReason] = useState("");
  const [actionBusy, setActionBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const currentProgress = workflow.progress?.progress ??
    (workflow.run === undefined ? 0 : progressFor(workflow.run.state) / 100);

  const blockingChecks = useMemo(
    () => workflow.artifacts?.checks.filter((check) => check.blocking && check.status === "failed") ?? [],
    [workflow.artifacts],
  );

  useEffect(() => {
    const current = workflow.run?.id;
    if (current !== undefined && current !== reviewRunId) onReviewRunId?.(current);
  }, [onReviewRunId, reviewRunId, workflow.run?.id]);

  const dismiss = (findingId: string) => {
    if (workflow.baseUrl === undefined || dismissReason.trim() === "") return;
    setActionBusy(`finding:${findingId}`);
    setActionError(undefined);
    const key = newIdempotencyKey("dismiss-finding");
    void dismissFinding(workflow.baseUrl, findingId, dismissReason.trim(), key).then((result) => {
      setActionBusy(undefined);
      if (result.kind === "ok") {
        setDismissTarget(undefined);
        setDismissReason("");
        workflow.refreshArtifacts();
      } else {
        setActionError(failureSentence(result));
      }
    });
  };

  const resolve = (conversationId: string) => {
    if (workflow.baseUrl === undefined) return;
    setActionBusy(`conversation:${conversationId}`);
    setActionError(undefined);
    const key = newIdempotencyKey("resolve-conversation");
    void resolveConversation(workflow.baseUrl, conversationId, key).then((result) => {
      setActionBusy(undefined);
      if (result.kind === "ok") workflow.refreshArtifacts();
      else setActionError(failureSentence(result));
    });
  };

  return (
    <Drawer
      open={pullRequest !== undefined}
      onClose={onClose}
      title={
        pullRequest === undefined ? null : (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{pullRequest.title}</p>
            <p className="mt-0.5 font-mono text-2xs text-fg-subtle">
              {pullRequest.repositoryName} {pullRequest.number === undefined ? "" : `#${String(pullRequest.number)}`}
            </p>
          </div>
        )
      }
      footer={
        workflow.run !== undefined && !workflow.run.settled ? (
          <Button variant="danger" size="sm" onClick={workflow.cancel} icon={<Square className="h-3.5 w-3.5" />}>
            Cancel review
          </Button>
        ) : undefined
      }
    >
      {pullRequest !== undefined && (
        <div className="space-y-5">
          <section className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={pullRequest.draft ? "neutral" : "info"}>
                {pullRequest.draft ? "Draft" : pretty(pullRequest.state)}
              </Badge>
              <span className="text-xs text-fg-subtle">by {pullRequest.author}</span>
              <span className="ml-auto text-2xs text-fg-faint">
                Updated {new Date(pullRequest.updatedAt).toLocaleString()}
              </span>
            </div>
            {pullRequest.labels.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {pullRequest.labels.map((label) => <Badge key={label} tone="outline">{label}</Badge>)}
              </div>
            )}
            <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
              Risk, priority, reviewer assignment, diff statistics and effort estimates are not exposed by the current review API and are intentionally not inferred here.
            </p>
          </section>

          {workflow.run === undefined ? (
            <section className="rounded-lg border border-line bg-surface p-4">
              <div className="flex items-start gap-3">
                <Play className="mt-0.5 h-4 w-4 text-brand" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-medium text-fg">Run Acalys review</h3>
                  <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
                    Queue a review of the pull request’s current persisted revision. Progress will stream live and reconnect from the last durable event if the connection drops.
                  </p>
                  <Button className="mt-3" size="sm" variant="brand" disabled={workflow.operation !== "idle"} onClick={workflow.queue}>
                    {workflow.operation === "queueing"
                      ? "Queueing…"
                      : workflow.operation === "loading_results" && reviewRunId !== undefined
                        ? "Loading review…"
                        : "Start review"}
                  </Button>
                </div>
              </div>
            </section>
          ) : (
            <section className="rounded-lg border border-line bg-surface p-4">
              <div className="flex items-center gap-2">
                <Badge tone={runTone[workflow.run.state] ?? "neutral"} dot>{pretty(workflow.run.state)}</Badge>
                <span className="font-mono text-2xs text-fg-faint">{workflow.run.id}</span>
                {workflow.streamReconnects > 0 && (
                  <span className="ml-auto flex items-center gap-1 text-2xs text-fg-subtle">
                    <RefreshCw className="h-3 w-3" /> reconnected {workflow.streamReconnects}
                  </span>
                )}
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--cr-hover)]">
                <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${Math.round(currentProgress * 100)}%` }} />
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-fg-subtle">
                <Clock3 className="h-3.5 w-3.5" />
                <span>{workflow.progress?.message ?? `Review is ${pretty(workflow.run.state).toLowerCase()}.`}</span>
                {workflow.progress?.findingCount !== undefined && <span className="ml-auto tabular-nums">{workflow.progress.findingCount} findings</span>}
              </div>
              {workflow.stale && (
                <div className="mt-3 flex gap-2 rounded-md border border-warn/30 bg-warn/10 p-2.5 text-xs text-warn">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  The pull request changed after this review was queued. Treat these results as stale and start a new review before relying on them.
                </div>
              )}
              {workflow.run.failureCode !== undefined && (
                <div className="mt-3 flex gap-2 rounded-md border border-danger/30 bg-danger/10 p-2.5 text-xs text-danger">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Review failed with code {workflow.run.failureCode}.
                </div>
              )}
            </section>
          )}

          {workflow.failure !== undefined && (
            <div className="flex gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
              <AlertTriangle className="h-4 w-4 shrink-0" /> {failureSentence(workflow.failure)}
            </div>
          )}
          {actionError !== undefined && (
            <div className="rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{actionError}</div>
          )}

          {workflow.artifacts?.summary !== undefined && (
            <section>
              <div className="mb-2 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-ok" />
                <h3 className="text-sm font-medium text-fg">Review summary</h3>
                {workflow.artifacts.summary.decision !== undefined && <Badge tone="outline">{pretty(workflow.artifacts.summary.decision)}</Badge>}
              </div>
              <div className="rounded-lg border border-line bg-surface p-4">
                <p className="text-sm leading-relaxed text-fg-muted">{workflow.artifacts.summary.overview}</p>
                {workflow.artifacts.summary.changedAreas.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {workflow.artifacts.summary.changedAreas.map((area) => (
                      <div key={`${area.title}:${area.paths.join(",")}`} className="rounded-md bg-[var(--cr-hover)] p-2.5">
                        <p className="text-xs font-medium text-fg">{area.title}</p>
                        <p className="mt-1 text-xs text-fg-subtle">{area.description}</p>
                        <p className="mt-1 font-mono text-2xs text-fg-faint">{area.paths.join(", ")}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {workflow.artifacts !== undefined && (
            <>
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <CircleDot className="h-4 w-4 text-fg-subtle" />
                  <h3 className="text-sm font-medium text-fg">Findings</h3>
                  <Badge tone="neutral">{workflow.artifacts.findings.length}</Badge>
                </div>
                <div className="space-y-2">
                  {workflow.artifacts.findings.length === 0 ? (
                    <div className="rounded-lg border border-line bg-surface p-4 text-xs text-fg-subtle">No findings were published for this review.</div>
                  ) : workflow.artifacts.findings.map((finding) => (
                    <article key={finding.id} className="rounded-lg border border-line bg-surface p-3">
                      <div className="flex items-start gap-2">
                        <Badge tone={severityTone[pretty(finding.severity)] ?? "neutral"}>{pretty(finding.severity)}</Badge>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-fg">{finding.title}</p>
                          <p className="mt-1 text-xs leading-relaxed text-fg-subtle">{finding.explanation}</p>
                          <p className="mt-2 font-mono text-2xs text-fg-faint">{finding.path}:{finding.startLine}-{finding.endLine}</p>
                        </div>
                        <Badge tone="outline">{pretty(finding.lifecycle)}</Badge>
                      </div>
                      {finding.lifecycle === "published" && (
                        <div className="mt-3 border-t border-line pt-3">
                          {dismissTarget === finding.id ? (
                            <div className="flex gap-2">
                              <Input value={dismissReason} onChange={(event) => setDismissReason(event.target.value)} placeholder="Why is this being dismissed?" aria-label="Dismissal reason" />
                              <Button size="sm" variant="danger" disabled={dismissReason.trim() === "" || actionBusy === `finding:${finding.id}`} onClick={() => dismiss(finding.id)}>Dismiss</Button>
                              <Button size="sm" variant="ghost" onClick={() => { setDismissTarget(undefined); setDismissReason(""); }}>Cancel</Button>
                            </div>
                          ) : (
                            <Button size="xs" variant="ghost" onClick={() => setDismissTarget(finding.id)}>Dismiss finding</Button>
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center gap-2">
                  <CheckCircle2 className={cn("h-4 w-4", blockingChecks.length > 0 ? "text-danger" : "text-ok")} />
                  <h3 className="text-sm font-medium text-fg">Pre-merge checks</h3>
                  <Badge tone={blockingChecks.length > 0 ? "danger" : "neutral"}>{workflow.artifacts.checks.length}</Badge>
                </div>
                <div className="space-y-2">
                  {workflow.artifacts.checks.length === 0 ? (
                    <div className="rounded-lg border border-line bg-surface p-4 text-xs text-fg-subtle">No pre-merge checks were reported. Merge permission is therefore unknown, not approved.</div>
                  ) : workflow.artifacts.checks.map((check) => (
                    <div key={check.id} className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3">
                      <Badge tone={checkTone[check.status] ?? "neutral"}>{pretty(check.status)}</Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-fg">{check.name}</p>
                        {check.explanation !== undefined && <p className="mt-1 text-xs text-fg-subtle">{check.explanation}</p>}
                      </div>
                      {check.blocking && <Badge tone="outline">Blocking</Badge>}
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-fg-subtle" />
                  <h3 className="text-sm font-medium text-fg">Conversations</h3>
                  <Badge tone="neutral">{workflow.artifacts.conversations.length}</Badge>
                </div>
                <div className="space-y-2">
                  {workflow.artifacts.conversations.length === 0 ? (
                    <div className="rounded-lg border border-line bg-surface p-4 text-xs text-fg-subtle">No review conversations are attached to this pull request.</div>
                  ) : workflow.artifacts.conversations.map((conversation) => (
                    <div key={conversation.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-fg">{conversation.messageCount} message{conversation.messageCount === 1 ? "" : "s"}</p>
                        <p className="mt-1 font-mono text-2xs text-fg-faint">{conversation.id}</p>
                      </div>
                      <Badge tone={conversation.state === "resolved" ? "success" : "warning"}>{pretty(conversation.state)}</Badge>
                      {conversation.state !== "resolved" && (
                        <Button size="xs" variant="outline" disabled={actionBusy === `conversation:${conversation.id}`} onClick={() => resolve(conversation.id)}>Resolve</Button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}
