import { useState } from "react";
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Flag,
  FolderGit2,
  List,
  ListFilter,
  Search,
  RefreshCw,
  Tag,
  TriangleAlert,
  User,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Misc";
import { Popover } from "@/components/ui/Menu";
import { cn } from "@/lib/utils";

export type GroupKey =
  | "priority"
  | "repo"
  | "author"
  | "reviewState"
  | "changeType"
  | "risk";

export const groupOptions: { value: GroupKey; label: string }[] = [
  { value: "priority", label: "Priority" },
  { value: "repo", label: "Repository" },
  { value: "author", label: "PR author" },
  { value: "reviewState", label: "Review state" },
  { value: "changeType", label: "Change type" },
  { value: "risk", label: "Risk" },
];

export type OrderKey =
  | "priority"
  | "updatedAt"
  | "reviewEffort"
  | "risk"
  | "blastRadius";

export const orderOptions: { value: OrderKey; label: string }[] = [
  { value: "priority", label: "Priority" },
  { value: "updatedAt", label: "Last activity" },
  { value: "reviewEffort", label: "Review effort" },
  { value: "risk", label: "Risk" },
  { value: "blastRadius", label: "Blast radius" },
];

export const displayProperties = [
  { key: "summary", label: "Summary" },
  { key: "lastActivity", label: "Last activity" },
  { key: "changeType", label: "Change type" },
  { key: "reviewGuidance", label: "Review guidance" },
  { key: "risk", label: "Risk" },
  { key: "securityRisk", label: "Security risk" },
  { key: "blastRadius", label: "Blast radius" },
  { key: "reviewEffort", label: "Review effort" },
  { key: "issueSeverity", label: "Issue severity" },
  { key: "priority", label: "Priority" },
  { key: "reviewers", label: "Reviewers" },
] as const;

export type PropertyKey = (typeof displayProperties)[number]["key"];

export interface DisplayState {
  layout: "list" | "board";
  grouping: GroupKey;
  subGrouping: GroupKey | "none";
  ordering: OrderKey;
  direction: "asc" | "desc";
  properties: PropertyKey[];
}

export const defaultDisplay: DisplayState = {
  layout: "board",
  grouping: "priority",
  subGrouping: "none",
  ordering: "priority",
  direction: "asc",
  properties: ["summary", "lastActivity", "priority", "reviewers"],
};

