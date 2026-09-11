import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, Info, Mail, PlusCircle, Slack, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { MenuItem, Popover } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { DiscordIcon, TeamsIcon } from "@/components/icons";
import { Page } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import {
  dateRangePresets,
  groupByOptions,
  parameterOptions,
  promptTemplates,
  reportChannels,
  timezones,
  weekdays,
  type ReportKind,
} from "@/data/reports";
import { cn } from "@/lib/utils";

/** Card whose title and blurb sit left of the control, as on the app's form. */
function FormCard({
  title,
  required,
  description,
  action,
  children,
}: {
  title: string;
  required?: boolean;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-fg">
            {title}
            {required && <span className="ml-0.5 text-fg-subtle">*</span>}
          </h2>
          {description && (
            <p className="mt-1.5 max-w-lg text-xs leading-relaxed text-fg-subtle">
              {description}
            </p>
          )}
        </div>
        {action}
      </header>
      {children && <div className="border-t border-line">{children}</div>}
    </section>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm text-fg">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  width = 180,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  width?: number;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={{
        width,
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b8493' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
      }}
      className="h-8 appearance-none rounded-md border border-line bg-canvas bg-[length:14px] bg-[right_8px_center] bg-no-repeat pl-2.5 pr-7 text-sm text-fg outline-none transition-colors hover:border-line-strong"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function ChannelIcon({ id }: { id: string }) {
  const shared = "h-4 w-4";
  if (id === "slack") return <Slack className={shared} />;
  if (id === "discord") return <DiscordIcon className={shared} />;
  if (id === "teams") return <TeamsIcon className={shared} />;
  return <Mail className={shared} />;
}

