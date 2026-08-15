import { useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  RefreshCw,
  Search,
  X,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Popover } from "@/components/ui/Menu";
import { cn } from "@/lib/utils";

export interface TimeRange {
  from: Date;
  to: Date;
  /** Set when a quick range is active, so the label stays relative. */
  label?: string;
}

const quickRanges: { label: string; ms: number }[] = [
  { label: "Last 24 hours", ms: 864e5 },
  { label: "Last 2 days", ms: 2 * 864e5 },
  { label: "Last 7 days", ms: 7 * 864e5 },
  { label: "Last 30 days", ms: 30 * 864e5 },
  { label: "Last 90 days", ms: 90 * 864e5 },
  { label: "Last 6 months", ms: 182 * 864e5 },
  { label: "Last 1 year", ms: 365 * 864e5 },
  { label: "Last 2 years", ms: 730 * 864e5 },
  { label: "Last 5 years", ms: 1826 * 864e5 },
];

export const refreshIntervals = [
  "Off",
  "Auto",
  "5s",
  "10s",
  "30s",
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "1d",
];

const isValid = (date: Date) => date instanceof Date && !Number.isNaN(date.getTime());

/** Never throws: an unparsable date formats as an empty string. */
const stamp = (date: Date) =>
  isValid(date) ? date.toISOString().replace("T", " ").slice(0, 19) : "";

/** Never throws: falls back to now so the UI always has something to render. */
const parseStamp = (value: string) => {
  const parsed = new Date(String(value).replace(" ", "T") + "Z");
  return isValid(parsed) ? parsed : new Date();
};

export function makeRange(label = "Last 30 days"): TimeRange {
  const preset = quickRanges.find((entry) => entry.label === label) ?? quickRanges[3];
  const to = new Date();
  return { from: new Date(to.getTime() - preset.ms), to, label: preset.label };
}

/** Guards a range so downstream maths and formatting can rely on it. */
function safeRange(range: TimeRange): TimeRange {
  if (isValid(range.from) && isValid(range.to)) return range;
  return makeRange();
}