function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="h-8 w-[150px] appearance-none rounded-md border border-line bg-canvas bg-[length:14px] bg-[right_8px_center] bg-no-repeat pl-2.5 pr-7 text-sm text-fg outline-none transition-colors hover:border-line-strong"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b8493' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function DisplayMenu({
  state,
  onChange,
}: {
  state: DisplayState;
  onChange: (next: DisplayState) => void;
}) {
  const toggleProperty = (key: PropertyKey) =>
    onChange({
      ...state,
      properties: state.properties.includes(key)
        ? state.properties.filter((entry) => entry !== key)
        : [...state.properties, key],
    });

  return (
    <Popover
      align="end"
      panelClassName="w-[330px] p-3"
      trigger={({ open, toggle }) => (
        <Button
          size="sm"
          variant={open ? "secondary" : "outline"}
          icon={<Columns3 className="h-3.5 w-3.5" />}
          onClick={toggle}
        >
          Display
        </Button>
      )}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-1 rounded-md border border-line p-0.5">
          {(["list", "board"] as const).map((layout) => (
            <button
              key={layout}
              type="button"
              onClick={() => onChange({ ...state, layout })}
              className={cn(
                "flex h-7 flex-1 items-center justify-center gap-1.5 rounded text-xs font-medium capitalize transition-colors",
                state.layout === layout
                  ? "bg-[var(--cr-active)] text-fg"
                  : "text-fg-subtle hover:text-fg",
              )}
            >
              {layout === "list" ? (
                <List className="h-3.5 w-3.5" />
              ) : (
                <Columns3 className="h-3.5 w-3.5" />
              )}
              {layout}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-fg-muted">Grouping</span>
          <Select
            value={state.grouping}
            onChange={(grouping) => onChange({ ...state, grouping })}
            options={groupOptions}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-fg-muted">Sub-grouping</span>
          <Select
            value={state.subGrouping}
            onChange={(subGrouping) => onChange({ ...state, subGrouping })}
            options={[
              { value: "none" as const, label: "No grouping" },
              ...groupOptions.filter((entry) => entry.value !== state.grouping),
            ]}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-fg-muted">Ordering</span>
          <div className="flex items-center gap-1.5">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={
                state.direction === "asc" ? "Sort ascending" : "Sort descending"
              }
              onClick={() =>
                onChange({
                  ...state,
                  direction: state.direction === "asc" ? "desc" : "asc",
                })
              }
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
            </Button>
            <Select
              value={state.ordering}
              onChange={(ordering) => onChange({ ...state, ordering })}
              options={orderOptions}
            />
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs text-fg-subtle">Display properties</p>
          <div className="flex flex-wrap gap-1.5">
            {displayProperties.map((property) => (
              <button
                key={property.key}
                type="button"
                aria-pressed={state.properties.includes(property.key)}
                onClick={() => toggleProperty(property.key)}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs transition-colors",
                  state.properties.includes(property.key)
                    ? "border-line-strong bg-[var(--cr-active)] text-fg"
                    : "border-line text-fg-subtle hover:text-fg",
                )}
              >
                {property.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Popover>
  );
}

export type FacetKey =
  | "repo"
  | "author"
  | "reviewers"
  | "priority"
  | "reviewGuidance"
  | "risk"
  | "securityRisk"
  | "reviewState"
  | "changeType";

export type Facets = Partial<Record<FacetKey, string[]>>;

const facetMeta: { key: FacetKey; label: string; icon: typeof Flag }[] = [
  { key: "repo", label: "Repository name", icon: FolderGit2 },
  { key: "author", label: "PR author", icon: User },
  { key: "reviewers", label: "PR reviewers", icon: Users },
  { key: "priority", label: "Priority", icon: Flag },
  { key: "reviewGuidance", label: "Review guidance", icon: Columns3 },
  { key: "risk", label: "Risk", icon: TriangleAlert },
  { key: "securityRisk", label: "Security risk", icon: TriangleAlert },
  { key: "reviewState", label: "Review workflow", icon: RefreshCw },
  { key: "changeType", label: "Change type", icon: Tag },
];

export function FilterMenu({
  facets,
  options,
  onChange,
}: {
  facets: Facets;
  options: Record<FacetKey, string[]>;
  onChange: (next: Facets) => void;
}) {
  const [openFacet, setOpenFacet] = useState<FacetKey | null>(null);
  const [query, setQuery] = useState("");
  const activeCount = Object.values(facets).reduce(
    (sum, values) => sum + (values?.length ?? 0),
    0,
  );

  const toggleValue = (facet: FacetKey, value: string) => {
    const current = facets[facet] ?? [];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    onChange({ ...facets, [facet]: next.length > 0 ? next : undefined });
  };

  return (
    <Popover
      align="end"
      panelClassName="w-[300px] p-1"
      trigger={({ open, toggle }) => (
        <Button
          size="sm"
          variant={open || activeCount > 0 ? "secondary" : "outline"}
          icon={<ListFilter className="h-3.5 w-3.5" />}
          onClick={() => {
            setOpenFacet(null);
            toggle();
          }}
        >
          Filter
          {activeCount > 0 && (
            <span className="ml-1 rounded bg-brand-soft px-1.5 text-2xs text-brand">
              {activeCount}
            </span>
          )}
        </Button>
      )}
    >
      {openFacet === null ? (
        <>
          {facetMeta.map((facet) => {
            const count = facets[facet.key]?.length ?? 0;
            return (
              <button
                key={facet.key}
                type="button"
                onClick={() => {
                  setOpenFacet(facet.key);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2.5 rounded px-2 py-2 text-left text-sm text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
              >
                <facet.icon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate">{facet.label}</span>
                {count > 0 && (
                  <span className="rounded bg-brand-soft px-1.5 text-2xs text-brand">
                    {count}
                  </span>
                )}
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
              </button>
            );
          })}
          {activeCount > 0 && (
            <>
              <div className="my-1 h-px bg-line" />
              <button
                type="button"
                onClick={() => onChange({})}
                className="w-full rounded px-2 py-2 text-left text-sm text-fg-subtle transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
              >
                Clear all filters
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpenFacet(null)}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-fg transition-colors hover:bg-[var(--cr-hover)]"
          >
            <ChevronLeft className="h-3.5 w-3.5 text-fg-subtle" />
            {facetMeta.find((entry) => entry.key === openFacet)?.label}
          </button>
          <div className="my-1 h-px bg-line" />
          <div className="px-1 pb-1">
            <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-canvas px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={facetMeta.find((entry) => entry.key === openFacet)?.label}
                className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {options[openFacet]
              .filter((value) =>
                value.toLowerCase().includes(query.trim().toLowerCase()),
              )
              .map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => toggleValue(openFacet, value)}
                className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-sm text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
              >
                <Checkbox
                  checked={(facets[openFacet] ?? []).includes(value)}
                  onChange={() => toggleValue(openFacet, value)}
                  label={value}
                />
                <span className="min-w-0 flex-1 truncate">{value}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Popover>
  );
}