export function CreateReport({ kind }: { kind: ReportKind }) {
  const navigate = useNavigate();
  const toast = useToast();

  const [name, setName] = useState("");
  const [frequency, setFrequency] = useState<"Days of Week" | "Days of Month">(
    "Days of Week",
  );
  const [every, setEvery] = useState(1);
  const [days, setDays] = useState<string[]>(["Mon"]);
  const [monthDays, setMonthDays] = useState<number[]>([1]);
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState(timezones[0]);
  const [rangePreset, setRangePreset] = useState(dateRangePresets[0]);
  const [parameters, setParameters] = useState<string[]>([]);
  const [template, setTemplate] = useState(promptTemplates[0]);
  const [prompt, setPrompt] = useState(promptTemplates[0].prompt);
  const [groupBy, setGroupBy] = useState(groupByOptions[0]);
  const [emails, setEmails] = useState("");

  const recurring = kind === "recurring";

  const rangeLabel = (() => {
    const dayCount = Number.parseInt(rangePreset, 10);
    const end = new Date();
    const start = new Date();
    if (!Number.isNaN(dayCount)) start.setDate(end.getDate() - dayCount);
    const format = (date: Date) =>
      date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
    return `${format(start)} - ${format(end)}`;
  })();

  const submit = () => {
    if (!name.trim()) {
      toast({
        title: "Report name is required",
        description: "Give the report a name your team will recognise.",
        tone: "error",
      });
      return;
    }
    toast({
      title: recurring ? "Report created" : "Report saved",
      description: recurring
        ? `"${name.trim()}" runs every ${every} ${frequency === "Days of Week" ? "week(s)" : "month(s)"} at ${time} ${timezone}.`
        : `"${name.trim()}" will run once over ${rangePreset}.`,
    });
    navigate("/reports");
  };

  return (
    <Page className="max-w-[860px]">
      <TopBarActions>
        <Button size="sm" variant="primary" onClick={submit}>
          {recurring ? "Create Report" : "Save Report"}
        </Button>
      </TopBarActions>

      <div className="space-y-4">
        <FormCard
          title="Report name"
          required
          description="A clear, descriptive name helps your team recognise this report when it lands in a channel."
        >
          <div className="px-5 py-4">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Enter the name here"
              wrapperClassName="max-w-[300px] ml-auto"
            />
          </div>
        </FormCard>

        {recurring ? (
          <FormCard
            title="Schedule"
            required
            description="Stick to a schedule to provide reliable insights over time and drive improvement with confidence."
          >
            <FieldRow label="Frequency">
              <div className="inline-flex items-center gap-0.5 rounded-md border border-line bg-canvas p-0.5">
                {(["Days of Week", "Days of Month"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setFrequency(option)}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                      frequency === option
                        ? "bg-[var(--cr-active)] text-fg"
                        : "text-fg-subtle hover:text-fg",
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </FieldRow>

            <FieldRow label="Every">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={12}
                  value={every}
                  onChange={(event) => setEvery(Number(event.target.value) || 1)}
                  wrapperClassName="w-[86px]"
                  className="tabular-nums"
                />
                <span className="text-sm text-fg-subtle">
                  {frequency === "Days of Week" ? "week(s)" : "month(s)"}
                </span>
              </div>
            </FieldRow>

            {frequency === "Days of Week" ? (
              <FieldRow label="Days">
                <div className="flex flex-wrap gap-1">
                  {weekdays.map((day) => (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={days.includes(day)}
                      onClick={() =>
                        setDays((current) =>
                          current.includes(day)
                            ? current.filter((entry) => entry !== day)
                            : [...current, day],
                        )
                      }
                      className={cn(
                        "h-7 w-10 rounded border text-xs font-medium transition-colors",
                        days.includes(day)
                          ? "border-line-strong bg-[var(--cr-active)] text-fg"
                          : "border-line text-fg-subtle hover:text-fg",
                      )}
                    >
                      {day}
                    </button>
                  ))}
                </div>
              </FieldRow>
            ) : (
              <FieldRow label="Days of month">
                <div className="grid max-w-[300px] grid-cols-8 gap-1">
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={monthDays.includes(day)}
                      onClick={() =>
                        setMonthDays((current) =>
                          current.includes(day)
                            ? current.filter((entry) => entry !== day)
                            : [...current, day],
                        )
                      }
                      className={cn(
                        "h-6 rounded border text-2xs tabular-nums transition-colors",
                        monthDays.includes(day)
                          ? "border-line-strong bg-[var(--cr-active)] text-fg"
                          : "border-line text-fg-subtle hover:text-fg",
                      )}
                    >
                      {day}
                    </button>
                  ))}
                </div>
              </FieldRow>
            )}

            <FieldRow label="Time">
              <Input
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                wrapperClassName="w-[130px]"
                className="tabular-nums"
              />
            </FieldRow>

            <FieldRow label="Timezone">
              <Select
                value={timezone}
                onChange={setTimezone}
                options={timezones}
                width={190}
              />
            </FieldRow>
          </FormCard>
        ) : (
          <FormCard
            title="Date Range"
            required
            description="Select a date range to include your pull request activity."
          >
            <div className="flex flex-wrap items-center gap-2 px-5 py-4">
              <Select
                value={rangePreset}
                onChange={setRangePreset}
                options={dateRangePresets}
                width={130}
              />
              <span className="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-canvas px-2.5 text-sm text-fg-muted">
                <CalendarDays className="h-3.5 w-3.5 text-fg-subtle" />
                {rangeLabel}
              </span>
            </div>
          </FormCard>
        )}

        <FormCard
          title="Report Parameters"
          description="Fine-tune reports seamlessly. Leverage Report Parameters for accuracy."
          action={
            <Popover
              align="end"
              panelClassName="w-[260px]"
              trigger={({ toggle }) => (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<PlusCircle className="h-3.5 w-3.5" />}
                  onClick={toggle}
                >
                  Add Parameter
                </Button>
              )}
            >
              {(close) =>
                parameterOptions
                  .filter((option) => !parameters.includes(option.id))
                  .map((option) => (
                    <MenuItem
                      key={option.id}
                      onClick={() => {
                        setParameters((current) => [...current, option.id]);
                        close();
                      }}
                    >
                      {option.label}
                    </MenuItem>
                  ))
              }
            </Popover>
          }
        >
          {parameters.length > 0 && (
            <div className="divide-y divide-line">
              {parameters.map((id) => {
                const option = parameterOptions.find((entry) => entry.id === id)!;
                return (
                  <div
                    key={id}
                    className="flex items-center justify-between gap-3 px-5 py-3"
                  >
                    <div>
                      <p className="text-sm text-fg">{option.label}</p>
                      <p className="mt-0.5 text-xs text-fg-subtle">{option.hint}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input placeholder="Any" wrapperClassName="w-[180px]" />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${option.label}`}
                        onClick={() =>
                          setParameters((current) =>
                            current.filter((entry) => entry !== id),
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </FormCard>

        <FormCard
          title="Prompt"
          required
          description="Adjust the AI prompt to your liking for personalizing the report."
        >
          <FieldRow label="Prompt template">
            <Select
              value={template.label}
              onChange={(label) => {
                const next = promptTemplates.find((entry) => entry.label === label)!;
                setTemplate(next);
                setPrompt(next.prompt);
              }}
              options={promptTemplates.map((entry) => entry.label)}
              width={210}
            />
          </FieldRow>

          <div className="border-b border-line px-5 py-4">
            <p className="text-sm text-fg">Prompt</p>
            <p className="mt-0.5 text-xs text-fg-subtle">
              <code className="font-mono">{"{{today}}"}</code> in the prompt will be
              replaced by the date the report is generated at.
            </p>
            <Textarea
              rows={5}
              className="mt-2.5 leading-relaxed"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>

          <FieldRow label="Group by">
            <Select
              value={groupBy}
              onChange={setGroupBy}
              options={groupByOptions}
              width={150}
            />
          </FieldRow>
        </FormCard>

        <FormCard
          title="Channels"
          required
          description="Enable the channel to which the Custom Report applies."
        >
          <div className="divide-y divide-line">
            {reportChannels.map((channel) => (
              <div key={channel.id} className="px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--cr-hover)] text-fg-muted">
                      <ChannelIcon id={channel.id} />
                    </span>
                    <span className="text-sm font-medium text-fg">
                      {channel.name}
                    </span>
                  </span>
                  {channel.id !== "email" && (
                    <Button size="sm" variant="secondary">
                      Connect
                    </Button>
                  )}
                </div>

                <p className="mt-2 text-xs leading-relaxed text-fg-subtle">
                  {channel.description}
                  {channel.extra && (
                    <>
                      {" "}
                      Check out our new{" "}
                      <a href={channel.extra.href} className="text-brand hover:underline">
                        {channel.extra.label}
                      </a>
                    </>
                  )}
                </p>

                {channel.id === "email" && (
                  <div className="mt-3">
                    <label
                      htmlFor="report-emails"
                      className="text-xs font-medium text-fg"
                    >
                      Email ID(s)
                    </label>
                    <Input
                      id="report-emails"
                      value={emails}
                      onChange={(event) => setEmails(event.target.value)}
                      wrapperClassName="mt-1.5"
                      placeholder="team@acalys.dev, lead@acalys.dev"
                    />
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-fg-subtle">
                      <Info className="h-3 w-3 shrink-0" />
                      Use comma separated email IDs to send the report to multiple
                      email addresses.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </FormCard>
      </div>
    </Page>
  );
}
