import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SegmentedControl, Switch } from "@/components/ui/Misc";
import { languages, type OrgConfig } from "@/data/orgSettings";
import { InstructionsBlock, Panel, Row, Select, severityOptions } from "./parts";

/** Section slugs match the app's URLs, e.g. /organization/settings/review/summary */
export type SettingsSection =
  | "general"
  | "review/summary"
  | "review/walkthrough"
  | "review/behavior"
  | "pre-merge-checks"
  | "finishing-touches"
  | "custom-post-merge-actions"
  | "statuses"
  | "fun";

export const sectionTitles: Record<SettingsSection, string> = {
  general: "General",
  "review/summary": "Summary",
  "review/walkthrough": "Walkthrough",
  "review/behavior": "Behavior",
  "pre-merge-checks": "Pre-merge checks",
  "finishing-touches": "Finishing touches",
  "custom-post-merge-actions": "Custom post-merge actions",
  statuses: "Statuses",
  fun: "Fun",
};

export const allSections: SettingsSection[] = [
  "general",
  "review/summary",
  "review/walkthrough",
  "review/behavior",
  "pre-merge-checks",
  "finishing-touches",
  "custom-post-merge-actions",
  "statuses",
  "fun",
];

export type Update = <K extends keyof OrgConfig>(
  key: K,
  value: Partial<OrgConfig[K]>,
) => void;

interface SectionProps {
  config: OrgConfig;
  update: Update;
  onView?: (target: string) => void;
}

export function SettingsPanel({
  section,
  ...props
}: SectionProps & { section: SettingsSection }) {
  switch (section) {
    case "general":
      return <GeneralSection {...props} />;
    case "review/summary":
      return <SummarySection {...props} />;
    case "review/walkthrough":
      return <WalkthroughSection {...props} />;
    case "review/behavior":
      return <BehaviorSection {...props} />;
    case "pre-merge-checks":
      return <PreMergeSection {...props} />;
    case "finishing-touches":
      return <FinishingTouchesSection {...props} />;
    case "custom-post-merge-actions":
      return <PostMergeSection {...props} />;
    case "statuses":
      return <StatusesSection {...props} />;
    case "fun":
      return <FunSection {...props} />;
  }
}

/* ------------------------------------------------------------------ General */

function GeneralSection({ config, update }: SectionProps) {
  return (
    <Panel title="General">
      <Row
        label="Language"
        description="Set the language for reviews by using the corresponding ISO language code."
        control={
          <Select
            value={config.general.language}
            onChange={(language) => update("general", { language })}
            options={languages.map((entry) => ({
              value: entry.code,
              label: entry.label,
            }))}
          />
        }
      />
      <Row
        label="Early access"
        description="Enable early-access features."
        control={
          <Switch
            checked={config.general.earlyAccess}
            onChange={(earlyAccess) => update("general", { earlyAccess })}
            label="Early access"
          />
        }
      />
      <InstructionsBlock
        label="Tone instructions"
        blurb="Set the tone of reviews and chat for the whole organization. Example: 'Be direct and skip praise. Lead with the risk, then the concrete fix, and keep each comment under three sentences.'"
        value={config.general.toneInstructions}
        onChange={(toneInstructions) => update("general", { toneInstructions })}
      />
    </Panel>
  );
}

/* ------------------------------------------------------------------ Summary */

