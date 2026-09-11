import { AcalysMark } from "@/components/icons";
import { Avatar } from "@/components/ui/Misc";
import { Badge } from "@/components/ui/Badge";
import { previewChanges, type OrgConfig } from "./settings-model";
import { cn } from "@/lib/utils";

/**
 * Live preview of the comment Acalys will post. Every block here is
 * driven by the config on the left, so toggling a setting shows its effect.
 */
export interface ReviewPreviewIdentity {
  readonly name: string;
  readonly avatarUrl?: string | undefined;
}

export function ReviewPreview({
  config,
  viewMode,
  author = { name: "Pull request author" },
}: {
  config: OrgConfig;
  viewMode: "Concise" | "Detailed";
  author?: ReviewPreviewIdentity | undefined;
}) {
  const detailed = viewMode === "Detailed";

  return (
    <div className="space-y-3">
      {/* Pull request description, edited in place by the bot */}
      <article className="overflow-hidden rounded-lg border border-line bg-surface">
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Avatar src={author.avatarUrl ?? ""} name={author.name} size={22} />
          <span className="text-sm font-medium text-fg">{author.name}</span>
          <span className="text-xs text-fg-subtle">edited by acalysai</span>
        </header>

        <div className="space-y-4 px-4 py-4">
          <section>
            <h3 className="text-sm font-semibold text-fg">
              PR Author-generated Summary
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-fg-muted">
              User-generated pull request details that hopefully answers the most
              important questions about why they created this pull request, why
              this is the best solution, and what is the meaning of life!
            </p>
          </section>

          {config.summary.highLevelSummary && (
            <section data-preview="summary">
              <h3 className="text-sm font-semibold text-fg">
                Acalys-generated Summary
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                An AI-generated thorough summary of a PR's purpose and key
                changes, written for human reviewers. By default, Acalys
                generates release notes in the description.
              </p>
              {detailed && (
                <ul className="mt-2 space-y-1 text-sm text-fg-muted">
                  <li className="flex gap-2">
                    <span className="text-fg-faint">•</span>
                    <span>
                      <strong className="font-medium text-fg">Bug fixes</strong> —
                      sessions no longer trust the organization id sent by the
                      client.
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-fg-faint">•</span>
                    <span>
                      <strong className="font-medium text-fg">Chores</strong> —
                      refresh tokens now rotate on every exchange.
                    </span>
                  </li>
                </ul>
              )}
            </section>
          )}

          {config.summary.assessLinkedIssues && (
            <section data-preview="issues">
              <h3 className="text-sm font-semibold text-fg">Linked issues</h3>
              <p className="mt-1.5 text-sm text-fg-muted">
                <span className="font-mono text-brand">#218</span> — Scope agent
                reads to the caller's organization.{" "}
                <span className="text-ok">Objectives met.</span>
              </p>
            </section>
          )}

          {(config.summary.suggestedLabels || config.summary.suggestedReviewers) && (
            <section
              data-preview="labels"
              className="flex flex-wrap items-center gap-x-6 gap-y-2"
            >
              {config.summary.suggestedLabels && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-subtle">
                    {config.summary.autoApplyLabels ? "Labels" : "Suggested labels"}
                  </span>
                  <Badge tone="danger">security</Badge>
                  <Badge tone="info">backend</Badge>
                </div>
              )}
              {config.summary.suggestedReviewers && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-subtle">
                    {config.summary.autoAssignReviewers
                      ? "Reviewers"
                      : "Suggested reviewers"}
                  </span>
                  <Badge tone="neutral">jonas-b</Badge>
                  <Badge tone="neutral">meera.k</Badge>
                </div>
              )}
            </section>
          )}
        </div>
      </article>

      {/* The review comment itself */}
      <article className="overflow-hidden rounded-lg border border-line bg-surface">
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <AcalysMark className="h-[22px] w-[22px] shrink-0 rounded-full" />
          <span className="text-sm font-medium text-fg">acalysai</span>
          {config.behavior.profile === "assertive" && (
            <Badge tone="warning" className="ml-auto">
              Assertive
            </Badge>
          )}
        </header>

        <div className="space-y-4 px-4 py-4">
          {config.walkthrough.enabled && (
            <section data-preview="walkthrough">
              <h3 className="text-sm font-semibold text-fg">Walkthrough</h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                A concise summary of what changed in this pull request.
              </p>
              {config.summary.highLevelSummaryInWalkthrough &&
                config.summary.highLevelSummary && (
                  <p className="mt-2 rounded-md border border-line bg-canvas p-2.5 text-sm leading-relaxed text-fg-muted">
                    <span className="font-medium text-fg">Summary — </span>
                    sessions no longer trust the organization id sent by the
                    client, and refresh tokens rotate on every exchange.
                  </p>
                )}
            </section>
          )}

          {config.walkthrough.enabled && config.walkthrough.changedFilesSummary && (
            <section data-preview="changes">
              <h3 className="text-sm font-semibold text-fg">Changes</h3>
              <div className="mt-2 overflow-hidden rounded-md border border-line">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="bg-[var(--cr-hover)]">
                      <th className="border-b border-line px-2.5 py-1.5 font-medium text-fg-muted">
                        File(s) / Path(s)
                      </th>
                      <th className="border-b border-line px-2.5 py-1.5 font-medium text-fg-muted">
                        Change Summary
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detailed ? previewChanges : previewChanges.slice(0, 2)).map(
                      (change) => (
                        <tr key={change.path}>
                          <td className="border-b border-line/60 px-2.5 py-1.5 align-top font-mono text-2xs text-fg">
                            {change.path}
                          </td>
                          <td className="border-b border-line/60 px-2.5 py-1.5 align-top leading-relaxed text-fg-muted">
                            {detailed
                              ? change.summary
                              : "Summary of changes to this file."}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {config.walkthrough.enabled && config.walkthrough.estimateCodeReviewEffort && (
            <section data-preview="effort" className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-fg">
                Estimated code review effort
              </h3>
              <Badge tone="warning">🔵🔵⚪ 3 (~25 minutes)</Badge>
            </section>
          )}

          {config.walkthrough.enabled && config.walkthrough.sequenceDiagrams && (
            <section data-preview="diagram">
              <h3 className="text-sm font-semibold text-fg">Sequence diagram(s)</h3>
              <SequenceDiagram />
            </section>
          )}

          {config.summary.relatedPrs && (
            <section data-preview="related-prs">
              <h3 className="text-sm font-semibold text-fg">Related pull requests</h3>
              <p className="mt-1.5 text-sm text-fg-muted">
                <span className="font-mono text-brand">#401</span> — Introduces the
                session helper this change builds on.
              </p>
            </section>
          )}

          {config.fun.poem && (
            <section data-preview="poem" className="rounded-md border border-line bg-canvas p-3">
              <p className="whitespace-pre-line font-mono text-xs leading-relaxed text-fg-muted">
                {`A token rotates, the old one retires,
The org now comes from the session's wires.
No body may claim what it does not own —
A hop, a check, and the scope has grown. 🐇`}
              </p>
            </section>
          )}

          {config.statuses.reviewStatus && (
            <section data-preview="status" className="flex items-center gap-2 border-t border-line pt-3">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  config.behavior.requestChangesWorkflow ? "bg-warn" : "bg-ok",
                )}
              />
              <span className="text-xs text-fg-subtle">
                Review status:{" "}
                <span className="text-fg-muted">
                  {config.behavior.requestChangesWorkflow
                    ? "Changes requested"
                    : "Commented"}
                </span>
              </span>
            </section>
          )}
        </div>
      </article>
    </div>
  );
}

