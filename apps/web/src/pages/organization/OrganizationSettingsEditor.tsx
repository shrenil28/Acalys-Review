import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Check, ChevronDown, Columns2, Copy, Info, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { UnsavedBar } from "@/components/ui/UnsavedBar";
import { MenuItem, Popover } from "@/components/ui/Menu";
import { Textarea } from "@/components/ui/Input";
import { TopBarActions } from "@/components/layout/TopBar";
import { useToast } from "@/components/ui/Toast";
import type { OrgConfig } from "@/features/review-settings/model";
import { cn } from "@/lib/utils";
import { ReviewPreview } from "./ReviewPreview";
import { copyToClipboard } from "@/lib/clipboard";
import {
  AllSettingsPanel,
  type AllSettingsSection,
} from "./AllSettingsSections";
import {
  allSettingsTree,
  conciseTree,
  flattenTree,
  SettingsNav,
} from "./settingsTree";
import {
  buildYaml,
  SettingsPanel,
  type SettingsSection,
} from "./SettingsSections";

const viewModes = [
  "Concise",
  "All Settings",
  "YAML Editor",
  "Global Overrides",
] as const;
type ViewMode = (typeof viewModes)[number];

const BASE = "/organization/settings";

const conciseSlugs = flattenTree(conciseTree);
const allSettingsSlugs = flattenTree(allSettingsTree);

export interface OrganizationSettingsEditorProps {
  readonly initialConfig: OrgConfig;
  readonly onApply?: ((config: OrgConfig) => Promise<OrgConfig>) | undefined;
  readonly repositoryLabel?: string | undefined;
  readonly previewAuthor?: { readonly name: string; readonly avatarUrl?: string | undefined } | undefined;
  readonly capabilitySummary?: string | undefined;
}