function SummarySection({ config, update, onView }: SectionProps) {
  return (
    <div className="space-y-3">
      <Panel title="Summary">
        <Row
          label="High level summary"
          viewTarget="summary"
          onView={onView}
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
        <InstructionsBlock
          label="High level summary instructions"
          blurb="By default, Acalys generates release notes in the description. Use this to customize the summary content and format. Example: 'Create concise release notes as a bullet-point list, grouped by New features, Bug fixes, and Chores, and keep each entry to one line.'"
          value={config.summary.highLevelSummaryInstructions}
          onChange={(highLevelSummaryInstructions) =>
            update("summary", { highLevelSummaryInstructions })
          }
        />
        <Row
          label="High level summary in walkthrough"
          viewTarget="walkthrough"
          onView={onView}
          description="Include the high-level summary in the walkthrough comment."
          control={
            <Switch
              checked={config.summary.highLevelSummaryInWalkthrough}
              onChange={(highLevelSummaryInWalkthrough) =>
                update("summary", { highLevelSummaryInWalkthrough })
              }
              label="High level summary in walkthrough"
            />
          }
        />
        <Row
          label="High level summary placeholder"
          description="Placeholder in the pull request description that Acalys replaces with the summary."
          control={
            <Input
              className="font-mono text-xs"
              wrapperClassName="w-56"
              value={config.summary.summaryPlaceholder}
              onChange={(event) =>
                update("summary", { summaryPlaceholder: event.target.value })
              }
            />
          }
        />
        <Row
          label="Auto-generate title"
          description="Replace vague pull request titles with one that describes the change."
          control={
            <Switch
              checked={config.summary.autoTitle}
              onChange={(autoTitle) => update("summary", { autoTitle })}
              label="Auto-generate title"
            />
          }
        />
      </Panel>

      <Panel title="Issues and pull requests">
        <Row
          label="Assess linked issues"
          viewTarget="issues"
          onView={onView}
          description="Check whether the change actually satisfies every linked issue."
          control={
            <Switch
              checked={config.summary.assessLinkedIssues}
              onChange={(assessLinkedIssues) =>
                update("summary", { assessLinkedIssues })
              }
              label="Assess linked issues"
            />
          }
        />
        <Row
          label="Related issues"
          description="Surface issues that describe the same work."
          control={
            <Switch
              checked={config.summary.relatedIssues}
              onChange={(relatedIssues) => update("summary", { relatedIssues })}
              label="Related issues"
            />
          }
        />
        <Row
          label="Related pull requests"
          viewTarget="related-prs"
          onView={onView}
          description="Link pull requests that touch the same code."
          control={
            <Switch
              checked={config.summary.relatedPrs}
              onChange={(relatedPrs) => update("summary", { relatedPrs })}
              label="Related pull requests"
            />
          }
        />
      </Panel>

      <Panel title="Labels and reviewers">
        <Row
          label="Suggest labels"
          viewTarget="labels"
          onView={onView}
          description="Propose labels based on what the change touches."
          control={
            <Switch
              checked={config.summary.suggestedLabels}
              onChange={(suggestedLabels) => update("summary", { suggestedLabels })}
              label="Suggest labels"
            />
          }
        />
        <Row
          label="Auto-apply labels"
          description="Apply the suggested labels instead of only listing them."
          control={
            <Switch
              checked={config.summary.autoApplyLabels}
              disabled={!config.summary.suggestedLabels}
              onChange={(autoApplyLabels) => update("summary", { autoApplyLabels })}
              label="Auto-apply labels"
            />
          }
        />
        <Row
          label="Suggest reviewers"
          viewTarget="labels"
          onView={onView}
          description="Recommend reviewers from recent history on the changed files."
          control={
            <Switch
              checked={config.summary.suggestedReviewers}
              onChange={(suggestedReviewers) =>
                update("summary", { suggestedReviewers })
              }
              label="Suggest reviewers"
            />
          }
        />
        <Row
          label="Auto-assign reviewers"
          description="Assign the suggested reviewers to the pull request."
          control={
            <Switch
              checked={config.summary.autoAssignReviewers}
              disabled={!config.summary.suggestedReviewers}
              onChange={(autoAssignReviewers) =>
                update("summary", { autoAssignReviewers })
              }
              label="Auto-assign reviewers"
            />
          }
        />
      </Panel>
    </div>
  );
}

/* -------------------------------------------------------------- Walkthrough */

