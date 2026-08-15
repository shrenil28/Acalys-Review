import { useEffect, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * One categorical ramp for the whole app so a series keeps its colour
 * between the Summary, Quality and Trends views.
 */
export const series = {
  brand: "#fb923c",
  purple: "#c084fc",
  info: "#60a5fa",
  ok: "#34d399",
  warn: "#fbbf24",
  danger: "#f87171",
  teal: "#2dd4bf",
  pink: "#f472b6",
};

export const seriesRamp = [
  series.brand,
  series.info,
  series.purple,
  series.ok,
  series.warn,
  series.teal,
  series.pink,
  series.danger,
];

export const severityColors: Record<string, string> = {
  Critical: "#ef4444",
  High: "#fb7185",
  Medium: series.warn,
  Low: series.info,
  Info: "#8b8493",
};

const readTokens = () => {
  if (typeof window === "undefined")
    return { grid: "#3b3740", tick: "#8b8493", legend: "#b9b4bf", cursor: "rgba(255,255,255,0.04)" };
  const style = getComputedStyle(document.documentElement);
  return {
    grid: style.getPropertyValue("--cr-chart-grid").trim() || "#3b3740",
    tick: style.getPropertyValue("--cr-chart-tick").trim() || "#8b8493",
    legend: style.getPropertyValue("--cr-chart-legend").trim() || "#b9b4bf",
    cursor: style.getPropertyValue("--cr-chart-cursor").trim() || "rgba(255,255,255,0.04)",
  };
};

/** Re-reads the chart greys whenever the theme class flips. */
function useChartTokens() {
  const [tokens, setTokens] = useState(readTokens);
  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(readTokens()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return tokens;
}

function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number | string; color?: string }[];
  label?: string | number;
  formatter?: (value: number | string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line bg-shell px-2.5 py-2 shadow-pop">
      {label !== undefined && (
        <p className="mb-1 text-2xs font-medium text-fg-subtle">{label}</p>
      )}
      <ul className="space-y-0.5">
        {payload.map((entry, index) => (
          <li key={index} className="flex items-center gap-2 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: entry.color }}
            />
            <span className="text-fg-muted">{entry.name}</span>
            <span className="ml-auto pl-3 font-medium tabular-nums text-fg">
              {formatter && entry.value !== undefined
                ? formatter(entry.value)
                : entry.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}



export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

export function AreaTrend({
  data,
  seriesDefs,
  height = 180,
  stacked,
  xKey = "label",
  valueFormatter,
}: {
  data: Record<string, string | number>[];
  seriesDefs: SeriesDef[];
  height?: number;
  stacked?: boolean;
  xKey?: string;
  valueFormatter?: (value: number | string) => string;
}) {
  const axis = useChartTokens();
  const legendStyle = { fontSize: 11, color: axis.legend };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
        <defs>
          {seriesDefs.map((def) => (
            <linearGradient
              key={def.key}
              id={`fill-${def.key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={def.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={def.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={axis.grid} strokeOpacity={0.4} vertical={false} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{ fill: axis.tick, fontSize: 11 }} />
        <YAxis tickLine={false} axisLine={false} tick={{ fill: axis.tick, fontSize: 11 }} width={52} />
        <Tooltip
          cursor={{ stroke: axis.grid }}
          content={<ChartTooltip formatter={valueFormatter} />}
        />
        {seriesDefs.length > 1 && (
          <Legend iconType="square" iconSize={8} wrapperStyle={legendStyle} />
        )}
        {seriesDefs.map((def) => (
          <Area
            key={def.key}
            type="monotone"
            dataKey={def.key}
            name={def.label}
            stroke={def.color}
            strokeWidth={2}
            fill={`url(#fill-${def.key})`}
            stackId={stacked ? "a" : undefined}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function BarTrend({
  data,
  seriesDefs,
  height = 180,
  stacked,
  xKey = "label",
  layout = "horizontal",
  valueFormatter,
}: {
  data: Record<string, string | number>[];
  seriesDefs: SeriesDef[];
  height?: number;
  stacked?: boolean;
  xKey?: string;
  layout?: "horizontal" | "vertical";
  valueFormatter?: (value: number | string) => string;
}) {
  const vertical = layout === "vertical";
  const axis = useChartTokens();
  const legendStyle = { fontSize: 11, color: axis.legend };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout={layout}
        margin={{ top: 6, right: 8, bottom: 0, left: vertical ? 8 : -18 }}
        barCategoryGap={vertical ? "22%" : "28%"}
      >
        <CartesianGrid
          stroke={axis.grid}
          strokeOpacity={0.4}
          vertical={vertical}
          horizontal={!vertical}
        />
        {vertical ? (
          <>
            <XAxis type="number" tickLine={false} axisLine={false} tick={{ fill: axis.tick, fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey={xKey}
              tickLine={false}
              axisLine={false}
              tick={{ fill: axis.tick, fontSize: 11 }}
              width={124}
            />
          </>
        ) : (
          <>
            <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{ fill: axis.tick, fontSize: 11 }} />
            <YAxis tickLine={false} axisLine={false} tick={{ fill: axis.tick, fontSize: 11 }} width={52} />
          </>
        )}
        <Tooltip
          cursor={{ fill: axis.cursor }}
          content={<ChartTooltip formatter={valueFormatter} />}
        />
        {seriesDefs.length > 1 && (
          <Legend iconType="square" iconSize={8} wrapperStyle={legendStyle} />
        )}
        {seriesDefs.map((def) => (
          <Bar
            key={def.key}
            dataKey={def.key}
            name={def.label}
            fill={def.color}
            stackId={stacked ? "a" : undefined}
            radius={vertical ? [0, 3, 3, 0] : [3, 3, 0, 0]}
            maxBarSize={vertical ? 18 : 40}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function LineTrend({
  data,
  seriesDefs,
  height = 180,
  xKey = "label",
  valueFormatter,
}: {
  data: Record<string, string | number>[];
  seriesDefs: SeriesDef[];
  height?: number;
  xKey?: string;
  valueFormatter?: (value: number | string) => string;
}) {
  const axis = useChartTokens();
  const legendStyle = { fontSize: 11, color: axis.legend };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={axis.grid} strokeOpacity={0.4} vertical={false} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{ fill: axis.tick, fontSize: 11 }} />
        <YAxis tickLine={false} axisLine={false} tick={{ fill: axis.tick, fontSize: 11 }} width={52} />
        <Tooltip
          cursor={{ stroke: axis.grid }}
          content={<ChartTooltip formatter={valueFormatter} />}
        />
        {seriesDefs.length > 1 && (
          <Legend iconType="square" iconSize={8} wrapperStyle={legendStyle} />
        )}
        {seriesDefs.map((def) => (
          <Line
            key={def.key}
            type="monotone"
            dataKey={def.key}
            name={def.label}
            stroke={def.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function DonutChart({
  data,
  height = 180,
  centerLabel,
  centerValue,
  colors,
}: {
  data: { name: string; value: number }[];
  height?: number;
  centerLabel?: string;
  centerValue?: ReactNode;
  colors?: Record<string, string>;
}) {
  const axis = useChartTokens();
  const legendStyle = { fontSize: 11, color: axis.legend };
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="58%"
            outerRadius="82%"
            paddingAngle={2}
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((entry, index) => (
              <Cell
                key={entry.name}
                fill={colors?.[entry.name] ?? seriesRamp[index % seriesRamp.length]}
              />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
          <Legend iconType="circle" iconSize={7} wrapperStyle={legendStyle} />
        </PieChart>
      </ResponsiveContainer>
      {centerValue !== undefined && (
        <div
          className="pointer-events-none absolute inset-x-0 flex flex-col items-center"
          style={{ top: height * 0.32 }}
        >
          <span className="text-xl font-semibold tabular-nums text-fg">
            {centerValue}
          </span>
          {centerLabel && (
            <span className="text-2xs text-fg-subtle">{centerLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact inline sparkline used on the Explore metric cards. */
export function Sparkline({
  data,
  color = series.brand,
  height = 44,
}: {
  data: { value: number }[];
  color?: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`spark-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#spark-${color})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