export function OrganizationSettingsEditor({
  initialConfig,
  onApply,
  repositoryLabel = "this organization",
  previewAuthor,
  capabilitySummary,
}: OrganizationSettingsEditorProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const slug = pathname.replace(`${BASE}/`, "").replace(BASE, "");

  const [config, setConfig] = useState<OrgConfig>(initialConfig);
  const [baseline, setBaseline] = useState<OrgConfig>(initialConfig);
  // A URL that only exists in the deeper tree opens in "All Settings",
  // so a shared link lands on the section it names.
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    allSettingsSlugs.includes(slug) && !conciseSlugs.includes(slug)
      ? "All Settings"
      : "Concise",
  );
  const [previewOpen, setPreviewOpen] = useState(true);

  // Each view mode exposes its own section tree, so the URL resolves against
  // whichever tree is active and falls back to General.
  const tree = viewMode === "All Settings" ? allSettingsTree : conciseTree;
  const slugs = viewMode === "All Settings" ? allSettingsSlugs : conciseSlugs;
  const section = slugs.includes(slug) ? slug : "general";
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const [yamlDraft, setYamlDraft] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const update: <K extends keyof OrgConfig>(
    key: K,
    value: Partial<OrgConfig[K]>,
  ) => void = (key, value) => {
    setSaved(false);
    setYamlDraft(null);
    setConfig((current) => ({
      ...current,
      [key]: Array.isArray(current[key])
        ? value
        : { ...(current[key] as object), ...(value as object) },
    }));
  };

  useEffect(() => {
    setConfig(initialConfig);
    setBaseline(initialConfig);
    setSaved(false);
    setYamlDraft(null);
  }, [initialConfig]);

  const apply = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const authoritative = onApply === undefined ? config : await onApply(config);
      setConfig(authoritative);
      setBaseline(authoritative);
      setSaved(true);
      setYamlDraft(null);
      toast({
        title: "Settings applied",
        description: `New reviews in ${repositoryLabel} use this configuration.`,
      });
    } catch (error) {
      // The last confirmed server snapshot is authoritative on any failed save.
      setConfig(baseline);
      setYamlDraft(null);
      setSaved(false);
      toast({
        title: "Settings were not saved",
        description: error instanceof Error ? error.message : "Reloaded the last confirmed server configuration.",
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(baseline),
    [baseline, config],
  );

  /** The View chips jump to the matching block in the preview pane. */
  const scrollToPreview = (target: string) => {
    setPreviewOpen(true);
    requestAnimationFrame(() => {
      const node = previewRef.current?.querySelector(`[data-preview="${target}"]`);
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      node?.classList.add("ring-1", "ring-brand", "rounded-md");
      window.setTimeout(
        () => node?.classList.remove("ring-1", "ring-brand", "rounded-md"),
        1400,
      );
    });
  };

  const isYamlMode = viewMode === "YAML Editor" || viewMode === "Global Overrides";
  const showPreview = previewOpen && !isYamlMode;

  return (
    <div className="flex min-h-full">
      <TopBarActions>
        <Button
          size="sm"
          variant={previewOpen ? "secondary" : "outline"}
          icon={<Columns2 className="h-3.5 w-3.5" />}
          onClick={() => setPreviewOpen((value) => !value)}
        >
          Preview
        </Button>
        <Button
          size="sm"
          variant={dirty ? "brand" : "outline"}
          disabled={!dirty || saving}
          icon={saved ? <Check className="h-3.5 w-3.5" /> : undefined}
          onClick={() => { void apply(); }}
        >
          {saving ? "Saving…" : saved ? "Applied" : "Apply changes"}
        </Button>
      </TopBarActions>

      {/* Settings navigation — hidden in the YAML modes, which run full width */}
      <aside
        className={cn(
          "sticky top-0 hidden w-[268px] shrink-0 self-start p-4",
          isYamlMode ? "hidden" : "lg:block",
        )}
      >
        <div className="rounded-lg border border-line bg-surface p-2">
          <div className="flex items-center justify-between gap-2 px-1.5 pb-2">
            <span className="text-sm text-fg">View mode</span>
            <Popover
              align="end"
              panelClassName="w-[188px]"
              trigger={({ toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-fg transition-colors hover:bg-[var(--cr-hover)]"
                >
                  {viewMode}
                  <ChevronDown className="h-3 w-3 text-fg-subtle" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {viewModes.map((mode) => (
                    <MenuItem
                      key={mode}
                      selected={viewMode === mode}
                      onClick={() => {
                        setViewMode(mode);
                        close();
                      }}
                    >
                      {mode}
                    </MenuItem>
                  ))}
                </>
              )}
            </Popover>
          </div>

          <SettingsNav
            tree={tree}
            active={section}
            onSelect={(next) => navigate(`${BASE}/${next}`)}
          />
        </div>
      </aside>

      {/* Editor */}
      <div className="min-w-0 flex-1 p-4 sm:py-4 sm:pr-6">
        {isYamlMode && (
          <div className="mb-4 flex items-center gap-3">
            <span className="text-sm text-fg">View mode</span>
            <Popover
              panelClassName="w-[188px]"
              trigger={({ toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm text-fg transition-colors hover:bg-[var(--cr-hover)]"
                >
                  {viewMode}
                  <ChevronDown className="h-3 w-3 text-fg-subtle" />
                </button>
              )}
            >
              {(close) => (
                <>
                  {viewModes.map((mode) => (
                    <MenuItem
                      key={mode}
                      selected={viewMode === mode}
                      onClick={() => {
                        setViewMode(mode);
                        close();
                      }}
                    >
                      {mode}
                    </MenuItem>
                  ))}
                </>
              )}
            </Popover>
          </div>
        )}

        <div className={cn("space-y-3", !showPreview && !isYamlMode && "mx-auto max-w-3xl")}>
          {capabilitySummary !== undefined && !isYamlMode && (
            <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-fg-subtle">
              {capabilitySummary}
            </div>
          )}

          {viewMode === "Concise" && (
            <SettingsPanel
              section={section as SettingsSection}
              config={config}
              update={update}
              onView={scrollToPreview}
            />
          )}

          {viewMode === "All Settings" &&
            (section === "general" ? (
              <SettingsPanel
                section="general"
                config={config}
                update={update}
                onView={scrollToPreview}
              />
            ) : (
              <AllSettingsPanel
                section={section as AllSettingsSection}
                config={config}
                update={update}
              />
            ))}

          {viewMode === "YAML Editor" && (
            <YamlEditor
              value={yamlDraft ?? buildYaml(config)}
              onChange={setYamlDraft}
            />
          )}

          {viewMode === "Global Overrides" && <GlobalOverrides />}
        </div>
      </div>

      <UnsavedBar
        open={dirty && !saved}
        saveLabel="Apply changes"
        onReset={() => {
          setConfig(baseline);
          setYamlDraft(null);
          setSaved(false);
        }}
        onSave={() => { void apply(); }}
      />

      {/* Live preview */}
      {showPreview && (
        <aside
          ref={previewRef}
          className="hidden w-[440px] shrink-0 overflow-y-auto border-l border-line p-4 xl:block"
        >
          <ReviewPreview config={config} viewMode={viewMode === "Concise" ? "Concise" : "Detailed"} {...(previewAuthor === undefined ? {} : { author: previewAuthor })} />
        </aside>
      )}
    </div>
  );
}

function YamlLines({ value }: { value: string }) {
  const lines = value.split("\n");
  return (
    <div className="flex overflow-x-auto rounded-md border border-line bg-canvas font-mono text-xs leading-relaxed">
      <div className="select-none border-r border-line px-3 py-3 text-right text-fg-faint">
        {lines.map((_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <pre className="min-h-[420px] flex-1 px-3 py-3 text-fg-muted">{value}</pre>
    </div>
  );
}

const SCHEMA_LINE =
  "# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json";

function YamlEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="border-b border-line px-4 py-3.5">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-fg">
          Configuration YAML
          <span title="Only values that differ from the defaults are shown.">
            <Info className="h-3 w-3 text-fg-faint" />
          </span>
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
          Edit your Acalys configuration directly. Only customized (non-default)
          values are shown. For the schema reference, see{" "}
          <a
            href="https://coderabbit.ai/integrations/schema.v2.json"
            target="_blank"
            rel="noreferrer"
            className="text-fg-muted hover:text-fg"
          >
            https://coderabbit.ai/integrations/schema.v2.json
          </a>
        </p>
      </header>
      <div className="p-4" onClick={() => setEditing(true)}>
        {editing ? (
          <Textarea
            autoFocus
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={() => setEditing(false)}
            spellCheck={false}
            className="min-h-[440px] font-mono text-xs leading-relaxed"
          />
        ) : (
          <YamlLines value={`${SCHEMA_LINE}\n`} />
        )}
      </div>
    </section>
  );
}

function GlobalOverrides() {
  const toast = useToast();
  return (
    <div className="space-y-3">
      <div
        className="flex items-start gap-2.5 rounded-lg border border-warn/40 px-4 py-3"
        style={{
          backgroundImage:
            "radial-gradient(oklch(0.795 0.184 86.047 / 0.18) 0.5px, transparent 0.5px)",
          backgroundSize: "5px 5px",
        }}
      >
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <p className="text-sm leading-relaxed text-warn">
          <strong className="font-semibold">Global Override Settings</strong> These
          settings override all repository and organization configurations across
          your entire organization. Changes here will take effect on every PR
          review, regardless of individual repository or inheritance settings.
        </p>
      </div>

      <section className="rounded-lg border border-line bg-surface">
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3.5">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-fg">
              Global Overrides YAML
              <span title="Applied on top of every repository configuration.">
                <Info className="h-3 w-3 text-fg-faint" />
              </span>
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-fg-subtle">
              These overrides apply on top of every repository's configuration. For
              the schema reference, see{" "}
              <a
                href="https://coderabbit.ai/integrations/schema.v2.json"
                target="_blank"
                rel="noreferrer"
                className="text-fg-muted hover:text-fg"
              >
                https://coderabbit.ai/integrations/schema.v2.json
              </a>
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon={<Copy className="h-3.5 w-3.5" />}
            onClick={() => {
              void copyToClipboard(SCHEMA_LINE).then((copied) => {
                toast(
                  copied
                    ? { title: "YAML copied" }
                    : { title: "Could not copy YAML", tone: "error" },
                );
              });
            }}
          >
            Copy YAML
          </Button>
        </header>
        <div className="p-4">
          <YamlLines value={`${SCHEMA_LINE}\n`} />
        </div>
      </section>
    </div>
  );
}