function WalkthroughSection({ config, update, onView }: SectionProps) {
  return (
    <Panel title="Walkthrough">
      <Row
        label="Walkthrough"
        viewTarget="walkthrough"
        onView={onView}
        description="Post a walkthrough comment that explains the change to human reviewers."
        control={
          <Switch
            checked={config.walkthrough.enabled}
            onChange={(enabled) => update("walkthrough", { enabled })}
            label="Walkthrough"
          />
        }
      />
      <Row
        label="Changed files summary"
        viewTarget="changes"
        onView={onView}
        description="Include a table of every changed file and what changed in it."
        control={
          <Switch
            checked={config.walkthrough.changedFilesSummary}
            disabled={!config.walkthrough.enabled}
            onChange={(changedFilesSummary) =>
              update("walkthrough", { changedFilesSummary })
            }
            label="Changed files summary"
          />
        }
      />
      <Row
        label="Sequence diagrams"
        viewTarget="diagram"
        onView={onView}
        description="Add a Mermaid sequence diagram when the change spans several components."
        control={
          <Switch
            checked={config.walkthrough.sequenceDiagrams}
            disabled={!config.walkthrough.enabled}
            onChange={(sequenceDiagrams) =>
              update("walkthrough", { sequenceDiagrams })
            }
            label="Sequence diagrams"
          />
        }
      />
      <Row
        label="Estimate code review effort"
        viewTarget="effort"
        onView={onView}
        description="Rate how long a careful review of this change is likely to take."
        control={
          <Switch
            checked={config.walkthrough.estimateCodeReviewEffort}
            disabled={!config.walkthrough.enabled}
            onChange={(estimateCodeReviewEffort) =>
              update("walkthrough", { estimateCodeReviewEffort })
            }
            label="Estimate code review effort"
          />
        }
      />
    </Panel>
  );
}

/* ----------------------------------------------------------------- Behavior */

function BehaviorSection({ config, update }: SectionProps) {
  return (
    <div className="space-y-3">
      <Panel title="Review profile">
        <Row
          label="Profile"
          description="Assertive surfaces more nitpicks and style notes. Chill focuses on what matters most."
          control={
            <SegmentedControl
              value={config.behavior.profile}
              onChange={(profile) => update("behavior", { profile })}
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
      </Panel>

      <Panel title="Automatic review">
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
                <button
                  type="button"
                  aria-label={`Remove ${branch}`}
                  onClick={() =>
                    update("behavior", {
                      baseBranches: config.behavior.baseBranches.filter(
                        (entry) => entry !== branch,
                      ),
                    })
                  }
                  className="ml-0.5 text-fg-faint transition-colors hover:text-danger"
                >
                  ×
                </button>
              </Badge>
            ))}
            <Button
              size="xs"
              variant="ghost"
              icon={<Plus className="h-3 w-3" />}
              onClick={() =>
                update("behavior", {
                  baseBranches: [...config.behavior.baseBranches, "release/*"],
                })
              }
            >
              Add
            </Button>
          </div>
        </Row>
      </Panel>
    </div>
  );
}

/* --------------------------------------------------------- Pre-merge checks */

function PreMergeSection({ config, update }: SectionProps) {
  return (
    <Panel title="Pre-merge checks">
      <Row
        label="Title"
        description="Check that the pull request title describes the change."
        control={
          <Select
            value={config.preMergeChecks.title}
            onChange={(title) =>
              update("preMergeChecks", {
                title: title as OrgConfig["preMergeChecks"]["title"],
              })
            }
            options={severityOptions}
          />
        }
      />
      <Row
        label="Description"
        description="Check that the description explains why the change is needed."
        control={
          <Select
            value={config.preMergeChecks.description}
            onChange={(description) =>
              update("preMergeChecks", {
                description:
                  description as OrgConfig["preMergeChecks"]["description"],
              })
            }
            options={severityOptions}
          />
        }
      />
      <Row
        label="Issue assessment"
        description="Check that the change satisfies every linked issue."
        control={
          <Select
            value={config.preMergeChecks.issueAssessment}
            onChange={(issueAssessment) =>
              update("preMergeChecks", {
                issueAssessment:
                  issueAssessment as OrgConfig["preMergeChecks"]["issueAssessment"],
              })
            }
            options={severityOptions}
          />
        }
      />
      <Row
        label="Docstring coverage"
        description="Check that new public functions carry a docstring."
        control={
          <Select
            value={config.preMergeChecks.docstrings}
            onChange={(docstrings) =>
              update("preMergeChecks", {
                docstrings: docstrings as OrgConfig["preMergeChecks"]["docstrings"],
              })
            }
            options={severityOptions}
          />
        }
      />
    </Panel>
  );
}

/* ------------------------------------------------------- Finishing touches */