/**
 * The dashboard time control. Mirrors Grafana's: step back and forward by the
 * current window, an absolute range with quick presets, zoom out, manual
 * refresh, and an auto-refresh interval.
 */

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Month grid opened from the From/To fields, Monday-first like the app. */
function Calendar({
  value,
  rangeStart,
  rangeEnd,
  time,
  onSelect,
  onTimeChange,
  onClose,
}: {
  value: Date;
  rangeStart: Date;
  rangeEnd: Date;
  time: string;
  onSelect: (date: Date) => void;
  onTimeChange: (time: string) => void;
  onClose: () => void;
}) {
  const anchor = isValid(value) ? value : new Date();
  const [cursor, setCursor] = useState(
    () => new Date(anchor.getFullYear(), anchor.getMonth(), 1),
  );

  const days = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    // Monday-first offset: JS weeks start on Sunday.
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - offset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [cursor]);


  return (
    <div className="absolute right-full top-0 z-10 mr-2 w-[292px] rounded-lg border border-line bg-shell p-3 shadow-pop">
      <header className="flex items-center justify-between">
        <p className="text-sm font-medium text-fg">Select a time range</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close calendar"
          className="rounded p-0.5 text-fg-subtle transition-colors hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() =>
            setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))
          }
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <p className="text-sm text-fg">
          {cursor.toLocaleString("en-US", { month: "long", year: "numeric" })}
        </p>
        <button
          type="button"
          aria-label="Next month"
          onClick={() =>
            setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))
          }
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-7 gap-y-0.5">
        {WEEKDAYS.map((day) => (
          <span
            key={day}
            className="py-1 text-center text-2xs font-medium text-fg-subtle"
          >
            {day}
          </span>
        ))}
        {days.map((date, index) => {
          const outside = date.getMonth() !== cursor.getMonth();
          const day = startOfDay(date).getTime();
          const start = isValid(rangeStart) ? startOfDay(rangeStart).getTime() : NaN;
          const end = isValid(rangeEnd) ? startOfDay(rangeEnd).getTime() : NaN;
          const isStart = day === start;
          const isEnd = day === end;
          const inRange = day > Math.min(start, end) && day < Math.max(start, end);
          const edge = isStart || isEnd;

          return (
            <button
              key={index}
              type="button"
              onClick={() => onSelect(date)}
              className={cn(
                "h-7 text-center text-xs tabular-nums transition-colors",
                // The band runs edge to edge so a week reads as one stripe.
                inRange && "bg-[var(--cr-hover)] text-fg",
                edge && "bg-[var(--cr-active)] font-medium text-fg",
                isStart && !isEnd && "rounded-l-full",
                isEnd && !isStart && "rounded-r-full",
                isStart && isEnd && "rounded-full",
                !edge && !inRange && "rounded",
                !edge &&
                  !inRange &&
                  (outside
                    ? "text-fg-faint hover:bg-[var(--cr-hover)]"
                    : "text-fg-muted hover:bg-[var(--cr-hover)] hover:text-fg"),
              )}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
        <span className="text-xs text-fg-subtle">Time</span>
        <input
          value={time}
          onChange={(event) => onTimeChange(event.target.value)}
          placeholder="HH:MM"
          aria-label="Time"
          className="ml-auto h-7 w-[86px] rounded border border-line bg-canvas px-2 text-center font-mono text-xs tabular-nums text-fg outline-none transition-colors hover:border-line-strong"
        />
      </div>
    </div>
  );
}

export function TimeRangePicker({
  range: rawRange,
  onChange,
  timezone,
  onTimezoneChange,
  refresh,
  onRefreshChange,
}: {
  range: TimeRange;
  onChange: (next: TimeRange) => void;
  timezone: "UTC" | "Browser";
  onTimezoneChange: (next: "UTC" | "Browser") => void;
  refresh: string;
  onRefreshChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");
  const range = safeRange(rawRange);
  const [fromDraft, setFromDraft] = useState(stamp(range.from));
  const [toDraft, setToDraft] = useState(stamp(range.to));
  const [calendarFor, setCalendarFor] = useState<"from" | "to" | null>(null);

  const span = range.to.getTime() - range.from.getTime();

  const shift = (direction: -1 | 1) =>
    onChange({
      from: new Date(range.from.getTime() + direction * span),
      to: new Date(range.to.getTime() + direction * span),
    });

  const zoomOut = () =>
    onChange({
      from: new Date(range.from.getTime() - span / 2),
      to: new Date(range.to.getTime() + span / 2),
    });

  const filteredRanges = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return quickRanges;
    return quickRanges.filter((entry) =>
      entry.label.toLowerCase().includes(needle),
    );
  }, [query]);

  const label = range.label ?? `${stamp(range.from)} to ${stamp(range.to)}`;

  return (
    <div className="flex items-center gap-0.5">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Shift range backward"
        onClick={() => shift(-1)}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>

      <Popover
        align="end"
        panelClassName="w-[560px] p-0"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={() => {
              setFromDraft(stamp(range.from));
              setToDraft(stamp(range.to));
              toggle();
            }}
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-md border border-line px-2.5 text-xs transition-colors hover:bg-[var(--cr-hover)]",
              open ? "bg-[var(--cr-hover)] text-fg" : "text-fg-muted",
            )}
          >
            <Clock className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <span className="tabular-nums text-fg">{label}</span>
            <span className="text-fg-subtle">{timezone === "UTC" ? "UTC" : "Browser"}</span>
            <ChevronDown className="h-3 w-3 text-fg-subtle" />
          </button>
        )}
      >
        {(close) => (
          <div className="relative">
            {calendarFor && (
              <Calendar
                value={
                  new Date(
                    (calendarFor === "from" ? fromDraft : toDraft).replace(" ", "T") +
                      "Z",
                  )
                }
                rangeStart={parseStamp(fromDraft)}
                rangeEnd={parseStamp(toDraft)}
                time={(calendarFor === "from" ? fromDraft : toDraft).slice(11, 16)}
                onTimeChange={(next) => {
                  const draft = calendarFor === "from" ? fromDraft : toDraft;
                  const updated = `${draft.slice(0, 10)} ${next}:00`;
                  if (calendarFor === "from") setFromDraft(updated);
                  else setToDraft(updated);
                }}
                onClose={() => setCalendarFor(null)}
                onSelect={(date) => {
                  const draft = calendarFor === "from" ? fromDraft : toDraft;
                  const time = /^\d{2}:\d{2}(:\d{2})?$/.test(draft.slice(11))
                    ? draft.slice(11).padEnd(8, ":00").slice(0, 8)
                    : "00:00:00";
                  const next = `${date.toISOString().slice(0, 10)} ${time}`;
                  if (calendarFor === "from") setFromDraft(next);
                  else setToDraft(next);
                }}
              />
            )}
            <div className="flex">
              <div className="w-1/2 space-y-3 border-r border-line p-4">
                <p className="text-sm font-medium text-fg">Absolute time range</p>
                {(["from", "to"] as const).map((field) => {
                  const draft = field === "from" ? fromDraft : toDraft;
                  const setDraft = field === "from" ? setFromDraft : setToDraft;
                  return (
                    <div key={field}>
                      <span className="text-xs capitalize text-fg-subtle">
                        {field}
                      </span>
                      <div className="mt-1 flex items-center gap-1.5">
                        <Input
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          className="font-mono text-xs tabular-nums"
                          wrapperClassName="flex-1"
                        />
                        <Button
                          size="icon-sm"
                          variant={calendarFor === field ? "secondary" : "outline"}
                          aria-label={`Pick ${field} date`}
                          onClick={() =>
                            setCalendarFor(calendarFor === field ? null : field)
                          }
                        >
                          <CalendarDays className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => {
                    const from = new Date(fromDraft.replace(" ", "T") + "Z");
                    const to = new Date(toDraft.replace(" ", "T") + "Z");
                    if (isValid(from) && isValid(to)) {
                      onChange({ from, to });
                      close();
                    }
                  }}
                >
                  Apply time range
                </Button>
              </div>

              <div className="flex w-1/2 flex-col">
                <div className="p-2">
                  <Input
                    icon={<Search className="h-3.5 w-3.5" />}
                    placeholder="Search quick ranges"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <div className="max-h-[240px] flex-1 overflow-y-auto px-1 pb-2">
                  {filteredRanges.map((entry) => (
                    <button
                      key={entry.label}
                      type="button"
                      onClick={() => {
                        onChange(makeRange(entry.label));
                        close();
                      }}
                      className={cn(
                        "flex w-full items-center rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-[var(--cr-hover)]",
                        range.label === entry.label ? "text-fg" : "text-fg-muted",
                      )}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 border-t border-line px-4 py-2.5">
              <span className="text-xs text-fg-muted">
                Browser Time{" "}
                <span className="text-fg-subtle">
                  {Intl.DateTimeFormat().resolvedOptions().timeZone}
                </span>
              </span>
              <span className="ml-auto text-xs tabular-nums text-fg-subtle">
                {timezone === "UTC" ? "UTC+00:00" : localOffset()}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  onTimezoneChange(timezone === "UTC" ? "Browser" : "UTC")
                }
              >
                Change time settings
              </Button>
            </div>
          </div>
        )}
      </Popover>

      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Shift range forward"
        onClick={() => shift(1)}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>

      <Button size="icon-sm" variant="ghost" aria-label="Zoom out" onClick={zoomOut}>
        <ZoomOut className="h-3.5 w-3.5" />
      </Button>

      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Refresh dashboard"
        onClick={() => onChange({ ...range })}
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>

      <Popover
        align="end"
        panelClassName="w-[110px]"
        trigger={({ toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-label="Auto refresh interval"
            className="flex h-7 items-center gap-1 rounded px-1 text-xs text-fg-muted transition-colors hover:bg-[var(--cr-hover)] hover:text-fg"
          >
            {refresh !== "Off" && <span className="tabular-nums">{refresh}</span>}
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      >
        {(close) =>
          refreshIntervals.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => {
                onRefreshChange(entry);
                close();
              }}
              className={cn(
                "flex w-full rounded px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-[var(--cr-hover)]",
                entry === refresh ? "text-fg" : "text-fg-muted",
              )}
            >
              {entry}
            </button>
          ))
        }
      </Popover>
    </div>
  );
}

function localOffset() {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
