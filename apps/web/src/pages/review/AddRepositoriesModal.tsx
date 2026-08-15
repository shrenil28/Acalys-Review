import { useMemo, useState } from "react";
import { Lock, Search, Unlock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Misc";
import { useToast } from "@/components/ui/Toast";
import { GitHubIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/** Repositories visible to the GitHub App but not yet added to Acalys. */
const available = [
  { name: "acalys-mobile", visibility: "Private", language: "Swift", pushedAt: "3h ago" },
  { name: "acalys-docs", visibility: "Public", language: "MDX", pushedAt: "1d ago" },
  { name: "eval-harness", visibility: "Private", language: "Python", pushedAt: "2d ago" },
  { name: "design-tokens", visibility: "Public", language: "TypeScript", pushedAt: "5d ago" },
  { name: "notifications-service", visibility: "Private", language: "Go", pushedAt: "1w ago" },
  { name: "legacy-import", visibility: "Private", language: "PHP", pushedAt: "3mo ago" },
] as const;

export function AddRepositoriesModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return available;
    return available.filter((repo) => repo.name.toLowerCase().includes(needle));
  }, [query]);

  const toggle = (name: string) =>
    setSelected((current) =>
      current.includes(name)
        ? current.filter((entry) => entry !== name)
        : [...current, name],
    );

  const add = () => {
    toast({
      title: `${selected.length} ${selected.length === 1 ? "repository" : "repositories"} added`,
      description: "Acalys reviews the next pull request opened on each.",
    });
    setSelected([]);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add repositories"
      description="Pick the repositories Acalys should review. Only repositories the GitHub App can see are listed."
      size="lg"
      footer={
        <>
          <a
            href="https://github.com/apps/coderabbitai/installations/select_target"
            target="_blank"
            rel="noreferrer"
            className="mr-auto text-xs text-brand underline-offset-2 hover:underline"
          >
            Manage GitHub App access
          </a>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" disabled={selected.length === 0} onClick={add}>
            Add {selected.length > 0 ? selected.length : ""}{" "}
            {selected.length === 1 ? "repository" : "repositories"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          icon={<Search className="h-3.5 w-3.5" />}
          placeholder="Search repositories..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="max-h-[320px] overflow-y-auto rounded-md border border-line">
          {rows.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-fg-subtle">
              No repositories match that search.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((repo) => {
                const checked = selected.includes(repo.name);
                return (
                  <li key={repo.name}>
                    <button
                      type="button"
                      onClick={() => toggle(repo.name)}
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--cr-hover)]",
                        checked && "bg-[var(--cr-hover)]",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onChange={() => toggle(repo.name)}
                        label={`Add ${repo.name}`}
                      />
                      <GitHubIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">
                        {repo.name}
                      </span>
                      {repo.visibility === "Private" ? (
                        <Lock className="h-3 w-3 shrink-0 text-fg-faint" />
                      ) : (
                        <Unlock className="h-3 w-3 shrink-0 text-fg-faint" />
                      )}
                      <Badge tone="outline">{repo.language}</Badge>
                      <span className="w-16 shrink-0 text-right text-2xs text-fg-faint">
                        {repo.pushedAt}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="text-xs text-fg-subtle">
          {selected.length} selected · Acalys reviews the next pull request
          opened on each.
        </p>
      </div>
    </Modal>
  );
}