function FinishingTouchesSection({ config, update }: SectionProps) {
  return (
    <Panel title="Finishing touches">
      <Row
        label="Generate docstrings"
        description="Offer a follow-up commit that documents new public functions."
        control={
          <Switch
            checked={config.finishingTouches.docstrings}
            onChange={(docstrings) => update("finishingTouches", { docstrings })}
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
}

/* ------------------------------------------------------- Post-merge actions */

function PostMergeSection({ config, update }: SectionProps) {
  return (
    <Panel
      title="Custom post-merge actions"
      action={
        <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />}>
          New action
        </Button>
      }
    >
      {config.postMergeActions.map((action) => (
        <Row
          key={action.id}
          label={action.name}
          description={action.description}
          control={
            <div className="flex items-center gap-2">
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
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Delete ${action.name}`}
                onClick={() =>
                  update(
                    "postMergeActions",
                    config.postMergeActions.filter(
                      (entry) => entry.id !== action.id,
                    ) as OrgConfig["postMergeActions"],
                  )
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          }
        />
      ))}
    </Panel>
  );
}

/* ----------------------------------------------------------------- Statuses */

function StatusesSection({ config, update, onView }: SectionProps) {
  return (
    <Panel title="Statuses">
      <Row
        label="Review status"
        viewTarget="status"
        onView={onView}
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
      <Row
        label="Fail commit status"
        description="Mark the commit status as failed while a critical finding is open."
        control={
          <Switch
            checked={config.statuses.failCommitStatus}
            disabled={!config.statuses.commitStatus}
            onChange={(failCommitStatus) =>
              update("statuses", { failCommitStatus })
            }
            label="Fail commit status"
          />
        }
      />
    </Panel>
  );
}

/* ---------------------------------------------------------------------- Fun */

function FunSection({ config, update, onView }: SectionProps) {
  return (
    <Panel title="Fun">
      <Row
        label="Poem"
        viewTarget="poem"
        onView={onView}
        description="End each review with a short poem about the change."
        control={
          <Switch
            checked={config.fun.poem}
            onChange={(poem) => update("fun", { poem })}
            label="Poem"
          />
        }
      />
    </Panel>
  );
}

/* --------------------------------------------------------------- YAML view */

export function buildYaml(config: OrgConfig) {
  return `language: "${config.general.language}"
early_access: ${config.general.earlyAccess}
${config.general.toneInstructions ? `tone_instructions: "${config.general.toneInstructions}"\n` : ""}reviews:
  profile: "${config.behavior.profile}"
  request_changes_workflow: ${config.behavior.requestChangesWorkflow}
  high_level_summary: ${config.summary.highLevelSummary}
  high_level_summary_placeholder: "${config.summary.summaryPlaceholder}"
  high_level_summary_in_walkthrough: ${config.summary.highLevelSummaryInWalkthrough}
  auto_title_placeholder: ${config.summary.autoTitle}
  assess_linked_issues: ${config.summary.assessLinkedIssues}
  related_issues: ${config.summary.relatedIssues}
  related_prs: ${config.summary.relatedPrs}
  suggested_labels: ${config.summary.suggestedLabels}
  auto_apply_labels: ${config.summary.autoApplyLabels}
  suggested_reviewers: ${config.summary.suggestedReviewers}
  auto_assign_reviewers: ${config.summary.autoAssignReviewers}
  poem: ${config.fun.poem}
  review_status: ${config.statuses.reviewStatus}
  commit_status: ${config.statuses.commitStatus}
  fail_commit_status: ${config.statuses.failCommitStatus}
  walkthrough:
    enabled: ${config.walkthrough.enabled}
    changed_files_summary: ${config.walkthrough.changedFilesSummary}
    sequence_diagrams: ${config.walkthrough.sequenceDiagrams}
    estimate_code_review_effort: ${config.walkthrough.estimateCodeReviewEffort}
  auto_review:
    enabled: ${config.behavior.autoReview}
    drafts: ${config.behavior.autoReviewDrafts}
    auto_incremental_review: ${config.behavior.autoIncrementalReview}
    ignore_title_keywords: []
    base_branches:
${config.behavior.baseBranches.map((branch) => `      - "${branch}"`).join("\n")}
  pre_merge_checks:
    title:
      mode: "${config.preMergeChecks.title}"
    description:
      mode: "${config.preMergeChecks.description}"
    issue_assessment:
      mode: "${config.preMergeChecks.issueAssessment}"
    docstrings:
      mode: "${config.preMergeChecks.docstrings}"
  finishing_touches:
    docstrings:
      enabled: ${config.finishingTouches.docstrings}
    unit_tests:
      enabled: ${config.finishingTouches.unitTests}`;
}
