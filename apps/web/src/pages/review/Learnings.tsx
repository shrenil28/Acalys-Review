import { useEffect, useMemo, useState } from "react";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, SearchInput, Textarea } from "@/components/ui/Input";
import { FilterSelect } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/Misc";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import { useToast } from "@/components/ui/Toast";
import {
  LiveFailureState,
  LiveMisconfiguredState,
  LiveTableLoading,
} from "@/components/live/LiveDataState";
import {
  useKnowledgeDirectory,
  type KnowledgeView,
} from "@/lib/api/liveDashboard";

export function LearningsPage() {
  const directory = useKnowledgeDirectory();
  const [items, setItems] = useState<KnowledgeView[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("All");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftRepo, setDraftRepo] = useState("Organization");
  const toast = useToast();

  useEffect(() => {
    if (directory.status === "ready") setItems([...directory.value]);
  }, [directory]);

  const repoNames = useMemo(
    () =>
      [...new Set(items.flatMap((item) => (item.repo === undefined ? [] : [item.repo])))].sort(),
    [items],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((learning) => {
      if (scope === "Organization" && learning.scope !== "Organization") return false;
      if (scope === "Path" && learning.scope !== "Path") return false;
      if (
        scope !== "All" &&
        scope !== "Organization" &&
        scope !== "Path" &&
        learning.repo !== scope
      ) return false;
      if (!needle) return true;
      return learning.content.toLowerCase().includes(needle);
    });
  }, [items, query, scope]);

  const canMutate = directory.status === "ready" && directory.source === "fixtures";

  const addLearning = () => {
    if (!canMutate || !draft.trim()) return;
    setItems((current) => [
      {
        id: `l-${Date.now()}`,
        scope: draftRepo === "Organization" ? "Organization" : "Repository",
        ...(draftRepo === "Organization" ? {} : { repo: draftRepo }),
        content: draft.trim(),
        source: "Manual",
        authored: true,
        createdAt: new Date().toISOString().slice(0, 10),
        appliedCount: 0,
        author: "shrenil28",
      },
      ...current,
    ]);
    toast({
      title: "Learning added",
      description:
        draftRepo === "Organization"
          ? "Applied to every repository in this organization."
          : `Applied to ${draftRepo}.`,
    });
    setDraft("");
    setCreating(false);
  };

  return (
    <Page>
      <TopBarActions>
        <Button
          size="sm"
          variant="brand"
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setCreating(true)}
          disabled={!canMutate}
        >
          Add learning
        </Button>
      </TopBarActions>

      <PageHeader
        title="Learnings"
        description="Conventions Acalys has picked up from your reviews and chats. Every learning is applied to future reviews in its scope."
      />

      {directory.status === "loading" ? (
        <div className="mt-5"><LiveTableLoading columns={3} /></div>
      ) : directory.status === "misconfigured" ? (
        <div className="mt-5"><LiveMisconfiguredState detail={directory.detail} /></div>
      ) : directory.status === "failed" ? (
        <div className="mt-5"><LiveFailureState failure={directory.failure} /></div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <SearchInput
              placeholder="Search learnings..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              wrapperClassName="w-full max-w-sm"
            />
            <FilterSelect
              label="Scope"
              value={scope}
              options={["All", "Organization", "Path", ...repoNames]}
              onChange={setScope}
            />
            <span className="ml-auto text-xs text-fg-subtle">
              {filtered.length} of {items.length}
            </span>
          </div>

          <div className="mt-3">
            {items.length === 0 ? (
              <EmptyState
                icon={<Sparkles />}
                title="No learnings yet"
                description="Acalys has not recorded any learnings for this organization yet."
                action={
                  canMutate ? (
                    <Button variant="brand" onClick={() => setCreating(true)}>Add learning</Button>
                  ) : undefined
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Sparkles />}
                title="No learnings match the current filters"
                description="The knowledge store loaded successfully, but nothing matches this search and scope."
              />
            ) : (
              <ul className="space-y-2">
                {filtered.map((learning) => (
                  <li key={learning.id} className="group flex items-start gap-3 rounded-lg border border-line bg-surface p-3.5">
                    <Badge tone={learning.scope === "Organization" ? "purple" : "neutral"}>
                      {learning.scope === "Organization"
                        ? "Organization"
                        : learning.scope === "Path"
                          ? learning.path ?? "Path"
                          : learning.repo ?? "Repository"}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-relaxed text-fg-muted">{learning.content}</p>
                      <p className="mt-1.5 text-2xs text-fg-faint">
                        From {learning.source.toLowerCase()}
                        {learning.createdAt ? ` · added ${learning.createdAt.slice(0, 10)}` : ""}
                        {learning.author ? ` by ${learning.author}` : ""}
                        {learning.appliedCount === null ? " · usage not available" : ` · applied ${learning.appliedCount}×`}
                      </p>
                    </div>
                    {canMutate ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Delete learning"
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() =>
                          setItems((current) => current.filter((entry) => entry.id !== learning.id))
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <Modal
        open={creating && canMutate}
        onClose={() => setCreating(false)}
        title="Add learning"
        description="Write it the way you would explain the rule to a new teammate."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="brand" onClick={addLearning} disabled={!draft.trim()}>Add learning</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Applies to">
            <select
              value={draftRepo}
              onChange={(event) => setDraftRepo(event.target.value)}
              className="h-8 rounded-md border border-line bg-canvas px-2 text-sm text-fg outline-none"
            >
              <option value="Organization">Organization (all repositories)</option>
              {repoNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </Field>
          <Field label="Learning" hint="Applied to every review in the selected scope.">
            <Textarea
              rows={4}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Prefer dependency injection over module-level singletons in service code."
            />
          </Field>
        </div>
      </Modal>
    </Page>
  );
}
