import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Misc";
import { Textarea } from "@/components/ui/Input";
import { languages, type KbScope, type OrgConfig } from "@/data/orgSettings";
import { InstructionsBlock, Panel, Row, Select } from "./parts";
import { NoItems, PathInstructionList } from "./NoItems";
import type { Update } from "./SettingsSections";

/**
 * Sections that only exist in the "All Settings" view mode. They mirror the
 * deeper configuration tree the app exposes there.
 */
export type AllSettingsSection =
  | "review/general"
  | "review/auto-review"
  | "review/finishing-touches"
  | "review/pre-merge-checks"
  | "review/post-merge-actions"
  | "review/tools"
  | "chat"
  | "knowledge-base"
  | "code-generation"
  | "issue-enrichment";

interface Props {
  config: OrgConfig;
  update: Update;
}

const kbOptions: { value: KbScope; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "global", label: "Global" },
  { value: "local", label: "Local" },
];

export function AllSettingsPanel({
  section,
  config,
  update,
}: Props & { section: AllSettingsSection }) {
  switch (section) {
    case "review/general":
      return (
        <Panel title="General">
          <Row
            label="Review profile"
            description="Assertive surfaces more nitpicks and style notes. Chill focuses on what matters most."
            control={
              <Select
                value={config.behavior.profile}
                onChange={(profile) =>
                  update("behavior", {
                    profile: profile as OrgConfig["behavior"]["profile"],
                  })
                }
                options={[
                  { value: "chill", label: "Chill" },
                  { value: "assertive", label: "Assertive" },
                ]}
              />
            }
          />
          <Row
            label="Request changes workflow"
            description="Post reviews as 'Request changes' rather than 'Comment' while findings are open."
            control={
              <Switch
                checked={config.behavior.requestChangesWorkflow}
                onChange={(requestChangesWorkflow) =>
                  update("behavior", { requestChangesWorkflow })
                }
                label="Request changes workflow"
              />
            }
          />
          <Row
            label="High level summary"
            description="Generate a high-level summary of the changes in the PR description or walkthrough."
            control={
              <Switch
                checked={config.summary.highLevelSummary}
                onChange={(highLevelSummary) =>
                  update("summary", { highLevelSummary })
                }
                label="High level summary"
              />
            }
          />
          <Row
            label="Poem"
            description="End each review with a short poem about the change."
            control={
              <Switch
                checked={config.fun.poem}
                onChange={(poem) => update("fun", { poem })}
                label="Poem"
              />
            }
          />
          <Row
            label="Review status"
            description="Post a status line at the end of each review."
            control={
              <Switch
                checked={config.statuses.reviewStatus}
                onChange={(reviewStatus) => update("statuses", { reviewStatus })}
                label="Review status"
              />
            }
          />
          <Row
            label="Commit status"
            description="Report review progress as a commit status check."
            control={
              <Switch
                checked={config.statuses.commitStatus}
                onChange={(commitStatus) => update("statuses", { commitStatus })}
                label="Commit status"
              />
            }
          />
        </Panel>
      );

    case "review/auto-review":
      return (
        <Panel title="Auto review">
          <Row
            label="Automatic review"
            description="Review every pull request opened against an enabled repository."
            control={
              <Switch
                checked={config.behavior.autoReview}
                onChange={(autoReview) => update("behavior", { autoReview })}
                label="Automatic review"
              />
            }
          />
          <Row
            label="Include drafts"
            description="Review draft pull requests as soon as they open."
            control={
              <Switch
                checked={config.behavior.autoReviewDrafts}
                disabled={!config.behavior.autoReview}
                onChange={(autoReviewDrafts) =>
                  update("behavior", { autoReviewDrafts })
                }
                label="Include drafts"
              />
            }
          />
          <Row
            label="Incremental reviews"
            description="Review each new push, not only the first one."
            control={
              <Switch
                checked={config.behavior.autoIncrementalReview}
                disabled={!config.behavior.autoReview}
                onChange={(autoIncrementalReview) =>
                  update("behavior", { autoIncrementalReview })
                }
                label="Incremental reviews"
              />
            }
          />
          <Row
            label="Abort on close"
            description="Stop an in-flight review when the pull request is closed."
            control={
              <Switch
                checked={config.behavior.abortOnClose}
                onChange={(abortOnClose) => update("behavior", { abortOnClose })}
                label="Abort on close"
              />
            }
          />
          <Row
            label="Base branches"
            description="Only review pull requests targeting these branches. Regular expressions are supported."
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {config.behavior.baseBranches.map((branch) => (
                <Badge key={branch} tone="neutral" className="font-mono">
                  {branch}
                </Badge>
              ))}
            </div>
          </Row>
        </Panel>
      );

    case "review/finishing-touches":
      return (
        <Panel title="Finishing touches">
          <Row
            label="Generate docstrings"
            description="Offer a follow-up commit that documents new public functions."
            control={
              <Switch
                checked={config.finishingTouches.docstrings}
                onChange={(docstrings) =>
                  update("finishingTouches", { docstrings })
                }
                label="Generate docstrings"
              />
            }
          />
          <Row
            label="Generate unit tests"
            description="Offer a follow-up commit that adds tests for uncovered branches."
            control={
              <Switch
                checked={config.finishingTouches.unitTests}
                onChange={(unitTests) => update("finishingTouches", { unitTests })}
                label="Generate unit tests"
              />
            }
          />
        </Panel>
      );

    case "review/pre-merge-checks":
      return (
        <Panel title="Pre merge checks">
          {(
            [
              ["title", "Title", "Check that the pull request title describes the change."],
              ["description", "Description", "Check that the description explains why the change is needed."],
              ["issueAssessment", "Issue assessment", "Check that the change satisfies every linked issue."],
              ["docstrings", "Docstring coverage", "Check that new public functions carry a docstring."],
            ] as const
          ).map(([key, label, description]) => (
            <Row
              key={key}
              label={label}
              description={description}
              control={
                <Select
                  value={config.preMergeChecks[key]}
                  onChange={(mode) =>
                    update("preMergeChecks", {
                      [key]: mode,
                    } as Partial<OrgConfig["preMergeChecks"]>)
                  }
                  options={[
                    { value: "off", label: "Off" },
                    { value: "warning", label: "Warning" },
                    { value: "error", label: "Error" },
                  ]}
                />
              }
            />
          ))}
        </Panel>
      );

    case "review/post-merge-actions":
      return (
        <Panel title="Post merge actions">
          <Row
            label="Custom actions"
            description="Work CodeRabbit performs after a pull request merges."
          >
            {config.postMergeActions.length === 0 ? (
              <NoItems onCreate={() => undefined} />
            ) : (
              <div className="space-y-2">
                {config.postMergeActions.map((action) => (
                  <div
                    key={action.id}
                    className="flex items-center justify-between gap-4 rounded-md border border-line p-3"
                  >
                    <div>
                      <p className="text-sm text-fg">{action.name}</p>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {action.description}
                      </p>
                    </div>
                    <Switch
                      checked={action.enabled}
                      onChange={(enabled) =>
                        update(
                          "postMergeActions",
                          config.postMergeActions.map((entry) =>
                            entry.id === action.id ? { ...entry, enabled } : entry,
                          ) as OrgConfig["postMergeActions"],
                        )
                      }
                      label={action.name}
                    />
                  </div>
                ))}
              </div>
            )}
          </Row>
        </Panel>
      );

    case "review/tools":
      return (
        <Panel title="Tools">
          <Row
            label="Analysis tools"
            description="CodeRabbit runs these alongside its own review and folds their findings into one report."
          >
            <div className="grid gap-1.5 sm:grid-cols-2">
              {Object.entries(config.tools).map(([name, enabled]) => (
                <label
                  key={name}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
                >
                  <span className="truncate font-mono text-xs text-fg-muted">
                    {name}
                  </span>
                  <Switch
                    checked={enabled}
                    onChange={(value) =>
                      update("tools", {
                        [name]: value,
                      } as Partial<OrgConfig["tools"]>)
                    }
                    label={name}
                  />
                </label>
              ))}
            </div>
          </Row>
        </Panel>
      );

    case "chat":
      return (
        <Panel title="Chat">
          <Row
            label="Auto reply"
            description="Reply to comments that mention CodeRabbit without needing an explicit command."
            control={
              <Switch
                checked={config.chat.autoReply}
                onChange={(autoReply) => update("chat", { autoReply })}
                label="Auto reply"
              />
            }
          />
          <Row
            label="Integrations"
            description="Let chat read linked Jira and Linear issues when answering."
            control={
              <Switch
                checked={config.chat.integrations}
                onChange={(integrations) => update("chat", { integrations })}
                label="Integrations"
              />
            }
          />
          <Row
            label="Art chat"
            description="Allow CodeRabbit to reply with ASCII art when asked."
            control={
              <Switch
                checked={config.chat.artChat}
                onChange={(artChat) => update("chat", { artChat })}
                label="Art chat"
              />
            }
          />
        </Panel>
      );

    case "knowledge-base":
      return (
        <div className="space-y-3">
          <Panel title="Knowledge base">
            <Row
              label="Opt out"
              description="Choose whether the knowledge base is shared across the organization or kept per repository."
              control={
                <Select
                  value={config.knowledgeBase.opt}
                  onChange={(opt) =>
                    update("knowledgeBase", { opt: opt as KbScope })
                  }
                  options={kbOptions}
                />
              }
            />
            <Row
              label="Learnings"
              description="Scope of the learnings CodeRabbit applies during review."
              control={
                <Select
                  value={config.knowledgeBase.learnings}
                  onChange={(learnings) =>
                    update("knowledgeBase", { learnings: learnings as KbScope })
                  }
                  options={kbOptions}
                />
              }
            />
            <Row
              label="Issues"
              description="Scope of the issue tracker context available to reviews."
              control={
                <Select
                  value={config.knowledgeBase.issues}
                  onChange={(issues) =>
                    update("knowledgeBase", { issues: issues as KbScope })
                  }
                  options={kbOptions}
                />
              }
            />
            <Row
              label="Pull requests"
              description="Scope of prior pull request context available to reviews."
              control={
                <Select
                  value={config.knowledgeBase.pullRequests}
                  onChange={(pullRequests) =>
                    update("knowledgeBase", {
                      pullRequests: pullRequests as KbScope,
                    })
                  }
                  options={kbOptions}
                />
              }
            />
          </Panel>

          <Panel title="Jira">
            <Row
              label="Project keys"
              description="Issues in these projects are available as review context."
            >
              {config.knowledgeBase.jiraProjectKeys.length === 0 ? (
                <NoItems
                  onCreate={() =>
                    update("knowledgeBase", { jiraProjectKeys: ["ACL"] })
                  }
                />
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {config.knowledgeBase.jiraProjectKeys.map((key) => (
                    <Badge key={key} tone="neutral" className="font-mono">
                      {key}
                    </Badge>
                  ))}
                </div>
              )}
            </Row>
          </Panel>

          <Panel title="Linear">
            <Row
              label="Team keys"
              description="Issues in these teams are available as review context."
            >
              {config.knowledgeBase.linearTeamKeys.length === 0 ? (
                <NoItems
                  onCreate={() =>
                    update("knowledgeBase", { linearTeamKeys: ["ENG"] })
                  }
                />
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {config.knowledgeBase.linearTeamKeys.map((key) => (
                    <Badge key={key} tone="neutral" className="font-mono">
                      {key}
                    </Badge>
                  ))}
                </div>
              )}
            </Row>
          </Panel>
        </div>
      );

    case "code-generation":
      return (
        <div className="space-y-3">
          <Panel title="Docstring generation">
            <Row
              label="Language"
              description="Language for generated docstrings (ISO language code)."
              control={
                <Select
                  value={config.codeGeneration.docstringLanguage}
                  onChange={(docstringLanguage) =>
                    update("codeGeneration", { docstringLanguage })
                  }
                  options={languages.map((entry) => ({
                    value: entry.code,
                    label: entry.label,
                  }))}
                />
              }
            />
            <Row
              label="Path instructions"
              description="Add path-specific guidelines for docstring generation."
            >
              <PathInstructionList
                items={config.codeGeneration.docstringPathInstructions}
                onChange={(docstringPathInstructions) =>
                  update("codeGeneration", { docstringPathInstructions })
                }
                placeholderInstruction="Document the units of every numeric argument."
              />
            </Row>
          </Panel>

          <Panel title="Unit test generation">
            <Row
              label="Path instructions"
              description="Add path-specific guidelines for unit test generation."
            >
              <PathInstructionList
                items={config.codeGeneration.unitTestPathInstructions}
                onChange={(unitTestPathInstructions) =>
                  update("codeGeneration", { unitTestPathInstructions })
                }
                placeholderPath="src/**/*.ts"
                placeholderInstruction="Cover the error path as well as the happy path."
              />
            </Row>
          </Panel>
        </div>
      );

    case "issue-enrichment":
      return (
        <Panel title="Issue enrichment">
          <Row
            label="Enrich issues"
            description="Add reproduction steps, affected files, and severity to newly opened issues."
            control={
              <Switch
                checked={config.issueEnrichment.enabled}
                onChange={(enabled) => update("issueEnrichment", { enabled })}
                label="Enrich issues"
              />
            }
          />
          <Row
            label="Suggest labels"
            description="Apply labels based on the area of the codebase the issue touches."
            control={
              <Switch
                checked={config.issueEnrichment.autoLabel}
                disabled={!config.issueEnrichment.enabled}
                onChange={(autoLabel) => update("issueEnrichment", { autoLabel })}
                label="Suggest labels"
              />
            }
          />
          <Row
            label="Link duplicates"
            description="Point at existing issues that describe the same problem."
            control={
              <Switch
                checked={config.issueEnrichment.linkDuplicates}
                disabled={!config.issueEnrichment.enabled}
                onChange={(linkDuplicates) =>
                  update("issueEnrichment", { linkDuplicates })
                }
                label="Link duplicates"
              />
            }
          />
          <InstructionsBlock
            label="Enrichment instructions"
            blurb="Tell CodeRabbit what a well-formed issue looks like on this team. Example: 'Always restate the expected behaviour, the observed behaviour, and the smallest reproduction you can find, then list the files most likely involved.'"
            value={config.issueEnrichment.instructions}
            onChange={(instructions) =>
              update("issueEnrichment", { instructions })
            }
          />
        </Panel>
      );
  }
}

/** Extra text field reused by the issue-enrichment section. */
export function PlainTextarea(props: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Textarea
      rows={3}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}