/** Stand-in for the Mermaid diagram Acalys renders inside the walkthrough. */
function SequenceDiagram() {
  const lanes = ["Client", "Auth middleware", "Token service"];
  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-line bg-canvas p-3">
      <svg viewBox="0 0 420 150" className="h-auto w-full min-w-[360px]" role="img" aria-label="Sequence diagram preview">
        {lanes.map((lane, index) => {
          const x = 40 + index * 150;
          return (
            <g key={lane}>
              <rect
                x={x - 34}
                y={6}
                width={68}
                height={18}
                rx={3}
                className="fill-[var(--cr-surface-raised)] stroke-[var(--cr-line)]"
              />
              <text
                x={x}
                y={19}
                textAnchor="middle"
                className="fill-[var(--cr-fg-muted)]"
                style={{ fontSize: 8 }}
              >
                {lane}
              </text>
              <line
                x1={x}
                y1={26}
                x2={x}
                y2={140}
                className="stroke-[var(--cr-line)]"
                strokeDasharray="3 3"
              />
            </g>
          );
        })}
        {[
          { from: 0, to: 1, y: 52, label: "request + token" },
          { from: 1, to: 2, y: 80, label: "verify + rotate" },
          { from: 2, to: 1, y: 106, label: "session (org id)" },
          { from: 1, to: 0, y: 130, label: "scoped response" },
        ].map((arrow, index) => {
          const x1 = 40 + arrow.from * 150;
          const x2 = 40 + arrow.to * 150;
          const forward = x2 > x1;
          return (
            <g key={index}>
              <line
                x1={x1}
                y1={arrow.y}
                x2={forward ? x2 - 5 : x2 + 5}
                y2={arrow.y}
                className="stroke-[var(--cr-brand)]"
                strokeWidth={1.2}
              />
              <polygon
                points={
                  forward
                    ? `${x2},${arrow.y} ${x2 - 6},${arrow.y - 3} ${x2 - 6},${arrow.y + 3}`
                    : `${x2},${arrow.y} ${x2 + 6},${arrow.y - 3} ${x2 + 6},${arrow.y + 3}`
                }
                className="fill-[var(--cr-brand)]"
              />
              <text
                x={(x1 + x2) / 2}
                y={arrow.y - 5}
                textAnchor="middle"
                className="fill-[var(--cr-fg-subtle)]"
                style={{ fontSize: 7.5 }}
              >
                {arrow.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
