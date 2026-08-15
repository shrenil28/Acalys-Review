import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavNode {
  label: string;
  /** Leaf nodes carry a slug; group nodes carry children instead. */
  slug?: string;
  children?: NavNode[];
}

/** "Concise" keeps the tree shallow: the settings people change most often. */
export const conciseTree: NavNode[] = [
  { label: "General", slug: "general" },
  {
    label: "Reviews",
    children: [
      { label: "Summary", slug: "review/summary" },
      { label: "Walkthrough", slug: "review/walkthrough" },
      { label: "Behavior", slug: "review/behavior" },
    ],
  },
  { label: "Pre-merge checks", slug: "pre-merge-checks" },
  { label: "Finishing touches", slug: "finishing-touches" },
  { label: "Custom post-merge actions", slug: "custom-post-merge-actions" },
  { label: "Statuses", slug: "statuses" },
  { label: "Fun", slug: "fun" },
];

/** "All Settings" exposes the full configuration surface. */
export const allSettingsTree: NavNode[] = [
  { label: "General", slug: "general" },
  {
    label: "Reviews",
    children: [
      { label: "General", slug: "review/general" },
      { label: "Auto review", slug: "review/auto-review" },
      { label: "Finishing touches", slug: "review/finishing-touches" },
      { label: "Pre merge checks", slug: "review/pre-merge-checks" },
      { label: "Post merge actions", slug: "review/post-merge-actions" },
      { label: "Tools", slug: "review/tools" },
    ],
  },
  { label: "Chat", slug: "chat" },
  { label: "Knowledge base", slug: "knowledge-base" },
  { label: "Code generation", slug: "code-generation" },
  { label: "Issue enrichment", slug: "issue-enrichment" },
];

export function flattenTree(tree: NavNode[]): string[] {
  return tree.flatMap((node) =>
    node.slug ? [node.slug] : flattenTree(node.children ?? []),
  );
}

/**
 * Settings navigation. Groups collapse, and the group containing the active
 * section opens itself — the same behaviour as the app's sidebar.
 */
export function SettingsNav({
  tree,
  active,
  onSelect,
}: {
  tree: NavNode[];
  active: string;
  onSelect: (slug: string) => void;
}) {
  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
      {tree.map((node) =>
        node.children ? (
          <NavGroup
            key={node.label}
            node={node}
            active={active}
            onSelect={onSelect}
          />
        ) : (
          <NavButton
            key={node.slug}
            active={active === node.slug}
            onClick={() => onSelect(node.slug!)}
          >
            {node.label}
          </NavButton>
        ),
      )}
    </nav>
  );
}

function NavGroup({
  node,
  active,
  onSelect,
}: {
  node: NavNode;
  active: string;
  onSelect: (slug: string) => void;
}) {
  const contains = (node.children ?? []).some((child) => child.slug === active);
  // Groups start expanded, as they do in the app.
  const [open, setOpen] = useState<boolean>(true);

  useEffect(() => {
    if (contains) setOpen(true);
  }, [contains]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm transition-colors",
          contains
            ? "font-medium text-fg"
            : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
        )}
      >
        <span className="flex-1 truncate">{node.label}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-0.5 pl-3 pt-0.5">
            {(node.children ?? []).map((child) => (
              <NavButton
                key={child.slug}
                active={active === child.slug}
                onClick={() => onSelect(child.slug!)}
              >
                {child.label}
              </NavButton>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 items-center rounded px-2 text-left text-sm transition-colors",
        active
          ? "bg-[var(--cr-hover)] font-medium text-fg"
          : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg",
      )}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}
